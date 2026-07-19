/**
 * Fair Seat Purchase — DynamoDB-backed seat repository (AWS SDK v3).
 *
 * This is the real data-access layer for seat items. It implements the design's
 * Reservation Strategy (`design.md` → Reservation Strategy) faithfully as
 * DynamoDB conditional writes and a `TransactWriteItems` confirmation, so the
 * same conditional-write correctness proven by the in-memory reference model
 * (`../store.ts`, `../transitions.ts`, `../confirm.ts`) holds against real
 * DynamoDB.
 *
 * Mapping of operations to the design's access-pattern matrix:
 * - createSeat        → AP9  conditional PutItem `attribute_not_exists(PK)`
 * - getSeat           → AP1  GetItem (strongly consistent read-back)
 * - hold              → AP6  conditional UpdateItem `available → held`
 * - release           → AP8  conditional UpdateItem `held → available`
 * - confirm           → AP7  TransactWriteItems `held → sold` + `paid → confirmed`
 * - querySeatMap      → AP2  Query GSI1 `begins_with(GSI1SK, "STATUS#available")`
 * - countSectionAvail → AP3  Query GSI1 `Select = COUNT`
 * - queryExpiredHolds → AP4  Query GSI2 `GSI2SK < now` (KEYS_ONLY)
 *
 * Requirements covered: R1 (seat modeling/uniqueness), R3 (availability view),
 * R4 (hold), R6 (confirm/release), R7/R8 (sold-exactly-once, atomic race-free
 * transitions), R9 (expiration), R11 (access patterns).
 */

import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import type { Seat, SeatIdentity } from "../seat.js";
import { DuplicateSeatError } from "../store.js";
import { txnPK, txnSK } from "../transaction.js";
import {
  GSI1_NAME,
  GSI2_NAME,
  SHARD_COUNT,
  TABLE_NAME,
  getDocumentClient,
} from "./ddb-client.js";
import {
  GSI1SK_AVAILABLE_PREFIX,
  gsi1Attributes,
  gsi1PK,
  gsi2Attributes,
  gsi2ShardPK,
  seatKey,
} from "./keys.js";

/**
 * Rejection thrown when a hold is refused because the seat is not available
 * (nor an expired hold) at write time. Mirrors DynamoDB's
 * `ConditionalCheckFailedException` on the `available → held` conditional write
 * (design: `available → held`; Requirement 4.6). Nothing is changed.
 */
export class SeatNotAvailableError extends Error {
  constructor(public readonly identity: SeatIdentity) {
    super(
      `Seat not available for hold: venue=${identity.venue} section=${identity.section} ` +
        `row=${identity.row} seat=${identity.seat}.`,
    );
    this.name = "SeatNotAvailableError";
  }
}

/**
 * Rejection thrown when a release is refused because the seat is not currently
 * `held` (e.g. already `sold`, or already `available` → "no action required").
 * Mirrors `ConditionalCheckFailedException` on the `held → available` write
 * (design: `held → available`; Requirements 6.7, 6.8). Nothing is changed.
 */
export class SeatNotHeldError extends Error {
  constructor(public readonly identity: SeatIdentity) {
    super(
      `Seat not held (cannot release): venue=${identity.venue} section=${identity.section} ` +
        `row=${identity.row} seat=${identity.seat}.`,
    );
    this.name = "SeatNotHeldError";
  }
}

/**
 * Rejection thrown when a confirmation's `TransactWriteItems` is canceled
 * because either the seat guard (`held` AND holder matches AND not expired) or
 * the transaction guard (`Payment_Status = paid`) failed. Mirrors DynamoDB's
 * `TransactionCanceledException` (design: `held → sold`; Requirements 6.2, 9.3,
 * Property 8). Neither the seat nor the transaction is changed.
 */
export class SeatConfirmationRejectedError extends Error {
  constructor(
    public readonly identity: SeatIdentity,
    public readonly fanId: string,
    public readonly txnId: string,
    /** Per-item cancellation reasons from DynamoDB, if available. */
    public readonly cancellationReasons?: readonly (string | undefined)[],
  ) {
    super(
      `Seat cannot be confirmed: venue=${identity.venue} section=${identity.section} ` +
        `row=${identity.row} seat=${identity.seat} fan=${fanId} txn=${txnId}.`,
    );
    this.name = "SeatConfirmationRejectedError";
  }
}

/** A seat map row projected from GSI1 (INCLUDE {Row, Seat_Number, Seat_Status}). */
export interface SeatMapEntry {
  readonly PK: string;
  readonly SK: string;
  readonly Row?: string;
  readonly Seat_Number?: string;
  readonly Seat_Status?: string;
  readonly GSI1PK?: string;
  readonly GSI1SK?: string;
}

/** A KEYS_ONLY row returned from the GSI2 expired-hold sweep query. */
export interface ExpiredHoldKey {
  readonly PK: string;
  readonly SK: string;
  readonly GSI2PK: string;
  readonly GSI2SK: number;
}

/**
 * DynamoDB-backed repository for seat items. Stateless: all coordination happens
 * inside DynamoDB via conditional writes and transactions (design: Architecture).
 */
export class SeatRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient = getDocumentClient(),
    private readonly tableName: string = TABLE_NAME,
    private readonly shardCount: number = SHARD_COUNT,
  ) {}

  /**
   * AP9 — Create a seat (seed inventory) as a conditional `PutItem` guarded by
   * `attribute_not_exists(PK)`, starting `available` with GSI1 attributes set so
   * it appears in the seat map (design: Seat item; Requirements 1.1, 1.2, 1.4).
   *
   * Optionally accepts per-seat pricing (`opts.price` / `opts.tier`); when
   * provided, `Price` (N) and `Tier` (S) are stored on the seat item. These are
   * NOT projected into any GSI (the seat map still projects only
   * Row/Seat_Number/Seat_Status); per-seat price is read via {@link getSeat}.
   *
   * @throws {DuplicateSeatError} if a seat with the same identity already exists.
   */
  async createSeat(
    identity: SeatIdentity,
    opts?: { price?: number; tier?: string },
  ): Promise<void> {
    const { PK, SK } = seatKey(identity);
    const gsi1 = gsi1Attributes(identity);
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK,
            SK,
            Entity_Type: "SEAT",
            Venue: identity.venue,
            Section: identity.section,
            Row: identity.row,
            Seat_Number: identity.seat,
            Seat_Status: "available",
            GSI1PK: gsi1.GSI1PK,
            GSI1SK: gsi1.GSI1SK,
            Version: 0,
            // Optional per-seat pricing (sparse; omitted when undefined via the
            // doc client's removeUndefinedValues marshalling option).
            Price: opts?.price,
            Tier: opts?.tier,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new DuplicateSeatError(identity);
      }
      throw err;
    }
  }

  /**
   * AP1 — Look up one seat by primary key with a strongly consistent read, so a
   * just-committed transition is observed (design AP1; Requirements 1.9, 11.1).
   *
   * @returns the seat, or `undefined` if it does not exist (Requirement 11.2).
   */
  async getSeat(identity: SeatIdentity): Promise<Seat | undefined> {
    const { PK, SK } = seatKey(identity);
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK, SK },
        ConsistentRead: true,
      }),
    );
    return res.Item as Seat | undefined;
  }

  /**
   * AP6 — Hold a seat (`available → held`) as a single conditional `UpdateItem`
   * (design: `available → held`; Requirement 4). The condition treats an expired
   * hold as available (`Seat_Status = held AND Hold_Expiration <= now`), so a
   * lapsed hold can be re-grabbed even before physical cleanup (Requirement 9.6).
   *
   * On success: `Seat_Status = held`, holder + `Hold_Expiration = now + window`
   * set, GSI2 (sharded) attributes set for sweeping, GSI1 attributes removed so
   * the seat drops out of the seat map, `Version` incremented (R4.2, 4.4, 4.5).
   *
   * @param holdWindowSeconds hold window in seconds (design default 480).
   * @param now current time as epoch seconds.
   * @throws {SeatNotAvailableError} on `ConditionalCheckFailedException` — the
   *   seat was not available (or held-and-not-expired); nothing changed (R4.6).
   */
  async hold(
    identity: SeatIdentity,
    fanId: string,
    holdWindowSeconds: number,
    now: number,
  ): Promise<Seat> {
    const { PK, SK } = seatKey(identity);
    const holdExpiration = now + holdWindowSeconds;
    const gsi2 = gsi2Attributes(identity, holdExpiration, this.shardCount);
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK, SK },
          UpdateExpression:
            "SET Seat_Status = :held, Holder_Identifier = :fan, " +
            "Hold_Expiration = :exp, GSI2PK = :holdsShard, GSI2SK = :exp, " +
            "Version = Version + :one REMOVE GSI1PK, GSI1SK",
          ConditionExpression:
            "Seat_Status = :available OR (Seat_Status = :held AND Hold_Expiration <= :now)",
          ExpressionAttributeValues: {
            ":held": "held",
            ":available": "available",
            ":fan": fanId,
            ":exp": holdExpiration,
            ":now": now,
            ":holdsShard": gsi2.GSI2PK,
            ":one": 1,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return res.Attributes as Seat;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new SeatNotAvailableError(identity);
      }
      throw err;
    }
  }

  /**
   * AP8 — Release a held seat (`held → available`) as a single conditional
   * `UpdateItem` (design: `held → available`; Requirement 6.4). Requires the
   * seat to currently be `held`; clears holder + expiration, re-adds GSI1 (seat
   * map) attributes, removes GSI2 attributes, increments `Version` (R6.6).
   *
   * @throws {SeatNotHeldError} on `ConditionalCheckFailedException` — the seat
   *   was not `held` (already `sold`, R6.7; or already `available`, R6.8);
   *   nothing changed.
   */
  async release(identity: SeatIdentity): Promise<Seat> {
    const { PK, SK } = seatKey(identity);
    const gsi1 = gsi1Attributes(identity);
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK, SK },
          UpdateExpression:
            "SET Seat_Status = :available, GSI1PK = :sectionPk, GSI1SK = :sectionSk, " +
            "Version = Version + :one " +
            "REMOVE Holder_Identifier, Hold_Expiration, GSI2PK, GSI2SK",
          ConditionExpression: "Seat_Status = :held",
          ExpressionAttributeValues: {
            ":available": "available",
            ":held": "held",
            ":sectionPk": gsi1.GSI1PK,
            ":sectionSk": gsi1.GSI1SK,
            ":one": 1,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return res.Attributes as Seat;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new SeatNotHeldError(identity);
      }
      throw err;
    }
  }

  /**
   * Sweeper release: physically flip an EXPIRED held seat back to `available`
   * (design: Temporary Hold and Expiration → optional active sweeper). Unlike
   * {@link release}, the guard additionally requires the hold to still be
   * expired (`Hold_Expiration <= now`), so a seat that was re-held or sold
   * between the sweep query and this write is never clobbered — the conditional
   * write simply no-ops (returns `false`).
   *
   * @returns `true` if the seat was flipped to `available`; `false` if the guard
   *   no longer matched (already re-held, sold, or released).
   */
  async releaseExpired(identity: SeatIdentity, now: number): Promise<boolean> {
    const { PK, SK } = seatKey(identity);
    const gsi1 = gsi1Attributes(identity);
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK, SK },
          UpdateExpression:
            "SET Seat_Status = :available, GSI1PK = :sectionPk, GSI1SK = :sectionSk, " +
            "Version = Version + :one " +
            "REMOVE Holder_Identifier, Hold_Expiration, GSI2PK, GSI2SK",
          ConditionExpression:
            "Seat_Status = :held AND Hold_Expiration <= :now",
          ExpressionAttributeValues: {
            ":available": "available",
            ":held": "held",
            ":now": now,
            ":sectionPk": gsi1.GSI1PK,
            ":sectionSk": gsi1.GSI1SK,
            ":one": 1,
          },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return false; // Re-held, sold, or already released — nothing to do.
      }
      throw err;
    }
  }

  /**
   * AP7 — Confirm a purchase (`held → sold`) atomically with the purchase
   * transaction (`paid → confirmed`) via `TransactWriteItems` (design:
   * `held → sold`; Requirements 6.1, 6.3, 8.2). Two items must move together, so
   * a single conditional `UpdateItem` is insufficient.
   *
   * Seat guard: `Seat_Status = held AND Holder_Identifier = fan AND
   * Hold_Expiration > now` — a confirm on an expired hold is rejected without
   * capturing the sale (R9.3, 6.2). On success the seat becomes `sold`
   * (permanent — no outbound transition anywhere), `Hold_Expiration`/GSI2 are
   * removed, `Version` incremented.
   *
   * Txn guard: `Payment_Status = paid`. On success `Txn_State = confirmed` and a
   * UTC ISO-8601 `Confirmation_Timestamp` is stamped (Requirement 2.3).
   *
   * @param now current time as epoch seconds (compared to `Hold_Expiration`).
   * @throws {SeatConfirmationRejectedError} on `TransactionCanceledException` —
   *   either guard failed; neither item changed (R6.2, Property 8).
   */
  async confirm(
    identity: SeatIdentity,
    fanId: string,
    txnId: string,
    now: number,
  ): Promise<void> {
    const { PK, SK } = seatKey(identity);
    const confirmationTimestamp = new Date(now * 1000).toISOString();
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK, SK },
                UpdateExpression:
                  "SET Seat_Status = :sold, Version = Version + :one " +
                  "REMOVE Hold_Expiration, GSI2PK, GSI2SK",
                ConditionExpression:
                  "Seat_Status = :held AND Holder_Identifier = :fan AND Hold_Expiration > :now",
                ExpressionAttributeValues: {
                  ":sold": "sold",
                  ":held": "held",
                  ":fan": fanId,
                  ":now": now,
                  ":one": 1,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: txnPK(fanId), SK: txnSK(txnId) },
                UpdateExpression:
                  "SET Txn_State = :confirmed, Confirmation_Timestamp = :ts",
                ConditionExpression: "Payment_Status = :paid",
                ExpressionAttributeValues: {
                  ":confirmed": "confirmed",
                  ":paid": "paid",
                  ":ts": confirmationTimestamp,
                },
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        const reasons = err.CancellationReasons?.map((r) => r.Code);
        throw new SeatConfirmationRejectedError(identity, fanId, txnId, reasons);
      }
      throw err;
    }
  }

  /**
   * AP2 — Seat map: query GSI1 for the available seats in a section
   * (`GSI1PK = SECTION#<venue>#<section> AND begins_with(GSI1SK,
   * "STATUS#available")`), eventually consistent (design AP2; Requirements 3.1,
   * 11.3). GSI1 is sparse (only available seats populate it), so no filter is
   * needed. Paginates across all pages.
   *
   * @param section the (venue, section) whose seat map to read.
   * @returns the projected available-seat rows (INCLUDE {Row, Seat_Number,
   *   Seat_Status}).
   */
  async querySeatMap(section: { venue: string; section: string }): Promise<SeatMapEntry[]> {
    const pk = gsi1PK({ venue: section.venue, section: section.section, row: "", seat: "" });
    const items: SeatMapEntry[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI1_NAME,
          KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :prefix)",
          ExpressionAttributeValues: {
            ":pk": pk,
            ":prefix": GSI1SK_AVAILABLE_PREFIX,
          },
          // GSIs support eventually-consistent reads only (design AP2, R3.3).
          ConsistentRead: false,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      if (res.Items) {
        items.push(...(res.Items as SeatMapEntry[]));
      }
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  /**
   * Query EVERY seat in a section (regardless of status) directly from the BASE
   * table — a single-partition `Query` on `PK = SEAT#<venue>#<section>`, NOT a
   * `Scan`. Unlike {@link querySeatMap} (which reads the sparse GSI1 and so only
   * returns `available` seats), this returns the full seat items for
   * `available`, `held`, and `sold` seats alike, so a UI can render each seat's
   * current status. Eventually-consistent read (`ConsistentRead: false`);
   * paginates across all pages.
   *
   * @param section the (venue, section) whose seats to read.
   * @returns every seat item in the section (`Seat[]`).
   */
  async queryAllSeats(section: { venue: string; section: string }): Promise<Seat[]> {
    const pk = `SEAT#${section.venue}#${section.section}`;
    const items: Seat[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: {
            ":pk": pk,
          },
          // Eventually-consistent read is fine for a browsing seat map.
          ConsistentRead: false,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      if (res.Items) {
        items.push(...(res.Items as Seat[]));
      }
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  /**
   * AP3 — Section availability count: query GSI1 with `Select = COUNT`
   * (authoritative, eventually consistent) (design AP3; Requirements 3.4, 11.4).
   * Sums `Count` across all pages.
   */
  async countSectionAvailability(section: { venue: string; section: string }): Promise<number> {
    const pk = gsi1PK({ venue: section.venue, section: section.section, row: "", seat: "" });
    let total = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI1_NAME,
          Select: "COUNT",
          KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :prefix)",
          ExpressionAttributeValues: {
            ":pk": pk,
            ":prefix": GSI1SK_AVAILABLE_PREFIX,
          },
          ConsistentRead: false,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      total += res.Count ?? 0;
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return total;
  }

  /**
   * AP4 — Find expired holds for one shard: query GSI2 for
   * `GSI2PK = HOLDS#<shardIndex> AND GSI2SK < now`, KEYS_ONLY projection (design
   * AP4; Requirements 9.2, 11.5). Used by the optional sweeper, which then issues
   * `release` on each returned seat. Paginates across all pages.
   *
   * @param shardIndex the GSI2 shard to sweep (0 .. shardCount-1).
   * @param now current time as epoch seconds.
   */
  async queryExpiredHolds(shardIndex: number, now: number): Promise<ExpiredHoldKey[]> {
    const keys: ExpiredHoldKey[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI2_NAME,
          KeyConditionExpression: "GSI2PK = :pk AND GSI2SK < :now",
          ExpressionAttributeValues: {
            ":pk": gsi2ShardPK(shardIndex),
            ":now": now,
          },
          ConsistentRead: false,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      if (res.Items) {
        keys.push(...(res.Items as ExpiredHoldKey[]));
      }
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return keys;
  }
}
