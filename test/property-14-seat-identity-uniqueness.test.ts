// Feature: fair-seat-purchase, Property 14: Seat identity uniqueness
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  type SeatIdentity,
  seatKey,
  seatKeyString,
  SeatStore,
  DuplicateSeatError,
} from "../src/index.js";

/**
 * Property 14: Seat identity uniqueness.
 *
 * Validates: Requirements 1.1, 1.2
 *
 * Two parts, matching design.md "Property 14: Seat identity uniqueness":
 *  (a) The mapping (venue, section, row, seat) -> (PK, SK) is injective:
 *      two identities produce equal keys iff all four components are equal.
 *  (b) Creating a seat whose coordinates already exist is rejected with a
 *      DuplicateSeatError, and the existing seat is left unchanged (Req 1.2).
 *
 * Delimiter note (injectivity boundary):
 *   PK = `SEAT#<venue>#<section>` and SK = `ROW#<row>#SEAT#<seat>` embed the
 *   four components with literal `#` delimiters. This mapping is injective ONLY
 *   when the components themselves do not contain the delimiter `#`. For
 *   adversarial inputs containing `#`, injectivity genuinely breaks — e.g.
 *   {venue:"A#B", section:"C"} and {venue:"A", section:"B#C"} both map to
 *   PK "SEAT#A#B#C". Likewise `seatKeyString` joins PK and SK with `|`, so a
 *   raw `|` in a component could re-introduce ambiguity in that composed form.
 *   Requirement 1.1 is about seat coordinates (venue/section/row/seat as
 *   distinct fields), so the meaningful input space excludes these structural
 *   delimiters. The generators below therefore restrict component strings to
 *   exclude `#` and `|`, and we deliberately include tricky delimiter-adjacent
 *   values ("ROW", "SEAT", "") to exercise the composition robustly.
 */

/** Strip the structural delimiters so generated components stay in the valid input space. */
const safeString = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 0, maxLength: 6 }).map((s) => s.replace(/[#|]/g, ""));

/**
 * A small pool of `#`/`|`-free values chosen to force frequent collisions and
 * near-misses across the four components, plus values ("ROW", "SEAT") that
 * appear as literals in the key template so we probe delimiter robustness.
 */
const poolValue = fc.constantFrom("", "A", "B", "ROW", "SEAT", "1", "2", "10", "x", "AA");

/** A single seat-identity component: mostly from the collision pool, some freeform. */
const component = (): fc.Arbitrary<string> => fc.oneof(poolValue, safeString());

const identityArb: fc.Arbitrary<SeatIdentity> = fc.record({
  venue: component(),
  section: component(),
  row: component(),
  seat: component(),
});

const identityEquals = (a: SeatIdentity, b: SeatIdentity): boolean =>
  a.venue === b.venue &&
  a.section === b.section &&
  a.row === b.row &&
  a.seat === b.seat;

describe("Property 14: Seat identity uniqueness", () => {
  it("(a) maps (venue, section, row, seat) -> (PK, SK) injectively", () => {
    fc.assert(
      fc.property(identityArb, identityArb, (a, b) => {
        const ka = seatKey(a);
        const kb = seatKey(b);
        const keysEqual = ka.PK === kb.PK && ka.SK === kb.SK;
        const idsEqual = identityEquals(a, b);

        // Injective iff: keys are equal exactly when the identities are equal.
        expect(keysEqual).toBe(idsEqual);

        // The canonical string form (used as the store's Map key) is injective too.
        expect(seatKeyString(a) === seatKeyString(b)).toBe(idsEqual);
      }),
      { numRuns: 300 },
    );
  });

  it("(a') is deterministic: equal identities always yield the same key", () => {
    fc.assert(
      fc.property(identityArb, (id) => {
        const clone: SeatIdentity = {
          venue: id.venue,
          section: id.section,
          row: id.row,
          seat: id.seat,
        };
        expect(seatKey(clone)).toEqual(seatKey(id));
        expect(seatKeyString(clone)).toBe(seatKeyString(id));
      }),
      { numRuns: 100 },
    );
  });

  it("(b) rejects duplicate creation and leaves the existing seat unchanged (Req 1.2)", () => {
    fc.assert(
      fc.property(identityArb, (id) => {
        const store = new SeatStore();
        store.createSeat(id);

        // Move the seat into a non-default state so "unchanged" is meaningful:
        // a naive re-create would reset it back to `available`.
        store.conditionalUpdate(id, {
          condition: () => true,
          mutate: (s) => ({
            ...s,
            Seat_Status: "held",
            Holder_Identifier: "fan-1",
            Hold_Expiration: 1000,
            Version: s.Version + 1,
          }),
        });

        const before = store.getSeat(id);
        const sizeBefore = store.size;

        // The duplicate create must be rejected with DuplicateSeatError.
        expect(() => store.createSeat(id)).toThrow(DuplicateSeatError);

        // ...and the existing seat + store size must be untouched.
        const after = store.getSeat(id);
        expect(after).toEqual(before);
        expect(store.size).toBe(sizeBefore);
      }),
      { numRuns: 100 },
    );
  });

  it("(b') distinct identities coexist without collision in the store", () => {
    fc.assert(
      fc.property(fc.array(identityArb, { minLength: 1, maxLength: 30 }), (ids) => {
        const store = new SeatStore();
        const seen = new Set<string>();

        for (const id of ids) {
          const key = seatKeyString(id);
          if (seen.has(key)) {
            // Same coordinates already inserted -> must be rejected as duplicate.
            expect(() => store.createSeat(id)).toThrow(DuplicateSeatError);
          } else {
            const seat = store.createSeat(id);
            expect(seat.Seat_Status).toBe("available");
            seen.add(key);
          }
        }

        // One stored seat per distinct identity: injective keys => no lost seats.
        expect(store.size).toBe(seen.size);
      }),
      { numRuns: 100 },
    );
  });
});
