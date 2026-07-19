/**
 * Fair Seat Purchase — LIVE DynamoDB integration tests.
 *
 * These tests exercise the REAL data-access layer (`SeatRepository`,
 * `TransactionRepository`) and `TicketingService` against a running DynamoDB
 * Local instance, so the design's conditional-write correctness (hold races,
 * atomic confirm, expired-hold rejection, seat-map/count views) is validated
 * end-to-end against the actual database — not just the in-memory reference
 * model.
 *
 * SKIP-WHEN-NO-DB CONTRACT
 * ------------------------
 * The whole suite is gated on `FSP_DDB_ENDPOINT` (e.g. `http://localhost:8000`).
 * When it is unset — the normal `npm test` / CI case, which has no database —
 * the entire suite is skipped via `describe.skipIf`, keeping those runs green.
 * A console note is printed so the skip is visible in the log.
 *
 * To run these locally:
 *   1. Start DynamoDB Local (see docs/RUN_LOCAL.md), e.g. on port 8000.
 *   2. `set FSP_DDB_ENDPOINT=http://localhost:8000` (Windows) /
 *      `export FSP_DDB_ENDPOINT=http://localhost:8000` (bash).
 *   3. `npm run test:integration`.
 *
 * Each enabled run provisions its own uniquely-named table in `beforeAll` (via
 * the shared `createTable` routine from `scripts/create-table.ts`) and deletes
 * it in `afterAll`, so runs are isolated and self-cleaning.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DeleteTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { createTable } from "../../scripts/create-table.js";
import {
  createDocumentClient,
  createDynamoDBClient,
} from "../../src/aws/ddb-client.js";
import {
  SeatConfirmationRejectedError,
  SeatNotAvailableError,
  SeatRepository,
} from "../../src/aws/seat-repository.js";
import { TransactionRepository } from "../../src/aws/transaction-repository.js";
import { TicketingService } from "../../src/service/ticketing-service.js";
import { seatKeyString, type SeatIdentity } from "../../src/seat.js";

/** Run the suite only when a DynamoDB Local endpoint is configured. */
const run = !!process.env.FSP_DDB_ENDPOINT;

if (!run) {
  // Visible note so it is obvious WHY this suite did nothing in a no-DB run.
  console.info(
    "[ddb-live.integration] FSP_DDB_ENDPOINT not set — skipping live DynamoDB " +
      "integration tests. Start DynamoDB Local and set FSP_DDB_ENDPOINT " +
      "(e.g. http://localhost:8000) to run them (see docs/RUN_LOCAL.md).",
  );
}

// A unique table per run so concurrent/repeated runs never collide.
const TEST_TABLE_NAME = `FairSeatPurchase-test-${randomUUID().slice(0, 8)}`;

describe.skipIf(!run)("live DynamoDB integration", () => {
  let lowLevel: DynamoDBClient;
  let doc: DynamoDBDocumentClient;
  let seatRepo: SeatRepository;
  let txnRepo: TransactionRepository;

  // A controllable clock (epoch seconds) so hold-expiration is deterministic.
  let nowSeconds = 1_000_000;
  const clock = () => nowSeconds;
  const HOLD_WINDOW = 60;
  let service: TicketingService;

  beforeAll(async () => {
    lowLevel = createDynamoDBClient();
    doc = createDocumentClient(lowLevel);

    // Provision the isolated test table using the SAME CreateTable logic as the
    // CLI (`npm run db:create`), then wire repositories/service at that table.
    await createTable(lowLevel, TEST_TABLE_NAME);

    seatRepo = new SeatRepository(doc, TEST_TABLE_NAME);
    txnRepo = new TransactionRepository(doc, TEST_TABLE_NAME);
    service = new TicketingService(seatRepo, txnRepo, {
      clock,
      holdWindow: HOLD_WINDOW,
    });
  }, 120_000);

  afterAll(async () => {
    if (lowLevel) {
      await lowLevel.send(new DeleteTableCommand({ TableName: TEST_TABLE_NAME }));
    }
  }, 120_000);

  it("createSeat then getSeat returns an available seat", async () => {
    const identity: SeatIdentity = { venue: "V", section: "CREATE", row: "1", seat: "1" };
    await seatRepo.createSeat(identity);

    const seat = await seatRepo.getSeat(identity);
    expect(seat).toBeDefined();
    expect(seat?.Seat_Status).toBe("available");
    expect(seat?.Venue).toBe("V");
    expect(seat?.Section).toBe("CREATE");
  });

  it("hold makes the seat held; a second concurrent hold loses (exactly one winner)", async () => {
    const identity: SeatIdentity = { venue: "V", section: "HOLD", row: "1", seat: "1" };
    await seatRepo.createSeat(identity);

    const at = 2_000;
    const held = await seatRepo.hold(identity, "fan-winner", HOLD_WINDOW, at);
    expect(held.Seat_Status).toBe("held");
    expect(held.Holder_Identifier).toBe("fan-winner");
    expect(held.Hold_Expiration).toBe(at + HOLD_WINDOW);

    // Second hold on the still-live hold must be rejected by the DB condition.
    await expect(
      seatRepo.hold(identity, "fan-loser", HOLD_WINDOW, at),
    ).rejects.toBeInstanceOf(SeatNotAvailableError);

    // Persisted holder is still the winner — the loser changed nothing.
    const after = await seatRepo.getSeat(identity);
    expect(after?.Holder_Identifier).toBe("fan-winner");
  });

  it("release returns the seat to available and it reappears in the seat map", async () => {
    const identity: SeatIdentity = { venue: "V", section: "RELEASE", row: "1", seat: "1" };
    await seatRepo.createSeat(identity);
    await seatRepo.hold(identity, "fan-1", HOLD_WINDOW, 3_000);

    // Held seats drop out of the (sparse) GSI1 seat map.
    const mapWhileHeld = await seatRepo.querySeatMap({ venue: "V", section: "RELEASE" });
    expect(mapWhileHeld).toHaveLength(0);

    const released = await seatRepo.release(identity);
    expect(released.Seat_Status).toBe("available");
    expect(released.Holder_Identifier).toBeUndefined();

    const seat = await seatRepo.getSeat(identity);
    expect(seat?.Seat_Status).toBe("available");

    const mapAfterRelease = await seatRepo.querySeatMap({ venue: "V", section: "RELEASE" });
    expect(mapAfterRelease.map((e) => e.SK)).toContain("ROW#1#SEAT#1");
  });

  it("happy path: holdSeat → pay(success) → seat sold and transaction confirmed", async () => {
    const identity: SeatIdentity = { venue: "V", section: "HAPPY", row: "1", seat: "1" };
    await seatRepo.createSeat(identity);

    nowSeconds = 4_000;
    const held = await service.holdSeat({ ...identity, fanId: "fan-buyer" });
    expect(held.txnId).toBeTruthy();
    expect(held.holdExpiration).toBe(nowSeconds + HOLD_WINDOW);

    // Pay well within the hold window.
    nowSeconds = 4_010;
    const result = await service.pay({
      ...identity,
      fanId: "fan-buyer",
      txnId: held.txnId,
      processorResult: "success",
    });

    expect(result.outcome).toBe("confirmed");
    expect(result.seat.Seat_Status).toBe("sold");
    expect(result.transaction.Payment_Status).toBe("paid");
    expect(result.transaction.Txn_State).toBe("confirmed");
    expect(result.transaction.Confirmation_Timestamp).toBeDefined();
    // Timestamp is a valid UTC ISO-8601 instant.
    expect(Number.isNaN(Date.parse(result.transaction.Confirmation_Timestamp!))).toBe(false);
  });

  it("confirm on an expired hold is rejected (SeatConfirmationRejectedError)", async () => {
    const identity: SeatIdentity = { venue: "V", section: "EXPIRED", row: "1", seat: "1" };
    await seatRepo.createSeat(identity);

    const heldAt = 5_000;
    await seatRepo.hold(identity, "fan-1", HOLD_WINDOW, heldAt);

    const fanId = "fan-1";
    const txnId = randomUUID();
    await txnRepo.createTransaction({
      fanId,
      txnId,
      seatRef: seatKeyString(identity),
    });
    await txnRepo.markPaid(fanId, txnId);

    // "now" is past Hold_Expiration (heldAt + window), so the seat guard
    // (Hold_Expiration > now) fails and the whole transaction is canceled.
    const expiredNow = heldAt + HOLD_WINDOW + 100;
    await expect(
      seatRepo.confirm(identity, fanId, txnId, expiredNow),
    ).rejects.toBeInstanceOf(SeatConfirmationRejectedError);

    // Nothing was captured: the seat is still held, the txn still paid.
    const seat = await seatRepo.getSeat(identity);
    expect(seat?.Seat_Status).toBe("held");
    const txn = await txnRepo.getTransaction(fanId, txnId);
    expect(txn?.Txn_State).toBe("pending");
    expect(txn?.Payment_Status).toBe("paid");
  });

  it("querySeatMap and countSectionAvailability reflect seeded available seats", async () => {
    const section = { venue: "V", section: "COUNT" };
    const seatNums = ["1", "2", "3"];
    for (const seat of seatNums) {
      await seatRepo.createSeat({ ...section, row: "1", seat });
    }

    const count = await seatRepo.countSectionAvailability(section);
    expect(count).toBe(seatNums.length);

    const map = await seatRepo.querySeatMap(section);
    expect(map).toHaveLength(seatNums.length);
    for (const entry of map) {
      expect(entry.Seat_Status).toBe("available");
    }

    // Holding one seat drops it from both the map and the count.
    await seatRepo.hold({ ...section, row: "1", seat: "1" }, "fan-x", HOLD_WINDOW, 6_000);
    expect(await seatRepo.countSectionAvailability(section)).toBe(seatNums.length - 1);
    expect(await seatRepo.querySeatMap(section)).toHaveLength(seatNums.length - 1);
  });
});
