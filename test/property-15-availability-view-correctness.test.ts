// Feature: fair-seat-purchase, Property 15: Availability view correctness
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  confirmSeat,
  isEffectiveAvailable,
  seatMap,
  sectionAvailabilityCount,
  sectionCapacity,
  type Seat,
  type SeatIdentity,
} from "../src/index.js";

/**
 * Property 15: Availability view correctness.
 *
 * For any section in any mixture of seat states, a seat-map query returns
 * exactly the seats whose effective status is `available` (physical
 * `available`, plus `held` seats whose hold has expired), and the section
 * availability count equals the number of such seats, bounded within
 * [0, section capacity].
 *
 * **Validates: Requirements 3.1, 3.4, 11.3, 11.4**
 */
describe("Property 15: Availability view correctness", () => {
  // A single fixed observation instant. Holds are stamped relative to this so we
  // can deterministically produce active vs. expired holds.
  const NOW = 1_000_000;
  const WINDOW = 480; // default hold window (seconds), within [60, 1800].
  const VENUE = "VENUE1";
  const TARGET_SECTION = "A"; // the section we query
  const OTHER_SECTION = "B"; // a decoy section that must never leak into the query

  // The four physical situations a seat can be in, spanning the full lifecycle
  // plus the two distinct `held` cases (still-active vs. already-expired).
  type SeatState = "available" | "held-active" | "held-expired" | "sold";

  const seatSpecArb = fc.record({
    // Whether this seat lives in the section under query or a different section.
    inTargetSection: fc.boolean(),
    state: fc.constantFrom<SeatState>(
      "available",
      "held-active",
      "held-expired",
      "sold",
    ),
  });

  // A section is any mixture of seat states, including the empty section.
  const specsArb = fc.array(seatSpecArb, { minLength: 0, maxLength: 40 });

  /**
   * Materialize a seat in the store in the requested physical state. Distinct
   * `seat` numbers guarantee unique identities, so no spec collides with another.
   */
  function buildSeat(
    store: SeatStore,
    index: number,
    inTargetSection: boolean,
    state: SeatState,
  ): SeatIdentity {
    const identity: SeatIdentity = {
      venue: VENUE,
      section: inTargetSection ? TARGET_SECTION : OTHER_SECTION,
      row: "R",
      seat: String(index),
    };
    store.createSeat(identity); // starts `available`
    const holder = `fan-${index}`;

    switch (state) {
      case "available":
        break;
      case "held-active":
        // Hold stamped at NOW -> Hold_Expiration = NOW + WINDOW > NOW (active).
        holdSeat(store, identity, holder, { now: NOW, holdWindowSeconds: WINDOW });
        break;
      case "held-expired":
        // Hold stamped in the past so Hold_Expiration = (NOW - WINDOW - 1) + WINDOW
        // = NOW - 1 <= NOW (expired at the observation instant).
        holdSeat(store, identity, holder, {
          now: NOW - WINDOW - 1,
          holdWindowSeconds: WINDOW,
        });
        break;
      case "sold":
        holdSeat(store, identity, holder, { now: NOW, holdWindowSeconds: WINDOW });
        confirmSeat(store, identity, holder);
        break;
    }
    return identity;
  }

  const seatKeyOf = (s: Pick<Seat, "PK" | "SK">): string => `${s.PK}|${s.SK}`;

  it("seat-map returns exactly the effective-available seats and the count matches, bounded within [0, capacity]", () => {
    fc.assert(
      fc.property(specsArb, (specs) => {
        const store = new SeatStore();
        const section = { venue: VENUE, section: TARGET_SECTION };

        // Track which seats we EXPECT the query to return: only those in the
        // target section whose effective status is available (physical
        // `available` OR an expired hold). `sold` and still-active `held` are
        // excluded; anything in another section is excluded regardless of state.
        const expectedKeys = new Set<string>();
        let targetSectionCapacity = 0;

        specs.forEach((spec, index) => {
          const identity = buildSeat(store, index, spec.inTargetSection, spec.state);
          if (spec.inTargetSection) {
            targetSectionCapacity += 1;
            if (spec.state === "available" || spec.state === "held-expired") {
              const seat = store.getSeat(identity)!;
              expectedKeys.add(seatKeyOf(seat));
            }
          }
        });

        const result = seatMap(store, section, NOW);
        const resultKeys = new Set(result.map(seatKeyOf));

        // (1) The seat-map is EXACTLY the expected effective-available set:
        //     same size and same members (no missing, no extra).
        expect(resultKeys.size).toBe(result.length); // no duplicate rows
        expect(resultKeys).toEqual(expectedKeys);

        // (2) Every returned seat is genuinely effective-available at NOW and
        //     belongs to the queried section (Requirement 3.1, 11.3).
        for (const seat of result) {
          expect(isEffectiveAvailable(seat, NOW)).toBe(true);
          expect(seat.Venue).toBe(VENUE);
          expect(seat.Section).toBe(TARGET_SECTION);
          expect(seat.Seat_Status).not.toBe("sold");
        }

        // (3) The availability count equals the number of such seats
        //     (Requirement 3.4, 11.4).
        const count = sectionAvailabilityCount(store, section, NOW);
        expect(count).toBe(result.length);
        expect(count).toBe(expectedKeys.size);

        // (4) The count is bounded within [0, section capacity] (Requirement 3.4).
        const capacity = sectionCapacity(store, section);
        expect(capacity).toBe(targetSectionCapacity);
        expect(count).toBeGreaterThanOrEqual(0);
        expect(count).toBeLessThanOrEqual(capacity);
      }),
      { numRuns: 200 },
    );
  });
});
