/**
 * Fair Seat Purchase — DynamoDB-backed section-catalog repository (AWS SDK v3).
 *
 * The section catalog is a new item type stored on the SAME single table as
 * seats and transactions. Each section is one item describing a pricing tier and
 * capacity for a (venue, section) pair. The catalog is addressed entirely by the
 * base-table primary key, so it needs NO new index:
 *
 *   PK = `VENUE#<venue>`     — groups every section of a venue under one partition
 *   SK = `SECTION#<section>` — uniquely identifies the section within the venue
 *
 * Access patterns (all on the base table):
 * - putSection   → PutItem (plain; overwriting is acceptable for catalog seeds).
 * - listSections → Query `PK = :pk AND begins_with(SK, "SECTION#")`, eventually
 *                  consistent, returned sorted by Price descending.
 * - getSection   → GetItem by (PK, SK).
 *
 * Storing the catalog on the base table (rather than a GSI) keeps browsing cheap
 * and avoids any schema change: a single `Query` returns the whole venue catalog.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import { TABLE_NAME, getDocumentClient } from "./ddb-client.js";

/** The catalog partition key for a venue: `VENUE#<venue>`. */
export function sectionPK(venue: string): string {
  return `VENUE#${venue}`;
}

/** The catalog sort key for a section: `SECTION#<section>`. */
export function sectionSK(section: string): string {
  return `SECTION#${section}`;
}

/** The `SECTION#` sort-key prefix used by the venue-catalog `begins_with` query. */
export const SECTION_SK_PREFIX = "SECTION#" as const;

/** Arguments to {@link SectionRepository.putSection}. */
export interface PutSectionInput {
  readonly venue: string;
  readonly section: string;
  /** Pricing tier label, e.g. "VIP" | "Lower" | "Club" | "Upper" | "Balcony". */
  readonly tier: string;
  /** Whole-dollar price for every seat in the section. */
  readonly price: number;
  /** Total number of seats in the section. */
  readonly capacity: number;
  /** Number of rows in the section. */
  readonly rowCount: number;
  /** Number of seats per row in the section. */
  readonly seatsPerRow: number;
}

/** A section-catalog item as stored on the base table. */
export interface SectionItem {
  readonly PK: string;
  readonly SK: string;
  readonly Entity_Type: "SECTION";
  readonly Venue: string;
  readonly Section: string;
  readonly Tier: string;
  readonly Price: number;
  readonly Capacity: number;
  readonly RowCount: number;
  readonly SeatsPerRow: number;
}

/**
 * DynamoDB-backed repository for section-catalog items. Stateless — the catalog
 * lives entirely on the base table and is queried by primary key.
 */
export class SectionRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient = getDocumentClient(),
    private readonly tableName: string = TABLE_NAME,
  ) {}

  /**
   * Create (or overwrite) a section-catalog item as a plain `PutItem`. The
   * catalog is reference data, so overwriting an existing section is acceptable
   * and makes seeding idempotent.
   */
  async putSection(input: PutSectionInput): Promise<void> {
    const item: SectionItem = {
      PK: sectionPK(input.venue),
      SK: sectionSK(input.section),
      Entity_Type: "SECTION",
      Venue: input.venue,
      Section: input.section,
      Tier: input.tier,
      Price: input.price,
      Capacity: input.capacity,
      RowCount: input.rowCount,
      SeatsPerRow: input.seatsPerRow,
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      }),
    );
  }

  /**
   * List every section of a venue via a base-table `Query`
   * (`PK = VENUE#<venue> AND begins_with(SK, "SECTION#")`), eventually
   * consistent. Paginates across all pages and returns the catalog sorted by
   * `Price` descending (most expensive tier first).
   */
  async listSections(venue: string): Promise<SectionItem[]> {
    const items: SectionItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: {
            ":pk": sectionPK(venue),
            ":sk": SECTION_SK_PREFIX,
          },
          ConsistentRead: false,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      if (res.Items) {
        items.push(...(res.Items as SectionItem[]));
      }
      exclusiveStartKey = res.LastEvaluatedKey;
    } while (exclusiveStartKey);
    items.sort((a, b) => b.Price - a.Price);
    return items;
  }

  /**
   * Retrieve a single section-catalog item by (venue, section) via `GetItem`.
   *
   * @returns the section, or `undefined` if it does not exist.
   */
  async getSection(venue: string, section: string): Promise<SectionItem | undefined> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: sectionPK(venue), SK: sectionSK(section) },
      }),
    );
    return res.Item as SectionItem | undefined;
  }
}
