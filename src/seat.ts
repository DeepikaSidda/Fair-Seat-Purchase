/**
 * Fair Seat Purchase — seat entity model, status type, and identity→key mapping.
 *
 * This module defines the core seat inventory entity for the reference model. It
 * mirrors the single-table DynamoDB schema documented in `design.md`
 * (Data Models → Seat item): a seat is uniquely identified by
 * (venue, section, row, seat) and addressed by a single (PK, SK) primary key.
 *
 * Requirements covered:
 * - 1.1 Unique seat identity via (venue, section, row, seat) → (PK, SK) injective mapping.
 * - 1.3 Seat_Status is exactly one of `available` | `held` | `sold`.
 * - 1.4 Newly created seats start `available` (see `store.ts` create semantics).
 * - 1.7 Held/sold seats carry a non-empty Holder_Identifier.
 */

/**
 * The lifecycle state of a seat. Exactly one of these three values is ever
 * valid for `Seat_Status` (Requirement 1.3, 8.4).
 */
export type SeatStatus = "available" | "held" | "sold";

/** The set of valid seat statuses, used for runtime validation (Requirement 1.3). */
export const SEAT_STATUSES: readonly SeatStatus[] = ["available", "held", "sold"] as const;

/**
 * Runtime type guard: returns true iff `value` is one of the three valid
 * `SeatStatus` values (Requirement 1.3).
 */
export function isSeatStatus(value: unknown): value is SeatStatus {
  return (
    typeof value === "string" && (SEAT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The natural, human-facing identity of a seat. The four attributes together
 * uniquely identify a seat within the system (Requirement 1.1).
 */
export interface SeatIdentity {
  readonly venue: string;
  readonly section: string;
  readonly row: string;
  readonly seat: string;
}

/**
 * The DynamoDB primary-key pair a seat maps to. `PK` groups a section's seats
 * under one partition-key value; `SK` uniquely identifies the seat within that
 * section (design: Data Models → Seat item).
 */
export interface SeatKey {
  readonly PK: string;
  readonly SK: string;
}

/**
 * The seat entity as stored in the reference model. Field names mirror the
 * DynamoDB attribute names in `design.md` so the reference model reads as a
 * faithful stand-in for the real item.
 */
export interface Seat {
  /** `SEAT#<venue>#<section>` */
  readonly PK: string;
  /** `ROW#<row>#SEAT#<seat>` */
  readonly SK: string;
  /** Denormalized identity attributes. */
  readonly Venue: string;
  readonly Section: string;
  readonly Row: string;
  readonly Seat_Number: string;
  /** Lifecycle state (Requirement 1.3). */
  Seat_Status: SeatStatus;
  /** Present (non-empty) only while `held` or `sold` (Requirement 1.7). */
  Holder_Identifier?: string;
  /** Epoch seconds; present only while `held` (Requirement 1.5). */
  Hold_Expiration?: number;
  /** Monotonic counter incremented on each transition (audit/debug). */
  Version: number;
}

/**
 * Error thrown when a status value outside the permitted set is supplied
 * (Requirement 1.3).
 */
export class InvalidSeatStatusError extends Error {
  constructor(public readonly value: unknown) {
    super(`Invalid Seat_Status: ${JSON.stringify(value)}. Expected one of ${SEAT_STATUSES.join(", ")}.`);
    this.name = "InvalidSeatStatusError";
  }
}

/** Asserts that `value` is a valid `SeatStatus`, throwing otherwise (Requirement 1.3). */
export function assertSeatStatus(value: unknown): SeatStatus {
  if (!isSeatStatus(value)) {
    throw new InvalidSeatStatusError(value);
  }
  return value;
}

/**
 * Compute the base-table partition key for a seat identity.
 * `toPK(identity)` → `SEAT#<venue>#<section>` (design: Data Models → Seat item).
 */
export function toPK(identity: SeatIdentity): string {
  return `SEAT#${identity.venue}#${identity.section}`;
}

/**
 * Compute the base-table sort key for a seat identity.
 * `toSK(identity)` → `ROW#<row>#SEAT#<seat>` (design: Data Models → Seat item).
 */
export function toSK(identity: SeatIdentity): string {
  return `ROW#${identity.row}#SEAT#${identity.seat}`;
}

/**
 * Compute the full (PK, SK) primary key for a seat identity.
 *
 * The composed mapping (venue, section, row, seat) → (PK, SK) is injective: the
 * four identity components are embedded 1:1 into the two key strings with fixed
 * literal delimiters (`SEAT#`, `#`, `ROW#`, `#SEAT#`), so distinct identities
 * always produce distinct key pairs (Requirement 1.1).
 */
export function seatKey(identity: SeatIdentity): SeatKey {
  return { PK: toPK(identity), SK: toSK(identity) };
}

/**
 * A single canonical string form of a seat key, convenient for use as a Map key
 * in the in-memory store. Because `seatKey` is injective, this composition is
 * also injective over seat identities.
 */
export function seatKeyString(identity: SeatIdentity): string {
  const { PK, SK } = seatKey(identity);
  return `${PK}|${SK}`;
}
