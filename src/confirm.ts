/**
 * Fair Seat Purchase — atomic confirmation (seat + transaction).
 *
 * This module models the design's `held → sold` confirmation as a
 * `TransactWriteItems` operation (design: Reservation Strategy → `held → sold`).
 * Confirmation must change **two items together** — flip the seat to `sold` and
 * stamp its purchase transaction `confirmed` with a UTC timestamp — so a partial
 * commit can never leave a `sold` seat without a `confirmed` transaction or vice
 * versa. That all-or-nothing guarantee is precisely what `TransactWriteItems`
 * provides (Requirements 6.3, 8.2; design Properties 7 & 8).
 *
 * The reference model's in-memory stores (`SeatStore`, `TransactionStore`) do not
 * offer a real multi-item transaction, so the all-or-nothing semantics are
 * modelled here explicitly:
 *
 *   1. **Evaluate BOTH preconditions first**, mutating nothing:
 *      - Seat guard (design): `Seat_Status = 'held' AND Holder_Identifier = fanId
 *        AND Hold_Expiration > now` (Requirements 6.1, 9.3; Property 7).
 *      - Transaction guard (design): `Payment_Status = 'paid'` — i.e. the txn is
 *        in the `paid` phase, ready for `paid → confirmed` (Requirement 2.3).
 *   2. If **either** guard fails, throw {@link ConfirmationRejectedError} and
 *      leave **both** the seat and the transaction unchanged (Requirements 6.2,
 *      8.2, 8.3; Property 8 — no partial outcome is ever observable).
 *   3. Only when **both** guards pass are the two writes committed. Because both
 *      preconditions were validated up-front and the reference model executes
 *      synchronously (no interleaving between the checks and the writes), both
 *      commits are guaranteed to succeed — so there is no code path that leaves a
 *      partial commit, and no rollback (which would illegally move a seat out of
 *      `sold`) is ever required.
 *
 * `sold` has **no outbound transition** anywhere in this module: the seat write
 * only ever moves `held → sold`, guaranteeing `sold` permanence (Requirement 7.6).
 *
 * Concurrency: two confirmations racing for the same `held` seat resolve to
 * exactly one winner implicitly — the first flips the seat to `sold`, so a second
 * confirmation's seat guard (`Seat_Status = 'held'`) fails and is rejected. The
 * concurrency model (task 8.1) exercises this via serialized attempts.
 */

import { type Seat, type SeatIdentity } from "./seat.js";
import { type SeatStore, SeatNotFoundError } from "./store.js";
import {
  type PurchaseTransaction,
  type TransactionStore,
  TransactionNotFoundError,
  applyTransition,
  txnPhase,
} from "./transaction.js";

/**
 * Why a confirmation was rejected. The first three concern the seat guard, the
 * last concerns the transaction guard:
 *
 * - `seat-not-held`   : the seat's `Seat_Status` was not `held` (e.g. already
 *   `sold` or `available`) (Requirements 6.2, 8.3).
 * - `holder-mismatch` : the seat's `Holder_Identifier` did not equal the
 *   confirming fan (Requirements 6.1, 6.2).
 * - `hold-expired`    : the hold had already expired (`Hold_Expiration <= now`),
 *   so the sale must not be captured (Requirements 9.3, 6.2).
 * - `txn-not-paid`    : the purchase transaction was not in the `paid` phase, so
 *   `paid → confirmed` is not permitted (Requirement 2.3).
 */
export type ConfirmationRejectionReason =
  | "seat-not-held"
  | "holder-mismatch"
  | "hold-expired"
  | "txn-not-paid";

/**
 * Defined failure surfaced when a confirmation is rejected. When this is thrown,
 * **neither** the seat nor the transaction has been modified (Requirements 6.2,
 * 8.2; Property 8). The `reason` records which precondition failed so callers can
 * translate it into an appropriate response ("seat cannot be confirmed").
 */
export class ConfirmationRejectedError extends Error {
  constructor(
    public readonly reason: ConfirmationRejectionReason,
    public readonly seatIdentity: SeatIdentity,
    public readonly fanId: string,
    public readonly txnId: string,
    message?: string,
  ) {
    super(
      message ??
        `Confirmation rejected (${reason}) for fan=${fanId} txn=${txnId} ` +
          `seat=venue:${seatIdentity.venue} section:${seatIdentity.section} ` +
          `row:${seatIdentity.row} seat:${seatIdentity.seat}.`,
    );
    this.name = "ConfirmationRejectedError";
  }
}

/** Arguments to {@link confirmPurchase}. */
export interface ConfirmPurchaseInput {
  /** The seat being confirmed. */
  readonly seatIdentity: SeatIdentity;
  /** The confirming fan; must match the seat's `Holder_Identifier`. */
  readonly fanId: string;
  /** The purchase transaction id (within the fan's partition). */
  readonly txnId: string;
  /** Current time as epoch seconds; compared against `Hold_Expiration`. */
  readonly now: number;
}

/**
 * The successful, committed outcome of a confirmation: the `sold` seat and its
 * `confirmed` transaction (with a UTC `Confirmation_Timestamp`).
 */
export interface ConfirmPurchaseResult {
  /** The seat after transitioning `held → sold`. */
  readonly seat: Seat;
  /** The transaction after transitioning `paid → confirmed`. */
  readonly transaction: PurchaseTransaction;
}

/**
 * Atomically confirm a purchase: transition the seat `held → sold` and its
 * purchase transaction `paid → confirmed` (with a UTC confirmation timestamp)
 * as a single all-or-nothing unit, modelling DynamoDB `TransactWriteItems`
 * (Requirements 2.3, 6.1, 6.3, 8.2).
 *
 * Preconditions (evaluated together before any write):
 * - Seat: `Seat_Status = 'held'` AND `Holder_Identifier = fanId` AND not expired
 *   (`Hold_Expiration > now`) (Requirements 6.1, 9.3; Property 7).
 * - Transaction: in the `paid` phase, i.e. `Payment_Status = 'paid'` and not yet
 *   confirmed (Requirement 2.3).
 *
 * If either precondition fails, {@link ConfirmationRejectedError} is thrown and
 * neither item is modified (Requirements 6.2, 8.2; Property 8). If both pass,
 * both writes are committed and the resulting `sold` seat + `confirmed`
 * transaction are returned.
 *
 * @throws {SeatNotFoundError} if the seat does not exist.
 * @throws {TransactionNotFoundError} if the transaction does not exist.
 * @throws {ConfirmationRejectedError} if either guard fails (nothing mutated).
 */
export function confirmPurchase(
  seatStore: SeatStore,
  txnStore: TransactionStore,
  input: ConfirmPurchaseInput,
): ConfirmPurchaseResult {
  const { seatIdentity, fanId, txnId, now } = input;

  // --- Load both items (read-only). Missing items are a distinct error class
  //     from a guard rejection and never mutate state.
  const seat = seatStore.getSeat(seatIdentity);
  if (seat === undefined) {
    throw new SeatNotFoundError(seatIdentity);
  }
  const txn = txnStore.getTransaction(fanId, txnId);
  if (txn === undefined) {
    throw new TransactionNotFoundError(fanId, txnId);
  }

  // --- (a) Evaluate BOTH preconditions first, mutating nothing. ---

  // Seat guard: held AND holder matches AND not expired (design; Property 7).
  if (seat.Seat_Status !== "held") {
    throw new ConfirmationRejectedError("seat-not-held", seatIdentity, fanId, txnId);
  }
  if (seat.Holder_Identifier !== fanId) {
    throw new ConfirmationRejectedError("holder-mismatch", seatIdentity, fanId, txnId);
  }
  if (seat.Hold_Expiration === undefined || seat.Hold_Expiration <= now) {
    throw new ConfirmationRejectedError("hold-expired", seatIdentity, fanId, txnId);
  }

  // Transaction guard: must be in the `paid` phase for `paid → confirmed`.
  if (txnPhase(txn) !== "paid") {
    throw new ConfirmationRejectedError("txn-not-paid", seatIdentity, fanId, txnId);
  }

  // Purely validate the transaction transition up-front (throws only if not
  // permitted, which the `paid`-phase check above already precludes). This
  // guarantees the transaction commit below cannot fail, so committing the seat
  // first can never strand a `sold` seat without a `confirmed` transaction.
  applyTransition(txn, "confirmed");

  // --- (b) Both preconditions passed → commit BOTH writes. ---
  // Execution is synchronous with no interleaving between the checks above and
  // the writes below, so both commits are guaranteed to succeed together
  // (all-or-nothing; Property 8). The seat write uses the same guard as a
  // defensive conditional (mirroring the TransactWriteItems ConditionExpression);
  // it is guaranteed satisfied by the checks above.
  const soldSeat = seatStore.conditionalUpdate(seatIdentity, {
    condition: (current) =>
      current.Seat_Status === "held" &&
      current.Holder_Identifier === fanId &&
      current.Hold_Expiration !== undefined &&
      current.Hold_Expiration > now,
    mutate: (current) => {
      current.Seat_Status = "sold";
      // `sold` seats carry no active hold: clear the expiration (design REMOVEs
      // Hold_Expiration / GSI2 keys). `Holder_Identifier` is retained per R1.7.
      delete current.Hold_Expiration;
      current.Version += 1;
      return current;
    },
  });

  const confirmedTxn = txnStore.transition(fanId, txnId, "confirmed");

  return { seat: soldSeat, transaction: confirmedTxn };
}
