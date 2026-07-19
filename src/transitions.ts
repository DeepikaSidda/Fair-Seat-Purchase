/**
 * Fair Seat Purchase — guarded seat transition engine.
 *
 * This module implements the three (and only three) permitted seat lifecycle
 * transitions from `design.md` (Reservation Strategy), each as a single
 * conditional update built on `SeatStore.conditionalUpdate`:
 *
 *   - `available → held`  (hold)    — `holdSeat`    (design: `available → held`)
 *   - `held → available`  (release) — `releaseSeat` (design: `held → available`)
 *   - `held → sold`       (confirm) — `confirmSeat` (design: `held → sold`)
 *
 * Every transition asserts its expected source state inside the condition
 * (mirroring a DynamoDB `ConditionExpression`), so a guard mismatch or any
 * transition outside the permitted three is rejected and leaves the stored seat
 * unchanged. The engine never moves a seat out of `sold` — there is no outbound
 * transition from `sold` in any code path — which guarantees `sold` permanence.
 *
 * Requirements covered:
 * - 4.1  hold via conditional write requiring `Seat_Status = available`.
 * - 4.6  reject hold on a non-available seat, leaving state unchanged.
 * - 6.4  release `held → available` requires current `Seat_Status = held`.
 * - 6.7  releasing a `sold` seat is rejected (seat unchanged).
 * - 6.8  releasing an `available` seat is a no-op ("no action required").
 * - 8.1  every transition asserts the expected current status as a precondition.
 * - 8.3  a failed guard leaves the seat unchanged and reports the mismatch.
 * - 8.4  permitted transitions are exactly the three defined here.
 * - 8.5  any non-permitted transition is rejected, seat unchanged.
 * - 11.9 a source-status mismatch is rejected with a defined transition error.
 *
 * The confirm transition here is the seat-side guarded write only; task 7.2
 * couples it atomically with the purchase-transaction update via
 * `TransactWriteItems`.
 */

import { type Seat, type SeatIdentity } from "./seat.js";
import {
  ConditionalCheckFailedError,
  type SeatStore,
} from "./store.js";

/**
 * Hold-window policy (design: Temporary Hold and Expiration → Hold window).
 *
 * On `available → held`, the seat's `Hold_Expiration` is stamped as
 * `now + Hold_Window` (Requirement 4.2, 9.7). The window defaults to 8 minutes
 * and is configurable within [60, 1800] seconds (Requirement 4.3). The upper
 * bound of 1800 s combined with an integer-second window keeps every expiration
 * within the 600-second-margin guarantee of Requirement 1.5 for the default and
 * within the documented configurable band otherwise.
 */
export const DEFAULT_HOLD_WINDOW_SECONDS = 480;
/** Minimum configurable hold window in seconds (Requirement 4.3). */
export const MIN_HOLD_WINDOW_SECONDS = 60;
/** Maximum configurable hold window in seconds (Requirement 4.3). */
export const MAX_HOLD_WINDOW_SECONDS = 1800;

/**
 * An injectable clock: returns the current time as epoch seconds. Injecting the
 * clock keeps expiration semantics deterministic under test (Properties 9, 10)
 * while defaulting to real time in production via {@link systemClock}.
 */
export type Clock = () => number;

/** Default real-time clock: current wall-clock time in epoch seconds. */
export const systemClock: Clock = () => Math.floor(Date.now() / 1000);

/**
 * Error thrown when a requested hold window is outside the permitted
 * [60, 1800]-second range or is not an integer number of seconds
 * (Requirement 4.3). The store is never touched when this is thrown, so the
 * seat is left unchanged.
 */
export class InvalidHoldWindowError extends Error {
  constructor(public readonly value: unknown) {
    super(
      `Invalid hold window: ${JSON.stringify(value)}. Expected an integer number of ` +
        `seconds within [${MIN_HOLD_WINDOW_SECONDS}, ${MAX_HOLD_WINDOW_SECONDS}].`,
    );
    this.name = "InvalidHoldWindowError";
  }
}

/**
 * Validate and normalize a hold window (seconds), throwing
 * {@link InvalidHoldWindowError} if it is not an integer within
 * [{@link MIN_HOLD_WINDOW_SECONDS}, {@link MAX_HOLD_WINDOW_SECONDS}]
 * (Requirement 4.3).
 */
export function assertHoldWindow(seconds: number): number {
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_HOLD_WINDOW_SECONDS ||
    seconds > MAX_HOLD_WINDOW_SECONDS
  ) {
    throw new InvalidHoldWindowError(seconds);
  }
  return seconds;
}

/**
 * The exhaustive set of permitted seat status transitions (Requirement 8.4).
 * Any (from, to) pair not in this set is illegal and must be rejected (8.5).
 */
export type SeatTransition = "available->held" | "held->sold" | "held->available";

/** The three permitted transitions, as a frozen lookup set (Requirement 8.4). */
export const PERMITTED_TRANSITIONS: ReadonlySet<SeatTransition> = new Set<SeatTransition>([
  "available->held",
  "held->sold",
  "held->available",
]);

/**
 * Returns true iff moving a seat from `from` to `to` is one of the three
 * permitted transitions (Requirement 8.4, 8.5). Used to reject any illegal
 * transition before it can touch stored state.
 */
export function isPermittedTransition(from: string, to: string): boolean {
  return PERMITTED_TRANSITIONS.has(`${from}->${to}` as SeatTransition);
}

/**
 * Why a guarded transition was rejected. `guard-mismatch` means the stored
 * source status (or holder) did not satisfy the transition's precondition
 * (Requirement 8.3, 11.9); `not-permitted` means the requested (from, to) pair
 * is not one of the three permitted transitions (Requirement 8.5).
 */
export type TransitionRejectionReason = "guard-mismatch" | "not-permitted";

/**
 * Defined failure surfaced to callers when a guarded transition is rejected.
 *
 * The stored seat is always left unchanged when this is thrown (Requirements
 * 8.3, 8.5, 11.9). This wraps the store's low-level
 * `ConditionalCheckFailedError` with the transition context (which transition
 * was attempted, and why it was rejected) so callers get a defined,
 * inspectable failure rather than an opaque one.
 */
export class TransitionRejectedError extends Error {
  constructor(
    public readonly transition: SeatTransition,
    public readonly reason: TransitionRejectionReason,
    public readonly identity: SeatIdentity,
    message?: string,
  ) {
    super(
      message ??
        `Transition ${transition} rejected (${reason}) for venue=${identity.venue} ` +
          `section=${identity.section} row=${identity.row} seat=${identity.seat}.`,
    );
    this.name = "TransitionRejectedError";
  }
}

/** Options accepted by {@link holdSeat}. */
export interface HoldOptions {
  /**
   * Hold window in seconds. The seat's `Hold_Expiration` is stamped as
   * `now + holdWindowSeconds` (Requirement 4.2, 9.7). Must be an integer within
   * [{@link MIN_HOLD_WINDOW_SECONDS}, {@link MAX_HOLD_WINDOW_SECONDS}]; an
   * out-of-range value is rejected with {@link InvalidHoldWindowError} before
   * the store is touched (Requirement 4.3). Defaults to
   * {@link DEFAULT_HOLD_WINDOW_SECONDS}.
   */
  readonly holdWindowSeconds?: number;

  /**
   * Injectable clock supplying "now" as epoch seconds. Defaults to
   * {@link systemClock} (real time). Injecting a clock makes hold expiration and
   * the expired-hold-as-available guard deterministic under test.
   */
  readonly clock?: Clock;

  /**
   * Explicit "now" (epoch seconds) override. When provided, it takes precedence
   * over {@link HoldOptions.clock} and is used both to compute `Hold_Expiration`
   * and to evaluate the expired-hold guard. Convenient for deterministic tests
   * that want a fixed instant without constructing a clock function.
   */
  readonly now?: number;
}

/**
 * `available → held`: place a hold on a seat for `fanId` (Requirement 4.1).
 *
 * The guard requires the seat to be holdable at `now` ({@link isSeatHoldable}):
 * either physically `available`, or `held` with an already-elapsed
 * `Hold_Expiration` (an expired hold is treated as available at write time, per
 * design's `Seat_Status = available OR (Seat_Status = held AND
 * Hold_Expiration <= now)`, Requirement 9.6). On success the seat becomes
 * `held`, `fanId` is recorded as the holder (4.4), `Hold_Expiration` is stamped
 * as `now + holdWindowSeconds` (Requirement 4.2, 9.7), and `Version` is
 * incremented. The seat is removed from availability (holder set) atomically
 * with the status flip.
 *
 * The hold window defaults to {@link DEFAULT_HOLD_WINDOW_SECONDS} and must lie
 * within [60, 1800] s; an out-of-range window is rejected with
 * {@link InvalidHoldWindowError} before the store is touched (Requirement 4.3),
 * so the seat is left unchanged.
 *
 * Rejection (seat not holdable) throws {@link TransitionRejectedError} with
 * reason `guard-mismatch` and leaves the seat unchanged (Requirement 4.6, 8.3).
 * Concurrency: because this is a single conditional write, N concurrent holders
 * of one holdable seat resolve to exactly one winner (Requirement 4.7, 8.6).
 *
 * Note on GSI2: the real item additionally stamps a sharded `GSI2PK`
 * (`holdsShardKeyForSeat(identity)` from `./shard.js`) so the hold is sweepable
 * (design: GSI2). The reference `Seat` entity does not carry GSI2 attributes, so
 * no shard key is materialized here; shard derivation lives in `./shard.js`.
 */
export function holdSeat(
  store: SeatStore,
  identity: SeatIdentity,
  fanId: string,
  opts: HoldOptions = {},
): Seat {
  const holdWindowSeconds = assertHoldWindow(
    opts.holdWindowSeconds ?? DEFAULT_HOLD_WINDOW_SECONDS,
  );
  const now = opts.now ?? (opts.clock ?? systemClock)();
  const holdExpiration = now + holdWindowSeconds;
  return runGuardedTransition(store, identity, "available->held", {
    condition: (current) => isSeatHoldable(current, now),
    mutate: (current) => {
      current.Seat_Status = "held";
      current.Holder_Identifier = fanId;
      current.Hold_Expiration = holdExpiration;
      current.Version += 1;
      return current;
    },
  });
}

/**
 * `held → available`: release / abandon a held seat (Requirement 6.4).
 *
 * The guard requires the seat to currently be `held`. On success the seat
 * returns to `available`, its `Holder_Identifier` and `Hold_Expiration` are
 * cleared (Requirement 6.6), and `Version` is incremented.
 *
 * - Releasing a `sold` seat fails the guard → rejected, seat unchanged
 *   (Requirement 6.7): `sold` has no outbound transition (Requirement 7.6).
 * - Releasing an already-`available` seat also fails the guard and is reported
 *   as "no action required" (Requirement 6.8) — the seat is left unchanged.
 */
export function releaseSeat(store: SeatStore, identity: SeatIdentity): Seat {
  return runGuardedTransition(store, identity, "held->available", {
    condition: (current) => current.Seat_Status === "held",
    mutate: (current) => {
      current.Seat_Status = "available";
      delete current.Holder_Identifier;
      delete current.Hold_Expiration;
      current.Version += 1;
      return current;
    },
  });
}

/**
 * `held → sold`: confirm a held seat as sold for `fanId` (Requirement 6.1).
 *
 * The guard requires the seat to currently be `held` AND its
 * `Holder_Identifier` to equal `fanId`. On success the seat becomes `sold`
 * (permanent — no path ever moves it back, Requirement 7.6) and `Version` is
 * incremented. Rejection (not held, or holder mismatch) throws
 * {@link TransitionRejectedError} and leaves the seat unchanged
 * (Requirement 6.2, 8.3).
 *
 * This is the seat-side guarded write only. Task 7.2 couples it atomically with
 * the purchase-transaction `paid → confirmed` update via `TransactWriteItems`,
 * and adds the not-expired clause to the guard.
 */
export function confirmSeat(store: SeatStore, identity: SeatIdentity, fanId: string): Seat {
  return runGuardedTransition(store, identity, "held->sold", {
    condition: (current) =>
      current.Seat_Status === "held" && current.Holder_Identifier === fanId,
    mutate: (current) => {
      current.Seat_Status = "sold";
      current.Version += 1;
      return current;
    },
  });
}

/**
 * Returns true iff `seat` is a `held` seat whose hold has expired at `now`
 * (`Seat_Status = held AND Hold_Expiration <= now`) (Requirement 1.6, 9.6).
 *
 * This is the condition-at-read-time rule the design makes the source of truth:
 * an expired-but-not-yet-cleaned-up hold is logically eligible for return to
 * `available` regardless of whether any background sweeper has run.
 */
export function isHoldExpired(seat: Seat, now: number): boolean {
  return (
    seat.Seat_Status === "held" &&
    seat.Hold_Expiration !== undefined &&
    seat.Hold_Expiration <= now
  );
}

/**
 * Predicate for hold eligibility at time `now` (Requirement 4.1, 9.6).
 *
 * A seat is holdable iff it is physically `available` OR it is `held` with an
 * expired hold (`Seat_Status = held AND Hold_Expiration <= now`). This mirrors
 * the design's write-time condition
 * `Seat_Status = available OR (Seat_Status = held AND Hold_Expiration <= now)`,
 * so an expired hold behaves exactly like an available seat at write time even
 * before physical cleanup. Keeping this the single point of the holdability
 * decision means the whole write path shares one definition of "holdable".
 */
export function isSeatHoldable(seat: Seat, now: number): boolean {
  return seat.Seat_Status === "available" || isHoldExpired(seat, now);
}

/**
 * Shared driver for the three guarded transitions.
 *
 * It (1) rejects any transition whose (from, to) pair is not one of the three
 * permitted transitions before touching state (Requirement 8.5) — a defensive
 * guard since callers only pass permitted pairs — and (2) delegates the
 * source-status precondition and mutation to `SeatStore.conditionalUpdate`,
 * translating the store's `ConditionalCheckFailedError` into a
 * {@link TransitionRejectedError} carrying the transition context (Requirements
 * 8.3, 11.9). `SeatNotFoundError` from the store propagates unchanged.
 */
function runGuardedTransition(
  store: SeatStore,
  identity: SeatIdentity,
  transition: SeatTransition,
  update: { condition(current: Seat): boolean; mutate(current: Seat): Seat },
): Seat {
  const [from, to] = transition.split("->");
  if (!isPermittedTransition(from, to)) {
    throw new TransitionRejectedError(transition, "not-permitted", identity);
  }
  try {
    return store.conditionalUpdate(identity, update);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedError) {
      throw new TransitionRejectedError(transition, "guard-mismatch", identity);
    }
    throw err;
  }
}
