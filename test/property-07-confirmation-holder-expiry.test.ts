// Feature: fair-seat-purchase, Property 7: Confirmation requires matching holder and an unexpired hold
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  confirmSeat,
  confirmPurchase,
  ConfirmationRejectedError,
  type SeatIdentity,
} from "../src/index.js";
import {
  TransactionStore,
  type PurchaseTransaction,
} from "../src/transaction.js";
import { type Seat } from "../src/seat.js";

/**
 * Property 7: Confirmation requires matching holder and an unexpired hold.
 *
 * For any seat and confirming fan, the confirmation succeeds only if the seat is
 * `held`, its `Holder_Identifier` equals the confirming fan, and the current time
 * is before `Hold_Expiration`; otherwise the confirmation is rejected and both the
 * seat and its purchase transaction are left unchanged.
 *
 * To isolate the seat-side holder/expiry preconditions (Property 7) from the
 * separate transaction-side precondition (Property 8), the associated purchase
 * transaction is always set to `paid` before the attempt, so the transaction
 * guard (`Payment_Status = 'paid'`) is always satisfied and the seat guard is the
 * deciding factor.
 *
 * Validates: Requirements 6.1, 6.2, 9.3
 */

const NUM_RUNS = 200;

/** The physical status a seat is placed in before the confirmation attempt. */
type Setup = "available" | "held" | "sold";

const identityArb: fc.Arbitrary<SeatIdentity> = fc.record({
  venue: fc.string({ minLength: 1, maxLength: 6 }),
  section: fc.string({ minLength: 1, maxLength: 6 }),
  row: fc.string({ minLength: 1, maxLength: 6 }),
  seat: fc.string({ minLength: 1, maxLength: 6 }),
});

/** Snapshot the guard-relevant seat fields. */
function seatSnapshot(seat: Seat) {
  return {
    status: seat.Seat_Status,
    holder: seat.Holder_Identifier,
    expiration: seat.Hold_Expiration,
    version: seat.Version,
  };
}

/** Snapshot the transaction lifecycle fields. */
function txnSnapshot(txn: PurchaseTransaction) {
  return {
    payment: txn.Payment_Status,
    state: txn.Txn_State,
    confirmedAt: txn.Confirmation_Timestamp,
  };
}

describe("Property 7: Confirmation requires matching holder and an unexpired hold", () => {
  it("confirms iff seat is held, holder matches, and hold is unexpired; otherwise rejects both seat + txn unchanged", () => {
    fc.assert(
      fc.property(
        identityArb,
        fc.constantFrom<Setup>("available", "held", "sold"),
        // Whether the confirming fan is the seat's actual holder.
        fc.boolean(),
        // Distinct fan id suffixes (holder vs a different confirming fan).
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        // Transaction id.
        fc.string({ minLength: 1, maxLength: 8 }),
        // Hold timing: hold placed at `holdTime` with window `window`.
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.integer({ min: 60, max: 1800 }),
        // `now` relative to Hold_Expiration (negative => unexpired, >=0 => expired).
        fc.integer({ min: -3600, max: 3600 }),
        (identity, setup, sameFan, holderSuffix, otherSuffix, txnId, holdTime, window, offset) => {
          const holderFan = `holder-${holderSuffix}`;
          const confirmingFan = sameFan ? holderFan : `other-${otherSuffix}`;

          const seatStore = new SeatStore();
          const txnStore = new TransactionStore();
          seatStore.createSeat(identity);

          // The purchase transaction is owned by the confirming fan and is set to
          // `paid` so the transaction guard always passes (isolates Property 7).
          txnStore.createTransaction({
            fanId: confirmingFan,
            txnId,
            seatRef: `${identity.venue}#${identity.section}`,
          });
          txnStore.transition(confirmingFan, txnId, "paid");

          const expiration = holdTime + window;

          // Place the seat into the chosen physical status. Holds/sold use
          // `holderFan` as the holder so holder-match is governed by `sameFan`.
          if (setup === "held" || setup === "sold") {
            holdSeat(seatStore, identity, holderFan, { now: holdTime, holdWindowSeconds: window });
            if (setup === "sold") {
              confirmSeat(seatStore, identity, holderFan);
            }
          }

          // Observation instant. Only meaningful for `held` (drives expiry).
          const now = setup === "held" ? expiration + offset : holdTime;

          const seatBefore = seatSnapshot(seatStore.getSeat(identity)!);
          const txnBefore = txnSnapshot(txnStore.getTransaction(confirmingFan, txnId)!);

          // Success requires ALL seat-side preconditions to hold.
          const shouldSucceed =
            setup === "held" && confirmingFan === holderFan && now < expiration;

          if (shouldSucceed) {
            const result = confirmPurchase(seatStore, txnStore, {
              seatIdentity: identity,
              fanId: confirmingFan,
              txnId,
              now,
            });

            // Seat transitioned to sold.
            expect(result.seat.Seat_Status).toBe("sold");
            const seatAfter = seatStore.getSeat(identity)!;
            expect(seatAfter.Seat_Status).toBe("sold");

            // Transaction confirmed with a UTC ISO-8601 timestamp.
            expect(result.transaction.Payment_Status).toBe("paid");
            expect(result.transaction.Txn_State).toBe("confirmed");
            expect(result.transaction.Confirmation_Timestamp).toBeDefined();
            const txnAfter = txnStore.getTransaction(confirmingFan, txnId)!;
            expect(txnAfter.Txn_State).toBe("confirmed");
          } else {
            // Rejected: both seat and transaction left unchanged.
            expect(() =>
              confirmPurchase(seatStore, txnStore, {
                seatIdentity: identity,
                fanId: confirmingFan,
                txnId,
                now,
              }),
            ).toThrow(ConfirmationRejectedError);

            const seatAfter = seatSnapshot(seatStore.getSeat(identity)!);
            const txnAfter = txnSnapshot(txnStore.getTransaction(confirmingFan, txnId)!);
            expect(seatAfter).toEqual(seatBefore);
            expect(txnAfter).toEqual(txnBefore);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
