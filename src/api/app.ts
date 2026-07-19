/**
 * Fair Seat Purchase — Express HTTP API.
 *
 * `createApp(service)` builds an Express application that exposes the purchasing
 * lifecycle (browse → seat map → hold → pay → confirm → release) over HTTP,
 * delegating all business logic and DynamoDB access to the injected
 * {@link TicketingService}. The app itself is transport-only: it validates and
 * parses requests, calls the service, shapes JSON responses, and maps domain
 * errors to HTTP status codes via a single central error-handling middleware.
 *
 * Because the service is injected, the app can be exercised end-to-end with an
 * in-memory fake service in tests (see `test/api-contract.test.ts`) with NO real
 * DynamoDB, and wired to real repositories in `server.ts` for production.
 *
 * Routes (DynamoDB op each ultimately triggers, via the service):
 * - GET  /health                                                  → none
 * - GET  /venues/:venue/sections/:section/seatmap                 → AP2 GSI1 query
 * - GET  /venues/:venue/sections/:section/count                   → AP3 GSI1 COUNT
 * - GET  /venues/:venue/sections/:section/rows/:row/seats/:seat   → AP1 GetItem
 * - POST /holds                          (auth)                    → AP6 hold + AP10 create txn
 * - POST /payments                       (auth)                    → AP1 + markPaid/markFailed + AP7 confirm
 * - POST /releases                       (auth)                    → AP8 release
 * - GET  /transactions/:txnId            (auth)                    → AP5 GetItem
 *
 * Error → status mapping (central middleware):
 * - SeatNotAvailableError / SeatConfirmationRejectedError /
 *   PaymentTransitionRejectedError / PaymentNotAllowedError / SeatNotHeldError → 409 Conflict
 * - NotFoundError                                                             → 404 Not Found
 * - PaymentDeclinedError                                                      → 402 Payment Required
 * - RetryExhaustedError                                                       → 503 Service Unavailable
 * - ValidationError                                                           → 400 Bad Request
 * - anything else                                                             → 500 Internal Server Error
 * Every error response uses the stable `{ error, code }` JSON shape.
 */

import { fileURLToPath } from "node:url";

import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";

import type { SeatIdentity } from "../seat.js";
import { RetryExhaustedError } from "../access.js";
import {
  SeatConfirmationRejectedError,
  SeatNotAvailableError,
  SeatNotHeldError,
} from "../aws/seat-repository.js";
import { PaymentTransitionRejectedError } from "../aws/transaction-repository.js";
import {
  NotFoundError,
  PaymentDeclinedError,
  PaymentNotAllowedError,
  type ProcessorResult,
  type TicketingService,
} from "../service/ticketing-service.js";
import { requireEligibleFan } from "./auth.js";

/**
 * A request-validation failure (missing/ill-typed body fields). Mapped to
 * `400 Bad Request`. Kept local to the API layer since it is a transport concern.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Wrap an async handler so rejected promises are forwarded to Express's error chain. */
function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** Read a required non-empty string field from a JSON body, else throw {@link ValidationError}. */
function requireString(body: unknown, field: string): string {
  if (typeof body !== "object" || body === null) {
    throw new ValidationError("Request body must be a JSON object.");
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`Missing or invalid required field: '${field}'.`);
  }
  return value;
}

/** Parse an optional processor result from a body, validating the enum if present. */
function optionalProcessorResult(body: unknown): ProcessorResult | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const value = (body as Record<string, unknown>).processorResult;
  if (value === undefined) {
    return undefined;
  }
  if (value !== "success" && value !== "failure" && value !== "timeout") {
    throw new ValidationError(
      "Field 'processorResult' must be one of 'success', 'failure', 'timeout'.",
    );
  }
  return value;
}

/** Build the {@link SeatIdentity} from a request body (validating all four parts). */
function seatIdentityFromBody(body: unknown): SeatIdentity {
  return {
    venue: requireString(body, "venue"),
    section: requireString(body, "section"),
    row: requireString(body, "row"),
    seat: requireString(body, "seat"),
  };
}

/**
 * Build the Express app around an injected {@link TicketingService}.
 *
 * @param service the ticketing service (real repositories in production; an
 *   in-memory fake in contract tests).
 */
export function createApp(service: TicketingService): Express {
  const app = express();
  app.use(express.json());

  // ── CORS ─────────────────────────────────────────────────────────────────
  // When the UI is hosted separately (S3 + CloudFront), the browser makes
  // cross-origin requests to this API, so we must return CORS headers and
  // answer preflight OPTIONS. Origin is configurable via FSP_CORS_ORIGIN
  // (default "*"). We allow the custom `x-fan-id` header used by the demo auth.
  const corsOrigin = process.env.FSP_CORS_ORIGIN ?? "*";
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header("Access-Control-Allow-Origin", corsOrigin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, x-fan-id");
    res.header("Access-Control-Max-Age", "300");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── Static demo UI (public/). ────────────────────────────────────────────
  // Serves the dependency-free browser demo of the purchasing flow. "/" resolves
  // to public/index.html; the JSON API routes below take precedence for their
  // own paths, so serving static assets here does not shadow any API route.
  const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
  app.use(express.static(publicDir));

  // ── Health check (no auth, no DynamoDB). ─────────────────────────────────
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // ── Browse: seat map (AP2 — GSI1 query for available seats). ─────────────
  app.get(
    "/venues/:venue/sections/:section/seatmap",
    asyncHandler(async (req, res) => {
      const seatMap = await service.getSeatMap(req.params.venue, req.params.section);
      res.status(200).json(seatMap);
    }),
  );

  // ── Browse: all seats in a section with effective status (no auth). ──────
  // Returns every seat (available/held/sold) so the UI can render seat colors.
  app.get(
    "/venues/:venue/sections/:section/seats",
    asyncHandler(async (req, res) => {
      const seats = await service.getSectionSeats(req.params.venue, req.params.section);
      res.status(200).json(seats);
    }),
  );

  // ── Browse: venue overview — section catalog + live availability. ────────
  app.get(
    "/venues/:venue/sections",
    asyncHandler(async (req, res) => {
      const sections = await service.listVenueSections(req.params.venue);
      res.status(200).json(sections);
    }),
  );

  // ── Browse: available count (AP3 — GSI1 Select=COUNT). ───────────────────
  app.get(
    "/venues/:venue/sections/:section/count",
    asyncHandler(async (req, res) => {
      const available = await service.getSectionCount(req.params.venue, req.params.section);
      res.status(200).json({ available });
    }),
  );

  // ── Browse: single seat (AP1 — strongly consistent GetItem). ─────────────
  app.get(
    "/venues/:venue/sections/:section/rows/:row/seats/:seat",
    asyncHandler(async (req, res) => {
      const { venue, section, row, seat } = req.params;
      const found = await service.getSeat(venue, section, row, seat);
      res.status(200).json(found);
    }),
  );

  // ── Hold (auth): AP6 hold + AP10 create transaction. ─────────────────────
  app.post(
    "/holds",
    requireEligibleFan,
    asyncHandler(async (req, res) => {
      const identity = seatIdentityFromBody(req.body);
      const result = await service.holdSeat({ ...identity, fanId: req.fanId! });
      res.status(201).json({
        txnId: result.txnId,
        holdExpiration: result.holdExpiration,
        seat: result.hold,
        price: result.price,
        amount: result.price,
      });
    }),
  );

  // ── Pay (auth): AP1 read + markPaid/markFailed + AP7 atomic confirm. ─────
  app.post(
    "/payments",
    requireEligibleFan,
    asyncHandler(async (req, res) => {
      const identity = seatIdentityFromBody(req.body);
      const txnId = requireString(req.body, "txnId");
      const processorResult = optionalProcessorResult(req.body);
      const result = await service.pay({
        ...identity,
        fanId: req.fanId!,
        txnId,
        processorResult,
      });
      res.status(200).json(result);
    }),
  );

  // ── Release (auth): AP8 conditional held → available. ────────────────────
  app.post(
    "/releases",
    requireEligibleFan,
    asyncHandler(async (req, res) => {
      const identity = seatIdentityFromBody(req.body);
      const seat = await service.releaseSeat(identity);
      res.status(200).json({ released: true, seat });
    }),
  );

  // ── Retrieve a fan's transaction (auth): AP5 GetItem. ────────────────────
  app.get(
    "/transactions/:txnId",
    requireEligibleFan,
    asyncHandler(async (req, res) => {
      const transaction = await service.getTransaction(req.fanId!, req.params.txnId);
      res.status(200).json(transaction);
    }),
  );

  // ── Central error → HTTP mapping (stable { error, code } shape). ─────────
  app.use(errorHandler);

  return app;
}

/**
 * Central error-handling middleware mapping domain errors to HTTP status codes.
 * Must keep the 4-arg signature so Express treats it as an error handler.
 */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const { status, code } = classifyError(err);
  const message = err instanceof Error ? err.message : "Unexpected error.";
  res.status(status).json({ error: message, code });
}

/** Map a thrown error to an HTTP status + stable machine-readable code. */
function classifyError(err: unknown): { status: number; code: string } {
  if (
    err instanceof SeatNotAvailableError ||
    err instanceof SeatConfirmationRejectedError ||
    err instanceof PaymentTransitionRejectedError ||
    err instanceof PaymentNotAllowedError ||
    err instanceof SeatNotHeldError
  ) {
    return { status: 409, code: "CONFLICT" };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, code: "NOT_FOUND" };
  }
  if (err instanceof PaymentDeclinedError) {
    return { status: 402, code: "PAYMENT_REQUIRED" };
  }
  if (err instanceof RetryExhaustedError) {
    return { status: 503, code: "SERVICE_UNAVAILABLE" };
  }
  if (err instanceof ValidationError) {
    return { status: 400, code: "BAD_REQUEST" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}
