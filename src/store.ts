/**
 * Fair Seat Purchase — in-memory seat store.
 *
 * This is the reference model's stand-in for the single DynamoDB base table. It
 * stores seat items keyed by their injective (PK, SK) key string and mirrors the
 * conditional-write semantics the design relies on:
 *
 * - Seat creation mirrors a conditional `PutItem` with `attribute_not_exists(PK)`:
 *   creating a duplicate (same venue/section/row/seat) is rejected and the
 *   existing seat is left unchanged (Requirement 1.2, design AP9).
 * - Newly created seats start in `available` (Requirement 1.4).
 *
 * The store deliberately exposes a low-level conditional-update primitive
 * (`conditionalUpdate`) so the guarded transition engine (task 6.2) can build
 * `available→held`, `held→available`, and `held→sold` on top of it without the
 * store needing to know about seat lifecycle rules.
 */

import {
  type Seat,
  type SeatIdentity,
  seatKey,
  seatKeyString,
} from "./seat.js";

/**
 * Error thrown when a seat with the same identity already exists
 * (Requirement 1.2). Mirrors DynamoDB's `ConditionalCheckFailedException` on a
 * conditional `PutItem` guarded by `attribute_not_exists(PK)`.
 */
export class DuplicateSeatError extends Error {
  constructor(public readonly identity: SeatIdentity) {
    super(
      `Duplicate seat: a seat already exists for venue=${identity.venue} ` +
        `section=${identity.section} row=${identity.row} seat=${identity.seat}.`,
    );
    this.name = "DuplicateSeatError";
  }
}

/**
 * Error thrown when a conditional update's precondition is not satisfied.
 * Mirrors DynamoDB's `ConditionalCheckFailedException` on `UpdateItem`. The
 * seat is left unchanged when this is thrown (Requirement 8.3).
 */
export class ConditionalCheckFailedError extends Error {
  constructor(message = "The update condition was not satisfied.") {
    super(message);
    this.name = "ConditionalCheckFailedError";
  }
}

/**
 * A conditional update against a stored seat.
 *
 * - `condition` inspects the current stored seat and returns true iff the update
 *   may proceed. This mirrors a DynamoDB `ConditionExpression`.
 * - `mutate` produces the next seat state. It receives a shallow copy of the
 *   current seat so callers cannot accidentally mutate stored state in place.
 */
export interface ConditionalUpdate {
  condition(current: Seat): boolean;
  mutate(current: Seat): Seat;
}

/**
 * In-memory reference model of the single DynamoDB base table (seat items only).
 * Conditional-write semantics are preserved so the store faithfully models the
 * atomic, guarded transitions the design depends on.
 */
export class SeatStore {
  private readonly seats = new Map<string, Seat>();

  /** Number of seats currently in the store. */
  get size(): number {
    return this.seats.size;
  }

  /**
   * Create a new seat for `identity`, starting in `available` (Requirement 1.4).
   * Rejects creation if a seat with the same identity already exists, leaving the
   * existing seat unchanged (Requirement 1.2). Mirrors a conditional `PutItem`
   * guarded by `attribute_not_exists(PK)`.
   */
  createSeat(identity: SeatIdentity): Seat {
    const keyString = seatKeyString(identity);
    if (this.seats.has(keyString)) {
      throw new DuplicateSeatError(identity);
    }
    const { PK, SK } = seatKey(identity);
    const seat: Seat = {
      PK,
      SK,
      Venue: identity.venue,
      Section: identity.section,
      Row: identity.row,
      Seat_Number: identity.seat,
      Seat_Status: "available",
      Version: 0,
    };
    this.seats.set(keyString, seat);
    return this.copy(seat);
  }

  /** True iff a seat exists for the given identity. */
  hasSeat(identity: SeatIdentity): boolean {
    return this.seats.has(seatKeyString(identity));
  }

  /**
   * Return a copy of the stored seat for `identity`, or `undefined` if no such
   * seat exists. A copy is returned so callers cannot mutate stored state.
   */
  getSeat(identity: SeatIdentity): Seat | undefined {
    const seat = this.seats.get(seatKeyString(identity));
    return seat ? this.copy(seat) : undefined;
  }

  /**
   * Apply a conditional update to the seat for `identity`.
   *
   * Returns the updated seat on success. Throws:
   * - `SeatNotFoundError` if the seat does not exist.
   * - `ConditionalCheckFailedError` if the condition is not satisfied; the stored
   *   seat is left unchanged (Requirement 8.3).
   *
   * This is the single primitive the guarded transition engine (task 6.2) builds
   * every seat lifecycle transition on.
   */
  conditionalUpdate(identity: SeatIdentity, update: ConditionalUpdate): Seat {
    const keyString = seatKeyString(identity);
    const current = this.seats.get(keyString);
    if (current === undefined) {
      throw new SeatNotFoundError(identity);
    }
    if (!update.condition(current)) {
      throw new ConditionalCheckFailedError();
    }
    const next = update.mutate(this.copy(current));
    this.seats.set(keyString, next);
    return this.copy(next);
  }

  /** Return copies of all stored seats (order unspecified). */
  allSeats(): Seat[] {
    return [...this.seats.values()].map((seat) => this.copy(seat));
  }

  /** Shallow copy of a seat, so stored state is never handed out by reference. */
  private copy(seat: Seat): Seat {
    return { ...seat };
  }
}

/**
 * Error thrown when an operation targets a seat that does not exist
 * (Requirement 11.2).
 */
export class SeatNotFoundError extends Error {
  constructor(public readonly identity: SeatIdentity) {
    super(
      `Seat not found for venue=${identity.venue} section=${identity.section} ` +
        `row=${identity.row} seat=${identity.seat}.`,
    );
    this.name = "SeatNotFoundError";
  }
}
