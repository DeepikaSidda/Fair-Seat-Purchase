/**
 * Fair Seat Purchase — payment orchestration model.
 *
 * This module is the reference-model stand-in for the "Payment orchestrator"
 * component documented in `design.md` (Components → Payment orchestrator, and
 * Error Handling → Payment errors) and validated by Property 12 (Payment
 * precondition and outcome).
 *
 * The orchestrator models what happens when a fan attempts to pay for a seat they
 * are holding, while the hold is still active. It sits between the seat state
 * model (`./seat.js`, `./transitions.js`) and the purchase-transaction lifecycle
 * (`./transaction.js`): it decides whether a payment attempt is *admissible*, and
 * — only if it is — invokes an injectable external-processor callback and records
 * the resulting `Payment_Status` on the transaction.
 *
 * Precondition (Requirement 5.1): a payment is accepted ONLY WHILE
 *   - the seat is `held`, AND
 *   - the current time is before `Hold_Expiration` (the hold has NOT expired), AND
 *   - the paying fan matches the seat's `Holder_Identifier`.
 * If any precondition fails, the payment is rejected WITHOUT capturing funds and
 * the transaction's `Payment_Status` is left unchanged:
 *   - hold expired    → rejection `hold-expired`   (Requirements 5.6, 9.4)
 *   - holder mismatch → rejection `holder-mismatch` (Requirement 5.7)
 *   - seat not held   → rejection `seat-not-held`   (Requirement 5.1)
 *
 * Outcome on an accepted payment: the injectable {@link ProcessPayment} callback
 * models the external processor and the 30-second processing window
 * conceptually. It returns one of `success` | `failure` | `timeout`:
 *   - `success`           → `Payment_Status = 'paid'`   (Requirement 5.2)
 *   - `failure`/`timeout` → `Payment_Status = 'failed'`, and the seat is left
 *                           `held` until its natural expiry (Requirements 5.4, 5.5)
 *
 * This module deliberately does NOT perform the seat `held → sold` confirmation
 * (that is task 7.2's `confirmPurchase`, an atomic seat+transaction
 * `TransactWriteItems`). Payment sets `Payment_Status` only; in the full flow a
 * `paid` result would then be followed by confirmation. Keeping the two concerns
 * separate mirrors the design (payment capture is out of the DynamoDB
 * transaction; the confirm couples the `paid` transaction to the seat flip).
 *
 * Everything here is deterministic and side-effect free with respect to real
 * time and real payment processors: "now" is passed in as epoch seconds and the
 * processor is injected, so the model is fully testable (Property 12, task 7.5).
 */

import { type Seat } from "./seat.js";
import { isHoldExpired } from "./transitions.js";
import {
  markFailed,
  markPaid,
  type PaymentStatus,
  type PurchaseTransaction,
} from "./transaction.js";

/**
 * The result an external payment processor can return for an accepted payment
 * attempt (Requirement 5.1, 5.2, 5.4, 5.5).
 *
 * - `success` : funds captured; the payment succeeded within the processing
 *   window.
 * - `failure` : the processor declined/failed; no funds captured.
 * - `timeout` : processing did not complete within the 30-second window
 *   (Requirement 5.5). Modeled as a distinct outcome so callers/tests can assert
 *   the timeout path without real timers; it results in the same `failed`
 *   Payment_Status as an outright failure.
 */
export type ProcessPaymentResult = "success" | "failure" | "timeout";

/**
 * Context handed to the injected {@link ProcessPayment} callback. It carries the
 * admitted seat/transaction/fan and the evaluation instant so a processor model
 * can be fully deterministic in tests.
 */
export interface PaymentContext {
  /** The seat being paid for (guaranteed `held`, unexpired, held by `fanId`). */
  readonly seat: Seat;
  /** The purchase transaction whose `Payment_Status` will be updated. */
  readonly txn: PurchaseTransaction;
  /** The paying fan's identifier (matches the seat's `Holder_Identifier`). */
  readonly fanId: string;
  /** The evaluation instant, epoch seconds. */
  readonly now: number;
}

/**
 * The injectable external-payment-processor model. Given the admitted payment
 * context, it returns whether the payment succeeded, failed, or timed out. It is
 * only ever invoked once the admission preconditions have passed, so it models
 * exactly the "capture funds" step (Requirement 5.1). Keeping it injectable means
 * no real network/processor is contacted and the 30-second window is modeled
 * conceptually via the `timeout` result.
 */
export type ProcessPayment = (context: PaymentContext) => ProcessPaymentResult;

/**
 * Why a payment ended the way it did.
 *
 * Rejection reasons (no funds captured, `Payment_Status` unchanged):
 * - `seat-not-held`   : the seat is not in the `held` state (Requirement 5.1).
 * - `hold-expired`    : the hold's `Hold_Expiration` has passed (Requirements 5.6, 9.4).
 * - `holder-mismatch` : the paying fan is not the seat's holder (Requirement 5.7).
 *
 * Failure reasons (accepted, processor contacted, `Payment_Status = 'failed'`):
 * - `processor-failure` : the processor declined/failed (Requirement 5.4).
 * - `processor-timeout` : processing exceeded the window (Requirement 5.5).
 */
export type PaymentReason =
  | "seat-not-held"
  | "hold-expired"
  | "holder-mismatch"
  | "processor-failure"
  | "processor-timeout";

/**
 * The outcome of a payment attempt.
 *
 * - `paid`     : accepted and the processor succeeded → `Payment_Status = 'paid'`.
 * - `failed`   : accepted but the processor failed or timed out →
 *   `Payment_Status = 'failed'`; the seat remains `held` until expiry.
 * - `rejected` : a precondition failed; no funds captured and `Payment_Status`
 *   is left unchanged.
 */
export type PaymentOutcome = "paid" | "failed" | "rejected";

/**
 * The result of an {@link initiatePayment} call.
 *
 * `txn` is the resulting transaction: the transitioned copy on `paid`/`failed`,
 * or the original unchanged transaction on `rejected` (the reducer never mutates
 * its input, so a rejected attempt provably leaves state unchanged). `outcome`
 * and `paymentStatus` make the result unambiguous for callers and tests.
 */
export interface PaymentResult {
  /** High-level outcome of the attempt. */
  readonly outcome: PaymentOutcome;
  /** The resulting `Payment_Status` (unchanged from input on `rejected`). */
  readonly paymentStatus: PaymentStatus;
  /** The resulting transaction (transitioned, or the original on `rejected`). */
  readonly txn: PurchaseTransaction;
  /**
   * True iff the preconditions passed and the external processor was contacted.
   * `false` for every rejection (Requirements 5.6, 5.7 — rejected before
   * contacting the processor).
   */
  readonly accepted: boolean;
  /**
   * True iff funds were captured (only on an accepted, successful payment). A
   * rejection or a failed/timed-out payment captures no funds (Requirements 5.4,
   * 5.5, 5.6, 5.7).
   */
  readonly fundsCaptured: boolean;
  /** The reason for a rejection or failure; absent when `outcome === 'paid'`. */
  readonly reason?: PaymentReason;
}

/** Arguments to {@link initiatePayment}. */
export interface InitiatePaymentInput {
  /** The seat the fan is attempting to pay for. */
  readonly seat: Seat;
  /** The purchase transaction associated with the seat/fan. */
  readonly txn: PurchaseTransaction;
  /** The paying fan's identifier. */
  readonly fanId: string;
  /** The current time, epoch seconds. */
  readonly now: number;
  /** The injectable external-processor model (see {@link ProcessPayment}). */
  readonly processPayment: ProcessPayment;
}

/**
 * Attempt to pay for a held seat, modeling payment during an active hold
 * (Requirement 5.1–5.7, 9.4; design Property 12).
 *
 * Admission (all three must hold, else the attempt is rejected without capturing
 * funds and `Payment_Status` is left unchanged):
 *   1. the seat is `held`                              (Requirement 5.1),
 *   2. the hold has not expired (`now < Hold_Expiration`) (Requirements 5.6, 9.4),
 *   3. the seat's `Holder_Identifier` equals `fanId`   (Requirement 5.7).
 *
 * The checks are ordered status → expiry → holder: an expired hold is treated as
 * no longer a valid hold for anyone, so `hold-expired` takes precedence over a
 * holder mismatch on an already-expired seat.
 *
 * On admission, the injected `processPayment` callback is invoked exactly once:
 *   - `success`           → transaction transitions `pending → paid`
 *                           (`Payment_Status = 'paid'`, Requirement 5.2),
 *   - `failure`/`timeout` → transaction transitions `pending → failed`
 *                           (`Payment_Status = 'failed'`), and the seat is left
 *                           `held` until its natural expiry (Requirements 5.4, 5.5).
 *
 * The seat `held → sold` confirmation is intentionally NOT performed here; a
 * `paid` result is the precondition the confirm step (task 7.2) later couples to
 * the seat flip via `TransactWriteItems`.
 *
 * This function never mutates its inputs. The `paid`/`failed` results carry a new
 * transaction produced by the pure lifecycle reducer; the `rejected` result
 * returns the original transaction, which is why a rejected attempt provably
 * leaves `Payment_Status` unchanged.
 */
export function initiatePayment(input: InitiatePaymentInput): PaymentResult {
  const { seat, txn, fanId, now, processPayment } = input;

  // ── Admission checks (Requirement 5.1). On any failure: reject, no capture,
  //    Payment_Status unchanged, processor never contacted. ──────────────────

  // 1. Seat must be in the `held` state (Requirement 5.1).
  if (seat.Seat_Status !== "held") {
    return rejection(txn, "seat-not-held");
  }

  // 2. The hold must not have expired: now < Hold_Expiration (Requirements 5.6, 9.4).
  //    `isHoldExpired` implements the design's `Hold_Expiration <= now` rule.
  if (isHoldExpired(seat, now)) {
    return rejection(txn, "hold-expired");
  }

  // 3. The paying fan must be the current holder (Requirement 5.7).
  if (seat.Holder_Identifier !== fanId) {
    return rejection(txn, "holder-mismatch");
  }

  // ── Accepted: contact the (injected) processor exactly once (Requirement 5.1). ──
  const processorResult = processPayment({ seat, txn, fanId, now });

  if (processorResult === "success") {
    // Funds captured; record the payment (Requirement 5.2).
    const paidTxn = markPaid(txn);
    return {
      outcome: "paid",
      paymentStatus: paidTxn.Payment_Status,
      txn: paidTxn,
      accepted: true,
      fundsCaptured: true,
    };
  }

  // `failure` or `timeout`: no funds captured. Record the failed payment and
  // leave the seat `held` until expiry (Requirements 5.4, 5.5). The seat is not
  // touched here, so it remains held for the fan to retry while the hold lasts.
  const failedTxn = markFailed(txn);
  return {
    outcome: "failed",
    paymentStatus: failedTxn.Payment_Status,
    txn: failedTxn,
    accepted: true,
    fundsCaptured: false,
    reason: processorResult === "timeout" ? "processor-timeout" : "processor-failure",
  };
}

/**
 * Build a rejection result: no funds captured, transaction returned unchanged so
 * `Payment_Status` is provably preserved (Requirements 5.6, 5.7).
 */
function rejection(txn: PurchaseTransaction, reason: PaymentReason): PaymentResult {
  return {
    outcome: "rejected",
    paymentStatus: txn.Payment_Status,
    txn,
    accepted: false,
    fundsCaptured: false,
    reason,
  };
}
