/**
 * Fair Seat Purchase — TypeScript reference model.
 *
 * Entry point for the reference implementation of the seat state machine,
 * guarded transitions, purchase transactions, the concurrency model, and the
 * availability view. Task 6.1 implements the core seat entity model:
 * the `SeatStatus` type, the `Seat` entity, the injective identity→key mapping,
 * and the in-memory store with duplicate-rejecting, conditional-write semantics.
 * Later tasks build the transition engine and transactions on top of this.
 */

export {
  type SeatStatus,
  type SeatIdentity,
  type SeatKey,
  type Seat,
  SEAT_STATUSES,
  isSeatStatus,
  assertSeatStatus,
  InvalidSeatStatusError,
  toPK,
  toSK,
  seatKey,
  seatKeyString,
} from "./seat.js";

export {
  type ConditionalUpdate,
  SeatStore,
  DuplicateSeatError,
  ConditionalCheckFailedError,
  SeatNotFoundError,
} from "./store.js";

export {
  type SeatTransition,
  type TransitionRejectionReason,
  type HoldOptions,
  type Clock,
  PERMITTED_TRANSITIONS,
  DEFAULT_HOLD_WINDOW_SECONDS,
  MIN_HOLD_WINDOW_SECONDS,
  MAX_HOLD_WINDOW_SECONDS,
  systemClock,
  isPermittedTransition,
  isSeatHoldable,
  isHoldExpired,
  assertHoldWindow,
  InvalidHoldWindowError,
  TransitionRejectedError,
  holdSeat,
  releaseSeat,
  confirmSeat,
} from "./transitions.js";

export {
  type SectionRef,
  isEffectiveAvailable,
  seatMap,
  sectionAvailabilityCount,
  sectionCapacity,
} from "./availability.js";

export {
  type ConfirmationRejectionReason,
  type ConfirmPurchaseInput,
  type ConfirmPurchaseResult,
  ConfirmationRejectedError,
  confirmPurchase,
} from "./confirm.js";

export {
  type PaymentStatus,
  type TxnState,
  type TxnPhase,
  type PurchaseTransaction,
  type CreateTransactionInput,
  type Clock as TransactionClock,
  PAYMENT_STATUSES,
  TXN_STATES,
  ALLOWED_TRANSITIONS,
  isPaymentStatus,
  isTxnState,
  txnPK,
  txnSK,
  txnKeyString,
  txnPhase,
  isAllowedTransition,
  createTransaction,
  applyTransition,
  markPaid,
  markFailed,
  confirm as confirmTransaction,
  InvalidTransactionTransitionError,
  DuplicateTransactionError,
  TransactionNotFoundError,
  TransactionStore,
} from "./transaction.js";

export {
  type ProcessPaymentResult,
  type PaymentContext,
  type ProcessPayment,
  type PaymentReason,
  type PaymentOutcome,
  type PaymentResult,
  type InitiatePaymentInput,
  initiatePayment,
} from "./payment.js";

export {
  type AvailabilityQueryOptions,
  type RetryOptions,
  AVAILABILITY_QUERY_BUDGET_MS,
  MAX_RETRY_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  InvalidSectionError,
  AvailabilityUnavailableError,
  ThrottlingError,
  RetryExhaustedError,
  sectionExists,
  querySeatMap,
  querySectionAvailabilityCount,
  lookupSeat,
  lookupTransaction,
  backoffDelayMs,
  withThrottleRetry,
} from "./access.js";
