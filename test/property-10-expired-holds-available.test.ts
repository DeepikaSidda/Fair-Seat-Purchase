// Feature: fair-seat-purchase, Property 10: Expired holds are treated as available at read and write time
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  releaseSeat,
  isEffectiveAvailable,
  seatMap,
  TransitionRejectedError,
  type SeatIdentity,
} from "../src/index.js";

/**
 * Property 10: Expired holds are treated as available at read and write time
 *
 * For any seat physically `held` but whose Hold_Expiration is at or before the
 * current time, a subsequent hold attempt succeeds (the seat is grabbable) and
 * availability views treat the seat as available, regardless of background
 * cleanup; upon release the Holder_Identifier and Hold_Expiration are cleared.
 * Conversely, while the hold is still active a different fan's hold is rejected
 * and the seat is left unchanged.
 *
 * **Validates: Requirements 1.6, 6.5, 6.6, 9.6**
 */
describe("Property 10: Expired holds are treated as available at read and write time", () => {
  // Hold window bounds mirror MIN/MAX_HOLD_WINDOW_SECONDS from the design.
  const holdWindow = fc.integer({ min: 60, max: 1800 });

  const identityArb: fc.Arbitrary<SeatIdentity> = fc.record({
    venue: fc.string({ minLength: 1, maxLength: 6 }),
    section: fc.string({ minLength: 1, maxLength: 6 }),
    row: fc.string({ minLength: 1, maxLength: 6 }),
    seat: fc.string({ minLength: 1, maxLength: 6 }),
  });

  it("treats expired holds as available (grabbable + visible + clearable) and protects active holds", () => {
    fc.assert(
      fc.property(
        identityArb,
        fc.string({ minLength: 1 }), // suffix for original holder id
        fc.string({ minLength: 1 }), // suffix for the new fan id
        holdWindow, // window used for the original hold
        holdWindow, // window used by the new fan on re-hold
        fc.integer({ min: 0, max: 2_000_000_000 }), // holdTime (epoch seconds)
        fc.integer({ min: -3600, max: 3600 }), // offset of `now` relative to expiration
        (identity, origSuffix, newSuffix, origWindow, newWindow, holdTime, offset) => {
          // Guarantee two distinct, non-empty holder identifiers.
          const originalFan = `fan-A-${origSuffix}`;
          const newFan = `fan-B-${newSuffix}`;

          const store = new SeatStore();
          store.createSeat(identity);

          // Place the original hold at `holdTime`, stamping
          // Hold_Expiration = holdTime + origWindow.
          const held = holdSeat(store, identity, originalFan, {
            now: holdTime,
            holdWindowSeconds: origWindow,
          });
          const expiration = holdTime + origWindow;
          expect(held.Seat_Status).toBe("held");
          expect(held.Holder_Identifier).toBe(originalFan);
          expect(held.Hold_Expiration).toBe(expiration);

          // The observation instant, spanning both sides of the expiration.
          const now = expiration + offset;
          const section = { venue: identity.venue, section: identity.section };

          if (now >= expiration) {
            // --- EXPIRED: expired hold behaves like an available seat ---

            // (b) Availability views treat the seat as available BEFORE any
            // re-hold and regardless of background cleanup.
            const seatBefore = store.getSeat(identity)!;
            expect(seatBefore.Seat_Status).toBe("held"); // physically still held
            expect(isEffectiveAvailable(seatBefore, now)).toBe(true);
            const mapBefore = seatMap(store, section, now);
            expect(mapBefore.some((s) => s.SK === seatBefore.SK && s.PK === seatBefore.PK)).toBe(
              true,
            );

            // (a) A new fan's hold succeeds: seat becomes held by the new fan
            // with a fresh expiration = now + newWindow.
            const regrabbed = holdSeat(store, identity, newFan, {
              now,
              holdWindowSeconds: newWindow,
            });
            expect(regrabbed.Seat_Status).toBe("held");
            expect(regrabbed.Holder_Identifier).toBe(newFan);
            expect(regrabbed.Hold_Expiration).toBe(now + newWindow);

            // (c) Upon release, Holder_Identifier and Hold_Expiration are cleared.
            const released = releaseSeat(store, identity);
            expect(released.Seat_Status).toBe("available");
            expect(released.Holder_Identifier).toBeUndefined();
            expect(released.Hold_Expiration).toBeUndefined();
          } else {
            // --- ACTIVE: a still-live hold is protected ---

            // Availability views do NOT treat an active hold as available.
            const seatBefore = store.getSeat(identity)!;
            expect(isEffectiveAvailable(seatBefore, now)).toBe(false);
            expect(seatMap(store, section, now).length).toBe(0);

            // A different fan's hold is rejected and the seat is unchanged.
            expect(() =>
              holdSeat(store, identity, newFan, { now, holdWindowSeconds: newWindow }),
            ).toThrow(TransitionRejectedError);

            const seatAfter = store.getSeat(identity)!;
            expect(seatAfter).toEqual(seatBefore);
            expect(seatAfter.Seat_Status).toBe("held");
            expect(seatAfter.Holder_Identifier).toBe(originalFan);
            expect(seatAfter.Hold_Expiration).toBe(expiration);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
