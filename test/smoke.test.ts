import { describe, it, expect } from "vitest";
import { SeatStore, seatKey } from "../src/index.js";

/**
 * Toolchain smoke test. This verifies that TypeScript + vitest + the module
 * resolution are wired correctly against the reference model. Real
 * property-based and unit tests are added by later tasks.
 */
describe("toolchain", () => {
  it("builds and runs the test runner", () => {
    const store = new SeatStore();
    const identity = { venue: "VENUE1", section: "A", row: "1", seat: "1" };
    const seat = store.createSeat(identity);
    expect(seat.Seat_Status).toBe("available");
    expect(seatKey(identity)).toEqual({ PK: "SEAT#VENUE1#A", SK: "ROW#1#SEAT#1" });
  });
});
