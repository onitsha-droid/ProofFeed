/**
 * client.ts
 *
 * Exports a singleton pg Pool configured from process.env.DATABASE_URL.
 *
 * Import this module wherever you need a database connection:
 *
 *   import { pool } from './db/client';
 *
 * The pool manages connection lifecycle automatically. Call pool.end() only
 * when the process is shutting down.
 */

import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is not set. ' +
      'Copy .env.example to .env and fill in the value.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep idle connections alive so the indexer polling loop doesn't pay
  // connection-setup latency on every poll tick.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  max: 10,
});

pool.on('error', (err) => {
  console.error('[db/client] Unexpected pool error:', err);
});

export { pool };
