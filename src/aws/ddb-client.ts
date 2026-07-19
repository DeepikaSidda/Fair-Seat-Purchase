/**
 * Fair Seat Purchase — DynamoDB client factory (AWS SDK v3).
 *
 * Builds a low-level `DynamoDBClient` and a marshalling `DynamoDBDocumentClient`
 * from environment variables, so the same data-access layer can run against
 * DynamoDB Local in development or real AWS in production without code changes.
 *
 * Environment variables:
 * - `FSP_TABLE_NAME`   — base table name (default `FairSeatPurchase`).
 * - `AWS_REGION`       — AWS region (default `us-east-1`).
 * - `FSP_DDB_ENDPOINT` — optional; when set (e.g. `http://localhost:8000`), the
 *                        client is pointed at that endpoint for DynamoDB Local,
 *                        and dummy static credentials are supplied so local runs
 *                        work without real AWS credentials.
 *
 * The doc client marshals plain JS objects to/from DynamoDB attribute-value
 * form, so the repositories can read and write ordinary objects. `remove
 * undefined values` keeps optional attributes (e.g. `Holder_Identifier`) out of
 * items when they are absent, matching the sparse-attribute design.
 *
 * See `design.md` (Architecture → single table) and the shard scheme in
 * `../shard.ts` (`DEFAULT_SHARD_COUNT`).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_SHARD_COUNT } from "../shard.js";

/** Base table name, from `FSP_TABLE_NAME` (default `FairSeatPurchase`). */
export const TABLE_NAME: string = process.env.FSP_TABLE_NAME ?? "FairSeatPurchase";

/** AWS region, from `AWS_REGION` (default `us-east-1`). */
export const REGION: string = process.env.AWS_REGION ?? "us-east-1";

/**
 * Optional DynamoDB endpoint override, from `FSP_DDB_ENDPOINT`. When set the
 * client targets a local DynamoDB (e.g. DynamoDB Local at
 * `http://localhost:8000`) instead of the AWS-hosted regional endpoint.
 */
export const DDB_ENDPOINT: string | undefined = process.env.FSP_DDB_ENDPOINT;

/**
 * GSI2 write-sharding count reused from the reference model (`../shard.ts`), so
 * the real write path and the reference model share exactly one shard scheme
 * (design: Scale and Cost → write sharding; Requirement 10.3).
 */
export const SHARD_COUNT: number = DEFAULT_SHARD_COUNT;

/** GSI1 index name — seat map / available seats per section (design: GSI1). */
export const GSI1_NAME = "GSI1" as const;

/** GSI2 index name — expired-hold sweep (design: GSI2). */
export const GSI2_NAME = "GSI2" as const;

/**
 * Build a low-level {@link DynamoDBClient} configured from the environment.
 *
 * When `FSP_DDB_ENDPOINT` is set, the client points at that endpoint and uses
 * dummy static credentials so DynamoDB Local works without real AWS creds. When
 * it is unset, the default AWS credential provider chain and regional endpoint
 * are used (production).
 */
export function createDynamoDBClient(): DynamoDBClient {
  if (DDB_ENDPOINT) {
    return new DynamoDBClient({
      region: REGION,
      endpoint: DDB_ENDPOINT,
      credentials: {
        accessKeyId: "dummy",
        secretAccessKey: "dummy",
      },
    });
  }
  return new DynamoDBClient({ region: REGION });
}

/**
 * Build a {@link DynamoDBDocumentClient} wrapping a fresh low-level client.
 *
 * Marshalling options:
 * - `removeUndefinedValues` — omit attributes whose value is `undefined`, so
 *   sparse attributes (e.g. `Holder_Identifier`, GSI keys) are simply absent.
 * - `convertClassInstanceToMap` — defensively marshal plain-object-like values.
 */
export function createDocumentClient(
  client: DynamoDBClient = createDynamoDBClient(),
): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertClassInstanceToMap: true,
    },
  });
}

/**
 * A lazily-created, process-wide default document client. Most callers should
 * use this; tests or scripts that need a distinct configuration can call
 * {@link createDocumentClient} directly.
 */
let sharedDocClient: DynamoDBDocumentClient | undefined;

/** Return the shared default {@link DynamoDBDocumentClient}, creating it once. */
export function getDocumentClient(): DynamoDBDocumentClient {
  if (sharedDocClient === undefined) {
    sharedDocClient = createDocumentClient();
  }
  return sharedDocClient;
}
