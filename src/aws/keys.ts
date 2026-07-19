/**
 * Fair Seat Purchase — DynamoDB key & GSI attribute helpers.
 *
 * Centralizes construction of the base-table primary key and the two GSI key
 * sets so the repositories build them identically to the reference model and
 * the design's data model (`design.md` → Data Models). Base-table key helpers
 * (`toPK`/`toSK`/`seatKey`) and transaction key helpers (`txnPK`/`txnSK`) are
 * reused from the reference model; this module adds the GSI1/GSI2 attribute
 * builders that the real items carry.
 *
 * - GSI1 (seat map, available seats per section):
 *     `GSI1PK = SECTION#<venue>#<section>`
 *     `GSI1SK = STATUS#available#ROW#<row>#SEAT#<seat>`
 *   Written only while a seat is `available` (sparse index; design GSI1).
 *
 * - GSI2 (expired-hold sweep, sharded):
 *     `GSI2PK = HOLDS#<shard>`  (via `holdsShardKeyForSeat` from `../shard.ts`)
 *     `GSI2SK = Hold_Expiration` (epoch seconds, number)
 *   Written only while a seat is `held` (sparse index; design GSI2).
 */

import type { SeatIdentity } from "../seat.js";
import { toPK, toSK, seatKey } from "../seat.js";
import { holdsShardKeyForSeat } from "../shard.js";
import { txnPK, txnSK } from "../transaction.js";
import { SHARD_COUNT } from "./ddb-client.js";

// Re-export the reused base-table / transaction key helpers so callers have a
// single import surface for all key construction.
export { toPK, toSK, seatKey, txnPK, txnSK };

/** GSI1 partition key: `SECTION#<venue>#<section>` (design GSI1). */
export function gsi1PK(identity: SeatIdentity): string {
  return `SECTION#${identity.venue}#${identity.section}`;
}

/** GSI1 sort key: `STATUS#available#ROW#<row>#SEAT#<seat>` (design GSI1). */
export function gsi1SK(identity: SeatIdentity): string {
  return `STATUS#available#ROW#${identity.row}#SEAT#${identity.seat}`;
}

/** The GSI1 partition-key prefix used by the seat-map `begins_with` query. */
export const GSI1SK_AVAILABLE_PREFIX = "STATUS#available" as const;

/** The GSI1 key attributes a seat carries while `available`. */
export interface Gsi1Attributes {
  readonly GSI1PK: string;
  readonly GSI1SK: string;
}

/** Build the GSI1 attribute set for a seat identity (available seats only). */
export function gsi1Attributes(identity: SeatIdentity): Gsi1Attributes {
  return { GSI1PK: gsi1PK(identity), GSI1SK: gsi1SK(identity) };
}

/**
 * GSI2 partition key: `HOLDS#<shard>` derived from the seat identity via the
 * reference model's sharding scheme (`holdsShardKeyForSeat`, design GSI2).
 */
export function gsi2PK(identity: SeatIdentity, shardCount: number = SHARD_COUNT): string {
  return holdsShardKeyForSeat(identity, shardCount);
}

/** The GSI2 key attributes a seat carries while `held`. */
export interface Gsi2Attributes {
  readonly GSI2PK: string;
  readonly GSI2SK: number;
}

/**
 * Build the GSI2 attribute set for a held seat: the sharded partition key plus
 * `GSI2SK = Hold_Expiration` (epoch seconds) so the sweeper can query
 * `GSI2SK < now` per shard (design GSI2, AP4).
 */
export function gsi2Attributes(
  identity: SeatIdentity,
  holdExpiration: number,
  shardCount: number = SHARD_COUNT,
): Gsi2Attributes {
  return { GSI2PK: gsi2PK(identity, shardCount), GSI2SK: holdExpiration };
}

/** Build the GSI2 partition key for a given shard index (used by the sweeper). */
export function gsi2ShardPK(shardIndex: number): string {
  return `HOLDS#${shardIndex}`;
}
