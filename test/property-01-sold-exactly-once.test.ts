// Feature: fair-seat-purchase, Property 1: Sold-exactly-once
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  releaseSeat,
  confirmSeat,
  TransitionRejectedError,
  DEFAULT_HOLD_WINDOW_SECONDS,
  type SeatIdentity,
} from "../src/index.js";
import {
  concurrentHolds,
  concurrentConfirms,
  mulberry32,
} from "../src/concurrency.js";

/**
 * Property 1: Sold-exactly-once.
 *
 * For any seat and ANY sequence of operations against it — holds, releases,
 * confirmations, retries, and interleaved/concurrent batches — the cumulative
 * number of successful transitions of that seat into the `sold` state is at
 * most 1. Equivalently: a seat is transitioned to `sold` at most once
 * (Requirement 7.1), concurrent confirmations resolve to exactly one winner
 * (Requirement 7.4), and every losing confirmation is rejected without
 * disturbing the committed sale (Requirement 7.5).
 *
 * The reference model's guarded `held → sold` write (`confirmSeat`) is the only
 * path into `sold`, and `sold` has no outbound transition, so once sold the seat
 * can never leave `sold`. This test drives arbitrary op sequences and counts, at
 * every step, each time the stored seat's status crosses from a non-`sold` value
 * into `sold`; that count must never exceed 1.
 *
 * Validates: Requirements 7.1, 7.4, 7.5
 */

const NUM_RUNS = 200;

/** Fixed instant so held seats stay unexpired within a run (isolates the
 * sold-exactly-once guarantee from the separate expired-hold-as-available rule). */
const NOW = 1_000;
const WINDOW = DEFAULT_HOLD_WINDOW_SECONDS;

/** A single seat under test; identity is irrelevant to the property. */
const SEAT: SeatIdentity = { venue: "V1", section: "A", row: "1", seat: "7" };

/** Small fan pool so confirms sometimes match the current holder (a real win). */
const FANS = ["FAN#0", "FAN#1", "FAN#2"] as const;
const fanArb = fc.constantFrom(...FANS);

/**
 * A generated operation against the single seat. Each is a real reference-model
 * call; some succeed, some are rejected — exactly as under real contention.
 */
type Op =
  | { readonly kind: "hold"; readonly fan: string }
  | { readonly kind: "release" }
  | { readonly kind: "confirm"; readonly fan: string }
  | { readonly kind: "concurrentHolds"; readonly n: number; readonly seed: number }
  | { readonly kind: "concurrentConfirms"; readonly fans: readonly string[]; readonly seed: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("hold" as const), fan: fanArb }),
  fc.record({ kind: fc.constant("release" as const) }),
  fc.record({ kind: fc.constant("confirm" as const), fan: fanArb }),
  // A burst of N distinct fans racing to hold the seat.
  fc.record({
    kind: fc.constant("concurrentHolds" as const),
    n: fc.integer({ min: 2, max: 32 }),
    seed: fc.integer({ min: 0, max: 0xffffffff }),
  }),
  // A burst of confirm attempts (retries + rivals) racing to sell the seat.
  fc.record({
    kind: fc.constant("concurrentConfirms" as const),
    fans: fc.array(fanArb, { minLength: 2, maxLength: 32 }),
    seed: fc.integer({ min: 0, max: 0xffffffff }),
  }),
);

/**
 * Apply one op to the shared store, ignoring the defined rejection failures
 * (`TransitionRejectedError`) that losing/illegal attempts throw — those leave
 * state unchanged and are exactly what we expect under contention.
 */
function applyOp(store: SeatStore, op: Op): void {
  try {
    switch (op.kind) {
      case "hold":
        holdSeat(store, SEAT, op.fan, { now: NOW, holdWindowSeconds: WINDOW });
        return;
      case "release":
        releaseSeat(store, SEAT);
        return;
      case "confirm":
        confirmSeat(store, SEAT, op.fan);
        return;
      case "concurrentHolds": {
        const fans = Array.from({ length: op.n }, (_, i) => `RIVAL#${i}`);
        concurrentHolds(store, SEAT, fans, { now: NOW, holdWindowSeconds: WINDOW }, {
          rng: mulberry32(op.seed),
        });
        return;
      }
      case "concurrentConfirms":
        concurrentConfirms(store, SEAT, op.fans, { rng: mulberry32(op.seed) });
        return;
    }
  } catch (err) {
    // Only the defined guarded-rejection failure is expected; anything else is a
    // real bug and should surface the test.
    if (!(err instanceof TransitionRejectedError)) {
      throw err;
    }
  }
}

/**
 * Run a sequence of ops against a fresh seat, returning the cumulative number of
 * times the stored seat transitioned from a non-`sold` status into `sold`.
 */
function countSoldTransitions(ops: readonly Op[]): number {
  const store = new SeatStore();
  store.createSeat(SEAT); // starts `available`

  let soldTransitions = 0;
  let wasSold = false; // seat starts `available`

  for (const op of ops) {
    applyOp(store, op);
    const nowSold = store.getSeat(SEAT)!.Seat_Status === "sold";
    if (nowSold && !wasSold) {
      soldTransitions += 1;
    }
    // Once observed sold it must remain sold (no outbound transition); if it
    // ever left `sold`, a later re-entry would (correctly) be counted again.
    wasSold = nowSold;
  }

  return soldTransitions;
}

describe("Property 1: Sold-exactly-once", () => {
  it("any op sequence yields at most one successful transition into `sold`", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
        expect(countSoldTransitions(ops)).toBeLessThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("once `sold`, the seat never leaves `sold` for the rest of any op sequence (7.6 support)", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
        const store = new SeatStore();
        store.createSeat(SEAT);
        let everSold = false;
        for (const op of ops) {
          applyOp(store, op);
          const status = store.getSeat(SEAT)!.Seat_Status;
          if (status === "sold") everSold = true;
          // Sold is a terminal, permanent state.
          if (everSold) expect(status).toBe("sold");
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("N concurrent confirmations of a held seat resolve to exactly one winner (7.4, 7.5)", () => {
    fc.assert(
      fc.property(
        // N contenders, a mix of the true holder (retries) and rivals.
        fc.integer({ min: 2, max: 64 }),
        // How many of the N attempts are the true holder vs. rivals.
        fc.integer({ min: 0, max: 64 }),
        fc.integer({ min: 0, max: 0xffffffff }),
        (n, holderCount, seed) => {
          const holder = FANS[0];
          const store = new SeatStore();
          store.createSeat(SEAT);
          holdSeat(store, SEAT, holder, { now: NOW, holdWindowSeconds: WINDOW });

          // Build N confirm attempts: the first `min(holderCount, n)` are the
          // real holder (duplicate submissions / retries), the rest are rivals
          // whose holder guard will fail.
          const holders = Math.min(holderCount, n);
          const fans = Array.from({ length: n }, (_, i) =>
            i < holders ? holder : `RIVAL#${i}`,
          );

          const summary = concurrentConfirms(store, SEAT, fans, {
            rng: mulberry32(seed),
          });

          // Exactly one winner iff the true holder is among the contenders;
          // never more than one, regardless of ordering (7.4).
          const expectedWinners = holders > 0 ? 1 : 0;
          expect(summary.winners).toBe(expectedWinners);
          expect(summary.losers).toBe(n - expectedWinners);

          // Every loser is rejected without rolling back the winner (7.5): the
          // seat is `sold` iff there was a winner, and stays that way.
          const finalStatus = store.getSeat(SEAT)!.Seat_Status;
          expect(finalStatus).toBe(expectedWinners === 1 ? "sold" : "held");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("scales to a large concurrent-confirmation burst (up to 10,000) with a single winner", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10_000 }),
        fc.integer({ min: 0, max: 0xffffffff }),
        (n, seed) => {
          const holder = FANS[0];
          const store = new SeatStore();
          store.createSeat(SEAT);
          holdSeat(store, SEAT, holder, { now: NOW, holdWindowSeconds: WINDOW });

          // All N attempts are the holder retrying/duplicate-submitting: exactly
          // one flips `held → sold`, the remaining N-1 fail the `held` guard.
          const fans = new Array<string>(n).fill(holder);
          const summary = concurrentConfirms(store, SEAT, fans, {
            rng: mulberry32(seed),
          });

          expect(summary.winners).toBe(1);
          expect(summary.losers).toBe(n - 1);
          expect(store.getSeat(SEAT)!.Seat_Status).toBe("sold");
        },
      ),
      { numRuns: 20 },
    );
  });
});
