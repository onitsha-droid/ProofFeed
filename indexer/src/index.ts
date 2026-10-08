/**
 * index.ts
 *
 * ProofFeed Indexer — main entry point.
 *
 * Startup sequence:
 *   1. Load environment variables from .env (via dotenv).
 *   2. Create the pg connection pool.
 *   3. Run database migrations (idempotent — safe to run on every start).
 *   4. Start the Soroban event listener loop.
 *
 * The listener loop runs indefinitely. Send SIGINT (Ctrl-C) or SIGTERM to
 * shut down gracefully — the process will drain in-flight DB connections
 * before exiting.
 */

import * as dotenv from 'dotenv';

// Load .env before any other module reads process.env.
dotenv.config();

import { Pool } from 'pg';
import { migrate } from './db/migrate';
import { startListener } from './listener';
import { startApi } from './api';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      'Error: DATABASE_URL is not set. Copy .env.example to .env and fill in the values.'
    );
    process.exit(1);
  }

  console.log('[indexer] ProofFeed Indexer starting…');

  // ------------------------------------------------------------------
  // Database setup
  // ------------------------------------------------------------------
  const pool = new Pool({
    connectionString: databaseUrl,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    max: 10,
  });

  pool.on('error', (err) => {
    console.error('[indexer] Unexpected pool error:', err);
  });

  // Run migrations (idempotent — uses CREATE TABLE IF NOT EXISTS throughout).
  console.log('[indexer] Running migrations…');
  await migrate(databaseUrl);
  console.log('[indexer] Migrations complete.');

  // ------------------------------------------------------------------
  // Start REST API server
  // ------------------------------------------------------------------
  const apiPort = process.env.API_PORT ? Number(process.env.API_PORT) : 3001;
  const apiServer = startApi(pool, apiPort);

  // ------------------------------------------------------------------
  // Graceful shutdown
  // ------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    console.log(`\n[indexer] Received ${signal}, shutting down…`);
    apiServer.close();
    await pool.end();
    console.log('[indexer] DB pool closed. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ------------------------------------------------------------------
  // Start the listener (never returns unless an uncaught error occurs)
  // ------------------------------------------------------------------
  console.log('[indexer] Starting Soroban event listener…');
  await startListener(pool);
}

main().catch((err) => {
  console.error('[indexer] Fatal error:', err);
  process.exit(1);
});
