// Feature: fair-seat-purchase, Property 16: Status value validity
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SEAT_STATUSES,
  isSeatStatus,
  assertSeatStatus,
  InvalidSeatStatusError,
  SeatStore,
  type SeatIdentity,
} from "../src/index.js";

/**
 * Property 16: Status value validity.
 *
 * For any value, setting a seat's Seat_Status succeeds only if the value is
 * exactly one of `available`, `held`, or `sold`; and a newly created seat has
 * status `available`.
 *
 * Validates: Requirements 1.3, 1.4
 */
describe("Property 16: Status value validity", () => {
  const NUM_RUNS = 200;

  const validStatuses = SEAT_STATUSES as readonly string[];

  // Arbitrary that yields any JS value, biased to include the valid statuses,
  // near-miss strings, and many unrelated invalid values.
  const anyValue = fc.oneof(
    fc.constantFrom(...validStatuses), // the three valid ones
    fc.string(), // arbitrary strings (mostly invalid)
    fc.constantFrom(
      "AVAILABLE",
      "Held",
      "SOLD",
      "available ",
      " held",
      "pending",
      "paid",
      "failed",
      "",
    ), // near-miss / wrong-case / adjacent-domain strings
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.object(),
    fc.array(fc.string()),
  );

  it("accepts exactly the three valid statuses and rejects everything else", () => {
    fc.assert(
      fc.property(anyValue, (value) => {
        const shouldBeValid =
          typeof value === "string" && validStatuses.includes(value);

        // isSeatStatus is the source of truth for validity.
        expect(isSeatStatus(value)).toBe(shouldBeValid);

        if (shouldBeValid) {
          // assertSeatStatus returns the value unchanged for valid statuses.
          expect(assertSeatStatus(value)).toBe(value);
        } else {
          // assertSeatStatus rejects invalid values with InvalidSeatStatusError,
          // modeling the system rejecting an out-of-set Seat_Status (Req 1.3).
          expect(() => assertSeatStatus(value)).toThrow(InvalidSeatStatusError);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("treats only 'available', 'held', 'sold' as the valid set (no more, no less)", () => {
    // Guard against the valid set drifting: exactly these three, deduplicated.
    expect([...new Set(validStatuses)].sort()).toEqual(
      ["available", "held", "sold"].sort(),
    );
    for (const s of validStatuses) {
      expect(isSeatStatus(s)).toBe(true);
    }
  });

  it("newly created seats always have status 'available' (Req 1.4)", () => {
    const identity: fc.Arbitrary<SeatIdentity> = fc.record({
      venue: fc.string({ minLength: 1 }),
      section: fc.string({ minLength: 1 }),
      row: fc.string({ minLength: 1 }),
      seat: fc.string({ minLength: 1 }),
    });

    fc.assert(
      fc.property(identity, (id) => {
        const store = new SeatStore();
        const seat = store.createSeat(id);
        // The created seat's status is exactly 'available' and is a valid status.
        expect(seat.Seat_Status).toBe("available");
        expect(isSeatStatus(seat.Seat_Status)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
