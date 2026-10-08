/**
 * listener.ts
 *
 * Polls the Soroban RPC for new contract events and feeds them into the
 * processor pipeline.
 *
 * Design:
 *   - Uses long-poll / periodic pull against the Soroban getEvents RPC.
 *   - Persists the last processed ledger in the indexer_state table so the
 *     indexer resumes from the correct position after a restart.
 *   - Exponential backoff on RPC errors to avoid hammering the endpoint.
 *
 * Environment variables:
 *   CONTRACT_ID      — Stellar contract address to filter events for
 *   SOROBAN_RPC_URL  — Soroban RPC endpoint (e.g. https://soroban-testnet.stellar.org)
 *   POLL_INTERVAL_MS — How often to poll (default: 5000 ms)
 */

import { SorobanRpc } from '@stellar/stellar-sdk';
import { Pool } from 'pg';
import { parseEvent, RawSorobanEvent } from './parser';
import { processEvent } from './processor';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEXER_STATE_KEY = 'last_processed_ledger';

/** Minimum backoff delay on errors (ms). */
const BACKOFF_MIN_MS = 1_000;
/** Maximum backoff delay on errors (ms). */
const BACKOFF_MAX_MS = 60_000;
/** Multiplier applied to backoff on each successive error. */
const BACKOFF_FACTOR = 2;

// ---------------------------------------------------------------------------
// Ledger state helpers
// ---------------------------------------------------------------------------

async function getLastProcessedLedger(pool: Pool): Promise<number> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM indexer_state WHERE key = $1`,
    [INDEXER_STATE_KEY]
  );
  if (result.rows.length === 0) return 0;
  return parseInt(result.rows[0].value, 10);
}

async function setLastProcessedLedger(
  pool: Pool,
  ledger: number
): Promise<void> {
  await pool.query(
    `
    INSERT INTO indexer_state (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `,
    [INDEXER_STATE_KEY, ledger.toString()]
  );
}

// ---------------------------------------------------------------------------
// Core polling loop
// ---------------------------------------------------------------------------

/**
 * Fetches events from the Soroban RPC starting after `fromLedger` and
 * processes each one. Returns the highest ledger sequence seen, or
 * `fromLedger` if no new events were found.
 */
async function pollOnce(
  server: SorobanRpc.Server,
  pool: Pool,
  contractId: string,
  fromLedger: number
): Promise<number> {
  // getEvents accepts a startLedger; use fromLedger + 1 to avoid reprocessing
  // the last ledger we already handled.
  const startLedger = fromLedger > 0 ? fromLedger + 1 : undefined;

  // TODO(prod): The Soroban RPC getEvents API has pagination; in production
  //   you must loop through pages using the paging_token until you've consumed
  //   all events up to the current ledger.
  const response = await server.getEvents({
    startLedger: startLedger,
    filters: [
      {
        type: 'contract',
        contractIds: [contractId],
      },
    ],
  });

  let highestLedger = fromLedger;

  for (const rawEvent of response.events) {
    // The SDK returns fully decoded events; adapt to our RawSorobanEvent shape.
    // TODO(prod): The exact field names depend on the SDK version. Audit
    //   against SorobanRpc.Api.EventResponse when upgrading the SDK.
    const raw: RawSorobanEvent = {
      contractId: rawEvent.contractId,
      ledger: rawEvent.ledger,
      txHash: rawEvent.txHash,
      // topic and value are xdr.ScVal arrays/value from the SDK
      topic: rawEvent.topic,
      value: rawEvent.value,
    };

    const parsed = parseEvent(raw);
    if (parsed !== null) {
      await processEvent(pool, parsed);
    }

    if (rawEvent.ledger > highestLedger) {
      highestLedger = rawEvent.ledger;
    }
  }

  return highestLedger;
}

// ---------------------------------------------------------------------------
// startListener
// ---------------------------------------------------------------------------

/**
 * Starts the event listener loop.
 *
 * Reads CONTRACT_ID and SOROBAN_RPC_URL from environment variables, resumes
 * from the last processed ledger stored in the DB, and polls for new events
 * every POLL_INTERVAL_MS milliseconds.
 *
 * Errors are caught and logged; the loop uses exponential backoff before
 * retrying so transient RPC issues don't crash the process.
 *
 * @param pool — pg connection pool (already connected)
 */
export async function startListener(pool: Pool): Promise<never> {
  const contractId = process.env.CONTRACT_ID;
  const rpcUrl = process.env.SOROBAN_RPC_URL;
  const pollIntervalMs = parseInt(
    process.env.POLL_INTERVAL_MS ?? '5000',
    10
  );

  if (!contractId) {
    throw new Error('CONTRACT_ID environment variable is not set.');
  }
  if (!rpcUrl) {
    throw new Error('SOROBAN_RPC_URL environment variable is not set.');
  }

  // TODO(prod): Pass allowHttp: true only in development; require HTTPS in
  //   production by removing this option.
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: true });

  let lastLedger = await getLastProcessedLedger(pool);
  console.log(
    `[listener] Starting from ledger ${lastLedger} (contract: ${contractId})`
  );

  let consecutiveErrors = 0;
  let backoffMs = BACKOFF_MIN_MS;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const newHighest = await pollOnce(server, pool, contractId, lastLedger);

      if (newHighest > lastLedger) {
        lastLedger = newHighest;
        await setLastProcessedLedger(pool, lastLedger);
        console.log(`[listener] Processed up to ledger ${lastLedger}`);
      }

      // Reset backoff on success.
      consecutiveErrors = 0;
      backoffMs = BACKOFF_MIN_MS;

      await sleep(pollIntervalMs);
    } catch (err) {
      consecutiveErrors++;
      console.error(
        `[listener] Poll error (attempt ${consecutiveErrors}), backing off ${backoffMs}ms:`,
        err
      );

      await sleep(backoffMs);

      // Exponential backoff, capped at BACKOFF_MAX_MS.
      backoffMs = Math.min(backoffMs * BACKOFF_FACTOR, BACKOFF_MAX_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
