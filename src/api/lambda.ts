/**
 * Fair Seat Purchase — AWS Lambda handler (Express adapter).
 *
 * Wraps the same {@link createApp} Express application used by `server.ts` in a
 * Lambda-compatible handler via `serverless-http`, so the exact HTTP API (routes,
 * validation, error mapping) runs unchanged behind API Gateway.
 *
 * Cold-start / connection reuse: the {@link TicketingService} and its
 * DynamoDB-backed repositories are constructed ONCE at module load (outside the
 * handler). AWS Lambda reuses the same execution environment across invocations,
 * so the DynamoDB document client (and its underlying HTTP connections) are reused
 * warm-to-warm rather than rebuilt per request.
 *
 * Configuration is read entirely from environment variables by the shared
 * `ddb-client` module (`FSP_TABLE_NAME`, `AWS_REGION`, optional `FSP_DDB_ENDPOINT`).
 * The CDK stack wires `FSP_TABLE_NAME` and grants the function read/write on the
 * table; `AWS_REGION` is provided automatically by the Lambda runtime.
 *
 * ⚠️ SECURITY: this uses the PLACEHOLDER auth middleware (`x-fan-id` header) baked
 * into the Express app. A real deployment MUST place a proper authorizer
 * (JWT / signed waiting-room admission token) in front of the API. See the CDK
 * stack security note.
 */

import serverless from "serverless-http";

import { getDocumentClient } from "../aws/ddb-client.js";
import { SeatRepository } from "../aws/seat-repository.js";
import { TransactionRepository } from "../aws/transaction-repository.js";
import { TicketingService } from "../service/ticketing-service.js";
import { createApp } from "./app.js";

// ── Built once per execution environment (connection reuse across invocations). ──
const doc = getDocumentClient();
const service = new TicketingService(
  new SeatRepository(doc),
  new TransactionRepository(doc),
);
const app = createApp(service);

/**
 * Lambda entrypoint. `serverless-http` translates API Gateway proxy events into
 * Node `http` req/res objects the Express app understands, and back again.
 */
export const handler = serverless(app);
