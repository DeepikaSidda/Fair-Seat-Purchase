/**
 * Fair Seat Purchase — authentication middleware (PLACEHOLDER).
 *
 * ⚠️ SECURITY NOTICE — READ BEFORE DEPLOYING ⚠️
 * ------------------------------------------------------------------------------
 * `requireEligibleFan` is a DELIBERATE PLACEHOLDER, not real authentication.
 *
 * In production, fan eligibility for the purchasing lifecycle is gated UPSTREAM
 * of this service by a waiting-room / fair-queue admission system that issues a
 * short-lived, signed token once a fan reaches the front of the queue (design:
 * fairness and admission control). The real service MUST sit behind that gate
 * (e.g. an API Gateway authorizer / Lambda authorizer validating the signed
 * token) and MUST NOT be exposed to the public internet without it. Skipping
 * that gate would let un-throttled clients stampede the seat inventory,
 * defeating the fairness guarantees the whole system exists to provide.
 *
 * This middleware exists to make the auth boundary EXPLICIT in code rather than
 * silently open: it extracts a fan identifier from the request and rejects
 * requests that carry none with `401 Unauthorized`. It performs NO token
 * verification, NO signature checking, and NO eligibility check. Replace it with
 * a real authorizer before any non-demo deployment.
 * ------------------------------------------------------------------------------
 *
 * Fan-id sources (first match wins):
 *   1. `x-fan-id` header.
 *   2. `Authorization: Bearer <fanId>` header (the bearer value is treated as
 *      the raw fan id for the demo — again, NOT verified).
 */

import type { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The authenticated fan id, attached by {@link requireEligibleFan}. */
      fanId?: string;
    }
  }
}

/** Extract a fan id from the `x-fan-id` header or an `Authorization: Bearer` token. */
export function extractFanId(req: Request): string | undefined {
  const headerFanId = req.header("x-fan-id");
  if (headerFanId && headerFanId.trim().length > 0) {
    return headerFanId.trim();
  }
  const authHeader = req.header("authorization");
  if (authHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  return undefined;
}

/**
 * PLACEHOLDER eligibility gate. Attaches `req.fanId` when a fan id is present,
 * otherwise responds `401 Unauthorized` with the stable `{error, code}` shape.
 * See the module-level security notice: this is NOT real authentication.
 */
export function requireEligibleFan(req: Request, res: Response, next: NextFunction): void {
  const fanId = extractFanId(req);
  if (fanId === undefined) {
    res.status(401).json({
      error: "Missing fan identity: provide an 'x-fan-id' header or 'Authorization: Bearer <fanId>'.",
      code: "UNAUTHENTICATED",
    });
    return;
  }
  req.fanId = fanId;
  next();
}
