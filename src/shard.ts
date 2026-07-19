/**
 * Fair Seat Purchase — expired-hold write-sharding key derivation (GSI2).
 *
 * The expired-hold sweep index (GSI2) would be a single hot partition if it
 * were keyed by a constant value (`GSI2PK = "HOLDS"`), because every `held`
 * seat across the whole venue would write to one partition key. To keep any
 * single partition under the DynamoDB throughput ceiling (Requirement 10.1),
 * the design applies write sharding (Requirement 10.2) with the documented
 * scheme (Requirement 10.3):
 *
 *     GSI2PK = "HOLDS#" + (hash(seatId) mod N)
 *
 * where `N` is the shard count (design: Scale and Cost → Hot-partition risk and
 * write sharding; typically 10–50). Holds distribute across N partitions and
 * the sweeper scatter-gathers by querying all N shards for `GSI2SK < now`.
 *
 * This module is intentionally standalone and side-effect free so it can be
 * imported independently by the write path and by the shard-distribution
 * property test (Property 17, task 6.11).
 *
 * Requirements covered:
 * - 10.2 Apply write sharding where an access pattern would concentrate writes.
 * - 10.3 Document/implement the write-sharding scheme deterministically.
 */

import type { SeatIdentity } from "./seat.js";
import { seatKeyString } from "./seat.js";

/**
 * Default shard count. Chosen from the design's suggested 10–50 range; 10 keeps
 * the sweeper's scatter-gather fan-out modest while removing the single-partition
 * write hot spot. Callers may override `N` per deployment.
 */
export const DEFAULT_SHARD_COUNT = 10;

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * Error thrown when an invalid shard count is supplied. `N` must be a positive
 * integer (`N >= 1`) so that `mod N` yields a value in `[0, N)`.
 */
export class InvalidShardCountError extends Error {
  constructor(public readonly value: unknown) {
    super(`Invalid shard count N: ${JSON.stringify(value)}. Expected an integer >= 1.`);
    this.name = "InvalidShardCountError";
  }
}

/**
 * Deterministic FNV-1a 32-bit string hash.
 *
 * FNV-1a is a small, stable, well-distributed non-cryptographic hash. It is
 * fully deterministic (same input → same output) and depends on no runtime
 * state, which is exactly what a stable shard assignment requires.
 *
 * The result is returned as an unsigned 32-bit integer in `[0, 2^32)`.
 */
export function hashString(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // Multiply by the FNV prime using 32-bit overflow arithmetic. Math.imul
    // performs a true 32-bit multiply, and `>>> 0` coerces back to unsigned.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Validate and normalize a shard count, throwing `InvalidShardCountError` if it
 * is not a positive integer.
 */
function assertShardCount(N: number): number {
  if (!Number.isInteger(N) || N < 1) {
    throw new InvalidShardCountError(N);
  }
  return N;
}

/**
 * Compute the shard index for a seat identifier string.
 *
 * Returns `hash(seatId) mod N`, guaranteed to be an integer in the range
 * `[0, N)`. Deterministic: the same `(seatId, N)` always yields the same index
 * (Requirement 10.2, 10.3).
 *
 * @param seatId a stable seat identifier string (see `seatIdString`).
 * @param N the shard count; must be an integer `>= 1`. Defaults to
 *   {@link DEFAULT_SHARD_COUNT}.
 */
export function shardIndex(seatId: string, N: number = DEFAULT_SHARD_COUNT): number {
  assertShardCount(N);
  // Both operands are non-negative (hash is unsigned, N >= 1), so the JS `%`
  // remainder is a non-negative value in [0, N).
  return hashString(seatId) % N;
}

/**
 * Compute the GSI2 partition-key value (`HOLDS#<shardIndex>`) for a seat
 * identifier string, per the design's write-sharding scheme (Requirement 10.3).
 *
 * @param seatId a stable seat identifier string (see `seatIdString`).
 * @param N the shard count; must be an integer `>= 1`. Defaults to
 *   {@link DEFAULT_SHARD_COUNT}.
 */
export function holdsShardKey(seatId: string, N: number = DEFAULT_SHARD_COUNT): string {
  return `HOLDS#${shardIndex(seatId, N)}`;
}

/**
 * Derive a stable seat identifier string from a `SeatIdentity`.
 *
 * This reuses the injective `seatKeyString` composition
 * (`SEAT#v#s|ROW#r#SEAT#n`) so the sharding input is consistent with the base
 * table's primary key and stays stable across the seat's lifetime.
 */
export function seatIdString(identity: SeatIdentity): string {
  return seatKeyString(identity);
}

/**
 * Convenience: compute the GSI2 partition key directly from a `SeatIdentity`,
 * using the canonical {@link seatIdString} as the hash input.
 *
 * @param identity the seat's natural identity.
 * @param N the shard count; must be an integer `>= 1`. Defaults to
 *   {@link DEFAULT_SHARD_COUNT}.
 */
export function holdsShardKeyForSeat(
  identity: SeatIdentity,
  N: number = DEFAULT_SHARD_COUNT,
): string {
  return holdsShardKey(seatIdString(identity), N);
}
