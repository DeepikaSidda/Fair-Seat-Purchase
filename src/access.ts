/**
 * Fair Seat Purchase — access-layer error and edge-case behaviors.
 *
 * This module models the error paths described in `design.md` → Error Handling
 * that are exercised by example-based unit tests (design: Testing Strategy →
 * Example-based unit tests). They are not universal invariants (so they are not
 * property-tested); each is a specific, well-defined outcome for an invalid or
 * degraded request:
 *
 * - **Invalid-section error (R3.6).** A Seat_Map / Section_Availability_Count
 *   request for a section that does not exist is a *validation error returned
 *   before any work*, and no seat data is returned.
 * - **Timeout-availability error (R3.7).** If an availability query does not
 *   complete within its 2-second budget, an "availability temporarily
 *   unavailable" error is returned while the underlying seat state is preserved
 *   (availability reads never mutate state, so preservation is inherent).
 * - **Not-found lookups (R11.2, R11.7).** A seat / transaction lookup that finds
 *   no item returns a "not found" error and modifies no stored data.
 * - **Throttling retry-then-error (R10.9).** A throttled operation is retried
 *   with exponential backoff up to 5 attempts; if every attempt is throttled the
 *   caller gets an error while state is preserved (each attempt is atomic).
 *   Non-transient errors (e.g. a condition-check failure) are surfaced
 *   immediately and never retried (design: Throttling and transient failures).
 *
 * Everything here is deterministic and free of real time / real sleeps: the
 * availability query takes a modeled elapsed duration, and the retry helper takes
 * an injectable `sleep`, so tests assert the behavior without wall-clock delays.
 */

import { type Seat, type SeatIdentity } from "./seat.js";
import { type SeatStore, SeatNotFoundError } from "./store.js";
import {
  type PurchaseTransaction,
  type TransactionStore,
  TransactionNotFoundError,
} from "./transaction.js";
import { type SectionRef, seatMap, sectionAvailabilityCount } from "./availability.js";

// ───────────────────────────── Invalid section (R3.6) ─────────────────────────

/**
 * Error returned when an availability request targets a section identifier that
 * does not exist (Requirement 3.6). It is raised *before* any seat data is read
 * or returned, so no seat data leaks for an unknown section.
 */
export class InvalidSectionError extends Error {
  constructor(public readonly section: SectionRef) {
    super(
      `Invalid section: no seats exist for venue=${section.venue} ` +
        `section=${section.section}.`,
    );
    this.name = "InvalidSectionError";
  }
}

/**
 * True iff the store contains at least one seat in the given (venue, section).
 * A section "exists" exactly when it has inventory — the seat items are the
 * authoritative source of the section's existence (design: Scale and Cost).
 */
export function sectionExists(store: SeatStore, section: SectionRef): boolean {
  return store
    .allSeats()
    .some((seat) => seat.Venue === section.venue && seat.Section === section.section);
}

/** Assert the section exists, throwing {@link InvalidSectionError} otherwise (R3.6). */
function assertSectionExists(store: SeatStore, section: SectionRef): void {
  if (!sectionExists(store, section)) {
    throw new InvalidSectionError(section);
  }
}

// ─────────────────────────── Availability timeout (R3.7) ──────────────────────

/**
 * The availability-query time budget in milliseconds (Requirement 3.1, 3.7).
 * A Seat_Map / Section_Availability_Count query that would take longer than this
 * is reported as temporarily unavailable rather than blocking the fan.
 */
export const AVAILABILITY_QUERY_BUDGET_MS = 2000;

/**
 * Error returned when an availability query exceeds its time budget
 * (Requirement 3.7). The underlying seat state is untouched (availability reads
 * are pure), so this signals "try again" without any data loss.
 */
export class AvailabilityUnavailableError extends Error {
  constructor(
    public readonly section: SectionRef,
    public readonly elapsedMs: number,
    public readonly budgetMs: number,
  ) {
    super(
      `Availability temporarily unavailable for venue=${section.venue} ` +
        `section=${section.section}: query took ${elapsedMs}ms (budget ${budgetMs}ms).`,
    );
    this.name = "AvailabilityUnavailableError";
  }
}

/**
 * Options for an availability query.
 *
 * `queryDurationMs` models how long the underlying (Query) took; when it exceeds
 * `budgetMs` (default {@link AVAILABILITY_QUERY_BUDGET_MS}) the query is reported
 * as temporarily unavailable (Requirement 3.7). Defaulting `queryDurationMs` to
 * 0 means a query completes within budget unless a test says otherwise.
 */
export interface AvailabilityQueryOptions {
  /** Current time, epoch seconds — forwarded to the effective-availability view. */
  readonly now: number;
  /** Modeled elapsed time of the underlying query, in ms (default 0). */
  readonly queryDurationMs?: number;
  /** Time budget in ms (default {@link AVAILABILITY_QUERY_BUDGET_MS}). */
  readonly budgetMs?: number;
}

/** Enforce the query budget, throwing {@link AvailabilityUnavailableError} (R3.7). */
function assertWithinBudget(section: SectionRef, opts: AvailabilityQueryOptions): void {
  const budgetMs = opts.budgetMs ?? AVAILABILITY_QUERY_BUDGET_MS;
  const elapsedMs = opts.queryDurationMs ?? 0;
  if (elapsedMs > budgetMs) {
    throw new AvailabilityUnavailableError(section, elapsedMs, budgetMs);
  }
}

/**
 * Seat-map query with validation and timeout handling (Requirements 3.1, 3.6,
 * 3.7, 11.3).
 *
 * Order of checks: (1) reject an unknown section before any data read
 * ({@link InvalidSectionError}, R3.6); (2) reject an over-budget query
 * ({@link AvailabilityUnavailableError}, R3.7); (3) otherwise return the
 * effective-available seats for the section. No stored state is ever modified.
 */
export function querySeatMap(
  store: SeatStore,
  section: SectionRef,
  opts: AvailabilityQueryOptions,
): Seat[] {
  assertSectionExists(store, section);
  assertWithinBudget(section, opts);
  return seatMap(store, section, opts.now);
}

/**
 * Section availability count with validation and timeout handling (Requirements
 * 3.4, 3.6, 3.7, 11.4). Same check order and state-preservation guarantees as
 * {@link querySeatMap}.
 */
export function querySectionAvailabilityCount(
  store: SeatStore,
  section: SectionRef,
  opts: AvailabilityQueryOptions,
): number {
  assertSectionExists(store, section);
  assertWithinBudget(section, opts);
  return sectionAvailabilityCount(store, section, opts.now);
}

// ─────────────────────────── Not-found lookups (R11.2, R11.7) ──────────────────

/**
 * Look up a single seat by identity, modeling design AP1 (`GetItem`). Returns
 * the seat, or throws {@link SeatNotFoundError} when no item exists
 * (Requirement 11.2). The store is read-only here, so a miss modifies no data.
 */
export function lookupSeat(store: SeatStore, identity: SeatIdentity): Seat {
  const seat = store.getSeat(identity);
  if (seat === undefined) {
    throw new SeatNotFoundError(identity);
  }
  return seat;
}

/**
 * Look up a fan's purchase transaction, modeling design AP5 (`GetItem`/`Query`).
 * Returns the transaction, or throws {@link TransactionNotFoundError} when no
 * item exists (Requirement 11.7). Read-only: a miss modifies no data.
 */
export function lookupTransaction(
  txnStore: TransactionStore,
  fanId: string,
  txnId: string,
): PurchaseTransaction {
  const txn = txnStore.getTransaction(fanId, txnId);
  if (txn === undefined) {
    throw new TransactionNotFoundError(fanId, txnId);
  }
  return txn;
}

// ─────────────────────────── Throttling retry (R10.9) ─────────────────────────

/**
 * Maximum number of attempts (initial try + retries) for a throttled operation
 * (Requirement 10.9). After this many throttled attempts the caller receives an
 * error ({@link RetryExhaustedError}).
 */
export const MAX_RETRY_ATTEMPTS = 5;

/** Default base backoff delay (ms) used for the exponential schedule. */
export const DEFAULT_BASE_DELAY_MS = 50;

/**
 * A transient throttling failure, modeling DynamoDB's
 * `ProvisionedThroughputExceededException` / `ThrottlingException` /
 * `RequestLimitExceeded`. Only errors classified as transient are retried
 * (design: Throttling and transient failures).
 */
export class ThrottlingError extends Error {
  constructor(message = "Request was throttled.") {
    super(message);
    this.name = "ThrottlingError";
  }
}

/**
 * Terminal error returned when every retry attempt was throttled
 * (Requirement 10.9). `attempts` is how many times the operation was tried and
 * `lastError` is the final throttling failure. Because each attempt is atomic,
 * exhausting retries leaves stored state unchanged.
 */
export class RetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(
      `Operation failed after ${attempts} attempt(s) due to repeated throttling; ` +
        `state preserved.`,
    );
    this.name = "RetryExhaustedError";
  }
}

/**
 * Exponential backoff delay for a given attempt number (1-based):
 * `baseDelayMs * 2^(attempt - 1)` (design: exponential backoff, R10.9).
 * Deterministic (no jitter) so tests can assert the exact schedule; a production
 * implementation would add jitter on top of this base.
 */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
): number {
  return baseDelayMs * 2 ** (attempt - 1);
}

/** Options for {@link withThrottleRetry}. */
export interface RetryOptions {
  /** Max attempts (default {@link MAX_RETRY_ATTEMPTS} = 5). */
  readonly maxAttempts?: number;
  /** Base backoff delay in ms (default {@link DEFAULT_BASE_DELAY_MS}). */
  readonly baseDelayMs?: number;
  /**
   * Classifier for transient (retryable) errors. Defaults to "is a
   * {@link ThrottlingError}". Non-transient errors are surfaced immediately.
   */
  readonly isTransient?: (error: unknown) => boolean;
  /**
   * Injectable sleep between attempts. Defaults to a no-op so tests incur no
   * real delay; production would pass a real (jittered) sleep.
   */
  readonly sleep?: (ms: number) => void;
  /**
   * Observer invoked before each backoff wait with the just-failed attempt
   * number and the computed delay. Lets tests assert the exponential schedule.
   */
  readonly onBackoff?: (attempt: number, delayMs: number) => void;
}

/**
 * Run `op` with bounded exponential-backoff retry on transient throttling
 * (Requirement 10.9).
 *
 * - Returns `op`'s value as soon as an attempt succeeds (retry-then-succeed).
 * - Retries only transient errors (default: {@link ThrottlingError}); a
 *   non-transient error (e.g. a condition-check failure) is re-thrown
 *   immediately and never retried (design: condition failures surfaced
 *   immediately, not retried).
 * - After `maxAttempts` throttled attempts, throws {@link RetryExhaustedError};
 *   because every attempt is atomic, no partial write occurs and state is
 *   preserved.
 *
 * `op` receives the 1-based attempt number so callers/tests can vary behavior
 * per attempt. Backoff waits use the injectable {@link RetryOptions.sleep}
 * (default no-op) and the {@link backoffDelayMs} schedule.
 */
export function withThrottleRetry<T>(op: (attempt: number) => T, opts: RetryOptions = {}): T {
  const maxAttempts = opts.maxAttempts ?? MAX_RETRY_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const isTransient = opts.isTransient ?? ((error) => error instanceof ThrottlingError);
  const sleep = opts.sleep ?? (() => {});

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return op(attempt);
    } catch (error) {
      if (!isTransient(error)) {
        // Non-transient (e.g. condition failure): surface immediately (design).
        throw error;
      }
      lastError = error;
      if (attempt < maxAttempts) {
        const delayMs = backoffDelayMs(attempt, baseDelayMs);
        opts.onBackoff?.(attempt, delayMs);
        sleep(delayMs);
      }
    }
  }
  // Every attempt was throttled — return an error while preserving state (R10.9).
  throw new RetryExhaustedError(maxAttempts, lastError);
}
