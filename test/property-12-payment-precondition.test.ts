// Feature: fair-seat-purchase, Property 12: Payment precondition and outcome
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SeatStore,
  holdSeat,
  confirmSeat,
  createTransaction,
  initiatePayment,
  type ProcessPayment,
  type ProcessPaymentResult,
  type PurchaseTransaction,
  type Seat,
  type SeatIdentity,
  type SeatStatus,
} from "../src/index.js";

/**
 * Property 12: Payment precondition and outcome.
 *
 * For any payment attempt, the payment is accepted only while the seat is
 * `held`, the current time is before Hold_Expiration, and the paying fan matches
 * Holder_Identifier; a rejected payment (not held, expired, or holder mismatch)
 * captures no funds and leaves Payment_Status unchanged. On acceptance, success
 * sets Payment_Status = paid and failure or timeout sets Payment_Status = failed
 * while the seat remains held until expiration.
 *
 * **Validates: Requirements 5.1, 5.2, 5.4, 5.5, 5.6, 5.7, 9.4**
 */

const NUM_RUNS = 200;

/** Identity generator (short strings keep counterexamples readable). */
const identityArb: fc.Arbitrary<SeatIdentity> = fc.record({
  venue: fc.string({ minLength: 1, maxLength: 6 }),
  section: fc.string({ minLength: 1, maxLength: 6 }),
  row: fc.string({ minLength: 1, maxLength: 6 }),
  seat: fc.string({ minLength: 1, maxLength: 6 }),
});

/** Injectable processor returning a fixed result (models the external processor). */
function fixedProcessor(result: ProcessPaymentResult): ProcessPayment {
  return () => result;
}

/** Snapshot the seat fields relevant to "seat remains held until expiration". */
function seatSnapshot(seat: Seat) {
  return {
    status: seat.Seat_Status,
    holder: seat.Holder_Identifier,
    expiration: seat.Hold_Expiration,
  };
}

/**
 * Build a seat in the requested status, held by `holderFan`, using the given
 * hold time + window so tests can drive it into an expired/unexpired state.
 */
function seedSeat(
  store: SeatStore,
  id: SeatIdentity,
  status: SeatStatus,
  holderFan: string,
  holdTime: number,
  window: number,
): void {
  store.createSeat(id); // starts `available`
  if (status === "available") return;
  holdSeat(store, id, holderFan, { now: holdTime, holdWindowSeconds: window });
  if (status === "held") return;
  confirmSeat(store, id, holderFan); // → sold
}

describe("Property 12: Payment precondition and outcome", () => {
  it("accepts a payment iff the seat is held, unexpired, and the holder matches; otherwise rejects without capturing funds and leaves Payment_Status unchanged", () => {
    fc.assert(
      fc.property(
        identityArb,
        fc.constantFrom<SeatStatus>("available", "held", "sold"),
        fc.string({ minLength: 1, maxLength: 8 }), // holder suffix
        fc.boolean(), // does the paying fan match the holder?
        fc.string({ minLength: 1, maxLength: 8 }), // paying-fan suffix (when mismatched)
        fc.integer({ min: 60, max: 1800 }), // hold window
        fc.integer({ min: 0, max: 2_000_000_000 }), // hold time (epoch seconds)
        fc.integer({ min: -3600, max: 3600 }), // offset of `now` vs expiration
        fc.constantFrom<ProcessPaymentResult>("success", "failure", "timeout"),
        fc.string({ minLength: 1, maxLength: 6 }), // txn id
        (id, status, holderSuffix, matchHolder, payerSuffix, window, holdTime, offset, procResult, txnId) => {
          const holderFan = `holder-${holderSuffix}`;
          // A distinct paying fan when we want a mismatch (prefix guarantees inequality).
          const payingFan = matchHolder ? holderFan : `payer-${payerSuffix}`;

          const store = new SeatStore();
          seedSeat(store, id, status, holderFan, holdTime, window);
          const seat = store.getSeat(id)!;

          // For held seats, `now` straddles Hold_Expiration = holdTime + window.
          // For non-held seats, the offset is harmless (no expiration guard applies).
          const expiration = holdTime + window;
          const now = status === "held" ? expiration + offset : holdTime + offset;

          // A fresh `pending` transaction is the precondition for a payment attempt.
          const seatRef = `${seat.PK}|${seat.SK}`;
          const txn: PurchaseTransaction = createTransaction(
            { fanId: payingFan, txnId, seatRef },
            () => new Date(0),
          );
          expect(txn.Payment_Status).toBe("pending");

          const seatBefore = seatSnapshot(seat);

          const result = initiatePayment({
            seat,
            txn,
            fanId: payingFan,
            now,
            processPayment: fixedProcessor(procResult),
          });

          // The exact admission predicate from the design/requirements:
          // held AND now < Hold_Expiration AND holder matches (Requirements 5.1, 5.6, 5.7, 9.4).
          const notExpired = seat.Hold_Expiration !== undefined && now < seat.Hold_Expiration;
          const shouldAccept =
            seat.Seat_Status === "held" && notExpired && seat.Holder_Identifier === payingFan;

          expect(result.accepted).toBe(shouldAccept);

          if (!shouldAccept) {
            // Rejected: no funds captured, Payment_Status unchanged (Requirements 5.6, 5.7, 9.4).
            expect(result.outcome).toBe("rejected");
            expect(result.fundsCaptured).toBe(false);
            expect(result.paymentStatus).toBe("pending");
            expect(result.txn.Payment_Status).toBe("pending");
            // The returned transaction is the original, unchanged instance.
            expect(result.txn).toBe(txn);
            // The rejection reason is one of the three precondition failures.
            expect(["seat-not-held", "hold-expired", "holder-mismatch"]).toContain(result.reason);
          } else {
            // Accepted: the processor was contacted exactly once.
            if (procResult === "success") {
              // Success → Payment_Status = paid; funds captured (Requirement 5.2).
              expect(result.outcome).toBe("paid");
              expect(result.paymentStatus).toBe("paid");
              expect(result.txn.Payment_Status).toBe("paid");
              expect(result.fundsCaptured).toBe(true);
            } else {
              // Failure or timeout → Payment_Status = failed; no funds captured
              // (Requirements 5.4, 5.5).
              expect(result.outcome).toBe("failed");
              expect(result.paymentStatus).toBe("failed");
              expect(result.txn.Payment_Status).toBe("failed");
              expect(result.fundsCaptured).toBe(false);
              expect(result.reason).toBe(
                procResult === "timeout" ? "processor-timeout" : "processor-failure",
              );
              // The seat stays `held` until its natural expiration — payment never
              // touches the seat (Requirements 5.4, 5.5).
              const seatAfter = seatSnapshot(store.getSeat(id)!);
              expect(seatAfter.status).toBe("held");
              expect(seatAfter).toEqual(seatBefore);
              expect(seatAfter.expiration).toBe(expiration);
            }
          }

          // In every case a rejected/failed payment captures no funds, and the
          // seat item is never mutated by the payment step.
          const seatUnchanged = seatSnapshot(store.getSeat(id)!);
          expect(seatUnchanged).toEqual(seatBefore);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("boundary: a payment at exactly Hold_Expiration is rejected as expired (now < expiration is strict)", () => {
    fc.assert(
      fc.property(
        identityArb,
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.integer({ min: 60, max: 1800 }),
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.constantFrom<ProcessPaymentResult>("success", "failure", "timeout"),
        (id, holderSuffix, window, holdTime, procResult) => {
          const holderFan = `holder-${holderSuffix}`;
          const store = new SeatStore();
          seedSeat(store, id, "held", holderFan, holdTime, window);
          const seat = store.getSeat(id)!;
          const expiration = holdTime + window;

          const txn = createTransaction(
            { fanId: holderFan, txnId: "t", seatRef: `${seat.PK}|${seat.SK}` },
            () => new Date(0),
          );

          const result = initiatePayment({
            seat,
            txn,
            fanId: holderFan, // correct holder
            now: expiration, // exactly at expiration → expired
            processPayment: fixedProcessor(procResult),
          });

          expect(result.accepted).toBe(false);
          expect(result.outcome).toBe("rejected");
          expect(result.reason).toBe("hold-expired");
          expect(result.paymentStatus).toBe("pending");
          expect(result.fundsCaptured).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
