// Feature: fair-seat-purchase, Property 13: Transaction lifecycle legality and outcome
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  createTransaction,
  applyTransition,
  txnPhase,
  isAllowedTransition,
  InvalidTransactionTransitionError,
  ALLOWED_TRANSITIONS,
  type PurchaseTransaction,
  type TxnPhase,
  type Clock,
} from "../src/transaction.js";

/**
 * Property 13: Transaction lifecycle legality and outcome.
 *
 * For any purchase transaction and requested lifecycle transition, the transition
 * is applied if and only if it is one of `pending → paid`, `pending → failed`, or
 * `paid → confirmed`; a `paid` transition to `confirmed` records a UTC confirmation
 * timestamp, a `failed` transaction is retained with no confirmation timestamp, and
 * every transaction is created with `Payment_Status = pending`.
 *
 * Validates: Requirements 2.2, 2.3, 2.4, 2.6
 */

const NUM_RUNS = 200;

/** Fixed instant so the recorded confirmation timestamp is deterministic. */
const CONFIRM_INSTANT = new Date("2025-01-01T00:03:12.000Z");
const fixedClock: Clock = () => CONFIRM_INSTANT;

/** The four lifecycle phases a transaction can be in / be driven toward. */
const PHASES: readonly TxnPhase[] = ["pending", "paid", "failed", "confirmed"];

/** Arbitrary transaction identity (fan + txn + seat reference). */
const txnIdentityArb = fc.record({
  fanId: fc.string({ minLength: 1, maxLength: 10 }),
  txnId: fc.string({ minLength: 1, maxLength: 10 }),
  seatRef: fc.string({ minLength: 1, maxLength: 16 }),
});

/**
 * Build a transaction already advanced into `phase` using only the permitted
 * transitions from the freshly-created `pending` transaction.
 */
function seedInPhase(
  input: { fanId: string; txnId: string; seatRef: string },
  phase: TxnPhase,
): PurchaseTransaction {
  const created = createTransaction(input, fixedClock);
  switch (phase) {
    case "pending":
      return created;
    case "paid":
      return applyTransition(created, "paid", fixedClock);
    case "failed":
      return applyTransition(created, "failed", fixedClock);
    case "confirmed":
      return applyTransition(applyTransition(created, "paid", fixedClock), "confirmed", fixedClock);
  }
}

describe("Property 13: Transaction lifecycle legality and outcome", () => {
  it("every transaction is created with Payment_Status = pending (R2.2)", () => {
    fc.assert(
      fc.property(txnIdentityArb, (input) => {
        const txn = createTransaction(input, fixedClock);
        expect(txn.Payment_Status).toBe("pending");
        expect(txn.Txn_State).toBe("pending");
        expect(txnPhase(txn)).toBe("pending");
        // No confirmation timestamp is recorded on creation.
        expect(txn.Confirmation_Timestamp).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("the permitted transition set is exactly the three documented transitions (R2.4)", () => {
    expect(new Set(ALLOWED_TRANSITIONS.map(([f, t]) => `${f}->${t}`))).toEqual(
      new Set(["pending->paid", "pending->failed", "paid->confirmed"]),
    );
  });

  it("applies a transition iff it is one of the three legal transitions; otherwise rejects unchanged (R2.4)", () => {
    fc.assert(
      fc.property(
        txnIdentityArb,
        fc.constantFrom<TxnPhase>(...PHASES), // starting phase
        fc.constantFrom<TxnPhase>(...PHASES), // requested target phase
        (input, fromPhase, toPhase) => {
          const before = seedInPhase(input, fromPhase);
          expect(txnPhase(before)).toBe(fromPhase);

          const legal =
            (fromPhase === "pending" && toPhase === "paid") ||
            (fromPhase === "pending" && toPhase === "failed") ||
            (fromPhase === "paid" && toPhase === "confirmed");

          // The engine's own legality check agrees with the specification.
          expect(isAllowedTransition(fromPhase, toPhase)).toBe(legal);

          if (legal) {
            const after = applyTransition(before, toPhase, fixedClock);
            expect(txnPhase(after)).toBe(toPhase);

            if (toPhase === "confirmed") {
              // paid → confirmed records a UTC confirmation timestamp (R2.3).
              expect(after.Payment_Status).toBe("paid");
              expect(after.Txn_State).toBe("confirmed");
              expect(after.Confirmation_Timestamp).toBeDefined();
              expect(after.Confirmation_Timestamp).toBe(CONFIRM_INSTANT.toISOString());
              // ISO-8601 in UTC always ends with 'Z' and round-trips to the same instant.
              expect(after.Confirmation_Timestamp!.endsWith("Z")).toBe(true);
              expect(new Date(after.Confirmation_Timestamp!).getTime()).toBe(
                CONFIRM_INSTANT.getTime(),
              );
            } else if (toPhase === "failed") {
              // A failed transaction is retained with no confirmation timestamp (R2.6).
              expect(after.Payment_Status).toBe("failed");
              expect(after.Txn_State).toBe("failed");
              expect(after.Confirmation_Timestamp).toBeUndefined();
            } else {
              // pending → paid: awaiting confirmation, no timestamp yet.
              expect(after.Payment_Status).toBe("paid");
              expect(after.Confirmation_Timestamp).toBeUndefined();
            }
          } else {
            // Illegal transition: rejected and the transaction is left unchanged (R2.4).
            expect(() => applyTransition(before, toPhase, fixedClock)).toThrow(
              InvalidTransactionTransitionError,
            );
            // The reducer never mutates its input, so `before` still holds its state.
            expect(txnPhase(before)).toBe(fromPhase);
            expect(before).toEqual(seedInPhase(input, fromPhase));
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("a failed transaction never carries a confirmation timestamp regardless of how reached (R2.6)", () => {
    fc.assert(
      fc.property(txnIdentityArb, (input) => {
        const failed = seedInPhase(input, "failed");
        expect(txnPhase(failed)).toBe("failed");
        expect(failed.Confirmation_Timestamp).toBeUndefined();
        // failed is terminal: no permitted outbound transition exists.
        for (const to of PHASES) {
          expect(isAllowedTransition("failed", to)).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
