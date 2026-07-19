/**
 * Fair Seat Purchase — HTTP server entrypoint.
 *
 * Wires the real DynamoDB-backed repositories (via `getDocumentClient`) into a
 * {@link TicketingService}, builds the Express app with {@link createApp}, and
 * listens on `PORT` (default 3000).
 *
 * ⚠️ This entrypoint intentionally uses the PLACEHOLDER auth middleware
 * (`requireEligibleFan`). See `src/api/auth.ts`: in production this service MUST
 * sit behind the upstream waiting-room / signed-token admission gate and MUST
 * NOT be exposed publicly without a real authorizer.
 *
 * Run with `npm start` (tsx) or `npm run dev` (tsx watch).
 */

import { getDocumentClient, TABLE_NAME } from "../aws/ddb-client.js";
import { SeatRepository } from "../aws/seat-repository.js";
import { TransactionRepository } from "../aws/transaction-repository.js";
import { TicketingService } from "../service/ticketing-service.js";
import { startSweeper } from "../service/sweeper.js";
import { createApp } from "./app.js";

/** The TCP port to listen on, from `PORT` (default 3000). */
const PORT: number = Number(process.env.PORT ?? 3000);

/**
 * How often the active hold sweeper runs, from `FSP_SWEEP_INTERVAL_MS`
 * (default 30000 ms). Set to `0` to disable the sweeper (correctness does not
 * depend on it — see `src/service/sweeper.ts`).
 */
const SWEEP_INTERVAL_MS: number = Number(process.env.FSP_SWEEP_INTERVAL_MS ?? 30_000);

function main(): void {
  const doc = getDocumentClient();
  const seatRepo = new SeatRepository(doc);
  const service = new TicketingService(seatRepo, new TransactionRepository(doc));
  const app = createApp(service);

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Fair Seat Purchase API listening on port ${PORT} (table: ${TABLE_NAME}).`,
    );
    // eslint-disable-next-line no-console
    console.warn(
      "SECURITY: auth is a PLACEHOLDER (x-fan-id header). Do not expose without a real admission gate.",
    );

    // Start the active hold sweeper (housekeeping only; correctness holds
    // without it via condition-at-read-time). Disable with FSP_SWEEP_INTERVAL_MS=0.
    if (SWEEP_INTERVAL_MS > 0) {
      startSweeper(seatRepo, { intervalMs: SWEEP_INTERVAL_MS });
      // eslint-disable-next-line no-console
      console.log(`Active hold sweeper enabled (every ${SWEEP_INTERVAL_MS} ms).`);
    }
  });
}

main();
