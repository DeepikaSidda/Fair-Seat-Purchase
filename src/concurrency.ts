/**
 * Fair Seat Purchase — serialized conditional-write concurrency model.
 *
 * This module lets tests simulate N ≥ 2 concurrent attempts against a single
 * seat and observe the exactly-one-winner semantics the design guarantees
 * (design.md → Reservation Strategy → Concurrency; Correctness Properties 1, 4,
 * 5, 6). It does NOT implement any new locking or guard logic: correctness comes
 * entirely from the existing guarded transitions (`holdSeat`, `confirmSeat`,
 * `releaseSeat` in `./transitions.js`) and the store's conditional-update
 * primitive (`SeatStore.conditionalUpdate` in `./store.js`), which is
 * synchronous and single-threaded and therefore already serializes writes per
 * item — exactly how DynamoDB serializes conditional writes on one item's
 * storage node.
 *
 * What this module adds is *observability*: it applies the N attempts one at a
 * time in some (optionally shuffled/seeded) order against the shared store and
 * collects, for every attempt, whether it SUCCEEDED or was REJECTED (and why).
 * Because the underlying conditional writes guard on the current seat state, the
 * first attempt flips `available → held` (or `held → sold`) and every later
 * attempt's guard fails, so exactly one attempt commits and the rest are
 * rejected. This function makes that collectable so the concurrency property
 * tests (tasks 8.2–8.6) can assert `winners === 1`.
 *
 * Requirements covered:
 * - 7.1  Each seat is transitioned to `sold` at most once (observable here as
 *        exactly one winning confirm among concurrent confirms).
 * - 7.2  N (2..≥10,000) concurrent holds of one available seat → exactly one hold.
 * - 7.3  Losing hold attempts leave seat + attempt state unchanged (rejected).
 * - 7.4  N concurrent confirms of one held seat → exactly one sold transition.
 * - 7.5  Losing confirm attempts are rejected without rolling back the winner.
 * - 7.6  `sold` is permanent — no attempt here ever moves a seat out of `sold`.
 * - 8.6  At most one of several concurrent transitions on one seat commits.
 * - 11.8 A valid transition is applied as a single atomic conditional op such
 *        that at most one concurrent request can transition the same seat.
 */

import { type Seat, type SeatIdentity } from "./seat.js";
import { type SeatStore } from "./store.js";
import {
  type HoldOptions,
  TransitionRejectedError,
  confirmSeat,
  holdSeat,
} from "./transitions.js";

/**
 * The outcome of a single attempt once the serialized model has applied it.
 *
 * - `outcome: "succeeded"` — the attempt committed; `value` holds its return.
 * - `outcome: "rejected"`  — the attempt's guard failed (or it otherwise threw);
 *   `reason` is a short, inspectable classification and `error` is the thrown
 *   value. A rejected attempt made no change to stored state (Requirement 7.3,
 *   8.3), consistent with the underlying conditional-write semantics.
 *
 * `index` is the attempt's position in the input array; `order` is the position
 * at which it was applied in the serialized sequence (0-based). Together they
 * let tests reconstruct both "who" attempted and "when" it ran relative to the
 * shuffled order.
 */
export interface AttemptResult<T> {
  /** Position of this attempt in the original input array. */
  readonly index: number;
  /** 0-based position at which this attempt was applied in the serialized order. */
  readonly order: number;
  /** Whether the attempt committed or was rejected. */
  readonly outcome: "succeeded" | "rejected";
  /** The attempt's return value, present iff `outcome === "succeeded"`. */
  readonly value?: T;
  /** Short classification of the rejection, present iff `outcome === "rejected"`. */
  readonly reason?: string;
  /** The thrown error, present iff `outcome === "rejected"`. */
  readonly error?: unknown;
}

/**
 * Aggregate result of running N concurrent attempts against one seat.
 *
 * `winners` is the number of attempts that committed and `losers` the number
 * rejected; `winners + losers === results.length`. For a contested hold or
 * confirm on a single seat the invariant the property tests assert is
 * `winners === 1` (Requirements 7.2, 7.4, 8.6, 11.8).
 */
export interface ConcurrencySummary<T> {
  /** Count of attempts that committed (succeeded). */
  readonly winners: number;
  /** Count of attempts that were rejected. */
  readonly losers: number;
  /** Per-attempt results, indexed by original attempt position. */
  readonly results: ReadonlyArray<AttemptResult<T>>;
}

/**
 * Options controlling the order in which concurrent attempts are serialized.
 *
 * DynamoDB does not promise any particular ordering among contenders — it only
 * promises they are serialized and guarded. To model that faithfully (and to
 * make tests reproducible), the application order can be:
 *
 * - left as the input array order (default), or
 * - an explicit permutation via {@link RunOptions.order}, or
 * - a shuffle driven by a seeded RNG via {@link RunOptions.rng}.
 *
 * Whatever the order, the guarded writes guarantee exactly one winner, so the
 * ordering only affects *which* attempt wins, never *how many* win.
 */
export interface RunOptions {
  /**
   * Explicit application order: a permutation of the integers `[0, N)`. When
   * provided it takes precedence over {@link RunOptions.rng}. Throws
   * {@link InvalidOrderError} if it is not a valid permutation of `[0, N)`.
   */
  readonly order?: ReadonlyArray<number>;
  /**
   * Seeded RNG returning a float in `[0, 1)` (e.g. {@link mulberry32}). When
   * provided (and `order` is not), the attempts are shuffled with an unbiased
   * Fisher–Yates shuffle driven by this RNG, giving deterministic, reproducible
   * orderings across test runs.
   */
  readonly rng?: () => number;
}

/**
 * Error thrown when an explicit {@link RunOptions.order} is not a permutation of
 * `[0, N)` (wrong length, out-of-range index, or a duplicate/missing index).
 */
export class InvalidOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderError";
  }
}

/**
 * A deterministic, seedable PRNG (mulberry32). Returns a function producing
 * floats in `[0, 1)`. Small, fast, and dependency-free — ideal for reproducible
 * shuffles in property tests where a fast-check-supplied seed can drive the
 * ordering.
 *
 * @param seed a 32-bit unsigned integer seed. The same seed always yields the
 *   same sequence.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Classify a thrown value into a short, inspectable rejection reason.
 *
 * A {@link TransitionRejectedError} (the defined failure for a guard mismatch or
 * a non-permitted transition) is reported as `"<transition>:<reason>"`, e.g.
 * `"available->held:guard-mismatch"` — this is the expected loser outcome under
 * contention (Requirements 4.6, 6.2, 8.3). Any other error falls back to its
 * class name. This never throws, so it is safe to call on arbitrary values.
 */
export function rejectionReason(error: unknown): string {
  if (error instanceof TransitionRejectedError) {
    return `${error.transition}:${error.reason}`;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "unknown";
}

/**
 * Resolve the serialized application order for `count` attempts from the given
 * options. Returns a fresh `number[]` that is a permutation of `[0, count)`.
 *
 * Allocation-light: a single length-`count` array is created and, when shuffled,
 * permuted in place — O(count) time and O(count) space, which keeps N up to
 * 10,000 fast.
 */
function resolveOrder(count: number, options: RunOptions): number[] {
  if (options.order !== undefined) {
    return validatePermutation(options.order, count);
  }
  const order = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    order[i] = i;
  }
  if (options.rng !== undefined) {
    shuffleInPlace(order, options.rng);
  }
  return order;
}

/**
 * Unbiased Fisher–Yates shuffle of `array` in place, driven by `rng` (a float
 * generator in `[0, 1)`). O(n) time, no extra allocation.
 */
function shuffleInPlace(array: number[], rng: () => number): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
}

/**
 * Validate that `order` is a permutation of `[0, count)`, returning a defensive
 * copy as a `number[]`. Throws {@link InvalidOrderError} otherwise.
 */
function validatePermutation(order: ReadonlyArray<number>, count: number): number[] {
  if (order.length !== count) {
    throw new InvalidOrderError(
      `order length ${order.length} does not match attempt count ${count}.`,
    );
  }
  const seen = new Uint8Array(count);
  const copy = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const value = order[i];
    if (!Number.isInteger(value) || value < 0 || value >= count) {
      throw new InvalidOrderError(
        `order[${i}] = ${value} is not an integer in [0, ${count}).`,
      );
    }
    if (seen[value] === 1) {
      throw new InvalidOrderError(`order contains duplicate index ${value}.`);
    }
    seen[value] = 1;
    copy[i] = value;
  }
  return copy;
}

/**
 * Core serialization driver: apply `count` attempts one at a time in `order`,
 * collecting each attempt's outcome.
 *
 * `apply(index)` performs the attempt for the given original index against the
 * shared store; returning normally counts as a win, throwing counts as a
 * rejection (its reason is classified via {@link rejectionReason} and the error
 * is retained). This is the single point that models per-item write
 * serialization: attempts are applied strictly sequentially, so each one
 * observes the committed effect of all prior attempts — mirroring DynamoDB
 * evaluating conditional writes one at a time on the item's storage node.
 *
 * O(count) time and O(count) space; no per-attempt closure allocation beyond
 * what the caller passes in.
 */
function serializeApply<T>(
  count: number,
  apply: (index: number) => T,
  order: number[],
): ConcurrencySummary<T> {
  const results = new Array<AttemptResult<T>>(count);
  let winners = 0;
  for (let pos = 0; pos < count; pos++) {
    const index = order[pos];
    try {
      const value = apply(index);
      results[index] = { index, order: pos, outcome: "succeeded", value };
      winners++;
    } catch (error) {
      results[index] = {
        index,
        order: pos,
        outcome: "rejected",
        reason: rejectionReason(error),
        error,
      };
    }
  }
  return { winners, losers: count - winners, results };
}

/**
 * Run an arbitrary set of `attempts` as if they contended concurrently against
 * the shared store, and collect each attempt's outcome.
 *
 * Each element of `attempts` is a thunk that performs one attempt (typically a
 * guarded transition such as `holdSeat`/`confirmSeat` bound to the shared
 * store). The thunks are applied strictly one at a time in the resolved order
 * (see {@link RunOptions}); a thunk that returns normally is a winner and one
 * that throws is a rejected loser. Because the thunks share one store and the
 * store serializes conditional updates, the guards make exactly one attempt win
 * a contested transition and reject the rest (Requirements 7.2–7.5, 8.6, 11.8).
 *
 * This is the generic primitive; {@link concurrentHolds} and
 * {@link concurrentConfirms} are thin, allocation-light wrappers for the two
 * seat-contention scenarios the property tests exercise.
 *
 * @param attempts the per-attempt thunks (length N ≥ 0; N ≥ 2 for contention).
 * @param options ordering controls (explicit permutation or seeded shuffle).
 */
export function runConcurrentAttempts<T>(
  attempts: ReadonlyArray<() => T>,
  options: RunOptions = {},
): ConcurrencySummary<T> {
  const order = resolveOrder(attempts.length, options);
  return serializeApply(attempts.length, (index) => attempts[index](), order);
}

/**
 * Model "N fans concurrently attempt to hold seat X".
 *
 * Each entry of `fanIds` is one fan contending for the same seat via
 * `holdSeat`. The attempts are serialized (optionally shuffled by
 * {@link RunOptions.rng} or an explicit {@link RunOptions.order}); the first to
 * be applied flips `available → held`, and every later attempt fails the
 * `available`(or expired-hold) guard, so the summary reports exactly one winner
 * and `N - 1` rejected losers (Requirements 4.7, 7.2, 7.3, 8.6, 11.8).
 *
 * Efficient for N up to at least 10,000: no per-attempt closure array is built —
 * attempts are applied inline over a single length-N order array (O(N) time,
 * O(N) space).
 *
 * @param store the shared seat store (the single point of contention).
 * @param identity the contested seat.
 * @param fanIds the contending fans (length N); each attempts one hold.
 * @param holdOptions hold-window / clock options forwarded to every `holdSeat`
 *   call (e.g. a fixed `now` for deterministic expiry). Shared by all attempts,
 *   matching a real burst where contenders request the same hold window.
 * @param runOptions ordering controls for the serialized application.
 */
export function concurrentHolds(
  store: SeatStore,
  identity: SeatIdentity,
  fanIds: ReadonlyArray<string>,
  holdOptions: HoldOptions = {},
  runOptions: RunOptions = {},
): ConcurrencySummary<Seat> {
  const order = resolveOrder(fanIds.length, runOptions);
  return serializeApply(
    fanIds.length,
    (index) => holdSeat(store, identity, fanIds[index], holdOptions),
    order,
  );
}

/**
 * Model "N fans concurrently attempt to confirm held seat X".
 *
 * Each entry of `fanIds` is one confirm attempt via `confirmSeat`. In the
 * canonical scenario every entry is the seat's current holder (e.g. retries or
 * multiple service instances double-submitting): the first applied confirm
 * flips `held → sold` and every later attempt fails the `held` guard (the seat
 * is now `sold`, which has no outbound transition), so exactly one attempt wins
 * and the rest are rejected without disturbing the committed sale (Requirements
 * 7.1, 7.4, 7.5, 7.6, 8.6, 11.8). Passing non-holder ids models the additional
 * rejection path where the holder guard fails.
 *
 * The seat must already be `held` before calling this (the caller sets that up);
 * this helper only models the contended confirm step.
 *
 * Efficient for N up to at least 10,000 (O(N) time and space, no per-attempt
 * closure array).
 *
 * @param store the shared seat store.
 * @param identity the held seat being confirmed.
 * @param fanIds the confirming fans (length N); each attempts one confirm.
 * @param runOptions ordering controls for the serialized application.
 */
export function concurrentConfirms(
  store: SeatStore,
  identity: SeatIdentity,
  fanIds: ReadonlyArray<string>,
  runOptions: RunOptions = {},
): ConcurrencySummary<Seat> {
  const order = resolveOrder(fanIds.length, runOptions);
  return serializeApply(
    fanIds.length,
    (index) => confirmSeat(store, identity, fanIds[index]),
    order,
  );
}

/**
 * Convenience: build a length-N array of the same fan id, for the common case
 * where N indistinguishable attempts (retries / duplicate submissions) contend.
 * Useful with {@link concurrentConfirms} where all contenders are the one holder.
 */
export function repeatFan(fanId: string, count: number): string[] {
  const fans = new Array<string>(count);
  fans.fill(fanId);
  return fans;
}

/**
 * Convenience: build N distinct fan ids (`<prefix><i>`), for the common case
 * where N different fans contend for one available seat. Useful with
 * {@link concurrentHolds} to generate contenders for concurrency levels from 2
 * up to at least 10,000.
 */
export function distinctFans(count: number, prefix = "FAN#"): string[] {
  const fans = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    fans[i] = `${prefix}${i}`;
  }
  return fans;
}
