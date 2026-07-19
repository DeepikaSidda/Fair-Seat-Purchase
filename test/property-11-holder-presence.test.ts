// Feature: fair-seat-purchase, Property 11: Holder presence invariant
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  releaseSeat,
  confirmSeat,
  TransitionRejectedError,
  DEFAULT_HOLD_WINDOW_SECONDS,
  type Seat,
  type SeatIdentity,
} from "../src/index.js";

/**
 * Property 11: Holder presence invariant.
 *
 * For any seat reachable through any sequence of operations
 * (create / hold / release / confirm), the following invariant holds after
 * every step:
 *   - whenever its status is `held` or `sold` it has a non-empty
 *     Holder_Identifier (Requirement 1.7); and
 *   - whenever its status is `available` it has no Holder_Identifier and no
 *     Hold_Expiration (Requirement 6.6).
 *
 * The test drives randomized operation sequences against the reference store,
 * tolerating the guarded-transition rejections that occur when an operation is
 * not legal from the current state, and asserts the invariant after each step
 * regardless of whether the operation succeeded or was rejected.
 *
 * **Validates: Requirements 1.7, 6.6**
 */
describe("Property 11: Holder presence invariant", () => {
  const NUM_RUNS = 200;
  const WINDOW = DEFAULT_HOLD_WINDOW_SECONDS;

  /** A small pool of distinct, non-empty fan identifiers to contend for a seat. */
  const FANS = ["fan-alice", "fan-bob", "fan-carol"] as const;

  const identityArb: fc.Arbitrary<SeatIdentity> = fc.record({
    venue: fc.string({ minLength: 1, maxLength: 6 }),
    section: fc.string({ minLength: 1, maxLength: 6 }),
    row: fc.string({ minLength: 1, maxLength: 6 }),
    seat: fc.string({ minLength: 1, maxLength: 6 }),
  });

  /** One randomized operation applied to the seat. */
  type Op =
    | { kind: "hold"; fan: string }
    | { kind: "release" }
    | { kind: "confirm"; fan: string }
    | { kind: "advance"; seconds: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant("hold" as const), fan: fc.constantFrom(...FANS) }),
    fc.record({ kind: fc.constant("release" as const) }),
    fc.record({ kind: fc.constant("confirm" as const), fan: fc.constantFrom(...FANS) }),
    // Advancing the clock lets holds expire, so later holds/confirms exercise
    // the expired-hold-as-available path as well.
    fc.record({
      kind: fc.constant("advance" as const),
      seconds: fc.integer({ min: 0, max: 2 * WINDOW }),
    }),
  );

  /** Assert the holder-presence invariant for the current stored seat state. */
  function assertHolderPresenceInvariant(seat: Seat): void {
    if (seat.Seat_Status === "held" || seat.Seat_Status === "sold") {
      // held/sold ⇒ non-empty Holder_Identifier (Requirement 1.7).
      expect(typeof seat.Holder_Identifier).toBe("string");
      expect((seat.Holder_Identifier ?? "").length).toBeGreaterThan(0);
    } else {
      // available ⇒ no holder and no hold expiration (Requirement 6.6).
      expect(seat.Seat_Status).toBe("available");
      expect(seat.Holder_Identifier).toBeUndefined();
      expect(seat.Hold_Expiration).toBeUndefined();
    }
  }

  it("holds the holder-presence invariant after every operation in any sequence", () => {
    fc.assert(
      fc.property(
        identityArb,
        fc.array(opArb, { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 0, max: 2_000_000_000 }), // initial `now` (epoch seconds)
        (identity, ops, startNow) => {
          const store = new SeatStore();

          // create ⇒ seat starts `available` with no holder/expiration.
          store.createSeat(identity);
          assertHolderPresenceInvariant(store.getSeat(identity)!);

          let now = startNow;

          for (const op of ops) {
            try {
              switch (op.kind) {
                case "hold":
                  holdSeat(store, identity, op.fan, { now, holdWindowSeconds: WINDOW });
                  break;
                case "release":
                  releaseSeat(store, identity);
                  break;
                case "confirm":
                  confirmSeat(store, identity, op.fan);
                  break;
                case "advance":
                  now += op.seconds;
                  break;
              }
            } catch (err) {
              // Guarded transitions legitimately reject illegal operations
              // (e.g. holding a held seat, confirming with a non-holder). The
              // invariant must still hold on the unchanged seat.
              if (!(err instanceof TransitionRejectedError)) {
                throw err;
              }
            }

            // Invariant must hold after every step, success or rejection.
            assertHolderPresenceInvariant(store.getSeat(identity)!);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
