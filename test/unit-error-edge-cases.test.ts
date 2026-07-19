// Example-based unit tests for error and edge cases (task 9.3).
//
// These are deliberately example-based (not property-based): each covers a
// specific, well-defined error path from design.md → Error Handling that is not
// a universal invariant:
//
//   - invalid-section error ............ Requirement 3.6
//   - timeout-availability error ....... Requirement 3.7
//   - not-found seat lookup ............ Requirement 11.2
//   - not-found transaction lookup ..... Requirement 11.7
//   - throttling retry-then-error ...... Requirement 10.9
//
// Validates: Requirements 3.6, 3.7, 10.9, 11.2, 11.7
import { describe, it, expect } from "vitest";
import {
  SeatStore,
  SeatNotFoundError,
  holdSeat,
  type SeatIdentity,
  type SectionRef,
  // access-layer error/edge behaviors
  AVAILABILITY_QUERY_BUDGET_MS,
  MAX_RETRY_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  InvalidSectionError,
  AvailabilityUnavailableError,
  ThrottlingError,
  RetryExhaustedError,
  querySeatMap,
  querySectionAvailabilityCount,
  lookupSeat,
  lookupTransaction,
  backoffDelayMs,
  withThrottleRetry,
} from "../src/index.js";
import {
  TransactionStore,
  TransactionNotFoundError,
} from "../src/transaction.js";

/** Build a store seeded with `count` seats in venue V1 / section A (rows/seats 1..count). */
function seededStore(count = 3): SeatStore {
  const store = new SeatStore();
  for (let i = 1; i <= count; i++) {
    store.createSeat({ venue: "V1", section: "A", row: "1", seat: String(i) });
  }
  return store;
}

const SECTION_A: SectionRef = { venue: "V1", section: "A" };

// ─────────────────────────── Invalid-section error (R3.6) ─────────────────────

describe("invalid-section error (R3.6)", () => {
  it("querySeatMap throws InvalidSectionError for an unknown section and returns no seat data", () => {
    const store = seededStore();
    const unknown: SectionRef = { venue: "V1", section: "DOES_NOT_EXIST" };

    expect(() => querySeatMap(store, unknown, { now: 0 })).toThrow(InvalidSectionError);
  });

  it("querySectionAvailabilityCount throws InvalidSectionError for an unknown venue", () => {
    const store = seededStore();
    const unknown: SectionRef = { venue: "NO_SUCH_VENUE", section: "A" };

    expect(() => querySectionAvailabilityCount(store, unknown, { now: 0 })).toThrow(
      InvalidSectionError,
    );
  });

  it("returns data for a section that does exist (no false positive)", () => {
    const store = seededStore(3);

    expect(querySeatMap(store, SECTION_A, { now: 0 })).toHaveLength(3);
    expect(querySectionAvailabilityCount(store, SECTION_A, { now: 0 })).toBe(3);
  });

  it("does not modify any stored data when rejecting an unknown section", () => {
    const store = seededStore(2);
    const before = store.allSeats();
    try {
      querySeatMap(store, { venue: "V1", section: "ZZ" }, { now: 0 });
    } catch {
      // expected
    }
    expect(store.allSeats()).toEqual(before);
  });
});

// ─────────────────────────── Timeout-availability error (R3.7) ────────────────

describe("timeout-availability error (R3.7)", () => {
  it("throws AvailabilityUnavailableError when the query exceeds the 2s budget", () => {
    const store = seededStore();

    expect(() =>
      querySeatMap(store, SECTION_A, {
        now: 0,
        queryDurationMs: AVAILABILITY_QUERY_BUDGET_MS + 1,
      }),
    ).toThrow(AvailabilityUnavailableError);
  });

  it("succeeds when the query completes exactly at the budget boundary", () => {
    const store = seededStore(4);

    // Exactly at budget is within budget (only strictly greater times out).
    expect(
      querySeatMap(store, SECTION_A, {
        now: 0,
        queryDurationMs: AVAILABILITY_QUERY_BUDGET_MS,
      }),
    ).toHaveLength(4);
  });

  it("times out the availability-count query too, and preserves seat state", () => {
    const store = seededStore(3);
    const before = store.allSeats();

    let error: unknown;
    try {
      querySectionAvailabilityCount(store, SECTION_A, {
        now: 0,
        queryDurationMs: 5000,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(AvailabilityUnavailableError);
    // Underlying seat state is preserved (R3.7).
    expect(store.allSeats()).toEqual(before);
  });

  it("checks section validity before the timeout budget", () => {
    const store = seededStore();
    // Unknown section AND over budget → the invalid-section error wins.
    expect(() =>
      querySeatMap(store, { venue: "V1", section: "NOPE" }, {
        now: 0,
        queryDurationMs: 9999,
      }),
    ).toThrow(InvalidSectionError);
  });
});

// ─────────────────────────── Not-found seat lookup (R11.2) ─────────────────────

describe("not-found seat lookup (R11.2)", () => {
  const missing: SeatIdentity = { venue: "V1", section: "A", row: "99", seat: "99" };

  it("lookupSeat throws SeatNotFoundError when the seat does not exist", () => {
    const store = seededStore();
    expect(() => lookupSeat(store, missing)).toThrow(SeatNotFoundError);
  });

  it("lookupSeat returns the seat when it exists", () => {
    const store = seededStore(1);
    const seat = lookupSeat(store, { venue: "V1", section: "A", row: "1", seat: "1" });
    expect(seat.Seat_Status).toBe("available");
    expect(seat.PK).toBe("SEAT#V1#A");
  });

  it("does not modify stored data on a missing lookup", () => {
    const store = seededStore(2);
    const before = store.allSeats();
    expect(() => lookupSeat(store, missing)).toThrow(SeatNotFoundError);
    expect(store.allSeats()).toEqual(before);
  });
});

// ─────────────────────────── Not-found transaction lookup (R11.7) ─────────────

describe("not-found transaction lookup (R11.7)", () => {
  it("lookupTransaction throws TransactionNotFoundError when the transaction does not exist", () => {
    const txnStore = new TransactionStore();
    expect(() => lookupTransaction(txnStore, "FAN#ghost", "t-404")).toThrow(
      TransactionNotFoundError,
    );
  });

  it("lookupTransaction returns the transaction when it exists", () => {
    const txnStore = new TransactionStore();
    txnStore.createTransaction({
      fanId: "FAN#alice",
      txnId: "t-1",
      seatRef: "SEAT#V1#A|ROW#1#SEAT#1",
    });

    const txn = lookupTransaction(txnStore, "FAN#alice", "t-1");
    expect(txn.Payment_Status).toBe("pending");
    expect(txn.Fan_Id).toBe("FAN#alice");
  });

  it("does not modify stored data on a missing lookup", () => {
    const txnStore = new TransactionStore();
    txnStore.createTransaction({
      fanId: "FAN#alice",
      txnId: "t-1",
      seatRef: "SEAT#V1#A|ROW#1#SEAT#1",
    });
    const before = txnStore.allTransactions();

    expect(() => lookupTransaction(txnStore, "FAN#alice", "t-missing")).toThrow(
      TransactionNotFoundError,
    );
    expect(txnStore.allTransactions()).toEqual(before);
  });
});

// ─────────────────────────── Throttling retry-then-error (R10.9) ──────────────

describe("throttling retry-then-error with exponential backoff up to 5 attempts (R10.9)", () => {
  it("returns immediately when the first attempt succeeds (no retries)", () => {
    let calls = 0;
    const result = withThrottleRetry(() => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient throttling and succeeds on a later attempt (retry-then-succeed)", () => {
    let calls = 0;
    const backoffs: Array<{ attempt: number; delayMs: number }> = [];

    const result = withThrottleRetry(
      (attempt) => {
        calls++;
        if (attempt < 3) {
          throw new ThrottlingError();
        }
        return `succeeded-on-${attempt}`;
      },
      { onBackoff: (attempt, delayMs) => backoffs.push({ attempt, delayMs }) },
    );

    expect(result).toBe("succeeded-on-3");
    expect(calls).toBe(3);
    // Backoff was applied after attempts 1 and 2, and grows exponentially.
    expect(backoffs).toEqual([
      { attempt: 1, delayMs: DEFAULT_BASE_DELAY_MS * 1 },
      { attempt: 2, delayMs: DEFAULT_BASE_DELAY_MS * 2 },
    ]);
  });

  it("gives up after exactly 5 throttled attempts and returns an error (state preserved)", () => {
    let calls = 0;
    const delays: number[] = [];

    let thrown: unknown;
    try {
      withThrottleRetry(
        () => {
          calls++;
          throw new ThrottlingError();
        },
        { sleep: (ms) => delays.push(ms) },
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(RetryExhaustedError);
    expect((thrown as RetryExhaustedError).attempts).toBe(MAX_RETRY_ATTEMPTS);
    expect((thrown as RetryExhaustedError).lastError).toBeInstanceOf(ThrottlingError);
    // 5 attempts total → 4 backoff waits between them.
    expect(calls).toBe(5);
    expect(delays).toEqual([
      backoffDelayMs(1),
      backoffDelayMs(2),
      backoffDelayMs(3),
      backoffDelayMs(4),
    ]);
  });

  it("does not retry a non-transient error — it is surfaced immediately", () => {
    let calls = 0;
    const nonTransient = new Error("condition-check-failed");

    expect(() =>
      withThrottleRetry(() => {
        calls++;
        throw nonTransient;
      }),
    ).toThrow(nonTransient);
    // Only tried once; condition failures are not retried (design).
    expect(calls).toBe(1);
  });

  it("preserves store state when all retry attempts are throttled", () => {
    const store = seededStore(3);
    const before = store.allSeats();

    // A hold wrapped in retry that is always throttled never touches the store.
    expect(() =>
      withThrottleRetry(() => {
        throw new ThrottlingError();
      }),
    ).toThrow(RetryExhaustedError);

    expect(store.allSeats()).toEqual(before);
  });

  it("commits a real transition once a throttled operation eventually succeeds", () => {
    const store = seededStore(1);
    const id: SeatIdentity = { venue: "V1", section: "A", row: "1", seat: "1" };

    // Throttle the first attempt, then let the hold go through.
    const seat = withThrottleRetry((attempt) => {
      if (attempt === 1) {
        throw new ThrottlingError();
      }
      return holdSeat(store, id, "FAN#alice", { now: 0 });
    });

    expect(seat.Seat_Status).toBe("held");
    expect(store.getSeat(id)?.Seat_Status).toBe("held");
  });

  it("respects a custom maxAttempts", () => {
    let calls = 0;
    expect(() =>
      withThrottleRetry(
        () => {
          calls++;
          throw new ThrottlingError();
        },
        { maxAttempts: 2 },
      ),
    ).toThrow(RetryExhaustedError);
    expect(calls).toBe(2);
  });
});
