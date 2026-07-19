// Feature: fair-seat-purchase, Property 5: Concurrent holds resolve to exactly one winner
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  DEFAULT_HOLD_WINDOW_SECONDS,
  type SeatIdentity,
} from "../src/index.js";
import {
  concurrentHolds,
  distinctFans,
  mulberry32,
} from "../src/concurrency.js";

/**
 * Property 5: Concurrent holds resolve to exactly one winner.
 *
 * For any `available` seat targeted by N >= 2 concurrent hold attempts, exactly
 * one attempt transitions the seat to `held` and every other attempt is
 * rejected with a "seat not available" failure (the guarded `available->held`
 * conditional write fails) and makes no change to the seat. The final stored
 * seat reflects only the single winning hold: held by the winning fan with a
 * fresh Hold_Expiration = now + window.
 *
 * Concurrency levels are generated from 2 up to at least 10,000 contenders, and
 * a seeded, unbiased shuffle drives the serialized application order so *which*
 * attempt wins varies while *how many* win stays exactly one.
 *
 * **Validates: Requirements 4.7, 7.2, 7.3**
 */
describe("Property 5: Concurrent holds resolve to exactly one winner", () => {
  const identityArb: fc.Arbitrary<SeatIdentity> = fc.record({
    venue: fc.string({ minLength: 1, maxLength: 6 }),
    section: fc.string({ minLength: 1, maxLength: 6 }),
    row: fc.string({ minLength: 1, maxLength: 6 }),
    seat: fc.string({ minLength: 1, maxLength: 6 }),
  });

  /** The loser rejection reason surfaced by the guarded hold ("seat not available"). */
  const SEAT_NOT_AVAILABLE = "available->held:guard-mismatch";

  /**
   * Assert the exactly-one-winner invariant for `n` fans contending for a
   * single available seat, with the serialized order driven by `seed`.
   */
  function assertOneWinner(
    identity: SeatIdentity,
    n: number,
    now: number,
    window: number,
    seed: number,
  ): void {
    const store = new SeatStore();
    store.createSeat(identity); // starts `available`

    const fans = distinctFans(n, "FAN#"); // N distinct contenders
    const summary = concurrentHolds(
      store,
      identity,
      fans,
      { now, holdWindowSeconds: window },
      { rng: mulberry32(seed) }, // reproducible shuffled contention order
    );

    // Exactly one winner, N-1 losers.
    expect(summary.winners).toBe(1);
    expect(summary.losers).toBe(n - 1);
    expect(summary.results.length).toBe(n);

    const winners = summary.results.filter((r) => r.outcome === "succeeded");
    const losers = summary.results.filter((r) => r.outcome === "rejected");
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(n - 1);

    // The single winner transitioned the seat to `held` for its own fan.
    const winner = winners[0];
    const winningFan = fans[winner.index];
    expect(winner.value?.Seat_Status).toBe("held");
    expect(winner.value?.Holder_Identifier).toBe(winningFan);
    expect(winner.value?.Hold_Expiration).toBe(now + window);

    // Every loser was rejected with a "seat not available" guard failure.
    for (const loser of losers) {
      expect(loser.reason).toBe(SEAT_NOT_AVAILABLE);
      expect(loser.value).toBeUndefined();
    }

    // The seat reflects exactly the winning hold and nothing else: losers made
    // no change to the seat (Requirement 7.3).
    const finalSeat = store.getSeat(identity)!;
    expect(finalSeat.Seat_Status).toBe("held");
    expect(finalSeat.Holder_Identifier).toBe(winningFan);
    expect(finalSeat.Hold_Expiration).toBe(now + window);
  }

  it("grants exactly one hold and rejects the rest for N in [2, 10000] contenders", () => {
    fc.assert(
      fc.property(
        identityArb,
        // N contenders from 2 up to at least 10,000.
        fc.integer({ min: 2, max: 10_000 }),
        fc.integer({ min: 0, max: 2_000_000_000 }), // now (epoch seconds)
        fc.integer({ min: 60, max: 1800 }), // hold window seconds
        fc.integer({ min: 0, max: 0xffffffff }), // shuffle seed
        (identity, n, now, window, seed) => {
          assertOneWinner(identity, n, now, window, seed);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("holds the exactly-one-winner invariant at the 10,000-contender boundary", () => {
    // Deterministic check that the upper concurrency bound resolves cleanly.
    assertOneWinner(
      { venue: "VENUE1", section: "A", row: "1", seat: "1" },
      10_000,
      1_000,
      DEFAULT_HOLD_WINDOW_SECONDS,
      0x5eed,
    );
  });
});
