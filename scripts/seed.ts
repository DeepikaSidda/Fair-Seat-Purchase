/**
 * Fair Seat Purchase — seed script (large, tiered demo venue).
 *
 * Seeds a single large arena, `ARENA1`, with five price tiers across sixteen
 * sections (~4,568 seats). Two artefacts are written per section onto the SAME
 * single table:
 *
 *   1. A section-catalog item (Entity_Type = "SECTION") describing the tier,
 *      price, capacity, and geometry — via `SectionRepository.putSection`.
 *   2. Every seat in the section, created `available`, carrying the section's
 *      `Price` + `Tier` and the GSI1 seat-map attributes.
 *
 * PERFORMANCE: seats are written with `BatchWriteItem` (25 items/batch, plain
 * Put, no per-item condition) with a bounded number of batches in flight, so a
 * few-thousand-seat venue seeds quickly. Because there is no condition, a
 * re-run overwrites existing items (acceptable for a demo seed) — every seat is
 * reset to `available`.
 *
 * Run: `npm run db:seed` (or `npx tsx scripts/seed.ts`). Point at DynamoDB Local
 * by setting `FSP_DDB_ENDPOINT=http://localhost:8000`.
 */

import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

import { TABLE_NAME, createDocumentClient } from "../src/aws/ddb-client.js";
import { SectionRepository } from "../src/aws/section-repository.js";
import { gsi1Attributes } from "../src/aws/keys.js";

/** The primary demo venue. */
const VENUE = "ARENA1";

/** How many BatchWriteItem requests to keep in flight at once. */
const MAX_BATCHES_IN_FLIGHT = 8;

/** DynamoDB caps BatchWriteItem at 25 items per request. */
const BATCH_SIZE = 25;

/** One pricing tier spanning one or more sections with identical geometry. */
interface TierSpec {
  readonly tier: string;
  readonly price: number;
  readonly sections: readonly string[];
  readonly rowCount: number;
  readonly seatsPerRow: number;
}

/**
 * The tiered layout: 5 tiers, 16 sections, ~4,568 seats.
 *   VIP Floor : 2 × (8 × 25 = 200)  = 400   @ $499
 *   Lower     : 4 × (12 × 22 = 264) = 1,056 @ $249
 *   Club      : 3 × (10 × 20 = 200) = 600   @ $179
 *   Upper     : 5 × (14 × 24 = 336) = 1,680 @ $89
 *   Balcony   : 2 × (16 × 26 = 416) = 832   @ $45
 */
const TIERS: readonly TierSpec[] = [
  {
    tier: "VIP",
    price: 499,
    sections: ["FLR-A", "FLR-B"],
    rowCount: 8,
    seatsPerRow: 25,
  },
  {
    tier: "Lower",
    price: 249,
    sections: ["LWR-101", "LWR-102", "LWR-103", "LWR-104"],
    rowCount: 12,
    seatsPerRow: 22,
  },
  {
    tier: "Club",
    price: 179,
    sections: ["CLB-201", "CLB-202", "CLB-203"],
    rowCount: 10,
    seatsPerRow: 20,
  },
  {
    tier: "Upper",
    price: 89,
    sections: ["UPR-301", "UPR-302", "UPR-303", "UPR-304", "UPR-305"],
    rowCount: 14,
    seatsPerRow: 24,
  },
  {
    tier: "Balcony",
    price: 45,
    sections: ["BAL-401", "BAL-402"],
    rowCount: 16,
    seatsPerRow: 26,
  },
];

/** A DynamoDB PutRequest for the BatchWriteItem body. */
type PutRequest = { PutRequest: { Item: Record<string, unknown> } };

/** Build a single seat item (available, priced, with GSI1 seat-map attributes). */
function seatItem(
  section: string,
  tier: string,
  price: number,
  row: string,
  seat: string,
): Record<string, unknown> {
  const identity = { venue: VENUE, section, row, seat };
  const gsi1 = gsi1Attributes(identity);
  return {
    PK: `SEAT#${VENUE}#${section}`,
    SK: `ROW#${row}#SEAT#${seat}`,
    Entity_Type: "SEAT",
    Venue: VENUE,
    Section: section,
    Row: row,
    Seat_Number: seat,
    Seat_Status: "available",
    GSI1PK: gsi1.GSI1PK,
    GSI1SK: gsi1.GSI1SK,
    Version: 0,
    Price: price,
    Tier: tier,
  };
}

/** Split an array into fixed-size chunks. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Write all PutRequests via BatchWriteItem with bounded concurrency, retrying
 * any UnprocessedItems with a short backoff. Returns the number of items written.
 */
async function batchWriteAll(
  doc: ReturnType<typeof createDocumentClient>,
  requests: readonly PutRequest[],
): Promise<number> {
  const batches = chunk(requests, BATCH_SIZE);
  let written = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < batches.length) {
      const index = cursor++;
      let pending = batches[index];
      let attempt = 0;
      // Retry loop for UnprocessedItems (DynamoDB may throttle a batch).
      while (pending.length > 0) {
        const res = await doc.send(
          new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: pending } }),
        );
        const unprocessed = res.UnprocessedItems?.[TABLE_NAME] as PutRequest[] | undefined;
        const doneNow = pending.length - (unprocessed?.length ?? 0);
        written += doneNow;
        if (!unprocessed || unprocessed.length === 0) {
          break;
        }
        pending = unprocessed;
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(1000, 50 * 2 ** attempt)));
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(MAX_BATCHES_IN_FLIGHT, batches.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return written;
}

async function main(): Promise<void> {
  const doc = createDocumentClient();
  const sectionRepo = new SectionRepository(doc, TABLE_NAME);

  // Build the full seat item list and write the section catalog.
  const seatRequests: PutRequest[] = [];
  let plannedSeats = 0;
  let sectionCount = 0;

  console.log(`Seeding venue "${VENUE}" into table "${TABLE_NAME}"...`);

  for (const spec of TIERS) {
    const capacity = spec.rowCount * spec.seatsPerRow;
    for (const section of spec.sections) {
      sectionCount++;
      plannedSeats += capacity;
      // 1) Section-catalog item.
      await sectionRepo.putSection({
        venue: VENUE,
        section,
        tier: spec.tier,
        price: spec.price,
        capacity,
        rowCount: spec.rowCount,
        seatsPerRow: spec.seatsPerRow,
      });
      // 2) Seat items for the section.
      for (let r = 1; r <= spec.rowCount; r++) {
        for (let s = 1; s <= spec.seatsPerRow; s++) {
          seatRequests.push({
            PutRequest: {
              Item: seatItem(section, spec.tier, spec.price, String(r), String(s)),
            },
          });
        }
      }
      console.log(
        `  section ${section} (${spec.tier}, $${spec.price}): ` +
          `${spec.rowCount}×${spec.seatsPerRow} = ${capacity} seats`,
      );
    }
  }

  console.log(
    `Catalog written: ${sectionCount} sections. ` +
      `Writing ${plannedSeats} seats via BatchWriteItem (${BATCH_SIZE}/batch, ` +
      `${MAX_BATCHES_IN_FLIGHT} in flight)...`,
  );

  const start = Date.now();
  const written = await batchWriteAll(doc, seatRequests);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(
    `Seed complete: ${sectionCount} sections + ${written} seats written to ` +
      `"${TABLE_NAME}" in ${elapsed}s.`,
  );
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exitCode = 1;
});
