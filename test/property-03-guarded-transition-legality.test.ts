// Feature: fair-seat-purchase, Property 3: Guarded transition legality
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  releaseSeat,
  confirmSeat,
  isPermittedTransition,
  PERMITTED_TRANSITIONS,
  TransitionRejectedError,
  DEFAULT_HOLD_WINDOW_SECONDS,
  type SeatStatus,
  type SeatIdentity,
  type Seat,
} from "../src/index.js";

/**
 * Property 3: Guarded transition legality.
 *
 * For any seat in any status and any requested transition, the transition is
 * applied iff (a) it is one of the three permitted transitions
 * (available→held, held→sold, held→available) AND (b) the seat's current status
 * equals the transition's required source status; otherwise the request is
 * rejected and the seat's status, holder, and expiration are left unchanged.
 *
 * Validates: Requirements 4.1, 4.6, 6.1, 6.2, 6.4, 6.7, 6.8, 8.1, 8.3, 8.4, 8.5, 11.9
 */

const NUM_RUNS = 200;

/** Fixed instant for setup + attempts, so held seats stay unexpired (isolates
 * status-based legality from the separate expired-hold-as-available rule). */
const NOW = 1000;
const WINDOW = DEFAULT_HOLD_WINDOW_SECONDS;

/** The three seat statuses. */
const STATUSES: readonly SeatStatus[] = ["available", "held", "sold"];

/** The three invokable transitions and the source status each requires. */
type Kind = "hold" | "release" | "confirm";
const REQUIRED_SOURCE: Record<Kind, SeatStatus> = {
  hold: "available", // available → held
  release: "held", //   held → available
  confirm: "held", //   held → sold
};

/** Build a seat in the store already in the requested status, held by `holder`. */
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

/** Snapshot the guard-relevant fields (status, holder, expiration). */
function snapshot(seat: Seat) {
  return {
    status: seat.Seat_Status,
    holder: seat.Holder_Identifier,
    expiration: seat.Hold_Expiration,
  };
}

describe("Property 3: Guarded transition legality", () => {
  it("(a) exactly the three documented transitions are permitted; all others are not", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SeatStatus>(...STATUSES),
        fc.constantFrom<SeatStatus>(...STATUSES),
        (from, to) => {
          const expected =
            (from === "available" && to === "held") ||
            (from === "held" && to === "sold") ||
            (from === "held" && to === "available");
          expect(isPermittedTransition(from, to)).toBe(expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );

    // The permitted set is exactly the three documented transitions.
    expect(new Set(PERMITTED_TRANSITIONS)).toEqual(
      new Set(["available->held", "held->sold", "held->available"]),
    );
  });

  it("(a)+(b) applies a transition iff permitted AND current status matches its source; otherwise rejects unchanged", () => {
    fc.assert(
      fc.property(
        // Arbitrary starting seat state.
        fc.constantFrom<SeatStatus>(...STATUSES),
        // Arbitrary requested transition (each maps to a required source status).
        fc.constantFrom<Kind>("hold", "release", "confirm"),
        // Seat identity + holder + the new fan requesting a hold.
        fc.record({
          venue: fc.string({ minLength: 1, maxLength: 6 }),
          section: fc.string({ minLength: 1, maxLength: 6 }),
          row: fc.string({ minLength: 1, maxLength: 6 }),
          seat: fc.string({ minLength: 1, maxLength: 6 }),
        }),
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        (status, kind, id, holder, newFan) => {
          const store = new SeatStore();
          seedSeat(store, id, status, holder);

          const before = snapshot(store.getSeat(id)!);
          // The transition is legal iff the seat's current status equals the
          // required source status of the requested (permitted) transition.
          const shouldApply = status === REQUIRED_SOURCE[kind];

          const invoke = (): Seat => {
            switch (kind) {
              case "hold":
                return holdSeat(store, id, newFan, { now: NOW, holdWindowSeconds: WINDOW });
              case "release":
                return releaseSeat(store, id);
              case "confirm":
                // Pass the seat's holder so status is the deciding guard.
                return confirmSeat(store, id, holder);
            }
          };

          if (shouldApply) {
            const result = invoke();
            const after = snapshot(store.getSeat(id)!);
            // Persisted state equals returned state.
            expect(snapshot(result)).toEqual(after);

            if (kind === "hold") {
              expect(after.status).toBe("held");
              expect(after.holder).toBe(newFan);
              expect(after.expiration).toBe(NOW + WINDOW);
            } else if (kind === "release") {
              expect(after.status).toBe("available");
              expect(after.holder).toBeUndefined();
              expect(after.expiration).toBeUndefined();
            } else {
              expect(after.status).toBe("sold");
              // Confirm leaves holder + expiration untouched.
              expect(after.holder).toBe(before.holder);
              expect(after.expiration).toBe(before.expiration);
            }
          } else {
            // Illegal (status-mismatch) request: rejected, seat unchanged.
            expect(invoke).toThrow(TransitionRejectedError);
            const after = snapshot(store.getSeat(id)!);
            expect(after).toEqual(before);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
