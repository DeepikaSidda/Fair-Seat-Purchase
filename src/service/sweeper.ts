/**
 * Fair Seat Purchase — active hold sweeper (design: Temporary Hold and
 * Expiration → optional active sweeper).
 *
 * This is a LATENCY / HOUSEKEEPING optimisation, NOT a correctness dependency.
 * The system is already correct without it: every write treats an expired hold
 * as available via condition-at-read-time, and the availability views compute
 * effective status at read time. The sweeper simply flips the *physical*
 * `Seat_Status` of expired `held` seats back to `available` promptly, so the
 * raw table stays tidy and freed seats re-appear in the sparse GSI1 seat map
 * without waiting for the next contended write.
 *
 * How it works (design GSI2, AP4):
 *   - The expired-hold index GSI2 is sharded (`GSI2PK = HOLDS#<0..N-1>`) to
 *     avoid a hot partition, so a full sweep scatter-gathers across all N
 *     shards, querying each for `GSI2SK (= Hold_Expiration) < now` (KEYS_ONLY).
 *   - For each expired key it issues `SeatRepository.releaseExpired`, whose
 *     guard (`Seat_Status = held AND Hold_Expiration <= now`) means a seat that
 *     was re-held or sold in the meantime is left untouched (the write no-ops).
 */

import type { SeatIdentity } from "../seat.js";
import { SHARD_COUNT } from "../aws/ddb-client.js";
import { SeatRepository, type ExpiredHoldKey } from "../aws/seat-repository.js";
import { systemClock, type Clock } from "../transitions.js";

/** Parse a seat identity from its base-table keys (`SEAT#v#s` / `ROW#r#SEAT#n`). */
function identityFromKeys(key: ExpiredHoldKey): SeatIdentity | undefined {
  const pk = key.PK.split("#"); // ["SEAT", venue, section]
  const sk = key.SK.split("#"); // ["ROW", row, "SEAT", seat]
  if (pk.length < 3 || sk.length < 4) return undefined;
  return { venue: pk[1], section: pk[2], row: sk[1], seat: sk[3] };
}

/** Result of one sweep pass. */
export interface SweepResult {
  /** Expired hold keys found across all shards. */
  readonly found: number;
  /** Seats actually flipped back to `available` this pass. */
  readonly released: number;
}

/**
 * Run one sweep across all GSI2 shards, releasing seats whose holds have expired
 * at `now` (epoch seconds). Idempotent and safe to run repeatedly.
 */
export async function runSweep(
  seatRepo: SeatRepository,
  opts: { shardCount?: number; clock?: Clock } = {},
): Promise<SweepResult> {
  const shardCount = opts.shardCount ?? SHARD_COUNT;
  const now = (opts.clock ?? systemClock)();

  let found = 0;
  let released = 0;

  // Scatter-gather across the N shards (design: write sharding → scatter-gather).
  const perShard = await Promise.all(
    Array.from({ length: shardCount }, (_, shard) => seatRepo.queryExpiredHolds(shard, now)),
  );

  for (const keys of perShard) {
    for (const key of keys) {
      found += 1;
      const identity = identityFromKeys(key);
      if (!identity) continue;
      // Guarded conditional write: only releases if STILL expired-and-held.
      if (await seatRepo.releaseExpired(identity, now)) {
        released += 1;
      }
    }
  }

  return { found, released };
}

/** Handle returned by {@link startSweeper} so callers can stop the loop. */
export interface SweeperHandle {
  stop(): void;
}

/**
 * Start a periodic background sweeper. Runs {@link runSweep} every
 * `intervalMs` (default 30s). Errors in a pass are logged and swallowed so the
 * loop keeps running. Returns a handle to stop it.
 */
export function startSweeper(
  seatRepo: SeatRepository,
  opts: { intervalMs?: number; shardCount?: number; clock?: Clock } = {},
): SweeperHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // Skip if the previous pass is still in flight.
    running = true;
    try {
      const { found, released } = await runSweep(seatRepo, opts);
      if (found > 0) {
        // eslint-disable-next-line no-console
        console.log(`[sweeper] expired holds found=${found} released=${released}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[sweeper] pass failed (will retry next interval):", err);
    } finally {
      running = false;
    }
  };

  // Kick off an immediate pass, then schedule the interval.
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // Do not keep the process alive solely for the sweeper.
  if (typeof timer.unref === "function") timer.unref();

  return { stop: () => clearInterval(timer) };
}
