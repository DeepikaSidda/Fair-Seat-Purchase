/**
 * Fair Seat Purchase — purchase-transaction lifecycle model.
 *
 * This standalone module is the reference-model stand-in for the purchase
 * transaction item documented in `design.md` (Data Models → Purchase transaction
 * item) and its lifecycle (Property 13). A transaction records a fan's attempt to
 * buy exactly one seat and tracks its payment/confirmation progress.
 *
 * The design tracks two attributes on the item:
 * - `Payment_Status` ∈ {`pending`, `paid`, `failed`}
 * - `Txn_State`      ∈ {`pending`, `confirmed`, `failed`}
 *
 * Together these encode a single lifecycle "phase" that advances along exactly
 * three permitted transitions:
 *
 *     pending ──▶ paid ──▶ confirmed
 *        │
 *        └──────▶ failed
 *
 * Requirements covered:
 * - 2.1 A transaction references exactly one Fan and exactly one Seat.
 * - 2.2 Payment_Status restricted to {pending, paid, failed}; created as `pending`.
 * - 2.4 Only `pending → paid`, `pending → failed`, `paid → confirmed` are permitted;
 *       any other transition is rejected while the current state is retained.
 * - 2.6 A `failed` transaction is retained with no confirmation timestamp.
 * - 2.3 A `paid → confirmed` transition records a UTC ISO-8601 confirmation timestamp.
 *
 * A pure transition reducer (`applyTransition`) is the core primitive — a good fit
 * for the Property 13 test (task 7.4). A small in-memory `TransactionStore`,
 * analogous to `SeatStore`, is layered on top for convenience.
 */

/**
 * The payment state of a purchase transaction (Requirement 2.2). Exactly one of
 * these three values is ever valid for `Payment_Status`.
 */
export type PaymentStatus = "pending" | "paid" | "failed";

/** The set of valid payment statuses, used for runtime validation (Requirement 2.2). */
export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "pending",
  "paid",
  "failed",
] as const;

/**
 * The confirmation/lifecycle state of a purchase transaction. Exactly one of
 * these three values is ever valid for `Txn_State`.
 */
export type TxnState = "pending" | "confirmed" | "failed";

/** The set of valid transaction states, used for runtime validation. */
export const TXN_STATES: readonly TxnState[] = ["pending", "confirmed", "failed"] as const;

/**
 * The unified lifecycle phase of a transaction, derived from the
 * (`Payment_Status`, `Txn_State`) pair. This is the level at which the three
 * permitted transitions are expressed (Requirement 2.4).
 */
export type TxnPhase = "pending" | "paid" | "failed" | "confirmed";

/**
 * The purchase-transaction entity as stored in the reference model. Field names
 * mirror the DynamoDB attribute names in `design.md` so the reference model reads
 * as a faithful stand-in for the real item.
 */
export interface PurchaseTransaction {
  /** `TXN#<fanId>` — a fan's transactions live under their own partition. */
  readonly PK: string;
  /** `TXN#<txnId>` — unique transaction id within the fan's partition. */
  readonly SK: string;
  /** Entity discriminator for the single-table design. */
  readonly Entity_Type: "TXN";
  /** References exactly one Fan (Requirement 2.1). */
  readonly Fan_Id: string;
  /** References exactly one Seat, e.g. `SEAT#v#s|ROW#r#SEAT#n` (Requirement 2.1). */
  readonly Seat_Ref: string;
  /** Payment state (Requirement 2.2). */
  Payment_Status: PaymentStatus;
  /** Confirmation/lifecycle state. */
  Txn_State: TxnState;
  /** UTC ISO-8601, set only when confirmed (Requirements 2.3, 2.6). */
  Confirmation_Timestamp?: string;
  /** UTC ISO-8601 creation timestamp. */
  readonly Created_At: string;
}

/**
 * A clock abstraction so timestamps are deterministic in tests. Returns the
 * current instant; timestamps are always serialized to UTC ISO-8601.
 */
export type Clock = () => Date;

/** Default wall-clock. */
const systemClock: Clock = () => new Date();

/** Serialize a `Date` to a UTC ISO-8601 string (e.g. `2025-01-01T00:00:00.000Z`). */
function toUtcIso8601(date: Date): string {
  return date.toISOString();
}

/** Runtime type guard for {@link PaymentStatus} (Requirement 2.2). */
export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/** Runtime type guard for {@link TxnState}. */
export function isTxnState(value: unknown): value is TxnState {
  return typeof value === "string" && (TXN_STATES as readonly string[]).includes(value);
}

/**
 * Compute the base-table partition key for a fan's transactions.
 * `txnPK(fanId)` → `TXN#<fanId>` (design: Data Models → Purchase transaction item).
 */
export function txnPK(fanId: string): string {
  return `TXN#${fanId}`;
}

/**
 * Compute the base-table sort key for a transaction.
 * `txnSK(txnId)` → `TXN#<txnId>` (design: Data Models → Purchase transaction item).
 */
export function txnSK(txnId: string): string {
  return `TXN#${txnId}`;
}

/**
 * A single canonical string form of a transaction key, convenient for use as a
 * Map key in the in-memory store.
 */
export function txnKeyString(fanId: string, txnId: string): string {
  return `${txnPK(fanId)}|${txnSK(txnId)}`;
}

/** Arguments required to create a new purchase transaction. */
export interface CreateTransactionInput {
  /** The fan initiating the purchase (Requirement 2.1). */
  readonly fanId: string;
  /** The unique transaction id. */
  readonly txnId: string;
  /** Reference to the single seat being purchased (Requirement 2.1). */
  readonly seatRef: string;
}

/**
 * Create a new purchase transaction referencing exactly one fan and one seat
 * (Requirement 2.1). The transaction starts with `Payment_Status = 'pending'`
 * and `Txn_State = 'pending'` (Requirement 2.2), and records a UTC ISO-8601
 * `Created_At` timestamp.
 *
 * `clock` is injectable for deterministic tests; it defaults to the system clock.
 */
export function createTransaction(
  input: CreateTransactionInput,
  clock: Clock = systemClock,
): PurchaseTransaction {
  return {
    PK: txnPK(input.fanId),
    SK: txnSK(input.txnId),
    Entity_Type: "TXN",
    Fan_Id: input.fanId,
    Seat_Ref: input.seatRef,
    Payment_Status: "pending",
    Txn_State: "pending",
    Created_At: toUtcIso8601(clock()),
  };
}

/**
 * The three permitted lifecycle transitions, expressed as `[from, to]` phase
 * pairs (Requirement 2.4). No other transition is allowed.
 */
export const ALLOWED_TRANSITIONS: readonly (readonly [TxnPhase, TxnPhase])[] = [
  ["pending", "paid"],
  ["pending", "failed"],
  ["paid", "confirmed"],
] as const;

/**
 * Derive the unified lifecycle {@link TxnPhase} from a transaction's
 * (`Payment_Status`, `Txn_State`) pair.
 *
 * - `Payment_Status = 'failed'`  → `failed`
 * - `Payment_Status = 'paid'` and `Txn_State = 'confirmed'` → `confirmed`
 * - `Payment_Status = 'paid'` (not yet confirmed) → `paid`
 * - otherwise (`Payment_Status = 'pending'`) → `pending`
 */
export function txnPhase(txn: Pick<PurchaseTransaction, "Payment_Status" | "Txn_State">): TxnPhase {
  if (txn.Payment_Status === "failed") {
    return "failed";
  }
  if (txn.Payment_Status === "paid") {
    return txn.Txn_State === "confirmed" ? "confirmed" : "paid";
  }
  return "pending";
}

/** True iff `from → to` is one of the three permitted transitions (Requirement 2.4). */
export function isAllowedTransition(from: TxnPhase, to: TxnPhase): boolean {
  return ALLOWED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/**
 * Error thrown when a transition that is not one of the three permitted
 * transitions is requested. The transaction's current state is retained
 * (Requirement 2.4) because the reducer never mutates its input.
 */
export class InvalidTransactionTransitionError extends Error {
  constructor(
    public readonly from: TxnPhase,
    public readonly to: TxnPhase,
  ) {
    super(
      `Illegal transaction transition: ${from} → ${to}. ` +
        `Permitted transitions are pending → paid, pending → failed, paid → confirmed.`,
    );
    this.name = "InvalidTransactionTransitionError";
  }
}

/**
 * Pure lifecycle reducer: apply a requested transition to a transaction and
 * return the resulting transaction, leaving the input untouched.
 *
 * The transition is applied if and only if `phaseOf(txn) → to` is permitted
 * (Requirement 2.4); otherwise {@link InvalidTransactionTransitionError} is
 * thrown and — because the input is never mutated — the caller's transaction
 * retains its current state.
 *
 * Effects per target phase:
 * - `paid`      : `Payment_Status → 'paid'` (awaiting confirmation).
 * - `failed`    : `Payment_Status → 'failed'`, `Txn_State → 'failed'`, and no
 *                 confirmation timestamp is ever recorded (Requirement 2.6).
 * - `confirmed` : `Txn_State → 'confirmed'` and a UTC ISO-8601
 *                 `Confirmation_Timestamp` is recorded (Requirement 2.3).
 *
 * `clock` is injectable for deterministic tests; it defaults to the system clock.
 */
export function applyTransition(
  txn: PurchaseTransaction,
  to: TxnPhase,
  clock: Clock = systemClock,
): PurchaseTransaction {
  const from = txnPhase(txn);
  if (!isAllowedTransition(from, to)) {
    throw new InvalidTransactionTransitionError(from, to);
  }

  const next: PurchaseTransaction = { ...txn };
  switch (to) {
    case "paid":
      next.Payment_Status = "paid";
      break;
    case "failed":
      next.Payment_Status = "failed";
      next.Txn_State = "failed";
      break;
    case "confirmed":
      next.Txn_State = "confirmed";
      next.Confirmation_Timestamp = toUtcIso8601(clock());
      break;
    // `pending` is never a valid target (no transition leads to it), so it is
    // unreachable here — `isAllowedTransition` has already rejected it above.
  }
  return next;
}

/**
 * Convenience wrapper: transition `pending → paid` (Requirement 2.4). Throws
 * {@link InvalidTransactionTransitionError} if the transaction is not `pending`.
 */
export function markPaid(txn: PurchaseTransaction): PurchaseTransaction {
  return applyTransition(txn, "paid");
}

/**
 * Convenience wrapper: transition `pending → failed` (Requirements 2.4, 2.6).
 * Throws {@link InvalidTransactionTransitionError} if the transaction is not
 * `pending`.
 */
export function markFailed(txn: PurchaseTransaction): PurchaseTransaction {
  return applyTransition(txn, "failed");
}

/**
 * Convenience wrapper: transition `paid → confirmed`, recording a UTC ISO-8601
 * confirmation timestamp (Requirements 2.3, 2.4). Throws
 * {@link InvalidTransactionTransitionError} if the transaction is not `paid`.
 */
export function confirm(txn: PurchaseTransaction, clock: Clock = systemClock): PurchaseTransaction {
  return applyTransition(txn, "confirmed", clock);
}

/**
 * Error thrown when a transaction with the same (fanId, txnId) identity already
 * exists. Mirrors DynamoDB's `ConditionalCheckFailedException` on a conditional
 * `PutItem` guarded by `attribute_not_exists(PK)` (design AP10).
 */
export class DuplicateTransactionError extends Error {
  constructor(
    public readonly fanId: string,
    public readonly txnId: string,
  ) {
    super(`Duplicate transaction: a transaction already exists for fanId=${fanId} txnId=${txnId}.`);
    this.name = "DuplicateTransactionError";
  }
}

/**
 * Error thrown when an operation targets a transaction that does not exist
 * (Requirement 11.7).
 */
export class TransactionNotFoundError extends Error {
  constructor(
    public readonly fanId: string,
    public readonly txnId: string,
  ) {
    super(`Transaction not found for fanId=${fanId} txnId=${txnId}.`);
    this.name = "TransactionNotFoundError";
  }
}

/**
 * In-memory reference model of the purchase-transaction items in the single
 * DynamoDB base table, analogous to `SeatStore`. Transactions are keyed by their
 * (fanId, txnId) identity, created as `pending`, and advanced through the
 * permitted lifecycle via the pure {@link applyTransition} reducer.
 */
export class TransactionStore {
  private readonly txns = new Map<string, PurchaseTransaction>();

  constructor(private readonly clock: Clock = systemClock) {}

  /** Number of transactions currently in the store. */
  get size(): number {
    return this.txns.size;
  }

  /**
   * Create a new transaction for (fanId, txnId), starting `pending`
   * (Requirement 2.2). Rejects creation if a transaction with the same identity
   * already exists, leaving the existing transaction unchanged.
   */
  createTransaction(input: CreateTransactionInput): PurchaseTransaction {
    const keyString = txnKeyString(input.fanId, input.txnId);
    if (this.txns.has(keyString)) {
      throw new DuplicateTransactionError(input.fanId, input.txnId);
    }
    const txn = createTransaction(input, this.clock);
    this.txns.set(keyString, txn);
    return this.copy(txn);
  }

  /** True iff a transaction exists for the given identity. */
  hasTransaction(fanId: string, txnId: string): boolean {
    return this.txns.has(txnKeyString(fanId, txnId));
  }

  /**
   * Return a copy of the stored transaction, or `undefined` if none exists. A
   * copy is returned so callers cannot mutate stored state.
   */
  getTransaction(fanId: string, txnId: string): PurchaseTransaction | undefined {
    const txn = this.txns.get(txnKeyString(fanId, txnId));
    return txn ? this.copy(txn) : undefined;
  }

  /**
   * Apply a lifecycle transition to a stored transaction and persist the result.
   *
   * Throws {@link TransactionNotFoundError} if the transaction does not exist,
   * or {@link InvalidTransactionTransitionError} if the transition is not
   * permitted — in which case the stored transaction is left unchanged
   * (Requirement 2.4).
   */
  transition(fanId: string, txnId: string, to: TxnPhase): PurchaseTransaction {
    const keyString = txnKeyString(fanId, txnId);
    const current = this.txns.get(keyString);
    if (current === undefined) {
      throw new TransactionNotFoundError(fanId, txnId);
    }
    const next = applyTransition(current, to, this.clock);
    this.txns.set(keyString, next);
    return this.copy(next);
  }

  /** Return copies of all stored transactions (order unspecified). */
  allTransactions(): PurchaseTransaction[] {
    return [...this.txns.values()].map((txn) => this.copy(txn));
  }

  /** Shallow copy so stored state is never handed out by reference. */
  private copy(txn: PurchaseTransaction): PurchaseTransaction {
    return { ...txn };
  }
}
