# The Fair Seat Purchase — DynamoDB Ticket Purchasing System

A DynamoDB-powered ticket-purchasing system for a 100,000-seat venue that stays **correct under
extreme concurrency**: every seat is **sold exactly once** — never oversold, never lost — while
the experience stays fast for every fan. Built for the AWS Builder Center **"Fair Seat Purchase"**
challenge, this repo contains the data model, design, and a **fully deployed, live** reference
application on AWS.

## 🌐 Live demo

**https://d1ph0ldhhnu3jn.cloudfront.net**

Open the link, browse the tiered sections, pick a seat, hold it, and check out. Seats update
live: 🟩 available · 🟪 booking in progress (held) · 🟥 booked (sold).


---

## The problem

When a popular event goes on sale, thousands of fans contend for the same seats in the same
instant. The system must guarantee **sold-exactly-once** under that contention, expire abandoned
holds, and instantly return released seats to inventory — all while feeling fast. This is a
distributed inventory-control / locking problem, solved here with DynamoDB **conditional writes**
and **transactions** (no external lock service).

Lifecycle: **browse → select → hold (atomic) → pay → confirm _or_ release on timeout**.

---

## Submission deliverables

| # | Deliverable | File |
|---|---|---|
| 1 | **NoSQL Workbench data model** (valid, importable) | [`fair-seat-purchase.json`](./fair-seat-purchase.json) |
| 2 | **Design document** (explains *why*, not just *what*) | [`DESIGN.md`](./DESIGN.md) |
| 3 | **Access pattern matrix** (every pattern → table/index + key condition + filter) | [`access-patterns.csv`](./access-patterns.csv) (also embedded in `DESIGN.md` §2) |

### Import the NoSQL Workbench model
1. Open **NoSQL Workbench for Amazon DynamoDB** → **Import data model**.
2. Choose [`fair-seat-purchase.json`](./fair-seat-purchase.json).

It imports one table (`FairSeatPurchase`) with **GSI1** (seat map) and **GSI2** (expired-hold
sweep), and ≥5 representative sample items per table/index — seats in **available / held / sold**
states and transactions in **pending / paid+confirmed / failed** states.

---

## Design at a glance

- **Single-table design.** One table holds `SEAT` and `TXN` items (distinguished by key prefixes +
  `Entity_Type`). Keeps confirmation atomic across the seat and its transaction, and keeps every
  access pattern a `GetItem`/`Query`/`UpdateItem`/`TransactWriteItems` — **never a `Scan`**.
- **Sold-exactly-once via conditional writes.** `available → held` is a single conditional
  `UpdateItem` (`Seat_Status = available OR hold expired`). Concurrent contenders serialize on the
  item; exactly one wins, the rest get `ConditionalCheckFailedException`.
- **`held → sold` via `TransactWriteItems`.** The seat flip and the transaction confirmation commit
  all-or-nothing. `sold` is permanent (no outbound transition).
- **Temporary holds (8 min) with hybrid expiration.** Correctness rests on **condition-at-read-time**
  (an expired hold is treated as available in every guard), with an **optional active sweeper** for
  freshness. DynamoDB **TTL is deliberately *not*** the release mechanism (it deletes items; a seat
  must survive and return to `available`).
- **Scale & cost.** Seats spread across many partitions; GSI2 is **write-sharded** (scatter-gather
  on read); GSI projections are scoped (`INCLUDE` / `KEYS_ONLY`); eventually-consistent reads for
  browsing; on-demand billing for the bursty on-sale.

Full rationale and trade-offs are in [`DESIGN.md`](./DESIGN.md).

### Key schema

| Entity | PK | SK |
|---|---|---|
| Seat | `SEAT#<venue>#<section>` | `ROW#<row>#SEAT#<seat>` |
| Transaction | `TXN#<fanId>` | `TXN#<txnId>` |
| Section catalog | `VENUE#<venue>` | `SECTION#<section>` |
| GSI1 (available-seat map) | `SECTION#<venue>#<section>` | `STATUS#available#ROW#..#SEAT#..` |
| GSI2 (expired-hold sweep, sharded) | `HOLDS#<shard>` | `Hold_Expiration` (epoch) |

---

## Architecture

```
Browser ── HTTPS ──> CloudFront ──(OAC)──> S3 (private)         [ static UI ]
   │
   └──── HTTPS/fetch ──> API Gateway (HTTP API) ──> Lambda ──> DynamoDB   [ API + data ]
                                                     (Express app)   (single table + GSI1/GSI2, TTL)
```

- **UI:** private **S3** bucket served via **CloudFront** with **Origin Access Control** (bucket
  never public).
- **API:** the Express app on **Lambda** behind an **API Gateway HTTP API**, CORS-enabled.
- **Data:** a single **DynamoDB** table with GSI1/GSI2 and TTL.

See [`architecture.md`](./architecture.md) for the full purchasing-flow and component diagrams
(with the DynamoDB operation labelled at each step).

---

## Repository layout

```
.
├── README.md                         # this file
├── DESIGN.md                         # design document (deliverable 2)
├── fair-seat-purchase.json           # NoSQL Workbench model (deliverable 1)
├── access-patterns.csv               # access-pattern matrix (deliverable 3)
├── architecture.md / *.svg           # architecture diagrams
├── public/                           # static UI (HTML/CSS/JS) — hosted on S3+CloudFront
├── src/
│   ├── seat.ts, store.ts, transitions.ts, confirm.ts, payment.ts,
│   │   transaction.ts, availability.ts, shard.ts, access.ts, concurrency.ts   # reference model
│   ├── aws/          # real DynamoDB repositories (AWS SDK v3)
│   ├── service/      # TicketingService use cases + active sweeper
│   └── api/          # Express app, server, Lambda handler, placeholder auth
├── scripts/          # create-table + seed scripts
├── infra/            # AWS CDK stack (S3 + CloudFront + Lambda + API Gateway; imports the table)
└── test/             # fast-check property tests + API contract + integration
```

---

## Correctness evidence

The seat/transaction state machine and its conditional-write semantics are proven by
**property-based tests** (fast-check) covering 17 correctness properties — sold-exactly-once,
sold-is-permanent, one-winner concurrency (up to 10,000 contenders), confirmation atomicity, hold
expiration, and more — plus API-contract and live-DynamoDB integration tests.

```bash
npm install
npm run build      # type-check
npm test           # property + unit + contract tests (integration tests skip without a DB)
```

---

## Run it yourself

### Locally (Node + DynamoDB Local)
See [`docs/RUN_LOCAL.md`](./docs/RUN_LOCAL.md).

```bash
docker run --rm -p 8000:8000 amazon/dynamodb-local     # start DynamoDB Local
export FSP_DDB_ENDPOINT=http://localhost:8000           # PowerShell: $env:FSP_DDB_ENDPOINT="http://localhost:8000"
npm run db:create      # create table + GSI1/GSI2 + TTL
npm run db:seed        # seed the tiered ARENA1 venue (~4,568 seats)
npm start              # UI + API at http://localhost:3000
```

### Deploy to AWS (what powers the live demo)
```bash
cd infra
npx cdk bootstrap                          # one-time per account/region
npx cdk deploy --require-approval never     # outputs SiteUrl + ApiUrl
```
The stack **imports** the existing `FairSeatPurchase` table (created by `npm run db:create`), so
run `db:create` + `db:seed` first. Tear down with `npx cdk destroy` (the imported table is left
intact).

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `FSP_TABLE_NAME` | `FairSeatPurchase` | DynamoDB table name |
| `AWS_REGION` | `us-east-1` | AWS region |
| `FSP_DDB_ENDPOINT` | *(unset)* | Point at DynamoDB Local (e.g. `http://localhost:8000`) |
| `PORT` | `3000` | Local API/UI port |
| `FSP_SWEEP_INTERVAL_MS` | `30000` | Active expired-hold sweeper interval (`0` disables) |
| `FSP_CORS_ORIGIN` | `*` | Allowed CORS origin for the API |

---

## Tech stack

TypeScript · AWS SDK v3 · Express · DynamoDB (single-table, GSIs, TTL, conditional writes &
`TransactWriteItems`) · AWS CDK (S3 + CloudFront + Lambda + API Gateway) · vitest + fast-check.

## License

MIT.
