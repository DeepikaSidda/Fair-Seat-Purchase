/**
 * Fair Seat Purchase — availability view (read model).
 *
 * This module models the read side of the seat inventory: the GSI1 seat-map
 * query and the per-section availability count from `design.md`
 * (Data Models → GSI1 seat map; Scale and Cost → availability counters). It is
 * a pure *view* over the seat store — it never mutates seat state and contains
 * no transition logic (that lives in `./transitions.js`).
 *
 * ### Effective availability (read-time expiry)
 *
 * The design makes condition-at-read-time the source of truth for hold
 * expiration (design: Temporary Hold and Expiration). So the availability view
 * reports a seat's *effective* status, not just its physical `Seat_Status`:
 *
 *   effective-available  ⇔  physically `available`
 *                            OR `held` with an expired hold
 *
 * The expired-hold case reuses {@link isHoldExpired} from `./transitions.js` so
 * the read model and the write path share exactly one definition of "expired",
 * matching design's rule that an expired-but-not-yet-cleaned-up held seat is
 * treated as available at both read and write time (Requirement 3.1, 11.3).
 *
 * In the real system this is a `Query` on GSI1
 * (`GSI1PK = SECTION#<venue>#<section>`) returning only available seats. The
 * reference store is a simple in-memory model, so a filter over
 * {@link SeatStore.allSeats} stands in for that partition Query.
 *
 * Requirements covered:
 * - 3.1  seat-map returns all effective-`available` seats in a section.
 * - 3.4  section availability count equals the number of such seats,
 *        bounded within [0, section capacity].
 * - 11.3 available-seats-in-section served as a single (Query-equivalent) read.
 * - 11.4 section availability count equals the count of effective-available seats.
 */

import { type Seat } from "./seat.js";
import { type SeatStore } from "./store.js";
import { isHoldExpired } from "./transitions.js";

/**
 * The (venue, section) pair identifying a seat-map partition. In the real model
 * this maps to the GSI1 partition key `SECTION#<venue>#<section>`
 * (design: Data Models → GSI1).
 */
export interface SectionRef {
  readonly venue: string;
  readonly section: string;
}

/**
 * Returns true iff `seat` belongs to the section identified by `ref`
 * (matching both `Venue` and `Section`). This models the GSI1 partition scope
 * `GSI1PK = SECTION#<venue>#<section>`.
 */
function isInSection(seat: Seat, ref: SectionRef): boolean {
  return seat.Venue === ref.venue && seat.Section === ref.section;
}

/**
 * Returns true iff `seat` is *effectively* available at time `now`
 * (Requirement 3.1, 11.3):
 *
 *   - physically `available`, OR
 *   - `held` with an expired hold ({@link isHoldExpired}).
 *
 * `sold` seats — and `held` seats whose hold has not yet expired — are never
 * effective-available. Reusing {@link isHoldExpired} keeps this view consistent
 * with the write-time holdability guard in `./transitions.js`.
 */
export function isEffectiveAvailable(seat: Seat, now: number): boolean {
  return seat.Seat_Status === "available" || isHoldExpired(seat, now);
}

/**
 * The seat-map query: return all seats in the given section whose *effective*
 * status is available at `now` (Requirement 3.1, 11.3).
 *
 * Models a `Query` on GSI1 keyed by `SECTION#<venue>#<section>`. The reference
 * store has no real index, so this filters {@link SeatStore.allSeats} by
 * matching Venue/Section — a stand-in for the GSI1 partition Query. Returned
 * seats are copies owned by the store, so callers cannot mutate stored state.
 *
 * The result set is exactly the effective-available seats in the section: no
 * `sold` seat and no still-active `held` seat is included, and every physically
 * `available` seat plus every expired-hold seat is included.
 */
export function seatMap(store: SeatStore, section: SectionRef, now: number): Seat[] {
  return store
    .allSeats()
    .filter((seat) => isInSection(seat, section) && isEffectiveAvailable(seat, now));
}

/**
 * The section availability count: the number of effective-available seats in
 * the section at `now` (Requirement 3.4, 11.4).
 *
 * By construction this equals `seatMap(store, section, now).length` — the count
 * of a subset of the section's seats — so it is inherently a non-negative
 * integer no greater than the section's total seat capacity, i.e. bounded
 * within [0, section capacity] (Requirement 3.4). The count is derived directly
 * from the seat items, which are the authoritative source of availability
 * (design: Scale and Cost → the authoritative availability answer is always
 * derivable from the seat items themselves).
 */
export function sectionAvailabilityCount(
  store: SeatStore,
  section: SectionRef,
  now: number,
): number {
  return seatMap(store, section, now).length;
}

/**
 * The total number of seats in a section (its capacity) at query time. Provided
 * so callers can relate an availability count to the section's capacity; the
 * availability count is always within [0, this value] (Requirement 3.4).
 */
export function sectionCapacity(store: SeatStore, section: SectionRef): number {
  return store.allSeats().filter((seat) => isInSection(seat, section)).length;
}
