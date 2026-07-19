/**
 * Fair Seat Purchase — application service layer.
 *
 * `TicketingService` composes the two DynamoDB-backed repositories
 * (`SeatRepository`, `TransactionRepository`) into the end-to-end purchasing
 * use cases that the HTTP API drives:
 *
 *   browse → seat map → hold → pay → confirm → release
 *
 * It is the single place where the seat-side and transaction-side operations
 * are orchestrated together, mirroring the reference-model semantics of
 * `src/payment.ts` (payment admission + outcome) and `src/confirm.ts` (atomic
 * `held → sold` + `paid → confirmed`) but executed against the real
 * repositories. The service is deliberately transport-agnostic: it knows
 * nothing about Express, HTTP status codes, or request shapes — it only throws
 * well-defined domain errors that the API layer maps to responses.
 *
 * Dependency injection:
 * - `clock` — a function returning epoch seconds. Defaults to `systemClock`
 *   (`src/transitions.ts`). Injecting the clock keeps hold-expiration and
 *   payment/confirm admission deterministic under test (Properties 9, 10, 12).
 * - `holdWindow` — the hold window in seconds. Defaults to
 *   `DEFAULT_HOLD_WINDOW_SECONDS` (480 s; design: Temporary Hold and Expiration).
 *
 * Resilience (Requirement 10.9): every method that calls DynamoDB runs its
 * repository call(s) through {@link TicketingService.withThrottleRetry} — the
 * asynchronous counterpart of `withThrottleRetry` in `src/access.ts`. The
 * reference helper is synchronous (it drives the pure in-memory model), so it
 * cannot `await` the AWS SDK's promises; this adapter reuses the same
 * contract — the {@link backoffDelayMs} exponential schedule, the
 * {@link MAX_RETRY_ATTEMPTS} bound, and the {@link ThrottlingError} /
 * {@link RetryExhaustedError} types — while awaiting async DynamoDB calls and
 * additionally classifying the SDK's native throttling exceptions as transient.
 *
 * Requirement → method map:
 * - R3.1/R11.3  → {@link TicketingService.getSeatMap}          (AP2 GSI1 query)
 * - R3.4/R11.4  → {@link TicketingService.getSectionCount}     (AP3 GSI1 COUNT)
 * - R11.1/R11.2 → {@link TicketingService.getSeat}             (AP1 GetItem)
 * - R4.x        → {@link TicketingService.holdSeat}            (AP6 hold + AP10 create txn)
 * - R5.x/R6.x   → {@link TicketingService.pay}                 (payment + AP7 confirm)
 * - R6.4        → {@link TicketingService.releaseSeat}         (AP8 release)
 * - R11.6/R11.7 → {@link TicketingService.getTransaction}      (AP5 GetItem)
 */

import { randomUUID } from "node:crypto";

import type { Seat, SeatIdentity } from "../seat.js";
import { seatKeyString } from "../seat.js";
import type { PurchaseTransaction } from "../transaction.js";
import {
  DEFAULT_HOLD_WINDOW_SECONDS,
  systemClock,
  type Clock,
} from "../transitions.js";
import {
  RetryExhaustedError,
  ThrottlingError,
  backoffDelayMs,
  MAX_RETRY_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
} from "../access.js";
import {
  SeatNotAvailableError,
  SeatRepository,
  type SeatMapEntry,
} from "../aws/seat-repository.js";
import { TransactionRepository } from "../aws/transaction-repository.js";
import { SectionRepository } from "../aws/section-repository.js";

// ─────────────────────────── Service-level errors ─────────────────────────────

/**
 * A requested resource (seat or transaction) does not exist. Distinct from a
 * guard rejection: nothing was mutated. The API maps this to `404 Not Found`
 * (Requirements 11.2, 11.7).
 */
export class NotFoundError extends Error {
  constructor(
    public readonly resource: "seat" | "transaction",
    public readonly detail: string,
  ) {
    super(`${resource} not found: ${detail}.`);
    this.name = "NotFoundError";
  }
}

/**
 * A payment attempt was rejected before contacting the processor because a
 * precondition failed — the seat is not `held`, the hold has expired, or the
 * paying fan is not the holder (Requirements 5.1, 5.6, 5.7, 9.4). No funds are
 * captured and no state is changed. The API maps this to `409 Conflict`.
 */
export class PaymentNotAllowedError extends Error {
  constructor(
    public readonly reason: "seat-not-held" | "hold-expired" | "holder-mismatch",
    public readonly identity: SeatIdentity,
  ) {
    super(
      `Payment not allowed (${reason}) for venue=${identity.venue} ` +
        `section=${identity.section} row=${identity.row} seat=${identity.seat}.`,
    );
    this.name = "PaymentNotAllowedError";
  }
}

/**
 * The external payment processor declined or timed out. The transaction is
 * marked `failed` and the seat is left `held` until its natural expiry
 * (Requirements 5.4, 5.5). The API maps this to `402 Payment Required`.
 */
export class PaymentDeclinedError extends Error {
  constructor(public readonly processorResult: "failure" | "timeout") {
    super(`Payment ${processorResult}: the processor did not capture funds.`);
    this.name = "PaymentDeclinedError";
  }
}

// ─────────────────────────────── I/O shapes ───────────────────────────────────

/** A payment processor outcome, injected per request for the demo (design: Payment orchestrator). */
export type ProcessorResult = "success" | "failure" | "timeout";

/** Arguments to {@link TicketingService.holdSeat}. */
export interface HoldSeatInput extends SeatIdentity {
  /** The fan placing the hold (from the authenticated request). */
  readonly fanId: string;
}

/** Result of a successful hold: the held seat, the created transaction id, and the hold expiry. */
export interface HoldSeatResult {
  readonly hold: Seat;
  readonly txnId: string;
  readonly holdExpiration: number;
  /** The seat's price (whole dollars), when the seat carries per-seat pricing. */
  readonly price?: number;
}

/** A venue-overview row: one catalog section with its live availability count. */
export interface VenueSectionSummary {
  readonly venue: string;
  readonly section: string;
  readonly tier: string;
  readonly price: number;
  readonly capacity: number;
  /** Live count of currently-available seats (AP3 — GSI1 COUNT). */
  readonly available: number;
}

/** Arguments to {@link TicketingService.pay}. */
export interface PayInput extends SeatIdentity {
  readonly fanId: string;
  readonly txnId: string;
  /** Injected processor outcome for the demo; defaults to `success`. */
  readonly processorResult?: ProcessorResult;
}

/** Result of a confirmed purchase: the `sold` seat and its `confirmed` transaction. */
export interface PayResult {
  readonly outcome: "confirmed";
  readonly seat: Seat;
  readonly transaction: PurchaseTransaction;
}

/** Options for constructing a {@link TicketingService}. */
export interface TicketingServiceOptions {
  /** Epoch-seconds clock; defaults to {@link systemClock}. */
  readonly clock?: Clock;
  /** Hold window in seconds; defaults to {@link DEFAULT_HOLD_WINDOW_SECONDS}. */
  readonly holdWindow?: number;
  /** Max retry attempts on transient throttling; defaults to {@link MAX_RETRY_ATTEMPTS}. */
  readonly maxAttempts?: number;
  /** Base backoff delay in ms; defaults to {@link DEFAULT_BASE_DELAY_MS}. */
  readonly baseDelayMs?: number;
}

/** DynamoDB SDK error names that indicate a transient, retryable throttle. */
const RETRYABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "ThrottlingError",
]);

/**
 * Application service composing {@link SeatRepository} and
 * {@link TransactionRepository} into the purchasing lifecycle use cases.
 */
export class TicketingService {
  private readonly clock: Clock;
  private readonly holdWindow: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(
    private readonly seatRepo: SeatRepository = new SeatRepository(),
    private readonly txnRepo: TransactionRepository = new TransactionRepository(),
    opts: TicketingServiceOptions = {},
    // Section catalog is injected as an optional 4th param (after `opts`) so the
    // existing positional forms — `new TicketingService(seatRepo, txnRepo)` and
    // `new TicketingService(seatRepo, txnRepo, opts)` — keep working unchanged.
    private readonly sectionRepo: SectionRepository = new SectionRepository(),
  ) {
    this.clock = opts.clock ?? systemClock;
    this.holdWindow = opts.holdWindow ?? DEFAULT_HOLD_WINDOW_SECONDS;
    this.maxAttempts = opts.maxAttempts ?? MAX_RETRY_ATTEMPTS;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  }

  /**
   * Browse a section's seat map (AP2 — GSI1 query for available seats;
   * Requirements 3.1, 11.3). DynamoDB op: `SeatRepository.querySeatMap`.
   */
  async getSeatMap(venue: string, section: string): Promise<SeatMapEntry[]> {
    return this.withThrottleRetry(() => this.seatRepo.querySeatMap({ venue, section }));
  }

  /**
   * Full section seat map: return EVERY seat in a section with its EFFECTIVE
   * status at read time, so a UI can render green=available, purple=held,
   * red=sold. Reads all seats from the base table
   * (`SeatRepository.queryAllSeats`) and, for each, computes the status against
   * the service clock `now` (epoch seconds), mirroring the design's
   * condition-at-read-time rule (a held-but-expired seat reads as available):
   *   - `sold`                                            → `"sold"`
   *   - `held` AND `Hold_Expiration > now`                → `"held"`
   *   - otherwise (available, or held-but-expired)        → `"available"`
   */
  async getSectionSeats(
    venue: string,
    section: string,
  ): Promise<Array<{ row: string; seat: string; status: "available" | "held" | "sold" }>> {
    const seats = await this.withThrottleRetry(() =>
      this.seatRepo.queryAllSeats({ venue, section }),
    );
    const now = this.clock();
    return seats.map((s) => {
      let status: "available" | "held" | "sold";
      if (s.Seat_Status === "sold") {
        status = "sold";
      } else if (
        s.Seat_Status === "held" &&
        s.Hold_Expiration !== undefined &&
        s.Hold_Expiration > now
      ) {
        status = "held";
      } else {
        status = "available";
      }
      return { row: s.Row, seat: s.Seat_Number, status };
    });
  }

  /**
   * Count available seats in a section (AP3 — GSI1 `Select = COUNT`;
   * Requirements 3.4, 11.4). DynamoDB op: `SeatRepository.countSectionAvailability`.
   */
  async getSectionCount(venue: string, section: string): Promise<number> {
    return this.withThrottleRetry(() =>
      this.seatRepo.countSectionAvailability({ venue, section }),
    );
  }

  /**
   * Look up a single seat (AP1 — strongly consistent GetItem; Requirements 11.1,
   * 11.2). DynamoDB op: `SeatRepository.getSeat`.
   *
   * @throws {NotFoundError} if the seat does not exist (Requirement 11.2).
   */
  async getSeat(venue: string, section: string, row: string, seat: string): Promise<Seat> {
    const identity: SeatIdentity = { venue, section, row, seat };
    const found = await this.withThrottleRetry(() => this.seatRepo.getSeat(identity));
    if (found === undefined) {
      throw new NotFoundError("seat", seatKeyString(identity));
    }
    return found;
  }

  /**
   * Hold a seat for a fan, then open a pending purchase transaction (design:
   * `available → held`, Requirement 4; AP6 hold + AP10 create-transaction).
   *
   * Steps:
   *   1. Generate a fresh `txnId` (`crypto.randomUUID`).
   *   2. AP6 — `SeatRepository.hold(identity, fanId, holdWindow, now)` flips
   *      `available → held` and stamps `Hold_Expiration = now + holdWindow`.
   *   3. AP10 — `TransactionRepository.createTransaction({fanId, txnId, seatRef})`
   *      opens the pending transaction referencing the held seat.
   *
   * @returns the held seat, the new `txnId`, and the hold expiry (epoch seconds).
   * @throws {SeatNotAvailableError} if the seat is not holdable — surfaced as a
   *   defined conflict the API maps to `409` (Requirement 4.6).
   */
  async holdSeat(input: HoldSeatInput): Promise<HoldSeatResult> {
    const identity: SeatIdentity = {
      venue: input.venue,
      section: input.section,
      row: input.row,
      seat: input.seat,
    };
    const txnId = randomUUID();
    const seatRef = seatKeyString(identity);

    return this.withThrottleRetry(async () => {
      const now = this.clock();
      // AP6 — conditional `available → held`. A ConditionalCheckFailed surfaces
      // as SeatNotAvailableError, a defined conflict (Requirement 4.6).
      const hold = await this.seatRepo.hold(identity, input.fanId, this.holdWindow, now);
      // The seat may carry per-seat pricing (`Price`); `hold` is the ALL_NEW
      // image, so read it directly when present (no extra GetItem needed).
      const price = (hold as { Price?: number }).Price;
      // AP10 — open the pending purchase transaction for this held seat, passing
      // the seat's price as the transaction amount when the seat is priced.
      await this.txnRepo.createTransaction({ fanId: input.fanId, txnId, seatRef, amount: price });
      return {
        hold,
        txnId,
        holdExpiration: hold.Hold_Expiration ?? now + this.holdWindow,
        price,
      };
    });
  }

  /**
   * Venue overview: for each catalog section, return its tier/price/capacity and
   * a live availability count. The catalog is read once
   * (`SectionRepository.listSections`), then the per-section counts (AP3 — GSI1
   * `Select = COUNT`) are fetched in parallel via `Promise.all`.
   */
  async listVenueSections(venue: string): Promise<VenueSectionSummary[]> {
    return this.withThrottleRetry(async () => {
      const sections = await this.sectionRepo.listSections(venue);
      return Promise.all(
        sections.map(async (s) => ({
          venue: s.Venue,
          section: s.Section,
          tier: s.Tier,
          price: s.Price,
          capacity: s.Capacity,
          available: await this.seatRepo.countSectionAvailability({
            venue: s.Venue,
            section: s.Section,
          }),
        })),
      );
    });
  }

  /**
   * Pay for a held seat and, on success, atomically confirm it (mirrors
   * `src/payment.ts` admission + `src/confirm.ts` atomic confirm, executed
   * against the repositories; Requirements 5.*, 6.1–6.3, 8.2, 9.3).
   *
   * Admission (evaluated from a strongly consistent AP1 read; all must hold,
   * else rejected without capturing funds and nothing is mutated):
   *   1. seat is `held`                                   (Requirement 5.1),
   *   2. hold not expired (`now < Hold_Expiration`)       (Requirements 5.6, 9.4),
   *   3. seat's `Holder_Identifier` equals `fanId`        (Requirement 5.7).
   *
   * Outcome (processor result injected for the demo; default `success`):
   *   - `success`           → `TransactionRepository.markPaid` (`pending → paid`)
   *     then `SeatRepository.confirm` (AP7 `TransactWriteItems`: seat
   *     `held → sold` + txn `paid → confirmed`); returns the confirmed pair
   *     (Requirements 5.2, 6.1, 6.3).
   *   - `failure`/`timeout` → `TransactionRepository.markFailed`
   *     (`pending → failed`), seat left `held` until expiry, then
   *     {@link PaymentDeclinedError} (Requirements 5.4, 5.5).
   *
   * DynamoDB ops: AP1 GetItem, `markPaid`/`markFailed` UpdateItem, AP7
   * `TransactWriteItems` (confirm).
   *
   * @throws {NotFoundError} if the seat does not exist.
   * @throws {PaymentNotAllowedError} on a failed admission precondition (→ 409).
   * @throws {PaymentDeclinedError} on processor failure/timeout (→ 402).
   * @throws {SeatConfirmationRejectedError} if the atomic confirm is rejected (→ 409).
   */
  async pay(input: PayInput): Promise<PayResult> {
    const identity: SeatIdentity = {
      venue: input.venue,
      section: input.section,
      row: input.row,
      seat: input.seat,
    };
    const processorResult: ProcessorResult = input.processorResult ?? "success";

    return this.withThrottleRetry(async () => {
      const now = this.clock();

      // AP1 — strongly consistent read to evaluate admission (Requirement 5.1).
      const seat = await this.seatRepo.getSeat(identity);
      if (seat === undefined) {
        throw new NotFoundError("seat", seatKeyString(identity));
      }

      // Admission: status → expiry → holder (an expired hold is invalid for
      // everyone, so `hold-expired` takes precedence over a holder mismatch).
      if (seat.Seat_Status !== "held") {
        throw new PaymentNotAllowedError("seat-not-held", identity);
      }
      if (seat.Hold_Expiration === undefined || seat.Hold_Expiration <= now) {
        throw new PaymentNotAllowedError("hold-expired", identity);
      }
      if (seat.Holder_Identifier !== input.fanId) {
        throw new PaymentNotAllowedError("holder-mismatch", identity);
      }

      if (processorResult !== "success") {
        // Processor failed/timed out: record the failed payment; leave seat held
        // (Requirements 5.4, 5.5). No funds captured.
        await this.txnRepo.markFailed(input.fanId, input.txnId);
        throw new PaymentDeclinedError(processorResult);
      }

      // Success: capture (mark paid), then atomically confirm seat + txn (AP7).
      await this.txnRepo.markPaid(input.fanId, input.txnId);
      await this.seatRepo.confirm(identity, input.fanId, input.txnId, now);

      // Read back the committed `sold` seat and `confirmed` transaction.
      const [confirmedSeat, transaction] = await Promise.all([
        this.seatRepo.getSeat(identity),
        this.txnRepo.getTransaction(input.fanId, input.txnId),
      ]);
      if (confirmedSeat === undefined) {
        throw new NotFoundError("seat", seatKeyString(identity));
      }
      if (transaction === undefined) {
        throw new NotFoundError("transaction", `${input.fanId}/${input.txnId}`);
      }
      return { outcome: "confirmed", seat: confirmedSeat, transaction };
    });
  }

  /**
   * Release a held seat back to `available` (AP8 — conditional
   * `held → available`; Requirement 6.4). DynamoDB op: `SeatRepository.release`.
   *
   * @throws {SeatNotHeldError} if the seat is not currently `held` (→ 409;
   *   Requirements 6.7, 6.8).
   */
  async releaseSeat(identity: SeatIdentity): Promise<Seat> {
    return this.withThrottleRetry(() => this.seatRepo.release(identity));
  }

  /**
   * Retrieve a fan's purchase transaction (AP5 — strongly consistent GetItem;
   * Requirements 11.6, 11.7). DynamoDB op: `TransactionRepository.getTransaction`.
   *
   * @throws {NotFoundError} if the transaction does not exist (Requirement 11.7).
   */
  async getTransaction(fanId: string, txnId: string): Promise<PurchaseTransaction> {
    const txn = await this.withThrottleRetry(() =>
      this.txnRepo.getTransaction(fanId, txnId),
    );
    if (txn === undefined) {
      throw new NotFoundError("transaction", `${fanId}/${txnId}`);
    }
    return txn;
  }

  /**
   * Asynchronous counterpart of `withThrottleRetry` from `src/access.ts`
   * (Requirement 10.9). Runs `op` and, on a transient throttling error, retries
   * with the same bounded exponential-backoff schedule ({@link backoffDelayMs},
   * up to {@link maxAttempts} attempts). Non-transient errors (e.g. a
   * condition-check failure surfaced as a domain rejection) are re-thrown
   * immediately and never retried. After exhausting retries it throws
   * {@link RetryExhaustedError}; because each DynamoDB call is atomic, no partial
   * write occurs and state is preserved.
   *
   * The reference helper is synchronous (it drives the pure in-memory model) so
   * it cannot `await` the AWS SDK's promises — hence this adapter, which reuses
   * the reference contract (schedule + error types) while awaiting async ops and
   * additionally treating the SDK's native throttling exceptions as transient.
   */
  private async withThrottleRetry<T>(op: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await op();
      } catch (error) {
        if (!isTransient(error)) {
          throw error;
        }
        lastError = error;
        if (attempt < this.maxAttempts) {
          await sleep(backoffDelayMs(attempt, this.baseDelayMs));
        }
      }
    }
    throw new RetryExhaustedError(this.maxAttempts, lastError);
  }
}

/** True iff `error` is a transient, retryable throttling failure (Requirement 10.9). */
function isTransient(error: unknown): boolean {
  if (error instanceof ThrottlingError) {
    return true;
  }
  return error instanceof Error && RETRYABLE_ERROR_NAMES.has(error.name);
}

/** Promise-based sleep for backoff waits between retry attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export the repository conflict error so API/error-mapping code has a single
// import surface and the service's public contract is self-describing.
export { SeatNotAvailableError };
