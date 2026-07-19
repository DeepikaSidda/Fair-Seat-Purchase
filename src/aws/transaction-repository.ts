/**
 * Fair Seat Purchase — DynamoDB-backed purchase-transaction repository (SDK v3).
 *
 * Implements the purchase-transaction item operations from `design.md`
 * (Data Models → Purchase transaction item; Payment orchestrator). The
 * `paid → confirmed` transition is NOT done here: it is applied atomically with
 * the seat's `held → sold` inside `SeatRepository.confirm` via
 * `TransactWriteItems` (design AP7). This repository owns creation and the two
 * payment-side transitions.
 *
 * Access-pattern mapping:
 * - createTransaction → AP10 conditional PutItem `attribute_not_exists(PK)`
 * - getTransaction    → AP5  GetItem (strongly consistent)
 * - markPaid          → conditional UpdateItem `pending → paid`
 * - markFailed        → conditional UpdateItem `pending → failed`
 *
 * Requirements covered: R2 (transaction modeling & lifecycle), R5 (payment),
 * R11.6 (retrieve a fan's transaction).
 */

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import {
  DuplicateTransactionError,
  TransactionNotFoundError,
  type PurchaseTransaction,
  txnPK,
  txnSK,
} from "../transaction.js";
import { TABLE_NAME, getDocumentClient } from "./ddb-client.js";

/**
 * Rejection thrown when a payment-side transition is refused because the
 * transaction was not `pending` (e.g. already `paid`/`failed`). Mirrors
 * `ConditionalCheckFailedException` on the guarded `UpdateItem` (Requirement
 * 2.4). Nothing is changed.
 */
export class PaymentTransitionRejectedError extends Error {
  constructor(
    public readonly fanId: string,
    public readonly txnId: string,
    public readonly attempted: "paid" | "failed",
  ) {
    super(
      `Payment transition to ${attempted} rejected (transaction not pending) for ` +
        `fanId=${fanId} txnId=${txnId}.`,
    );
    this.name = "PaymentTransitionRejectedError";
  }
}

/** Arguments to {@link TransactionRepository.createTransaction}. */
export interface CreateTransactionInput {
  readonly fanId: string;
  readonly txnId: string;
  readonly seatRef: string;
  /** Optional purchase amount (whole dollars); stored as `Amount` when present. */
  readonly amount?: number;
}

/**
 * DynamoDB-backed repository for purchase-transaction items. Stateless.
 */
export class TransactionRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient = getDocumentClient(),
    private readonly tableName: string = TABLE_NAME,
  ) {}

  /**
   * AP10 — Create a purchase transaction as a conditional `PutItem` guarded by
   * `attribute_not_exists(PK)`, starting `Payment_Status = pending`,
   * `Txn_State = pending`, with a UTC ISO-8601 `Created_At` (design: Purchase
   * transaction item; Requirements 2.1, 2.2).
   *
   * @throws {DuplicateTransactionError} if a transaction with the same identity
   *   already exists.
   */
  async createTransaction(input: CreateTransactionInput): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: txnPK(input.fanId),
            SK: txnSK(input.txnId),
            Entity_Type: "TXN",
            Fan_Id: input.fanId,
            Seat_Ref: input.seatRef,
            Payment_Status: "pending",
            Txn_State: "pending",
            Created_At: new Date().toISOString(),
            // Optional purchase amount (sparse; omitted when undefined via the
            // doc client's removeUndefinedValues marshalling option).
            Amount: input.amount,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new DuplicateTransactionError(input.fanId, input.txnId);
      }
      throw err;
    }
  }

  /**
   * AP5 — Retrieve a fan's transaction by (fanId, txnId) with a strongly
   * consistent GetItem (design AP5; Requirement 11.6).
   *
   * @returns the transaction, or `undefined` if it does not exist.
   */
  async getTransaction(
    fanId: string,
    txnId: string,
  ): Promise<PurchaseTransaction | undefined> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: txnPK(fanId), SK: txnSK(txnId) },
        ConsistentRead: true,
      }),
    );
    return res.Item as PurchaseTransaction | undefined;
  }

  /**
   * Mark a transaction `paid` (`pending → paid`) as a conditional `UpdateItem`
   * requiring `Payment_Status = pending` (Requirement 2.4).
   *
   * @throws {PaymentTransitionRejectedError} if the transaction was not
   *   `pending`; nothing changed.
   */
  async markPaid(fanId: string, txnId: string): Promise<PurchaseTransaction> {
    return this.transitionPayment(fanId, txnId, "paid");
  }

  /**
   * Mark a transaction `failed` (`pending → failed`) as a conditional
   * `UpdateItem` requiring `Payment_Status = pending`; also sets
   * `Txn_State = failed` and records no confirmation timestamp (Requirements 2.4,
   * 2.6).
   *
   * @throws {PaymentTransitionRejectedError} if the transaction was not
   *   `pending`; nothing changed.
   */
  async markFailed(fanId: string, txnId: string): Promise<PurchaseTransaction> {
    return this.transitionPayment(fanId, txnId, "failed");
  }

  /**
   * Shared guarded payment-status transition. Both permitted payment-side
   * transitions (`pending → paid`, `pending → failed`) share the same
   * `Payment_Status = pending` precondition; `failed` additionally flips
   * `Txn_State` to `failed`.
   */
  private async transitionPayment(
    fanId: string,
    txnId: string,
    to: "paid" | "failed",
  ): Promise<PurchaseTransaction> {
    // `Payment_Status` / `Txn_State` are not DynamoDB reserved words, but the
    // guard value is shared, so build the expression per target.
    const updateExpression =
      to === "paid"
        ? "SET Payment_Status = :to"
        : "SET Payment_Status = :to, Txn_State = :failed";
    const values: Record<string, unknown> =
      to === "paid"
        ? { ":to": "paid", ":pending": "pending" }
        : { ":to": "failed", ":failed": "failed", ":pending": "pending" };
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: txnPK(fanId), SK: txnSK(txnId) },
          UpdateExpression: updateExpression,
          ConditionExpression: "Payment_Status = :pending",
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return res.Attributes as PurchaseTransaction;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Distinguish "not pending" from "does not exist": a missing item also
        // fails the condition, so surface the not-found case explicitly.
        const existing = await this.getTransaction(fanId, txnId);
        if (existing === undefined) {
          throw new TransactionNotFoundError(fanId, txnId);
        }
        throw new PaymentTransitionRejectedError(fanId, txnId, to);
      }
      throw err;
    }
  }
}
