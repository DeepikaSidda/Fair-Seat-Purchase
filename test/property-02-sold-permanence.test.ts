// Feature: fair-seat-purchase, Property 2: Sold is permanent (monotonicity)
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
  type Seat,
} from "../src/index.js";
import {
  concurrentHolds,
  concurrentConfirms,
  distinctFans,
  repeatFan,
  mulberry32,
} from "../src/concurrency.js";

/**
 * Property 2: Sold is permanent (monotonicity).
 *
 * Once a seat has become `sold`, no subsequent sequence of operations — direct
 * holds/releases/confirms by any fan, concurrent bursts, identical retries, or a
 * simulated system restart — ever moves the seat's status back to `available` or
 * `held`. The status remains exactly `sold` (and its holder is preserved)
 * forever after the sale.
 *
 * `sold` has no outbound transition in any code path (see design.md →
 * Reservation Strategy): `holdSeat` requires the seat to be holdable
 * (available or an expired hold), `releaseSeat` requires `held`, and
 * `confirmSeat` requires `held`. A `sold` seat satisfies none of these guards,
 * so every attempt is rejected with `TransitionRejectedError` and the stored
 * seat is left unchanged.
 *
 * Validates: Requirements 7.6
 */

const NUM_RUNS = 200;

/** Fixed instant used for the initial sale and every follow-up attempt. */
const NOW = 1_000;
const WINDOW = DEFAULT_HOLD_WINDOW_SECONDS;

/** The three invokable transition kinds a fan might attempt after the sale. */
type Kind = "hold" | "release" | "confirm";

/** Arbitrary seat identity with short, non-empty components. */
const identityArb: fc.Arbitrary<SeatIdentity> = fc.record({
  venue: fc.string({ minLength: 1, maxLength: 6 }),
  section: fc.string({ minLength: 1, maxLength: 6 }),
  row: fc.string({ minLength: 1, maxLength: 6 }),
  seat: fc.string({ minLength: 1, maxLength: 6 }),
});

/** Arbitrary fan identifier. */
const fanArb = fc.string({ minLength: 1, maxLength: 8 });

/** A single post-sale operation: a transition kind plus the fan attempting it. */
const operationArb: fc.Arbitrary<{ kind: Kind; fan: string }> = fc.record({
  kind: fc.constantFrom<Kind>("hold", "release", "confirm"),
  fan: fanArb,
});

/** Drive a freshly created seat all the way to `sold`, held/sold by `holder`. */
function sellSeat(store: SeatStore, id: SeatIdentity, holder: string): void {
  store.createSeat(id); // starts `available`
  holdSeat(store, id, holder, { now: NOW, holdWindowSeconds: WINDOW }); // → held
  confirmSeat(store, id, holder); // → sold
}

/** Snapshot the fields relevant to permanence (status + holder). */
function snapshot(seat: Seat) {
  return { status: seat.Seat_Status, holder: seat.Holder_Identifier };
}

/**
 * Invoke a single transition of the given kind against `store`. Any of the three
 * transitions attempted on a `sold` seat must be rejected, so callers wrap this
 * in `expect(...).toThrow(TransitionRejectedError)`.
 */
function invoke(store: SeatStore, id: SeatIdentity, kind: Kind, fan: string): Seat {
  switch (kind) {
    case "hold":
      return holdSeat(store, id, fan, { now: NOW, holdWindowSeconds: WINDOW });
    case "release":
      return releaseSeat(store, id);
    case "confirm":
      return confirmSeat(store, id, fan);
  }
}

/**
 * Simulate a system restart: reconstruct the persisted `sold` seat in a brand
 * new store. The recovered system rebuilds the seat from its durable record
 * (identity + holder) and re-establishes the `sold` state; correctness requires
 * the seat to still be `sold` afterward.
 */
function simulateRestart(soldSeat: Seat): { store: SeatStore; id: SeatIdentity } {
  const id: SeatIdentity = {
    venue: soldSeat.Venue,
    section: soldSeat.Section,
    row: soldSeat.Row,
    seat: soldSeat.Seat_Number,
  };
  const store = new SeatStore();
  sellSeat(store, id, soldSeat.Holder_Identifier!);
  return { store, id };
}

describe("Property 2: Sold is permanent (monotonicity)", () => {
  it("no direct sequence of operations moves a sold seat out of `sold`", () => {
    fc.assert(
      fc.property(
        identityArb,
        fanArb,
        fc.array(operationArb, { minLength: 1, maxLength: 12 }),
        (id, holder, operations) => {
          const store = new SeatStore();
          sellSeat(store, id, holder);

          const sold = snapshot(store.getSeat(id)!);
          expect(sold.status).toBe("sold");

          // Every follow-up operation is rejected and leaves the seat `sold`,
          // with its holder unchanged — status never returns to available/held.
          for (const { kind, fan } of operations) {
            expect(() => invoke(store, id, kind, fan)).toThrow(TransitionRejectedError);
            const after = snapshot(store.getSeat(id)!);
            expect(after).toEqual(sold);
            expect(after.status).toBe("sold");
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("concurrent holds and confirms after the sale produce zero winners and keep the seat `sold`", () => {
    fc.assert(
      fc.property(
        identityArb,
        fanArb,
        // Number of concurrent contenders (2..64 keeps runs fast; the model is
        // O(N) and validated up to 10,000 by Properties 5 and 6).
        fc.integer({ min: 2, max: 64 }),
        // Seed for the deterministic serialization order of the burst.
        fc.integer({ min: 0, max: 0xffffffff }),
        (id, holder, n, seed) => {
          const store = new SeatStore();
          sellSeat(store, id, holder);
          const sold = snapshot(store.getSeat(id)!);

          // A burst of distinct fans all trying to (re)hold the sold seat.
          const holdSummary = concurrentHolds(
            store,
            id,
            distinctFans(n),
            { now: NOW, holdWindowSeconds: WINDOW },
            { rng: mulberry32(seed) },
          );
          expect(holdSummary.winners).toBe(0);
          expect(holdSummary.losers).toBe(n);
          expect(snapshot(store.getSeat(id)!)).toEqual(sold);

          // A burst of confirm retries (all the original holder) on the sold seat.
          const confirmSummary = concurrentConfirms(
            store,
            id,
            repeatFan(holder, n),
            { rng: mulberry32(seed ^ 0x9e3779b9) },
          );
          expect(confirmSummary.winners).toBe(0);
          expect(confirmSummary.losers).toBe(n);
          expect(snapshot(store.getSeat(id)!).status).toBe("sold");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("identical retries of every transition are all rejected, leaving the seat `sold`", () => {
    fc.assert(
      fc.property(
        identityArb,
        fanArb,
        fc.constantFrom<Kind>("hold", "release", "confirm"),
        fc.integer({ min: 1, max: 20 }),
        (id, holder, kind, retries) => {
          const store = new SeatStore();
          sellSeat(store, id, holder);
          const sold = snapshot(store.getSeat(id)!);

          // Retrying the same operation many times (idempotent-retry storm) never
          // succeeds and never disturbs the committed sale.
          for (let i = 0; i < retries; i++) {
            expect(() => invoke(store, id, kind, holder)).toThrow(TransitionRejectedError);
            expect(snapshot(store.getSeat(id)!)).toEqual(sold);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("a simulated restart preserves `sold`, and further operations still cannot undo it", () => {
    fc.assert(
      fc.property(
        identityArb,
        fanArb,
        fc.array(operationArb, { minLength: 0, maxLength: 8 }),
        (id, holder, operations) => {
          const original = new SeatStore();
          sellSeat(original, id, holder);
          const soldSeat = original.getSeat(id)!;

          // After a restart the reconstructed seat is still `sold`.
          const { store: restarted, id: restoredId } = simulateRestart(soldSeat);
          const restored = restarted.getSeat(restoredId)!;
          expect(restored.Seat_Status).toBe("sold");
          expect(restored.Holder_Identifier).toBe(holder);

          const sold = snapshot(restored);

          // Operations issued after the restart are still rejected and the seat
          // remains `sold` — permanence survives the restart boundary.
          for (const { kind, fan } of operations) {
            expect(() => invoke(restarted, restoredId, kind, fan)).toThrow(
              TransitionRejectedError,
            );
            expect(snapshot(restarted.getSeat(restoredId)!)).toEqual(sold);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
