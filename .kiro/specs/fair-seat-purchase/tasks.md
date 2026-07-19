# Implementation Plan: Fair Seat Purchase

## Overview

This is a design/documentation challenge submission for the AWS Builder Center "Fair Seat
Purchase" challenge, so the plan is ordered to produce the **graded deliverables first** and
treat the reference implementation plus property-based tests as **validation/stretch work**
that proves the design is correct.

- Tasks 1–4 (core, required): the NoSQL Workbench data model JSON, the finalized submission
  design document, the access pattern matrix, the architecture diagram, the repository README,
  and the submission checklist.
- Tasks 5–10 (validation/stretch): a TypeScript reference model of the seat/transaction state
  machine and its conditional-write semantics, plus fast-check property-based tests that
  validate all 17 correctness properties from the design, along with supporting unit and
  integration/smoke tests.

The reference implementation and property tests use **TypeScript** with **fast-check**
(chosen per the design's Testing Strategy, which lists fast-check as the TS/JS option).

Convert the feature design into a series of prompts for a code-generation LLM that will
implement each step with incremental progress. Each task builds on the previous ones and ends
with wiring things together; there is no orphaned work.

## Tasks

- [x] 1. Build the NoSQL Workbench data model (`fair-seat-purchase.json`)
  - [x] 1.1 Author the base table schema in the NoSQL Workbench JSON
    - Create `fair-seat-purchase.json` with table `FairSeatPurchase`
    - Define primary key `PK` (S) / `SK` (S) and the seat + transaction attribute set
      (`Entity_Type`, `Venue`, `Section`, `Row`, `Seat_Number`, `Seat_Status`,
      `Holder_Identifier`, `Hold_Expiration`, `Fan_Id`, `Seat_Ref`, `Payment_Status`,
      `Txn_State`, `Confirmation_Timestamp`, `Created_At`, `Version`)
    - Register `Hold_Expiration` as the documented TTL attribute (auxiliary cleanup only, not
      seat release)
    - _Requirements: 1.1, 1.3, 1.7, 1.8, 2.1, 2.2, 10.4_

  - [x] 1.2 Add GSI1 and GSI2 definitions with intentionally scoped projections
    - GSI1 (`GSI1PK = SECTION#<venue>#<section>`, `GSI1SK = STATUS#available#ROW#..#SEAT#..`):
      sparse seat-map index, projection `INCLUDE {Row, Seat_Number, Seat_Status}`
    - GSI2 (`GSI2PK = HOLDS#<shard>`, `GSI2SK = Hold_Expiration`): sparse sharded expired-hold
      index, projection `KEYS_ONLY`
    - _Requirements: 3.2, 3.5, 9.2, 10.8, 11.3, 11.5_

  - [x] 1.3 Add representative sample items across all states
    - Minimum 5 seat items covering `available`, `held` (with `Holder_Identifier` +
      `Hold_Expiration` + GSI2 keys), and `sold`
    - Transaction items in `pending`, `paid`/`confirmed`, and `failed` states
    - Ensure `available` seats carry GSI1 keys and `held` seats carry GSI2 keys (sparse-index
      correctness) so items appear/disappear from indexes as designed
    - _Requirements: 1.4, 2.2, 2.3, 2.6, 3.5, 9.2_

  - [x] 1.4 Validate the model imports cleanly into NoSQL Workbench
    - Confirm the JSON structure matches NoSQL Workbench's data-model schema (table, GSIs,
      key schema, attribute definitions, sample data) and that every sample item satisfies the
      key schema and sparse-index rules
    - _Requirements: 1.9, 3.2, 10.5, 11.1, 11.3_

- [x] 2. Finalize the submission design document and derived artifacts
  - [x] 2.1 Polish `design.md` into the submission design document
    - Verify every modeling decision states WHY (single-table choice, conditional-write
      correctness, hybrid hold-expiration with condition-at-read-time as source of truth,
      TTL explicitly NOT used to release seats, sharded availability counters as optional,
      on-demand vs provisioned capacity)
    - Confirm the requirements coverage map and the exact condition expressions for
      `available→held`, `held→sold` (TransactWriteItems), and `held→available` are present
    - _Requirements: 8.1, 8.2, 9.5, 9.6, 10.2, 10.3, 10.7_

  - [x] 2.2 Extract and finalize the Access Pattern Matrix as a CSV artifact
    - Produce `access-patterns.csv` mapping every access pattern AP1–AP10 to table/index,
      operation, key condition, filter/projection, and consistency, matching the matrix in
      `design.md`
    - _Requirements: 11.10, 1.9, 2.5, 3.2, 9.2, 10.5_

  - [x] 2.3 Verify and export the architecture diagram
    - Validate the mermaid purchasing-flow and component diagrams render, and export a static
      image (`architecture.svg` or `.png`) for the submission
    - _Requirements: 4.1, 6.3, 8.2, 9.1_

- [x] 3. Assemble the public repository README and submission checklist
  - [x] 3.1 Write `README.md` tying the deliverables together
    - Summarize the problem, link the NoSQL Workbench JSON, design document, access pattern
      matrix, and architecture diagram; explain how to import/import-verify the model
    - _Requirements: 9.5, 10.3, 11.10_

  - [x] 3.2 Add the Builder Center submission checklist
    - Create `SUBMISSION_CHECKLIST.md` listing the manual steps the user performs: complete the
      required Builder Center survey and post the "something I learned" comment; include a
      checkbox list of all graded deliverables
    - _Requirements: 9.5_

- [x] 4. Checkpoint — review submission-critical deliverables
  - Ensure the NoSQL Workbench JSON imports, the design document, access pattern matrix,
    architecture diagram, README, and checklist are complete and consistent. Ask the user if
    questions arise.

- [x] 5. Set up the TypeScript reference implementation project
  - [x] 5.1 Initialize the TypeScript project and test tooling
    - Create `package.json`, `tsconfig.json`, a test runner (vitest or jest), and add
      `fast-check` as the property-based testing library
    - Establish `src/` and `test/` structure for the reference model
    - _Requirements: 7.1, 8.1_

- [x] 6. Implement the core seat state model and guarded transitions
  - [x] 6.1 Implement the seat item model, status type, and identity→key mapping
    - Define the `Seat_Status` union (`available` | `held` | `sold`), seat entity, and the
      injective (venue, section, row, seat) → (`PK`, `SK`) mapping; reject duplicate creation
    - Set newly created seats to `available`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7_

  - [x] 6.2 Implement the guarded transition engine with condition evaluation
    - Implement `available→held` and `held→available` as conditional updates that assert the
      required source status; reject illegal transitions leaving state unchanged; enforce the
      three permitted transitions only
    - _Requirements: 4.1, 4.6, 6.4, 6.7, 6.8, 8.1, 8.3, 8.4, 8.5, 11.9_

  - [x] 6.3 Implement hold-window and expiration semantics (expired-as-available)
    - Set `Hold_Expiration = now + window` (default 480s, configurable [60,1800]); treat an
      expired hold as available at write time; clear holder + expiration on release
    - _Requirements: 1.5, 1.6, 4.2, 4.3, 6.5, 6.6, 9.6, 9.7_

  - [x] 6.4 Implement the expired-hold shard key function
    - Compute `hash(seatId) mod N` in `[0, N)` for the GSI2 `HOLDS#<shard>` key
    - _Requirements: 10.2, 10.3_

  - [x]* 6.5 Write property test for guarded transition legality
    - **Property 3: Guarded transition legality**
    - **Validates: Requirements 4.1, 4.6, 6.1, 6.2, 6.4, 6.7, 6.8, 8.1, 8.3, 8.4, 8.5, 11.9**
    - Tag: `Feature: fair-seat-purchase, Property 3`; minimum 100 iterations

  - [x]* 6.6 Write property test for status value validity
    - **Property 16: Status value validity**
    - **Validates: Requirements 1.3, 1.4**
    - Tag: `Feature: fair-seat-purchase, Property 16`; minimum 100 iterations

  - [x]* 6.7 Write property test for seat identity uniqueness
    - **Property 14: Seat identity uniqueness**
    - **Validates: Requirements 1.1, 1.2**
    - Tag: `Feature: fair-seat-purchase, Property 14`; minimum 100 iterations

  - [x]* 6.8 Write property test for hold expiration bounds
    - **Property 9: Hold expiration is set within bounds**
    - **Validates: Requirements 1.5, 4.2, 4.3, 9.7**
    - Tag: `Feature: fair-seat-purchase, Property 9`; minimum 100 iterations

  - [x]* 6.9 Write property test for expired-holds-treated-as-available
    - **Property 10: Expired holds are treated as available at read and write time**
    - **Validates: Requirements 1.6, 6.5, 6.6, 9.6**
    - Tag: `Feature: fair-seat-purchase, Property 10`; minimum 100 iterations

  - [x]* 6.10 Write property test for holder presence invariant
    - **Property 11: Holder presence invariant**
    - **Validates: Requirements 1.7, 6.6**
    - Tag: `Feature: fair-seat-purchase, Property 11`; minimum 100 iterations

  - [x]* 6.11 Write property test for shard key distribution
    - **Property 17: Shard key distribution**
    - **Validates: Requirements 10.2, 10.3**
    - Tag: `Feature: fair-seat-purchase, Property 17`; minimum 100 iterations

- [x] 7. Implement purchase transactions and confirmation
  - [x] 7.1 Implement the purchase-transaction lifecycle model
    - Create transactions with `Payment_Status = pending`; permit only `pending→paid`,
      `pending→failed`, `paid→confirmed`; retain `failed` with no confirmation timestamp
    - _Requirements: 2.1, 2.2, 2.4, 2.6_

  - [x] 7.2 Implement confirmation as an atomic seat+transaction transaction
    - Model `TransactWriteItems`: seat `held→sold` (guard `held` AND holder match AND not
      expired) coupled with txn `paid→confirmed` + UTC timestamp; all-or-nothing; `sold` has
      no outbound transition
    - _Requirements: 2.3, 6.1, 6.3, 8.2_

  - [x] 7.3 Implement the payment orchestration model
    - Accept payment only while `held`, before `Hold_Expiration`, and holder matches; set
      `paid` on success, `failed` on failure/timeout leaving the seat `held` until expiry;
      reject expired/mismatched-holder payments with no charge
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.6, 5.7, 9.4_

  - [x]* 7.4 Write property test for transaction lifecycle legality and outcome
    - **Property 13: Transaction lifecycle legality and outcome**
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.6**
    - Tag: `Feature: fair-seat-purchase, Property 13`; minimum 100 iterations

  - [x]* 7.5 Write property test for payment precondition and outcome
    - **Property 12: Payment precondition and outcome**
    - **Validates: Requirements 5.1, 5.2, 5.4, 5.5, 5.6, 5.7, 9.4**
    - Tag: `Feature: fair-seat-purchase, Property 12`; minimum 100 iterations

  - [x]* 7.6 Write property test for confirmation atomicity
    - **Property 8: Confirmation atomicity (seat + transaction all-or-nothing)**
    - **Validates: Requirements 6.3, 8.2**
    - Tag: `Feature: fair-seat-purchase, Property 8`; minimum 100 iterations

  - [x]* 7.7 Write property test for confirmation holder/expiry preconditions
    - **Property 7: Confirmation requires matching holder and an unexpired hold**
    - **Validates: Requirements 6.1, 6.2, 9.3**
    - Tag: `Feature: fair-seat-purchase, Property 7`; minimum 100 iterations

- [x] 8. Implement the concurrency model and concurrency properties
  - [x] 8.1 Implement the serialized conditional-write concurrency model
    - Model N≥2 concurrent attempts against one seat serialized by per-item conditional
      evaluation so exactly one attempt commits and the rest fail with condition/conflict
      failures
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.6, 11.8_

  - [x]* 8.2 Write property test for sold-exactly-once
    - **Property 1: Sold-exactly-once**
    - **Validates: Requirements 7.1, 7.4, 7.5**
    - Tag: `Feature: fair-seat-purchase, Property 1`; minimum 100 iterations

  - [x]* 8.3 Write property test for sold permanence (monotonicity)
    - **Property 2: Sold is permanent (monotonicity)**
    - **Validates: Requirements 7.6**
    - Tag: `Feature: fair-seat-purchase, Property 2`; minimum 100 iterations

  - [x]* 8.4 Write property test for at-most-one concurrent transition commits
    - **Property 4: At most one concurrent transition commits**
    - **Validates: Requirements 8.6, 11.8**
    - Tag: `Feature: fair-seat-purchase, Property 4`; minimum 100 iterations

  - [x]* 8.5 Write property test for concurrent holds resolving to one winner
    - **Property 5: Concurrent holds resolve to exactly one winner**
    - **Validates: Requirements 4.7, 7.2, 7.3**
    - Generate N contenders from 2 up to at least 10,000; Tag:
      `Feature: fair-seat-purchase, Property 5`; minimum 100 iterations

  - [x]* 8.6 Write property test for concurrent confirmations resolving to one winner
    - **Property 6: Concurrent confirmations resolve to exactly one winner**
    - **Validates: Requirements 7.4, 7.5**
    - Generate N contenders from 2 up to at least 10,000; Tag:
      `Feature: fair-seat-purchase, Property 6`; minimum 100 iterations

- [x] 9. Implement the availability view and remaining tests
  - [x] 9.1 Implement the seat-map / availability-count query model
    - Model the GSI1 query returning effective-available seats (physical `available` plus
      expired holds) and a section availability count bounded within [0, capacity]
    - _Requirements: 3.1, 3.4, 11.3, 11.4_

  - [x]* 9.2 Write property test for availability view correctness
    - **Property 15: Availability view correctness**
    - **Validates: Requirements 3.1, 3.4, 11.3, 11.4**
    - Tag: `Feature: fair-seat-purchase, Property 15`; minimum 100 iterations

  - [x]* 9.3 Write example-based unit tests for error and edge cases
    - Invalid-section error, timeout-availability error, not-found seat/transaction lookups,
      and throttling retry-then-error behavior
    - _Requirements: 3.6, 3.7, 10.9, 11.2, 11.7_

  - [x]* 9.4 Write integration/smoke tests for structural guarantees
    - Item-size-under-400KB, GSI projection scoping, and Query/GetItem-not-Scan access-layer
      audits across the model
    - _Requirements: 1.8, 1.9, 2.5, 3.2, 3.5, 9.2, 10.4, 10.5, 10.8_

- [x] 10. Final checkpoint — ensure all tests pass
  - Run the full test suite and confirm all 17 property tests, unit tests, and integration
    tests pass. Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster submission of the core
  graded deliverables (Tasks 1–4).
- Tasks 1–4 are the submission-critical path (NoSQL Workbench JSON, design document, access
  pattern matrix, architecture diagram, README, submission checklist).
- Tasks 5–10 are the reference implementation and validation work; every one of the 17
  correctness properties from the design is covered by exactly one property-based test task.
- Each property test must be tagged `Feature: fair-seat-purchase, Property {number}: {text}`
  and run a minimum of 100 iterations, using fast-check (per the design Testing Strategy).
- Concurrency properties (5, 6) generate N contenders from 2 up to at least 10,000 against the
  serialized conditional-write model.
- Each task references the specific requirements and/or design property it implements.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "2.3", "6.1"] },
    { "id": 2, "tasks": ["1.3", "3.1", "6.2", "6.3", "6.4", "7.1", "9.1"] },
    { "id": 3, "tasks": ["1.4", "3.2", "7.2", "7.3", "8.1"] },
    { "id": 4, "tasks": ["6.5", "6.6", "6.7", "6.8", "6.9", "6.10", "6.11", "7.4", "7.5", "7.6", "7.7", "8.2", "8.3", "8.4", "8.5", "8.6", "9.2", "9.3", "9.4"] }
  ]
}
```
