/**
 * migrate.ts
 *
 * Reads src/db/schema.sql and executes it against the database configured by
 * the DATABASE_URL environment variable.
 *
 * Usage:
 *   npm run migrate
 *   # or directly:
 *   node -r ts-node/register src/db/migrate.ts
 *
 * The script is idempotent because every DDL statement uses IF NOT EXISTS.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

async function migrate(databaseUrl?: string): Promise<void> {
  const connectionString = databaseUrl ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL environment variable is not set. ' +
        'Copy .env.example to .env and fill in the value.'
    );
  }

  const pool = new Pool({ connectionString });

  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    console.log(`Running migrations against: ${connectionString.replace(/:[^:@]+@/, ':***@')}`);

    await pool.query(sql);

    console.log('Migrations completed successfully.');
  } finally {
    await pool.end();
  }
}

// Only run automatically when this file is the entry point.
if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

export { migrate };
