# Requirements Document

## Introduction

The Fair Seat Purchase challenge defines a DynamoDB-powered ticket purchasing system for a single 100,000-seat venue serving hundreds to thousands of fans purchasing concurrently. The central promise is fairness and correctness: every seat is sold exactly once, no seat is ever oversold, and all seat state transitions are atomic and race-condition-free even under heavy concurrent contention on the same seat.

The system models the full purchase lifecycle — browsing a live seat map, selecting a seat, placing a temporary hold, processing payment while the hold is active, and either confirming the purchase (held → sold) or releasing the seat (held → available) on timeout or abandonment. Inventory drains within minutes, so the data model must respect DynamoDB service limits (400 KB item size, 1000 WCU / 3000 RCU per partition), prefer Query/GetItem over Scan, use eventually-consistent reads where strong consistency is not required, and scope index projections intentionally to minimize cost.

This document captures the functional and correctness requirements that drive the eventual deliverables: a NoSQL Workbench data model, a design document explaining the rationale for each modeling decision, an access pattern matrix, and an architecture diagram. Requirements emphasize the correctness and concurrency guarantees, the hold-expiration mechanism, and the scale constraints, since those are the primary judging criteria.

## Glossary

- **Ticketing_System**: The complete DynamoDB-backed system responsible for seat inventory, holds, purchases, and state transitions.
- **Seat**: A uniquely addressable unit of inventory identified by the combination of venue, section, row, and seat number.
- **Seat_Status**: The lifecycle state of a seat, one of `available`, `held`, or `sold`.
- **Hold**: A temporary, exclusive reservation of a seat by one fan for a fixed time window, after which the seat is eligible for release.
- **Hold_Window**: The fixed duration (default 8 minutes / 480 seconds) for which a hold remains valid before expiration.
- **Hold_Expiration**: The absolute timestamp at which a hold ceases to be valid.
- **Fan**: An end user attempting to browse, hold, pay for, and confirm a seat, identified by a unique fan identifier.
- **Holder_Identifier**: The unique identifier of the fan currently holding or owning a seat.
- **Purchase_Transaction**: A record capturing a fan's attempt to buy a specific seat, including payment status and confirmation timestamp.
- **Payment_Status**: The state of payment for a purchase transaction, one of `pending`, `paid`, or `failed`.
- **Seat_Map**: The live, per-section view of seat availability presented to browsing fans.
- **Section_Availability_Count**: The number of available seats within a given section.
- **Conditional_Write**: A DynamoDB write that succeeds only if a specified condition on the current item holds.
- **Transaction_Write**: A DynamoDB transactional write (TransactWriteItems) that applies multiple conditional writes atomically.
- **Active_Release**: Release of an expired hold performed by an explicit process that scans for and transitions expired holds.
- **Passive_Release**: Release of an expired hold performed implicitly, either via DynamoDB TTL deletion or via a condition check that treats an expired hold as available at read/write time.
- **Access_Pattern**: A defined data-access operation mapped to a specific table or index, key condition, and optional filter.
- **WCU**: DynamoDB Write Capacity Unit.
- **RCU**: DynamoDB Read Capacity Unit.
- **GSI**: DynamoDB Global Secondary Index.
- **TTL**: DynamoDB Time To Live, an attribute-based automatic item expiration mechanism.

## Requirements

### Requirement 1: Seat Inventory Modeling

**User Story:** As a venue operator, I want every seat modeled as a uniquely identifiable inventory item with a tracked status, so that the system can account for all 100,000 seats individually and never lose track of one.

#### Acceptance Criteria

1. THE Ticketing_System SHALL uniquely identify each Seat by the combination of venue, section, row, and seat number, such that no two Seats share the same combination of these four values.
2. IF a request attempts to create a Seat whose combination of venue, section, row, and seat number matches an existing Seat, THEN THE Ticketing_System SHALL reject the request, leave the existing Seat unchanged, and return an error indicating a duplicate Seat identifier.
3. THE Ticketing_System SHALL record a Seat_Status for each Seat whose value is exactly one of `available`, `held`, or `sold`, and SHALL reject any request to set a Seat_Status to a value outside this set with an error indicating an invalid status.
4. WHEN a Seat is first created, THE Ticketing_System SHALL set that Seat's Seat_Status to `available`.
5. WHERE a Seat is in the `held` state, THE Ticketing_System SHALL record a Hold_Expiration timestamp for that Seat that is greater than the hold creation time by no more than 600 seconds.
6. IF the current time reaches or exceeds the Hold_Expiration timestamp of a Seat in the `held` state, THEN THE Ticketing_System SHALL transition that Seat's Seat_Status to `available` and clear its Holder_Identifier.
7. WHERE a Seat is in the `held` or `sold` state, THE Ticketing_System SHALL record a non-empty Holder_Identifier for that Seat.
8. THE Ticketing_System SHALL store each Seat as an item that remains within the DynamoDB 400 KB maximum item size.
9. THE Ticketing_System SHALL model Seat inventory such that any individual Seat lookup is served by a DynamoDB GetItem or Query operation rather than a Scan operation.

### Requirement 2: Purchase Transaction Modeling

**User Story:** As a fan, I want my purchase attempt tracked as a transaction record with its payment and confirmation state, so that I can complete payment and receive proof my seat is confirmed.

#### Acceptance Criteria

1. WHEN a Fan initiates a purchase of a Seat, THE Ticketing_System SHALL create a Purchase_Transaction that references exactly one Fan and exactly one Seat.
2. THE Ticketing_System SHALL restrict each Purchase_Transaction's Payment_Status to exactly one of the values `pending`, `paid`, or `failed`, and SHALL set the Payment_Status to `pending` upon creation of the Purchase_Transaction.
3. WHEN a Purchase_Transaction's Payment_Status becomes `paid`, THE Ticketing_System SHALL set the Purchase_Transaction state to `confirmed` and record a confirmation timestamp expressed in UTC.
4. THE Ticketing_System SHALL restrict Purchase_Transaction lifecycle transitions to the following: `pending` to `paid`, `pending` to `failed`, and `paid` to `confirmed`, and SHALL reject any other transition while retaining the Purchase_Transaction's current state.
5. WHEN retrieving a Fan's Purchase_Transaction and its Payment_Status, THE Ticketing_System SHALL use a GetItem or Query operation and SHALL NOT use a Scan operation.
6. IF a Purchase_Transaction's Payment_Status becomes `failed`, THEN THE Ticketing_System SHALL retain the Purchase_Transaction record with its Payment_Status set to `failed` and SHALL NOT record a confirmation timestamp.

### Requirement 3: Real-Time Seat Availability Display

**User Story:** As a browsing fan, I want to see a live seat map with available seats and per-section availability counts, so that I can decide where to sit before inventory runs out.

#### Acceptance Criteria

1. WHEN a Fan requests the Seat_Map for a section, THE Ticketing_System SHALL return, within 2 seconds for sections containing up to 5,000 seats, all seats in that section that are in the `available` state.
2. THE Ticketing_System SHALL serve section availability queries using a Query on a table or GSI rather than a Scan.
3. WHERE strong consistency is not required for availability display, THE Ticketing_System SHALL use eventually-consistent reads for Seat_Map queries that reflect committed seat state changes within 10 seconds of the change being committed.
4. WHEN a Fan requests the browsing overview, THE Ticketing_System SHALL provide a Section_Availability_Count for each section equal to the number of seats in the `available` state, ranging from 0 to the section's total seat capacity.
5. WHERE a GSI supports the Seat_Map, THE Ticketing_System SHALL scope the GSI projection to the attributes required by the Seat_Map to minimize storage and read cost.
6. IF a Fan requests the Seat_Map or Section_Availability_Count for a section identifier that does not exist, THEN THE Ticketing_System SHALL return an error indicating the section is invalid and SHALL NOT return seat data.
7. IF a Seat_Map or Section_Availability_Count query does not complete within 2 seconds, THEN THE Ticketing_System SHALL return an error indicating that availability data is temporarily unavailable while preserving the underlying seat state data.

### Requirement 4: Seat Selection and Temporary Hold

**User Story:** As an eligible fan, I want to select an available seat and place a temporary hold on it, so that I have exclusive time to complete payment without another fan taking it.

#### Acceptance Criteria

1. WHEN a Fan selects an `available` Seat, THE Ticketing_System SHALL transition that Seat from `available` to `held` using a Conditional_Write that requires the current Seat_Status to equal `available` at write time.
2. WHEN a Seat transitions to `held`, THE Ticketing_System SHALL set the Hold_Expiration to the transition timestamp plus the Hold_Window.
3. THE Ticketing_System SHALL use a default Hold_Window of 8 minutes (480 seconds), configurable within the range 60 to 1800 seconds.
4. WHEN a Seat transitions to `held`, THE Ticketing_System SHALL record the selecting Fan as the Holder_Identifier for that Seat.
5. WHEN a Seat is successfully transitioned to `held`, THE Ticketing_System SHALL return a success response that includes the Holder_Identifier and the Hold_Expiration.
6. IF a Fan attempts to hold a Seat that is not in the `available` state, THEN THE Ticketing_System SHALL reject the hold, leave the Seat_Status, Holder_Identifier, and Hold_Expiration unchanged, and return a failure response indicating the Seat is not available.
7. IF two or more Fans concurrently attempt to hold the same `available` Seat, THEN THE Ticketing_System SHALL grant the hold to exactly one Fan via the Conditional_Write and reject every other attempt.

### Requirement 5: Payment Processing During Active Hold

**User Story:** As a fan holding a seat, I want to pay for it while my hold is active, so that my seat is secured before the hold expires.

#### Acceptance Criteria

1. WHILE a Seat is in the `held` state and the current time is before the Hold_Expiration, THE Ticketing_System SHALL accept and process payment for the Purchase_Transaction associated with that Seat, completing processing within 30 seconds of initiation.
2. WHEN payment succeeds within the 30-second processing window, THE Ticketing_System SHALL set the Payment_Status of the Purchase_Transaction to `paid`.
3. WHEN the Payment_Status of the Purchase_Transaction is set to `paid`, THE Ticketing_System SHALL transition the associated Seat from the `held` state to the `sold` state.
4. IF payment fails, THEN THE Ticketing_System SHALL set the Payment_Status of the Purchase_Transaction to `failed`, retain the Seat in the `held` state until Hold_Expiration, and return a failure response indicating the payment was not captured.
5. IF payment processing does not complete within 30 seconds of initiation, THEN THE Ticketing_System SHALL set the Payment_Status of the Purchase_Transaction to `failed`, retain the Seat in the `held` state until Hold_Expiration, and return a failure response indicating a payment timeout.
6. IF a Fan attempts payment on a Seat whose Hold_Expiration has passed, THEN THE Ticketing_System SHALL reject the payment without capturing funds, leave the Payment_Status unchanged, and return a failure response indicating the hold has expired.
7. IF a Fan attempts payment on a Seat whose Holder_Identifier does not match the paying Fan's identifier, THEN THE Ticketing_System SHALL reject the payment without capturing funds, leave the Payment_Status unchanged, and return a failure response indicating a holder mismatch.

### Requirement 6: Confirmation and Release

**User Story:** As a fan, I want my paid hold confirmed as sold, and as an operator I want abandoned or expired holds released back to inventory, so that seats are neither lost nor double-booked.

#### Acceptance Criteria

1. WHEN payment for a held Seat is confirmed, THE Ticketing_System SHALL transition the Seat from `held` to `sold` using a Conditional_Write that requires the current Seat_Status to be `held` and the Holder_Identifier to match the confirming Fan.
2. IF the Conditional_Write guard for confirmation fails because the Seat_Status is not `held` or the Holder_Identifier does not match, THEN THE Ticketing_System SHALL reject the confirmation, leave the Seat and its Purchase_Transaction unchanged, and return a failure response indicating the Seat cannot be confirmed.
3. WHEN a Seat transitions to `sold`, THE Ticketing_System SHALL update the Seat_Status and record the confirmation timestamp on the associated Purchase_Transaction within a single Transaction_Write, such that either both changes are committed or neither change is committed.
4. WHEN a Fan abandons a hold before payment confirmation, THE Ticketing_System SHALL transition the Seat from `held` to `available` using a Conditional_Write that requires the current Seat_Status to be `held`.
5. WHEN the current time reaches or exceeds the Hold_Expiration of a `held` Seat that has not been confirmed as `sold`, THE Ticketing_System SHALL transition the Seat from `held` to `available`.
6. WHEN a Seat transitions from `held` to `available`, THE Ticketing_System SHALL clear the Holder_Identifier and Hold_Expiration for that Seat.
7. IF a release is attempted on a Seat that is already `sold`, THEN THE Ticketing_System SHALL reject the release, leave the Seat unchanged, and return a failure response indicating the Seat is already sold.
8. IF a release is attempted on a Seat that is already `available`, THEN THE Ticketing_System SHALL leave the Seat unchanged and return a response indicating no action was required.

### Requirement 7: Sold-Exactly-Once Correctness Guarantee

**User Story:** As a venue operator, I want every seat sold exactly once, so that no fan is ever double-booked and no seat is oversold.

#### Acceptance Criteria

1. THE Ticketing_System SHALL ensure that each Seat is transitioned to the `sold` state at most one time, such that the cumulative count of successful `sold` transitions for any single Seat never exceeds 1.
2. WHEN 2 or more Fans (tested at concurrency levels from 2 up to at least 10,000 simultaneous attempts within a 1-second window) concurrently attempt to hold the same `available` Seat, THE Ticketing_System SHALL transition the Seat to `held` for exactly one attempt and SHALL leave the Seat state unchanged for every other attempt.
3. IF a Fan's attempt to hold an `available` Seat is not the one that succeeds under concurrent contention, THEN THE Ticketing_System SHALL return a failure response indicating the Seat is no longer available and SHALL make no change to that Fan's session state or the Seat state.
4. WHEN 2 or more Fans (tested at concurrency levels from 2 up to at least 10,000 simultaneous attempts within a 1-second window) concurrently attempt to confirm the same `held` Seat as `sold`, THE Ticketing_System SHALL transition the Seat to `sold` for exactly one attempt and SHALL leave the Seat in the `held` state for every other attempt.
5. IF a Fan's attempt to confirm a `held` Seat as `sold` is not the one that succeeds under concurrent contention, THEN THE Ticketing_System SHALL return a failure response indicating the Seat cannot be confirmed by that Fan and SHALL preserve the Seat's existing state without rollback of the successful `sold` transition.
6. THE Ticketing_System SHALL guarantee that a Seat in the `sold` state is never transitioned back to the `available` or `held` state under any condition, including concurrent access, request retries, or system restart.

### Requirement 8: Atomic, Race-Condition-Free State Transitions

**User Story:** As a system designer, I want all seat state transitions to be atomic and guarded by DynamoDB primitives, so that concurrent contention cannot corrupt seat state.

#### Acceptance Criteria

1. THE Ticketing_System SHALL perform every Seat_Status transition using a Conditional_Write or Transaction_Write that asserts the expected current Seat_Status value as a precondition.
2. WHEN a Seat_Status transition depends on a related Purchase_Transaction change that must apply together, THE Ticketing_System SHALL apply both changes within a single Transaction_Write such that either both changes are committed or neither change is committed.
3. IF the condition guarding a Seat_Status transition is not satisfied at write time, THEN THE Ticketing_System SHALL reject the transition, leave the Seat_Status and any related Purchase_Transaction unchanged, and return a failure response indicating the expected current state did not match.
4. THE Ticketing_System SHALL define the permitted Seat_Status transitions as exactly the following three: `available → held`, `held → sold`, and `held → available`.
5. IF a Seat_Status transition that is not one of the three permitted transitions is attempted, THEN THE Ticketing_System SHALL reject the transition, leave the Seat_Status unchanged, and return a failure response indicating the requested transition is not permitted.
6. WHEN two or more transitions target the same Seat concurrently, THE Ticketing_System SHALL commit at most one transition and reject each remaining transition with a failure response indicating a conflicting concurrent modification.

### Requirement 9: Hold Expiration Mechanism

**User Story:** As a venue operator, I want expired holds to free their seats, so that abandoned selections return to inventory quickly and fairly.

#### Acceptance Criteria

1. WHEN the current time passes the Hold_Expiration of a `held` Seat that has not been confirmed as `sold`, THE Ticketing_System SHALL make that Seat eligible for return to the `available` state within 60 seconds of the Hold_Expiration timestamp.
2. THE Ticketing_System SHALL support locating holds whose Hold_Expiration has passed using a Query on a table or GSI rather than a Scan.
3. IF a Fan attempts to confirm a Seat whose Hold_Expiration has passed, THEN THE Ticketing_System SHALL reject the confirmation, leave the Seat eligible for return to `available`, make no `sold` state change, and return a failure response indicating the hold has expired.
4. IF a Fan attempts to pay for a Seat whose Hold_Expiration has passed, THEN THE Ticketing_System SHALL reject the payment, apply no charge, leave the Seat eligible for return to `available`, and return a failure response indicating the hold has expired.
5. THE Ticketing_System SHALL document the chosen release strategy as either Active_Release or Passive_Release, including the trade-offs of each.
6. WHERE Passive_Release via TTL is chosen, THE Ticketing_System SHALL evaluate release eligibility using the Hold_Expiration timestamp at read time so that an expired-but-not-yet-deleted Seat is treated as `available`.
7. WHEN a Seat transitions to `held`, THE Ticketing_System SHALL set the Hold_Expiration to 8 minutes (480 seconds) after the hold creation time.

### Requirement 10: Scale and DynamoDB Service Limit Compliance

**User Story:** As a system architect, I want the data model to respect DynamoDB service limits under thousands of concurrent purchases, so that hot partitions and throttling do not break fairness at peak load.

#### Acceptance Criteria

1. WHILE up to 10,000 concurrent purchase operations execute across up to 100,000 seats, THE Ticketing_System SHALL model data so that no single partition is required to exceed 1000 WCU or 3000 RCU.
2. WHERE an Access_Pattern would concentrate writes on a single partition beyond partition throughput limits, THE Ticketing_System SHALL apply write sharding.
3. THE Ticketing_System SHALL document the write sharding scheme.
4. THE Ticketing_System SHALL keep every item within the DynamoDB 400 KB maximum item size.
5. THE Ticketing_System SHALL prefer Query and GetItem over Scan for all defined Access_Patterns.
6. IF an Access_Pattern uses a Scan, THEN THE Ticketing_System SHALL document that the Scan retrieves a smaller or equal item count than an equivalent Query for that pattern.
7. WHERE strong consistency is not required for an Access_Pattern, THE Ticketing_System SHALL use eventually-consistent reads.
8. WHERE a GSI is defined, THE Ticketing_System SHALL scope the GSI projection to only the attributes read by its documented Access_Patterns.
9. IF a DynamoDB operation is throttled, THEN THE Ticketing_System SHALL retry with exponential backoff up to 5 attempts, and IF all retry attempts fail, THEN THE Ticketing_System SHALL return an error indication while preserving the current state.

### Requirement 11: Access Pattern Coverage

**User Story:** As a data modeler, I want every required access pattern mapped to a concrete table or index with key conditions, so that the model provably supports all system operations.

#### Acceptance Criteria

1. WHEN a request is made to look up a specific Seat's Seat_Status by venue, section, row, and seat number, THE Ticketing_System SHALL return the Seat_Status using a single GetItem or Query operation.
2. IF a Seat lookup references a Seat that does not exist, THEN THE Ticketing_System SHALL return an error indicating the Seat was not found without modifying any stored data.
3. WHEN a request is made to list `available` seats within a section for the Seat_Map, THE Ticketing_System SHALL return every seat in that section whose Seat_Status equals `available` using a single Query operation.
4. WHEN a request is made for a section's Section_Availability_Count, THE Ticketing_System SHALL return the current count of seats in that section whose Seat_Status equals `available`.
5. WHEN a request is made to find expired holds, THE Ticketing_System SHALL return all holds whose Hold_Expiration is earlier than the current system time using a single Query operation.
6. WHEN a request is made to retrieve a Fan's Purchase_Transaction, THE Ticketing_System SHALL return the Purchase_Transaction and its Payment_Status using a single GetItem or Query operation.
7. IF a Purchase_Transaction retrieval references a transaction that does not exist, THEN THE Ticketing_System SHALL return an error indicating the transaction was not found without modifying any stored data.
8. WHEN a valid Seat_Status transition (`available → held`, `held → sold`, or `held → available`) is requested, THE Ticketing_System SHALL apply the transition as a single atomic conditional operation such that at most one concurrent request can successfully transition the same Seat.
9. IF a Seat_Status transition is requested whose current stored Seat_Status does not match the transition's required source status, THEN THE Ticketing_System SHALL reject the transition, leave the Seat_Status unchanged, and return an error indicating the invalid transition.
10. THE Ticketing_System SHALL define, for each Access_Pattern, the target table or index, the key condition, and any filter expression used.
