// Feature: fair-seat-purchase, Property 4: At most one concurrent transition commits
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  releaseSeat,
  confirmSeat,
  TransitionRejectedError,
  DEFAULT_HOLD_WINDOW_SECONDS,
  type SeatStatus,
  type SeatIdentity,
  type Seat,
} from "../src/index.js";
import { runConcurrentAttempts, mulberry32 } from "../src/concurrency.js";

/**
 * Property 4: At most one concurrent transition commits.
 *
 * For any single seat targeted by N >= 2 concurrent transition attempts, at most
 * one attempt commits successfully and every other attempt fails (with a
 * conflict / condition failure), leaving the seat in the state produced by the
 * single winner. This is the general guarantee behind sold-exactly-once and
 * fairness: independent of *which* transition kinds contend for the seat, the
 * per-item conditional writes serialize the attempts so no two can both commit.
 *
 * The attempts are modeled as genuine contenders: every attempt guards on the
 * seat's *initial* (contended) state, exactly as concurrent DynamoDB conditional
 * writes are each formed against the observed snapshot. The serialized model
 * (src/concurrency.ts) then applies them one at a time in a seeded-shuffled
 * order — the first enabled attempt flips the state, so every later attempt's
 * guard fails.
 *
 * Validates: Requirements 8.6, 11.8
 */

const NUM_RUNS = 200;

/** Fixed instant + window so seeded holds never expire during a run — isolates
 * the concurrency guarantee from the separate expired-hold-as-available rule. */
const NOW = 1000;
const WINDOW = DEFAULT_HOLD_WINDOW_SECONDS;

const idArb = fc.record<SeatIdentity>({
  venue: fc.string({ minLength: 1, maxLength: 6 }),
  section: fc.string({ minLength: 1, maxLength: 6 }),
  row: fc.string({ minLength: 1, maxLength: 6 }),
  seat: fc.string({ minLength: 1, maxLength: 6 }),
});

/** Snapshot the observable seat fields. */
function snapshot(seat: Seat) {
  return {
    status: seat.Seat_Status,
    holder: seat.Holder_Identifier,
    expiration: seat.Hold_Expiration,
  };
}

/** Seed a seat into `store` already in `status`, held by `holder`. */
function seedSeat(
  store: SeatStore,
  id: SeatIdentity,
  status: SeatStatus,
  holder: string,
): void {
  store.createSeat(id); // starts `available`
  if (status === "available") return;
  holdSeat(store, id, holder, { now: NOW, holdWindowSeconds: WINDOW }); // → held (unexpired)
  if (status === "held") return;
  confirmSeat(store, id, holder); // → sold
}

/**
 * Build N contending attempt thunks against the seat, all guarding on its
 * initial `status` (so they genuinely race), mixing every transition kind that
 * is meaningful from that state:
 *  - available → N distinct fans each racing to hold.
 *  - held      → a mix of confirm(holder) and release, both requiring `held`.
 *  - sold      → a mix of every kind (all must fail; sold is terminal).
 */
function buildContenders(
  store: SeatStore,
  id: SeatIdentity,
  status: SeatStatus,
  holder: string,
  selectors: readonly number[],
): Array<() => Seat> {
  return selectors.map((sel, i) => {
    if (status === "available") {
      const fan = `FAN#${i}`;
      return () => holdSeat(store, id, fan, { now: NOW, holdWindowSeconds: WINDOW });
    }
    if (status === "held") {
      return sel % 2 === 0
        ? () => confirmSeat(store, id, holder)
        : () => releaseSeat(store, id);
    }
    // sold — terminal; every kind must be rejected.
    const fan = `FAN#${i}`;
    if (sel === 0) return () => holdSeat(store, id, fan, { now: NOW, holdWindowSeconds: WINDOW });
    if (sel === 1) return () => releaseSeat(store, id);
    return () => confirmSeat(store, id, holder);
  });
}

describe("Property 4: At most one concurrent transition commits", () => {
  it("commits at most one of N concurrent transitions on a seat; losers fail, seat = winner's state", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SeatStatus>("available", "held", "sold"),
        idArb,
        fc.string({ minLength: 1, maxLength: 8 }), // holder
        // N >= 2 per-attempt kind selectors (0,1,2).
        fc.array(fc.nat(2), { minLength: 2, maxLength: 15 }),
        // Seed driving the serialized application order (models arbitrary contention order).
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (status, id, holder, selectors, seed) => {
          const store = new SeatStore();
          seedSeat(store, id, status, holder);
          const before = snapshot(store.getSeat(id)!);

          const attempts = buildContenders(store, id, status, holder, selectors);
          const summary = runConcurrentAttempts(attempts, { rng: mulberry32(seed) });

          // Core guarantee: at most one attempt commits (Requirements 8.6, 11.8).
          expect(summary.winners).toBeLessThanOrEqual(1);
          expect(summary.results).toHaveLength(selectors.length);
          expect(summary.winners + summary.losers).toBe(selectors.length);

          const after = snapshot(store.getSeat(id)!);

          if (summary.winners === 1) {
            const winner = summary.results.find((r) => r.outcome === "succeeded")!;
            // The seat is left exactly in the state produced by the single winner.
            expect(snapshot(winner.value!)).toEqual(after);

            // Every other attempt is rejected with a defined conflict failure.
            const losers = summary.results.filter((r) => r.outcome !== "succeeded");
            expect(losers).toHaveLength(selectors.length - 1);
            for (const loser of losers) {
              expect(loser.outcome).toBe("rejected");
              expect(loser.error).toBeInstanceOf(TransitionRejectedError);
            }
          } else {
            // Zero winners (terminal `sold` seat): nothing commits, seat unchanged.
            expect(summary.winners).toBe(0);
            expect(after).toEqual(before);
            for (const r of summary.results) {
              expect(r.outcome).toBe("rejected");
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("holds the guarantee at high contention (N up to 10,000) for both available and held seats", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SeatStatus>("available", "held"),
        fc.integer({ min: 2, max: 10_000 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (status, n, seed) => {
          const store = new SeatStore();
          const id: SeatIdentity = { venue: "V", section: "S", row: "R", seat: "1" };
          const holder = "FAN#holder";
          seedSeat(store, id, status, holder);

          // N contenders: distinct-fan holds for available, confirm/release mix for held.
          const selectors = Array.from({ length: n }, (_, i) => i);
          const attempts = buildContenders(store, id, status, holder, selectors);
          const summary = runConcurrentAttempts(attempts, { rng: mulberry32(seed) });

          expect(summary.winners).toBe(1);
          expect(summary.losers).toBe(n - 1);
          const winner = summary.results.find((r) => r.outcome === "succeeded")!;
          expect(snapshot(winner.value!)).toEqual(snapshot(store.getSeat(id)!));
        },
      ),
      { numRuns: 25 },
    );
  });
});
