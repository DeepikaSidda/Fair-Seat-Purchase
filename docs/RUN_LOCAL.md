# Running Fair Seat Purchase locally against DynamoDB Local

The service and repositories talk to real DynamoDB. For local development and
the live integration tests you can point them at
[DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html)
instead of AWS. This is driven entirely by the `FSP_DDB_ENDPOINT` environment
variable (see `src/aws/ddb-client.ts`) — when it is set, the client targets that
endpoint with dummy credentials, so no real AWS account is needed.

## 1. Start DynamoDB Local (Docker)

```bash
docker run --rm -p 8000:8000 amazon/dynamodb-local
```

This exposes DynamoDB Local on `http://localhost:8000`. Leave it running in its
own terminal.

## 2. Point the app at it

Set the endpoint (and optionally table name / region). Defaults are
`FSP_TABLE_NAME=FairSeatPurchase` and `AWS_REGION=us-east-1`.

Windows (cmd):

```bat
set FSP_DDB_ENDPOINT=http://localhost:8000
```

Windows (PowerShell):

```powershell
$env:FSP_DDB_ENDPOINT = "http://localhost:8000"
```

macOS / Linux (bash):

```bash
export FSP_DDB_ENDPOINT=http://localhost:8000
```

## 3. Create the table and seed inventory

```bash
npm run db:create   # creates FairSeatPurchase + GSI1/GSI2, enables TTL
npm run db:seed     # seeds sample seats
```

Both are idempotent against an already-provisioned table.

## 4. Run the API and open the UI

```bash
npm start           # tsx src/api/server.ts
```

Then open the served UI in your browser (the console prints the listening URL).

## 5. Run the live integration tests

The live integration suite (`test/integration/ddb-live.integration.test.ts`)
**only runs when `FSP_DDB_ENDPOINT` is set**. With DynamoDB Local running and the
variable exported:

```bash
npm run test:integration
```

Each run provisions its own uniquely-named table
(`FairSeatPurchase-test-<random>`) and deletes it afterward, so it does not
touch your seeded `FairSeatPurchase` table.

> Note: the normal `npm test` run does **not** set `FSP_DDB_ENDPOINT`, so the
> live integration suite is skipped automatically and no database is required.
