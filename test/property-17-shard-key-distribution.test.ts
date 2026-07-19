// Feature: fair-seat-purchase, Property 17: Shard key distribution
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  hashString,
  shardIndex,
  holdsShardKey,
  DEFAULT_SHARD_COUNT,
  InvalidShardCountError,
} from "../src/shard.js";

/**
 * Property 17: Shard key distribution
 *
 * For any seat identifier, its expired-hold shard key is `hash(seatId) mod N`
 * and lies in `[0, N)`; and over a large set of seat identifiers the assignment
 * is approximately uniform across the N shards.
 *
 * Validates: Requirements 10.2, 10.3
 *
 * The design (Scale and Cost → write sharding) keys GSI2 as
 * `GSI2PK = "HOLDS#" + (hash(seatId) mod N)` to spread expired-hold writes
 * across N partitions instead of one hot partition. This test checks the two
 * halves of the property:
 *   (a) per-input correctness: the mapping is well-formed (integer in [0, N)),
 *       deterministic, matches the documented `hash mod N` formula, and the
 *       `HOLDS#<i>` key string is consistent; invalid N throws.
 *   (b) aggregate uniformity: a large sample of distinct ids spreads roughly
 *       evenly across the N shards.
 */

/** Arbitrary seat identifier string, including empty and unicode content. */
const seatIdArb = fc.string({ maxLength: 64 });

/** Arbitrary valid shard count in the design's practical range (1..50). */
const validNArb = fc.integer({ min: 1, max: 50 });

describe("Property 17: Shard key distribution", () => {
  it("shardIndex is an integer in [0, N), deterministic, and equals hash(seatId) mod N", () => {
    fc.assert(
      fc.property(seatIdArb, validNArb, (seatId, N) => {
        const idx = shardIndex(seatId, N);

        // Well-formed: a plain integer within the half-open range [0, N).
        expect(Number.isInteger(idx)).toBe(true);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(N);

        // Matches the documented scheme exactly: hash(seatId) mod N.
        expect(idx).toBe(hashString(seatId) % N);

        // Deterministic: identical inputs always produce identical output.
        expect(shardIndex(seatId, N)).toBe(idx);
      }),
      { numRuns: 300 },
    );
  });

  it("holdsShardKey returns 'HOLDS#<i>' with i === shardIndex in [0, N)", () => {
    fc.assert(
      fc.property(seatIdArb, validNArb, (seatId, N) => {
        const key = holdsShardKey(seatId, N);
        const idx = shardIndex(seatId, N);

        expect(key).toBe(`HOLDS#${idx}`);

        // Parse the suffix and re-check the range invariant.
        const suffix = key.slice("HOLDS#".length);
        const parsed = Number(suffix);
        expect(Number.isInteger(parsed)).toBe(true);
        expect(parsed).toBeGreaterThanOrEqual(0);
        expect(parsed).toBeLessThan(N);
        expect(parsed).toBe(idx);
      }),
      { numRuns: 300 },
    );
  });

  it("defaults to DEFAULT_SHARD_COUNT and stays in [0, DEFAULT_SHARD_COUNT)", () => {
    fc.assert(
      fc.property(seatIdArb, (seatId) => {
        const idx = shardIndex(seatId);
        expect(idx).toBe(hashString(seatId) % DEFAULT_SHARD_COUNT);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(DEFAULT_SHARD_COUNT);
        expect(holdsShardKey(seatId)).toBe(`HOLDS#${idx}`);
      }),
      { numRuns: 100 },
    );
  });

  it("throws InvalidShardCountError for non-positive or non-integer N", () => {
    const invalidNArb = fc.oneof(
      fc.integer({ min: -1000, max: 0 }), // N < 1
      fc.double({ min: 1.0001, max: 50, noNaN: true }).filter((n) => !Number.isInteger(n)),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
    );
    fc.assert(
      fc.property(seatIdArb, invalidNArb, (seatId, badN) => {
        expect(() => shardIndex(seatId, badN)).toThrow(InvalidShardCountError);
        expect(() => holdsShardKey(seatId, badN)).toThrow(InvalidShardCountError);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Aggregate uniformity — single large-sample statistical assertion.
   *
   * We hash SAMPLE distinct, realistic seat identifiers into N = 10 shards and
   * check that every bucket is close to the expected mean (SAMPLE / N).
   *
   * Tolerance rationale:
   *   - Expected mean per bucket is 5000 / 10 = 500.
   *   - For a good hash the counts behave like a multinomial; the per-bucket
   *     standard deviation is sqrt(n * p * (1-p)) = sqrt(5000 * 0.1 * 0.9) ≈ 21.2.
   *     A ±40% band (300..700) is ~9.4 standard deviations wide, so a correct
   *     hash effectively never trips it (no flakiness), while a broken hash
   *     (e.g. one that collapses ids onto a few shards, leaving other buckets
   *     near 0 or piling far above 700) is reliably caught.
   *   - We additionally assert no bucket is empty and a loose chi-square-style
   *     bound to catch subtler skew than the min/max band alone.
   */
  it("distributes ~5000 distinct seat identifiers approximately uniformly across N=10 shards", () => {
    const N = 10;
    const SAMPLE = 5000;

    const counts = new Array<number>(N).fill(0);
    for (let i = 0; i < SAMPLE; i++) {
      // Distinct, seat-like identifiers spanning multiple venues/sections/rows.
      const seatId = `SEAT#VENUE${i % 7}#SEC${(i % 13)}|ROW#${i % 29}#SEAT#${i}`;
      const idx = shardIndex(seatId, N);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(N);
      counts[idx]++;
    }

    const mean = SAMPLE / N; // 500
    const lower = mean * 0.6; // 300
    const upper = mean * 1.4; // 700

    // Every shard is used and within the ±40% band of the mean.
    for (let s = 0; s < N; s++) {
      expect(counts[s]).toBeGreaterThan(0);
      expect(counts[s]).toBeGreaterThanOrEqual(lower);
      expect(counts[s]).toBeLessThanOrEqual(upper);
    }

    // Loose chi-square goodness-of-fit check against a uniform expectation.
    // Chi-square = sum((observed - mean)^2 / mean). For df = N-1 = 9, the
    // 99.9% critical value is ~27.9; we use a generous bound of 50 so a
    // well-distributed hash passes comfortably while gross skew is rejected.
    const chiSquare = counts.reduce((acc, c) => acc + ((c - mean) ** 2) / mean, 0);
    expect(chiSquare).toBeLessThan(50);

    // Sanity: the counts must sum back to the sample size.
    expect(counts.reduce((a, b) => a + b, 0)).toBe(SAMPLE);
  });
});
