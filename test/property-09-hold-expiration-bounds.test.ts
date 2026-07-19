// Feature: fair-seat-purchase, Property 9: Hold expiration is set within bounds
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  InvalidHoldWindowError,
  DEFAULT_HOLD_WINDOW_SECONDS,
  MIN_HOLD_WINDOW_SECONDS,
  MAX_HOLD_WINDOW_SECONDS,
  type SeatIdentity,
} from "../src/index.js";

/**
 * Property 9: Hold expiration is set within bounds
 *
 * For any successful `available → held` transition with a configured hold
 * window W, the seat's `Hold_Expiration` equals the transition time plus W, and
 * W lies within [60, 1800] seconds (default 480).
 *
 * Validates: Requirements 1.5, 4.2, 4.3, 9.7
 *
 * NOTE ON A SPEC TENSION (reported, not forced):
 * Requirement 1.5 / design Property 9 also state the expiration must exceed the
 * creation time "by no more than 600 seconds", but Requirement 4.3 / 9.7 permit
 * a configurable window up to MAX_HOLD_WINDOW_SECONDS = 1800. Because 1800 > 600,
 * the 600-second bound cannot hold for every permitted window. The reference
 * implementation stamps `Hold_Expiration = now + W` for any W in [60, 1800], so
 * this test verifies the *implemented, design-consistent* invariant (delta === W,
 * W in [60, 1800]) rather than the strict 600-second bound. It additionally
 * documents that the DEFAULT window (480 s) does satisfy the 600-second bound.
 */

const SEAT_IDENTITY: SeatIdentity = {
  venue: "VENUE1",
  section: "A",
  row: "1",
  seat: "1",
};

/** Arbitrary "now" as a non-negative epoch-second instant. */
const nowArb = fc.integer({ min: 0, max: 4_102_444_800 }); // up to year ~2100

/** Arbitrary window strictly inside the permitted [60, 1800] band. */
const validWindowArb = fc.integer({
  min: MIN_HOLD_WINDOW_SECONDS,
  max: MAX_HOLD_WINDOW_SECONDS,
});

/**
 * Arbitrary window OUTSIDE the permitted band: either below MIN or above MAX,
 * plus some non-integer values, all of which must be rejected (Requirement 4.3).
 */
const invalidWindowArb = fc.oneof(
  fc.integer({ min: -10_000, max: MIN_HOLD_WINDOW_SECONDS - 1 }),
  fc.integer({ min: MAX_HOLD_WINDOW_SECONDS + 1, max: 100_000 }),
  fc
    .double({ min: MIN_HOLD_WINDOW_SECONDS, max: MAX_HOLD_WINDOW_SECONDS, noNaN: true })
    .filter((n) => !Number.isInteger(n)),
);

function freshAvailableStore(): SeatStore {
  const store = new SeatStore();
  store.createSeat(SEAT_IDENTITY);
  return store;
}

describe("Property 9: Hold expiration is set within bounds", () => {
  it("stamps Hold_Expiration = now + W with W in [60, 1800] for any successful hold", () => {
    fc.assert(
      fc.property(nowArb, validWindowArb, (now, windowSeconds) => {
        const store = freshAvailableStore();

        const held = holdSeat(store, SEAT_IDENTITY, "FAN#alice", {
          holdWindowSeconds: windowSeconds,
          now,
        });

        // Transition succeeded into `held`.
        expect(held.Seat_Status).toBe("held");

        // Hold_Expiration equals the transition time plus the configured window.
        expect(held.Hold_Expiration).toBe(now + windowSeconds);

        // The window itself lies within the permitted [60, 1800] band.
        expect(windowSeconds).toBeGreaterThanOrEqual(MIN_HOLD_WINDOW_SECONDS);
        expect(windowSeconds).toBeLessThanOrEqual(MAX_HOLD_WINDOW_SECONDS);

        // The expiration strictly exceeds the creation time, by exactly W.
        const delta = (held.Hold_Expiration as number) - now;
        expect(delta).toBe(windowSeconds);
        expect(delta).toBeGreaterThan(0);
        expect(delta).toBeGreaterThanOrEqual(MIN_HOLD_WINDOW_SECONDS);
        expect(delta).toBeLessThanOrEqual(MAX_HOLD_WINDOW_SECONDS);

        // The stored seat reflects the same expiration (no drift vs returned copy).
        expect(store.getSeat(SEAT_IDENTITY)?.Hold_Expiration).toBe(now + windowSeconds);
      }),
      { numRuns: 300 },
    );
  });

  it("uses the default window (480 s) which satisfies the 600-second R1.5 bound", () => {
    fc.assert(
      fc.property(nowArb, (now) => {
        const store = freshAvailableStore();

        const held = holdSeat(store, SEAT_IDENTITY, "FAN#alice", { now });

        const delta = (held.Hold_Expiration as number) - now;
        expect(delta).toBe(DEFAULT_HOLD_WINDOW_SECONDS);
        // The default window honors Requirement 1.5's "no more than 600 seconds".
        expect(delta).toBeLessThanOrEqual(600);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects out-of-range windows and leaves the seat unchanged", () => {
    fc.assert(
      fc.property(nowArb, invalidWindowArb, (now, badWindow) => {
        const store = freshAvailableStore();
        const before = store.getSeat(SEAT_IDENTITY);

        expect(() =>
          holdSeat(store, SEAT_IDENTITY, "FAN#alice", {
            holdWindowSeconds: badWindow,
            now,
          }),
        ).toThrow(InvalidHoldWindowError);

        // The seat is untouched: still available, no holder, no expiration.
        const after = store.getSeat(SEAT_IDENTITY);
        expect(after).toEqual(before);
        expect(after?.Seat_Status).toBe("available");
        expect(after?.Holder_Identifier).toBeUndefined();
        expect(after?.Hold_Expiration).toBeUndefined();
      }),
      { numRuns: 300 },
    );
  });
});
