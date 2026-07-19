/**
 * Fair Seat Purchase — create-table script.
 *
 * Creates the single `FairSeatPurchase` base table plus GSI1 (seat map) and
 * GSI2 (expired-hold sweep) exactly as documented in `design.md`
 * (Data Models → Base table & Global Secondary Indexes) and the NoSQL Workbench
 * model (`fair-seat-purchase.json`), then enables TTL on `Hold_Expiration`.
 *
 * - Base table: `PK` (S) / `SK` (S), on-demand (PAY_PER_REQUEST).
 * - GSI1: `GSI1PK` (S) / `GSI1SK` (S), projection INCLUDE
 *   {Row, Seat_Number, Seat_Status} — the seat-map read (design GSI1).
 * - GSI2: `GSI2PK` (S) / `GSI2SK` (N), projection KEYS_ONLY — the sweep index
 *   (design GSI2).
 * - TTL on `Hold_Expiration` for passive/auxiliary cleanup only (NOT the
 *   seat-release mechanism; design: Temporary Hold and Expiration).
 *
 * Idempotent: a `ResourceInUseException` (table/TTL already configured) is
 * treated as success. Config is read from the env via `../src/aws/ddb-client.ts`.
 *
 * Run: `npm run db:create` (or `npx tsx scripts/create-table.ts`). Point at
 * DynamoDB Local by setting `FSP_DDB_ENDPOINT=http://localhost:8000`.
 */

import { pathToFileURL } from "node:url";

import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  type CreateTableCommandInput,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

import { GSI1_NAME, GSI2_NAME, REGION, TABLE_NAME, createDynamoDBClient } from "../src/aws/ddb-client.js";

/**
 * Create the Fair Seat Purchase base table (plus GSI1/GSI2) and enable TTL on
 * `Hold_Expiration`, using the given low-level client and table name.
 *
 * This is the single reusable CreateTable routine shared by the CLI (`main`)
 * and the live integration tests, so both provision an identical schema. It is
 * idempotent: a `ResourceInUseException` (table/TTL already configured) is
 * treated as success.
 */
export async function createTable(client: DynamoDBClient, tableName: string): Promise<void> {
  const input: CreateTableCommandInput = {
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "PK", AttributeType: "S" },
      { AttributeName: "SK", AttributeType: "S" },
      { AttributeName: "GSI1PK", AttributeType: "S" },
      { AttributeName: "GSI1SK", AttributeType: "S" },
      { AttributeName: "GSI2PK", AttributeType: "S" },
      { AttributeName: "GSI2SK", AttributeType: "N" },
    ],
    KeySchema: [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: GSI1_NAME,
        KeySchema: [
          { AttributeName: "GSI1PK", KeyType: "HASH" },
          { AttributeName: "GSI1SK", KeyType: "RANGE" },
        ],
        Projection: {
          ProjectionType: "INCLUDE",
          NonKeyAttributes: ["Row", "Seat_Number", "Seat_Status"],
        },
      },
      {
        IndexName: GSI2_NAME,
        KeySchema: [
          { AttributeName: "GSI2PK", KeyType: "HASH" },
          { AttributeName: "GSI2SK", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "KEYS_ONLY" },
      },
    ],
  };

  console.log(`Creating table "${tableName}" in region "${REGION}"...`);
  try {
    await client.send(new CreateTableCommand(input));
    console.log("CreateTable request accepted; waiting for ACTIVE status...");
    await waitUntilTableExists(
      { client, maxWaitTime: 120 },
      { TableName: tableName },
    );
    console.log(`Table "${tableName}" is ACTIVE.`);
  } catch (err) {
    if (err instanceof ResourceInUseException) {
      console.log(`Table "${tableName}" already exists; skipping creation.`);
    } else {
      throw err;
    }
  }

  // Confirm the table is describable before enabling TTL (idempotent path).
  await client.send(new DescribeTableCommand({ TableName: tableName }));

  console.log("Enabling TTL on attribute Hold_Expiration...");
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: {
          Enabled: true,
          AttributeName: "Hold_Expiration",
        },
      }),
    );
    console.log("TTL enabled on Hold_Expiration.");
  } catch (err) {
    // TTL already enabled (or in the middle of being enabled) is fine.
    if (err instanceof ResourceInUseException) {
      console.log("TTL already configured; skipping.");
    } else if (err instanceof Error && /TimeToLive is already enabled/i.test(err.message)) {
      console.log("TTL already enabled; skipping.");
    } else {
      throw err;
    }
  }
}

async function main(): Promise<void> {
  const client = createDynamoDBClient();
  await createTable(client, TABLE_NAME);
  console.log("Done.");
}

// Run `main` only when executed directly as a CLI (`npm run db:create` /
// `npx tsx scripts/create-table.ts`), not when imported (e.g. by the live
// integration tests, which call `createTable` with their own client/table).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("create-table failed:", err);
    process.exitCode = 1;
  });
}
