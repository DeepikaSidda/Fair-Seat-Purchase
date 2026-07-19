// Feature: fair-seat-purchase, Integration/Smoke: structural guarantees
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SeatStore,
  holdSeat,
  DEFAULT_HOLD_WINDOW_SECONDS,
  type Seat,
} from "../src/index.js";

/**
 * Integration / smoke tests for the structural guarantees of the data model.
 *
 * Unlike the property tests (which exercise the runtime state machine), these
 * tests audit the *structure* of the submission artifacts — the NoSQL Workbench
 * model (`fair-seat-purchase.json`), the access-pattern matrix
 * (`access-patterns.csv`), and the shapes produced by the reference
 * implementation — to prove three design-level promises hold:
 *
 *   1. Item-size-under-400KB       — Requirements 1.8, 10.4
 *   2. GSI projection scoping       — Requirements 3.5, 10.8
 *   3. Query/GetItem-not-Scan audit — Requirements 1.9, 2.5, 3.2, 9.2, 10.5
 *
 * These are structural smoke tests: they read the actual committed artifacts so
 * that if a future edit widens a projection, bloats an item, or introduces a
 * Scan-based access pattern, the suite fails.
 */

// --- Artifact loading helpers -------------------------------------------------

/** Resolve a path relative to the repository root (one level up from /test). */
function repoPath(relative: string): string {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

interface WorkbenchProjection {
  ProjectionType: "ALL" | "KEYS_ONLY" | "INCLUDE";
  NonKeyAttributes?: string[];
}

interface WorkbenchGsi {
  IndexName: string;
  Projection: WorkbenchProjection;
}

interface WorkbenchTable {
  TableName: string;
  GlobalSecondaryIndexes: WorkbenchGsi[];
  TableData: Array<Record<string, Record<string, string>>>;
}

interface WorkbenchModel {
  ModelName: string;
  DataModel: WorkbenchTable[];
}

function loadModel(): WorkbenchTable {
  const raw = readFileSync(repoPath("fair-seat-purchase.json"), "utf8");
  const model = JSON.parse(raw) as WorkbenchModel;
  expect(model.DataModel.length).toBeGreaterThan(0);
  return model.DataModel[0];
}

/** DynamoDB hard limit on a single item: 400 KB. */
const ITEM_SIZE_LIMIT_BYTES = 400 * 1024; // 409,600
/**
 * "Well under" threshold. Seat and transaction items are a few hundred bytes;
 * a 4 KB ceiling is ~100x below the hard limit and still leaves an enormous
 * margin, so it documents "far under 400 KB" while catching accidental bloat.
 */
const WELL_UNDER_BYTES = 4 * 1024; // 4,096

/**
 * DynamoDB item-size accounting is (roughly) the sum of attribute-name bytes
 * plus attribute-value bytes (UTF-8). We approximate it from the modeled item
 * by summing the UTF-8 length of every attribute name and its scalar value.
 * This over- or approximately-counts vs. the exact wire format, which is fine
 * here: we only need to prove the items sit far below the limit.
 */
function approximateItemSizeBytes(item: Record<string, Record<string, string>>): number {
  let bytes = 0;
  for (const [name, typed] of Object.entries(item)) {
    bytes += Buffer.byteLength(name, "utf8");
    // typed is like { S: "..." } or { N: "123" }; count the scalar payload.
    for (const value of Object.values(typed)) {
      bytes += Buffer.byteLength(String(value), "utf8");
    }
  }
  return bytes;
}

/** Size of a reference-model seat item, serialized as it would be persisted. */
function referenceSeatSizeBytes(seat: Seat): number {
  let bytes = 0;
  for (const [name, value] of Object.entries(seat)) {
    if (value === undefined) continue;
    bytes += Buffer.byteLength(name, "utf8");
    bytes += Buffer.byteLength(String(value), "utf8");
  }
  return bytes;
}

// --- Minimal CSV parser (handles quoted fields with embedded commas) ---------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // ignore; handled by \n
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing empty rows.
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

// -----------------------------------------------------------------------------
// 1. Item size under 400 KB (R1.8, R10.4)
// -----------------------------------------------------------------------------

describe("Structural: item size stays under 400 KB (R1.8, R10.4)", () => {
  const table = loadModel();

  it("every modeled seat and transaction item is far under the 400 KB limit", () => {
    expect(table.TableData.length).toBeGreaterThan(0);
    for (const item of table.TableData) {
      const size = approximateItemSizeBytes(item);
      const label = `${item.PK?.S ?? "?"} | ${item.SK?.S ?? "?"}`;
      expect(size, `item ${label} must be < 400 KB`).toBeLessThan(ITEM_SIZE_LIMIT_BYTES);
      expect(size, `item ${label} must be well under 400 KB`).toBeLessThan(WELL_UNDER_BYTES);
    }
  });

  it("modeled seat items and transaction items are both represented and small", () => {
    const seats = table.TableData.filter((i) => i.Entity_Type?.S === "SEAT");
    const txns = table.TableData.filter((i) => i.Entity_Type?.S === "TXN");
    expect(seats.length).toBeGreaterThan(0);
    expect(txns.length).toBeGreaterThan(0);

    const largestSeat = Math.max(...seats.map(approximateItemSizeBytes));
    const largestTxn = Math.max(...txns.map(approximateItemSizeBytes));
    expect(largestSeat).toBeLessThan(WELL_UNDER_BYTES);
    expect(largestTxn).toBeLessThan(WELL_UNDER_BYTES);
  });

  it("reference-model seat items (available and held) are far under 400 KB", () => {
    const store = new SeatStore();
    const identity = { venue: "VENUE1", section: "A", row: "1", seat: "1" };
    const available = store.createSeat(identity);
    expect(referenceSeatSizeBytes(available)).toBeLessThan(WELL_UNDER_BYTES);

    // A held seat carries the most attributes (holder + expiration), so it is
    // the largest seat shape the reference model produces.
    const now = 1_735_689_600;
    const held = holdSeat(store, identity, "FAN#alice", {
      now,
      holdWindowSeconds: DEFAULT_HOLD_WINDOW_SECONDS,
    });
    const heldSize = referenceSeatSizeBytes(held);
    expect(heldSize).toBeLessThan(ITEM_SIZE_LIMIT_BYTES);
    expect(heldSize).toBeLessThan(WELL_UNDER_BYTES);
  });
});

// -----------------------------------------------------------------------------
// 2. GSI projection scoping (R3.5, R10.8)
// -----------------------------------------------------------------------------

describe("Structural: GSI projections are intentionally scoped (R3.5, R10.8)", () => {
  const table = loadModel();
  const gsiByName = new Map(table.GlobalSecondaryIndexes.map((g) => [g.IndexName, g]));

  it("GSI1 uses INCLUDE scoped to exactly {Row, Seat_Number, Seat_Status}", () => {
    const gsi1 = gsiByName.get("GSI1");
    expect(gsi1, "GSI1 must exist").toBeDefined();
    expect(gsi1!.Projection.ProjectionType).toBe("INCLUDE");

    const projected = new Set(gsi1!.Projection.NonKeyAttributes ?? []);
    expect(projected).toEqual(new Set(["Row", "Seat_Number", "Seat_Status"]));

    // Explicitly NOT a full projection — that is the cost guarantee (R10.8).
    expect(gsi1!.Projection.ProjectionType).not.toBe("ALL");
    // No stray attributes leaked into the seat-map index.
    expect(gsi1!.Projection.NonKeyAttributes).toHaveLength(3);
  });

  it("GSI2 uses KEYS_ONLY (sweeper only needs keys to locate items)", () => {
    const gsi2 = gsiByName.get("GSI2");
    expect(gsi2, "GSI2 must exist").toBeDefined();
    expect(gsi2!.Projection.ProjectionType).toBe("KEYS_ONLY");
    // KEYS_ONLY carries no NonKeyAttributes.
    expect(gsi2!.Projection.NonKeyAttributes ?? []).toHaveLength(0);
  });

  it("no GSI uses a full (ALL) projection", () => {
    for (const gsi of table.GlobalSecondaryIndexes) {
      expect(gsi.Projection.ProjectionType, `${gsi.IndexName} projection`).not.toBe("ALL");
    }
  });
});

// -----------------------------------------------------------------------------
// 3. Query/GetItem-not-Scan access-layer audit
//    (R1.9, R2.5, R3.2, R9.2, R10.5)
// -----------------------------------------------------------------------------

describe("Structural: every access pattern avoids Scan (R1.9, R2.5, R3.2, R9.2, R10.5)", () => {
  const csv = readFileSync(repoPath("access-patterns.csv"), "utf8");
  const rows = parseCsv(csv);
  const header = rows[0];
  const dataRows = rows.slice(1);

  const opIndex = header.indexOf("Operation");
  const patternIdIndex = header.indexOf("Pattern ID");

  /** The only DynamoDB operations the design permits for any access pattern. */
  const ALLOWED_OPS = [
    "GetItem",
    "Query",
    "UpdateItem",
    "PutItem",
    "TransactWriteItems",
  ] as const;

  it("the access-pattern matrix parsed with the expected columns and rows", () => {
    expect(opIndex).toBeGreaterThanOrEqual(0);
    expect(patternIdIndex).toBeGreaterThanOrEqual(0);
    // AP1..AP10 — all ten defined access patterns are present.
    expect(dataRows).toHaveLength(10);
    for (const row of dataRows) {
      expect(row[patternIdIndex]).toMatch(/^AP\d+$/);
    }
  });

  it("every defined access pattern uses an allowed operation and never Scan", () => {
    for (const row of dataRows) {
      const patternId = row[patternIdIndex];
      const operation = row[opIndex];

      // Never a Scan (case-insensitive, word-boundary to avoid false hits).
      expect(operation, `${patternId} operation "${operation}"`).not.toMatch(/\bscan\b/i);

      // Uses at least one of the permitted GetItem/Query/Update/Put/Transact ops.
      const usesAllowed = ALLOWED_OPS.some((op) => operation.includes(op));
      expect(
        usesAllowed,
        `${patternId} operation "${operation}" must use one of ${ALLOWED_OPS.join(", ")}`,
      ).toBe(true);
    }
  });

  it("no Scan appears anywhere in the access-pattern matrix operations column", () => {
    const allOps = dataRows.map((r) => r[opIndex]).join(" | ");
    expect(allOps).not.toMatch(/\bscan\b/i);
  });

  it("the read-oriented lookup patterns resolve via GetItem or Query, not Scan (R1.9, R2.5, R3.2, R9.2)", () => {
    // Map the specific requirements this audit covers to their access patterns.
    const readPatterns: Record<string, string> = {
      AP1: "seat lookup (R1.9, R11.1)",
      AP2: "seat map (R3.2, R11.3)",
      AP4: "expired holds sweep (R9.2, R11.5)",
      AP5: "fan transaction retrieval (R2.5, R11.6)",
    };
    for (const [apId, desc] of Object.entries(readPatterns)) {
      const row = dataRows.find((r) => r[patternIdIndex] === apId);
      expect(row, `${apId} (${desc}) must be defined`).toBeDefined();
      const operation = row![opIndex];
      expect(operation, `${apId} (${desc})`).toMatch(/GetItem|Query/);
      expect(operation, `${apId} (${desc})`).not.toMatch(/\bscan\b/i);
    }
  });
});
