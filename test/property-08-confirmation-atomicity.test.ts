// Feature: fair-seat-purchase, Property 8: Confirmation atomicity (seat + transaction all-or-nothing)
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  confirmSeat,
  confirmPurchase,
  ConfirmationRejectedError,
  DEFAULT_HOLD_WINDOW_SECONDS,
  type SeatIdentity,
  type SeatStatus,
} from "../src/index.js";
import {
  TransactionStore,
  type TxnPhase,
  type PurchaseTransaction,
} from "../src/transaction.js";

/**
 * Property 8: Confirmation atomicity (seat + transaction all-or-nothing).
 *
 * For any confirmation, either BOTH the seat transitions to `sold` AND its
 * purchase transaction becomes `confirmed` with a UTC confirmation timestamp,
 * or NEITHER change is applied; no partial outcome is ever observable.
 *
 * The confirmation succeeds iff every precondition holds together:
 *   - the seat is `held`, AND
 *   - the seat's holder equals the confirming fan, AND
 *   - the hold has not expired (`Hold_Expiration > now`), AND
 *   - the transaction is in the `paid` phase (ready for `paid → confirmed`).
 * If any precondition fails, {@link ConfirmationRejectedError} is thrown and
 * both items are left exactly as they were.
 *
 * Validates: Requirements 6.3, 8.2
 */

const NUM_RUNS = 200;

/** Fixed instant at which the setup hold is placed. */
const HOLD_NOW = 1000;

const TXN_ID = "t-1";

/** Snapshot an object as a stable string so before/after changes are detectable. */
function snap(obj: unknown): string {
  return JSON.stringify(obj);
}

/**
 * A fully-specified confirmation scenario. The four boolean/enum knobs let the
 * generator cover the success case and every distinct failure case (seat guard
 * failures: not-held / holder-mismatch / expired; txn guard failure: not-paid).
 */
interface Scenario {
  readonly id: SeatIdentity;
  readonly confirmFan: string;
  readonly seatStatus: SeatStatus;
  readonly holderMatches: boolean;
  readonly expired: boolean;
  readonly txnPhase: TxnPhase;
  readonly holdWindow: number;
}

/**
 * Build the seat + transaction stores into the scenario's state and return the
 * confirming fan, the transaction id, and the "now" to attempt confirmation at.
 */
function setup(s: Scenario): {
  seatStore: SeatStore;
  txnStore: TransactionStore;
  attemptNow: number;
} {
  const seatStore = new SeatStore();
  const txnStore = new TransactionStore();
  const otherFan = `${s.confirmFan}#other`; // guaranteed distinct from confirmFan

  // --- Seat setup ---------------------------------------------------------
  seatStore.createSeat(s.id); // starts `available`
  if (s.seatStatus === "held") {
    const holder = s.holderMatches ? s.confirmFan : otherFan;
    holdSeat(seatStore, s.id, holder, {
      now: HOLD_NOW,
      holdWindowSeconds: s.holdWindow,
    });
  } else if (s.seatStatus === "sold") {
    // Reach `sold` via the legal available → held → sold path (held by confirmFan).
    holdSeat(seatStore, s.id, s.confirmFan, {
      now: HOLD_NOW,
      holdWindowSeconds: s.holdWindow,
    });
    confirmSeat(seatStore, s.id, s.confirmFan);
  }

  // --- Transaction setup --------------------------------------------------
  const seatRef = `${seatStore.getSeat(s.id)!.PK}|${seatStore.getSeat(s.id)!.SK}`;
  txnStore.createTransaction({ fanId: s.confirmFan, txnId: TXN_ID, seatRef }); // `pending`
  switch (s.txnPhase) {
    case "pending":
      break;
    case "paid":
      txnStore.transition(s.confirmFan, TXN_ID, "paid");
      break;
    case "failed":
      txnStore.transition(s.confirmFan, TXN_ID, "failed");
      break;
    case "confirmed":
      txnStore.transition(s.confirmFan, TXN_ID, "paid");
      txnStore.transition(s.confirmFan, TXN_ID, "confirmed");
      break;
  }

  // Attempt confirmation just after the hold (unexpired) or past expiry.
  const attemptNow = s.expired ? HOLD_NOW + s.holdWindow + 1 : HOLD_NOW + 1;
  return { seatStore, txnStore, attemptNow };
}

/** True iff every confirmation precondition is satisfied for this scenario. */
function shouldSucceed(s: Scenario): boolean {
  return (
    s.seatStatus === "held" &&
    s.holderMatches &&
    !s.expired &&
    s.txnPhase === "paid"
  );
}

/** Assert `ts` is a valid UTC ISO-8601 instant (Requirement 2.3). */
function assertUtcTimestamp(ts: string | undefined): void {
  expect(ts).toBeDefined();
  expect(ts!.endsWith("Z")).toBe(true); // UTC designator
  const parsed = new Date(ts!);
  expect(Number.isNaN(parsed.getTime())).toBe(false);
  expect(parsed.toISOString()).toBe(ts);
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  id: fc.record({
    venue: fc.string({ minLength: 1, maxLength: 6 }),
    section: fc.string({ minLength: 1, maxLength: 6 }),
    row: fc.string({ minLength: 1, maxLength: 6 }),
    seat: fc.string({ minLength: 1, maxLength: 6 }),
  }),
  confirmFan: fc.string({ minLength: 1, maxLength: 8 }),
  seatStatus: fc.constantFrom<SeatStatus>("available", "held", "sold"),
  holderMatches: fc.boolean(),
  expired: fc.boolean(),
  txnPhase: fc.constantFrom<TxnPhase>("pending", "paid", "failed", "confirmed"),
  holdWindow: fc.integer({ min: 60, max: 1800 }),
});

describe("Property 8: Confirmation atomicity (seat + transaction all-or-nothing)", () => {
  it("commits both the seat and the transaction, or neither — never a partial outcome", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { seatStore, txnStore, attemptNow } = setup(s);

        const seatBefore = snap(seatStore.getSeat(s.id));
        const txnBefore = snap(txnStore.getTransaction(s.confirmFan, TXN_ID));

        let threw = false;
        try {
          confirmPurchase(seatStore, txnStore, {
            seatIdentity: s.id,
            fanId: s.confirmFan,
            txnId: TXN_ID,
            now: attemptNow,
          });
        } catch (err) {
          threw = true;
          // Any rejection must be the defined confirmation failure.
          expect(err).toBeInstanceOf(ConfirmationRejectedError);
        }

        const seatAfter = seatStore.getSeat(s.id)!;
        const txnAfter = txnStore.getTransaction(s.confirmFan, TXN_ID)!;
        const seatChanged = snap(seatAfter) !== seatBefore;
        const txnChanged = snap(txnAfter) !== txnBefore;

        // Atomicity core: the seat changed iff the transaction changed. There is
        // never a state in which one moved without the other.
        expect(seatChanged).toBe(txnChanged);

        if (shouldSucceed(s)) {
          // Success case: BOTH committed.
          expect(threw).toBe(false);
          expect(seatChanged).toBe(true);

          expect(seatAfter.Seat_Status).toBe("sold");
          expect(txnAfter.Txn_State).toBe("confirmed");
          expect(txnAfter.Payment_Status).toBe("paid");
          assertUtcTimestamp(txnAfter.Confirmation_Timestamp);
        } else {
          // Failure case: NEITHER committed — both items exactly as before.
          expect(threw).toBe(true);
          expect(seatChanged).toBe(false);
          expect(txnChanged).toBe(false);
          expect(snap(seatAfter)).toBe(seatBefore);
          expect(snap(txnAfter)).toBe(txnBefore);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("success case: a valid confirmation makes the seat `sold` and the txn `confirmed` with a UTC timestamp", () => {
    const seatStore = new SeatStore();
    const txnStore = new TransactionStore();
    const id: SeatIdentity = { venue: "VENUE1", section: "A", row: "1", seat: "2" };
    const fan = "FAN#alice";

    seatStore.createSeat(id);
    holdSeat(seatStore, id, fan, { now: HOLD_NOW, holdWindowSeconds: DEFAULT_HOLD_WINDOW_SECONDS });
    txnStore.createTransaction({ fanId: fan, txnId: TXN_ID, seatRef: "SEAT#VENUE1#A|ROW#1#SEAT#2" });
    txnStore.transition(fan, TXN_ID, "paid");

    const result = confirmPurchase(seatStore, txnStore, {
      seatIdentity: id,
      fanId: fan,
      txnId: TXN_ID,
      now: HOLD_NOW + 1,
    });

    expect(result.seat.Seat_Status).toBe("sold");
    expect(result.transaction.Txn_State).toBe("confirmed");
    assertUtcTimestamp(result.transaction.Confirmation_Timestamp);
    // Persisted state matches the returned committed state.
    expect(seatStore.getSeat(id)!.Seat_Status).toBe("sold");
    expect(txnStore.getTransaction(fan, TXN_ID)!.Txn_State).toBe("confirmed");
  });

  it("failure case (seat guard): an expired hold commits neither the seat nor the txn", () => {
    const seatStore = new SeatStore();
    const txnStore = new TransactionStore();
    const id: SeatIdentity = { venue: "VENUE1", section: "A", row: "3", seat: "9" };
    const fan = "FAN#bob";
    const window = 120;

    seatStore.createSeat(id);
    holdSeat(seatStore, id, fan, { now: HOLD_NOW, holdWindowSeconds: window });
    txnStore.createTransaction({ fanId: fan, txnId: TXN_ID, seatRef: "SEAT#VENUE1#A|ROW#3#SEAT#9" });
    txnStore.transition(fan, TXN_ID, "paid");

    const seatBefore = snap(seatStore.getSeat(id));
    const txnBefore = snap(txnStore.getTransaction(fan, TXN_ID));

    expect(() =>
      confirmPurchase(seatStore, txnStore, {
        seatIdentity: id,
        fanId: fan,
        txnId: TXN_ID,
        now: HOLD_NOW + window + 1, // past expiry
      }),
    ).toThrow(ConfirmationRejectedError);

    expect(snap(seatStore.getSeat(id))).toBe(seatBefore);
    expect(snap(txnStore.getTransaction(fan, TXN_ID))).toBe(txnBefore);
    const txn = txnStore.getTransaction(fan, TXN_ID)! as PurchaseTransaction;
    expect(txn.Confirmation_Timestamp).toBeUndefined();
  });

  it("failure case (txn guard): a held+matching+unexpired seat with an unpaid txn commits neither", () => {
    const seatStore = new SeatStore();
    const txnStore = new TransactionStore();
    const id: SeatIdentity = { venue: "VENUE1", section: "B", row: "5", seat: "10" };
    const fan = "FAN#carol";

    seatStore.createSeat(id);
    holdSeat(seatStore, id, fan, { now: HOLD_NOW, holdWindowSeconds: DEFAULT_HOLD_WINDOW_SECONDS });
    // Transaction left `pending` (not `paid`) → txn guard must fail.
    txnStore.createTransaction({ fanId: fan, txnId: TXN_ID, seatRef: "SEAT#VENUE1#B|ROW#5#SEAT#10" });

    const seatBefore = snap(seatStore.getSeat(id));
    const txnBefore = snap(txnStore.getTransaction(fan, TXN_ID));

    expect(() =>
      confirmPurchase(seatStore, txnStore, {
        seatIdentity: id,
        fanId: fan,
        txnId: TXN_ID,
        now: HOLD_NOW + 1,
      }),
    ).toThrow(ConfirmationRejectedError);

    // Seat must NOT have flipped to sold, txn must NOT have been confirmed.
    expect(snap(seatStore.getSeat(id))).toBe(seatBefore);
    expect(snap(txnStore.getTransaction(fan, TXN_ID))).toBe(txnBefore);
    expect(seatStore.getSeat(id)!.Seat_Status).toBe("held");
  });
});
