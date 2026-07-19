/**
 * Fair Seat Purchase — HTTP API contract tests.
 *
 * These tests exercise the Express app built by `createApp` end-to-end with
 * supertest, but against an INJECTED in-memory fake `TicketingService` — so they
 * run with NO real DynamoDB and no network. They verify:
 *   - routing + response shapes for every endpoint,
 *   - the placeholder auth gate (401 when no fan id is presented),
 *   - the happy-path hold → pay → confirm response shapes,
 *   - the central domain-error → HTTP-status mapping (409/404/402/400).
 *
 * The fake implements exactly the public surface `createApp` depends on and is
 * cast to `TicketingService`; it throws the real domain error classes so the
 * error-mapping middleware is tested against genuine error types.
 */

import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/api/app.js";
import type {
  HoldSeatInput,
  HoldSeatResult,
  PayInput,
  PayResult,
  TicketingService,
} from "../src/service/ticketing-service.js";
import {
  NotFoundError,
  PaymentDeclinedError,
  PaymentNotAllowedError,
} from "../src/service/ticketing-service.js";
import { SeatNotAvailableError } from "../src/aws/seat-repository.js";
import type { Seat, SeatIdentity } from "../src/seat.js";
import type { PurchaseTransaction } from "../src/transaction.js";

/** A configurable in-memory fake of the service's public surface. */
class FakeTicketingService {
  public heldSeat: Seat = makeSeat("held", "fan-1");
  public soldSeat: Seat = makeSeat("sold", "fan-1");
  public availableSeat: Seat = makeSeat("available");
  public txn: PurchaseTransaction = makeTxn();

  /** When set, `getSeat` throws NotFound; otherwise returns `availableSeat`. */
  public seatMissing = false;
  /** When true, `holdSeat` throws SeatNotAvailableError. */
  public holdConflict = false;
  /** Controls `pay` behaviour: 'confirm' | 'declined' | 'not-allowed'. */
  public payMode: "confirm" | "declined" | "not-allowed" = "confirm";

  async getSeatMap(_venue: string, _section: string): Promise<Seat[]> {
    return [this.availableSeat];
  }

  async getSectionCount(_venue: string, _section: string): Promise<number> {
    return 42;
  }

  async getSeat(venue: string, section: string, row: string, seat: string): Promise<Seat> {
    if (this.seatMissing) {
      throw new NotFoundError("seat", `${venue}/${section}/${row}/${seat}`);
    }
    return this.availableSeat;
  }

  async holdSeat(input: HoldSeatInput): Promise<HoldSeatResult> {
    if (this.holdConflict) {
      throw new SeatNotAvailableError(identityOf(input));
    }
    return { hold: this.heldSeat, txnId: "txn-123", holdExpiration: 1_000_480 };
  }

  async pay(input: PayInput): Promise<PayResult> {
    if (this.payMode === "declined") {
      throw new PaymentDeclinedError("failure");
    }
    if (this.payMode === "not-allowed") {
      throw new PaymentNotAllowedError("hold-expired", identityOf(input));
    }
    return { outcome: "confirmed", seat: this.soldSeat, transaction: this.txn };
  }

  async releaseSeat(_identity: SeatIdentity): Promise<Seat> {
    return this.availableSeat;
  }

  async getTransaction(_fanId: string, _txnId: string): Promise<PurchaseTransaction> {
    return this.txn;
  }
}

function identityOf(input: SeatIdentity): SeatIdentity {
  return { venue: input.venue, section: input.section, row: input.row, seat: input.seat };
}

function makeSeat(status: "available" | "held" | "sold", holder?: string): Seat {
  return {
    PK: "SEAT#v1#A",
    SK: "ROW#1#SEAT#1",
    Venue: "v1",
    Section: "A",
    Row: "1",
    Seat_Number: "1",
    Seat_Status: status,
    Holder_Identifier: holder,
    Hold_Expiration: status === "held" ? 1_000_480 : undefined,
    Version: 1,
  };
}

function makeTxn(): PurchaseTransaction {
  return {
    PK: "TXN#fan-1",
    SK: "TXN#txn-123",
    Entity_Type: "TXN",
    Fan_Id: "fan-1",
    Seat_Ref: "SEAT#v1#A|ROW#1#SEAT#1",
    Payment_Status: "paid",
    Txn_State: "confirmed",
    Confirmation_Timestamp: "2025-01-01T00:00:00.000Z",
    Created_At: "2025-01-01T00:00:00.000Z",
  };
}

/** Build an app around a fresh fake, returning both for assertions. */
function setup(): { app: ReturnType<typeof createApp>; fake: FakeTicketingService } {
  const fake = new FakeTicketingService();
  const app = createApp(fake as unknown as TicketingService);
  return { app, fake };
}

const FAN_HEADER = { "x-fan-id": "fan-1" } as const;

describe("health", () => {
  it("GET /health returns 200 {status:'ok'}", async () => {
    const { app } = setup();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("browse routes (no auth)", () => {
  it("GET seatmap returns the seat array", async () => {
    const { app } = setup();
    const res = await request(app).get("/venues/v1/sections/A/seatmap");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it("GET count returns {available:number}", async () => {
    const { app } = setup();
    const res = await request(app).get("/venues/v1/sections/A/count");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: 42 });
  });

  it("GET seat returns the seat", async () => {
    const { app } = setup();
    const res = await request(app).get("/venues/v1/sections/A/rows/1/seats/1");
    expect(res.status).toBe(200);
    expect(res.body.Seat_Status).toBe("available");
  });

  it("GET seat returns 404 when the seat is missing", async () => {
    const { app, fake } = setup();
    fake.seatMissing = true;
    const res = await request(app).get("/venues/v1/sections/A/rows/9/seats/9");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});

describe("auth gate (placeholder)", () => {
  it("POST /holds returns 401 when the fan-id header is missing", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/holds")
      .send({ venue: "v1", section: "A", row: "1", seat: "1" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  it("accepts an Authorization: Bearer token as the fan id", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/holds")
      .set("Authorization", "Bearer fan-9")
      .send({ venue: "v1", section: "A", row: "1", seat: "1" });
    expect(res.status).toBe(201);
  });
});

describe("hold → pay → confirm happy path", () => {
  it("POST /holds returns 201 {txnId, holdExpiration, seat}", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/holds")
      .set(FAN_HEADER)
      .send({ venue: "v1", section: "A", row: "1", seat: "1" });
    expect(res.status).toBe(201);
    expect(res.body.txnId).toBe("txn-123");
    expect(res.body.holdExpiration).toBe(1_000_480);
    expect(res.body.seat.Seat_Status).toBe("held");
  });

  it("POST /payments returns 200 with the confirmed seat + transaction", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/payments")
      .set(FAN_HEADER)
      .send({ venue: "v1", section: "A", row: "1", seat: "1", txnId: "txn-123" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("confirmed");
    expect(res.body.seat.Seat_Status).toBe("sold");
    expect(res.body.transaction.Txn_State).toBe("confirmed");
  });

  it("GET /transactions/:txnId returns the transaction for the authenticated fan", async () => {
    const { app } = setup();
    const res = await request(app).get("/transactions/txn-123").set(FAN_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.Fan_Id).toBe("fan-1");
  });

  it("POST /releases returns 200", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/releases")
      .set(FAN_HEADER)
      .send({ venue: "v1", section: "A", row: "1", seat: "1" });
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(true);
  });
});

describe("error → status mapping", () => {
  it("409 Conflict when a hold hits SeatNotAvailableError", async () => {
    const { app, fake } = setup();
    fake.holdConflict = true;
    const res = await request(app)
      .post("/holds")
      .set(FAN_HEADER)
      .send({ venue: "v1", section: "A", row: "1", seat: "1" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("402 Payment Required when the processor declines", async () => {
    const { app, fake } = setup();
    fake.payMode = "declined";
    const res = await request(app)
      .post("/payments")
      .set(FAN_HEADER)
      .send({ venue: "v1", section: "A", row: "1", seat: "1", txnId: "txn-123" });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("PAYMENT_REQUIRED");
  });

  it("409 Conflict when payment admission fails (hold expired)", async () => {
    const { app, fake } = setup();
    fake.payMode = "not-allowed";
    const res = await request(app)
      .post("/payments")
      .set(FAN_HEADER)
      .send({ venue: "v1", section: "A", row: "1", seat: "1", txnId: "txn-123" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("400 Bad Request when required body fields are missing", async () => {
    const { app } = setup();
    const res = await request(app).post("/holds").set(FAN_HEADER).send({ venue: "v1" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
  });

  it("400 Bad Request when processorResult is not a valid enum value", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/payments")
      .set(FAN_HEADER)
      .send({ venue: "v1", section: "A", row: "1", seat: "1", txnId: "t", processorResult: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
  });
});
