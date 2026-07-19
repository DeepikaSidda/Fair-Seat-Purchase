// Feature: fair-seat-purchase, Property 6: Concurrent confirmations resolve to exactly one winner
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  DEFAULT_HOLD_WINDOW_SECONDS,
  type SeatIdentity,
} from "../src/index.js";
import {
  concurrentConfirms,
  mulberry32,
  repeatFan,
} from "../src/concurrency.js";

/**
 * Property 6: Concurrent confirmations resolve to exactly one winner.
 *
 * For any `held` seat targeted by N ≥ 2 concurrent confirmation attempts, the
 * serialized conditional-write model transitions the seat to `sold` for exactly
 * one attempt and rejects every other attempt, while the winner's `sold`
 * transition is never rolled back. This mirrors DynamoDB evaluating the
 * `held → sold` conditional write one attempt at a time on the seat item's
 * storage node: the first flips `held → sold`, and every later attempt fails
 * the `Seat_Status = held` guard because `sold` has no outbound transition.
 *
 * Validates: Requirements 7.4, 7.5
 */

const NUM_RUNS = 120;

/** Fixed instant so the hold stays unexpired for every confirm attempt. */
const NOW = 1000;
const WINDOW = DEFAULT_HOLD_WINDOW_SECONDS;

/** Arbitrary seat identity (non-empty components). */
const identityArb: fc.Arbitrary<SeatIdentity> = fc.record({
  venue: fc.string({ minLength: 1, maxLength: 6 }),
  section: fc.string({ minLength: 1, maxLength: 6 }),
  row: fc.string({ minLength: 1, maxLength: 6 }),
  seat: fc.string({ minLength: 1, maxLength: 6 }),
});

/** Seed a store with one seat already `held` by `holder` at a fixed instant. */
function seedHeldSeat(id: SeatIdentity, holder: string): SeatStore {
  const store = new SeatStore();
  store.createSeat(id); // starts `available`
  holdSeat(store, id, holder, { now: NOW, holdWindowSeconds: WINDOW }); // → held, unexpired
  return store;
}

describe("Property 6: Concurrent confirmations resolve to exactly one winner", () => {
  it("N≥2 concurrent confirms of one held seat → exactly one sold, rest rejected, winner not rolled back", () => {
    fc.assert(
      fc.property(
        identityArb,
        fc.string({ minLength: 1, maxLength: 8 }), // the seat's holder
        // N contenders from 2 up to at least 10,000. Weighted toward smaller
        // levels for speed while still sampling large bursts (the 10,000 upper
        // bound is additionally pinned by the explicit `examples` below).
        fc.oneof(
          { weight: 8, arbitrary: fc.integer({ min: 2, max: 100 }) },
          { weight: 3, arbitrary: fc.integer({ min: 101, max: 2_000 }) },
          { weight: 1, arbitrary: fc.integer({ min: 2_001, max: 10_000 }) },
        ),
        // Seed driving the serialized application order (which attempt runs first).
        fc.integer({ min: 0, max: 0xffffffff }),
        (id, holder, n, seed) => {
          const store = seedHeldSeat(id, holder);

          // N indistinguishable confirmation attempts by the holder (retries /
          // duplicate submissions across service instances contending for the
          // same held seat), applied in a seeded, shuffled serialized order.
          const summary = concurrentConfirms(store, id, repeatFan(holder, n), {
            rng: mulberry32(seed),
          });

          // (7.4) Exactly one attempt transitions the seat to `sold`.
          expect(summary.winners).toBe(1);
          // (7.5) Every other attempt is rejected.
          expect(summary.losers).toBe(n - 1);
          expect(summary.results).toHaveLength(n);

          const winners = summary.results.filter((r) => r.outcome === "succeeded");
          expect(winners).toHaveLength(1);
          // The winning attempt observed the `sold` transition it applied.
          expect(winners[0].value?.Seat_Status).toBe("sold");

          // (7.5) Losers are rejected via the seat guard (seat already `sold`,
          // which has no outbound transition) and made no state change.
          for (const r of summary.results) {
            if (r.outcome === "rejected") {
              expect(r.reason).toBe("held->sold:guard-mismatch");
            }
          }

          // (7.5) The winner's `sold` transition is not rolled back: the stored
          // seat is `sold`, the holder is preserved, and exactly one confirm
          // (Version: available→held→sold = 2) was committed.
          const finalSeat = store.getSeat(id)!;
          expect(finalSeat.Seat_Status).toBe("sold");
          expect(finalSeat.Holder_Identifier).toBe(holder);
          expect(finalSeat.Version).toBe(2);
        },
      ),
      {
        numRuns: NUM_RUNS,
        // Guarantee the boundary and the upper concurrency bound are exercised.
        examples: [
          [{ venue: "v", section: "s", row: "r", seat: "1" }, "FAN#alice", 2, 1],
          [{ venue: "v", section: "s", row: "r", seat: "1" }, "FAN#alice", 10_000, 7],
        ],
      },
    );
  });
});
