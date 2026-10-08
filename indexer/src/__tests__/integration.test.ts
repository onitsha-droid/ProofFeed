/**
 * integration.test.ts
 *
 * Integration tests for the ProofFeed indexer.
 *
 * These tests:
 *   - Connect to a real PostgreSQL test database (TEST_DATABASE_URL, or
 *     DATABASE_URL with the database name suffixed with "_test").
 *   - Run migrations to ensure the schema is fresh.
 *   - Seed synthetic events by calling processEvent() directly (no real
 *     Soroban RPC connection needed).
 *   - Assert on DB state after processing.
 *
 * Prerequisites:
 *   A running PostgreSQL instance with a database matching TEST_DATABASE_URL.
 *   The indexer test user must have CREATE TABLE permissions on that database.
 *
 * Run with:
 *   npm test
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { migrate } from '../db/migrate';
import { processEvent } from '../processor';
import { computeEntropyScore } from '../metrics';
import {
  CreatorRegisteredEvent,
  PaymentRecordedEvent,
  SubscriptionCancelledEvent,
} from '../types';
import type { PaymentRow } from '../types';

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

/**
 * Derives the test database URL from TEST_DATABASE_URL or DATABASE_URL.
 * If the base URL ends with a path segment (the db name), appends "_test";
 * otherwise uses TEST_DATABASE_URL directly.
 */
function getTestDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set. ' +
        'Set TEST_DATABASE_URL to run integration tests.'
    );
  }
  // Append _test to the database name (last path segment).
  return base.replace(/\/([^/]+)$/, '/$1_test');
}

const TEST_DB_URL = getTestDatabaseUrl();

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DB_URL });
  // Run migrations on test DB.
  await migrate(TEST_DB_URL);
});

afterAll(async () => {
  await pool.end();
});

/** Truncates all application tables between tests to ensure isolation. */
async function cleanDb(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      raw_events,
      creator_registrations,
      payment_events,
      subscription_cancellations,
      creator_metrics,
      cohort_retention,
      indexer_state
    RESTART IDENTITY CASCADE
  `);
}

beforeEach(async () => {
  await cleanDb();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const CREATOR_A   = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABTEST1';
const SUB_1       = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSUB1';
const SUB_2       = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSUB2';
const SUB_3       = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSUB3';

/** Unix timestamp helpers — use a fixed base so cohort months are predictable. */
// 2024-03-15 00:00:00 UTC → 1710460800
const MARCH_2024 = 1710460800n;
// 2024-04-15 00:00:00 UTC → 1713139200
const APRIL_2024 = 1713139200n;

function makeCreatorRegistered(
  creator: string = CREATOR_A,
  tierCount: number = 2,
  ledger: number = 100
): CreatorRegisteredEvent {
  return {
    contractId: CONTRACT_ID,
    ledgerSequence: ledger,
    transactionHash: `tx_creator_${ledger}`,
    creator,
    tierCount,
  };
}

function makePayment(
  subscriber: string,
  creator: string,
  amountStroops: bigint,
  timestamp: bigint,
  isRenewal: boolean,
  ledger: number
): PaymentRecordedEvent {
  return {
    contractId: CONTRACT_ID,
    ledgerSequence: ledger,
    transactionHash: `tx_pay_${ledger}_${subscriber.slice(-4)}`,
    subscriber,
    creator,
    amountStroops,
    timestamp,
    isRenewal,
    };
}

function makeCancellation(
  subscriber: string,
  creator: string,
  timestamp: bigint,
  ledger: number
): SubscriptionCancelledEvent {
  return {
    contractId: CONTRACT_ID,
    ledgerSequence: ledger,
    transactionHash: `tx_cancel_${ledger}_${subscriber.slice(-4)}`,
    subscriber,
    creator,
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Helper: read creator_metrics row
// ---------------------------------------------------------------------------

interface MetricsRow {
  active_subscribers: number;
  lifetime_revenue_stroops: string;
  churn_events: number;
  entropy_score: number | null;
}

async function getMetrics(creatorAddress: string): Promise<MetricsRow | null> {
  const result = await pool.query<MetricsRow>(
    `SELECT active_subscribers, lifetime_revenue_stroops, churn_events, entropy_score
     FROM creator_metrics WHERE creator_address = $1`,
    [creatorAddress]
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Test suite 1: Subscription lifecycle
// ---------------------------------------------------------------------------

describe('Subscription lifecycle', () => {
  it('3 subscribers subscribe → active_subscribers=3, correct revenue, churn=0', async () => {
    // Register creator.
    await processEvent(pool, makeCreatorRegistered());

    // Three subscribers, different amounts (different tiers).
    const amount1 = 10_000_000n; // 1 USDC in stroops
    const amount2 = 20_000_000n; // 2 USDC
    const amount3 = 50_000_000n; // 5 USDC

    await processEvent(pool, makePayment(SUB_1, CREATOR_A, amount1, MARCH_2024, false, 101));
    await processEvent(pool, makePayment(SUB_2, CREATOR_A, amount2, MARCH_2024 + 100n, false, 102));
    await processEvent(pool, makePayment(SUB_3, CREATOR_A, amount3, MARCH_2024 + 200n, false, 103));

    const metrics = await getMetrics(CREATOR_A);
    expect(metrics).not.toBeNull();
    expect(metrics!.active_subscribers).toBe(3);
    expect(BigInt(metrics!.lifetime_revenue_stroops)).toBe(amount1 + amount2 + amount3);
    expect(metrics!.churn_events).toBe(0);
  });

  it('1 subscriber renews → active_subscribers still 3, revenue increases', async () => {
    await processEvent(pool, makeCreatorRegistered());

    const amount = 10_000_000n;

    await processEvent(pool, makePayment(SUB_1, CREATOR_A, amount, MARCH_2024, false, 101));
    await processEvent(pool, makePayment(SUB_2, CREATOR_A, amount, MARCH_2024 + 100n, false, 102));
    await processEvent(pool, makePayment(SUB_3, CREATOR_A, amount, MARCH_2024 + 200n, false, 103));

    // SUB_1 renews.
    await processEvent(pool, makePayment(SUB_1, CREATOR_A, amount, APRIL_2024, true, 104));

    const metrics = await getMetrics(CREATOR_A);
    expect(metrics!.active_subscribers).toBe(3); // renewal doesn't add a subscriber
    expect(BigInt(metrics!.lifetime_revenue_stroops)).toBe(amount * 4n); // 4 payments total
    expect(metrics!.churn_events).toBe(0);
  });

  it('1 cancellation → active_subscribers=2, churn=1', async () => {
    await processEvent(pool, makeCreatorRegistered());

    const amount = 10_000_000n;
    await processEvent(pool, makePayment(SUB_1, CREATOR_A, amount, MARCH_2024, false, 101));
    await processEvent(pool, makePayment(SUB_2, CREATOR_A, amount, MARCH_2024 + 100n, false, 102));
    await processEvent(pool, makePayment(SUB_3, CREATOR_A, amount, MARCH_2024 + 200n, false, 103));

    // SUB_3 cancels after their payment.
    await processEvent(
      pool,
      makeCancellation(SUB_3, CREATOR_A, MARCH_2024 + 300n, 104)
    );

    const metrics = await getMetrics(CREATOR_A);
    expect(metrics!.active_subscribers).toBe(2);
    expect(metrics!.churn_events).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: Cohort retention
// ---------------------------------------------------------------------------

describe('Cohort retention', () => {
  it('2 subscribers in March, both renew in April → retention_rate=1.0 at months_since_join=1', async () => {
    await processEvent(pool, makeCreatorRegistered());

    const amount = 10_000_000n;

    // Both subscribe in March 2024.
    await processEvent(pool, makePayment(SUB_1, CREATOR_A, amount, MARCH_2024, false, 101));
    await processEvent(pool, makePayment(SUB_2, CREATOR_A, amount, MARCH_2024 + 86400n, false, 102));

    // Both renew in April 2024.
    await processEvent(pool, makePayment(SUB_1, CREATOR_A, amount, APRIL_2024, true, 103));
    await processEvent(pool, makePayment(SUB_2, CREATOR_A, amount, APRIL_2024 + 86400n, true, 104));

    const result = await pool.query<{
      cohort_month: string;
      months_since_join: number;
      retained_count: number;
      cohort_size: number;
      retention_rate: number;
    }>(
      `SELECT cohort_month, months_since_join, retained_count, cohort_size, retention_rate
       FROM cohort_retention
       WHERE creator_address = $1
         AND cohort_month = '2024-03'
         AND months_since_join = 1`,
      [CREATOR_A]
    );

    expect(result.rows.length).toBe(1);
    const row = result.rows[0];
    expect(row.cohort_month).toBe('2024-03');
    expect(row.months_since_join).toBe(1);
    expect(row.retained_count).toBe(2);
    expect(row.cohort_size).toBe(2);
    expect(row.retention_rate).toBeCloseTo(1.0, 5);
  });

  it('Month-0 retention for the cohort is 1.0 (all cohort members paid in their first month)', async () => {
    await processEvent(pool, makeCreatorRegistered());

    const amount = 10_000_000n;
    await processEvent(pool, makePayment(SUB_1, CREATOR_A, amount, MARCH_2024, false, 101));
    await processEvent(pool, makePayment(SUB_2, CREATOR_A, amount, MARCH_2024 + 86400n, false, 102));
    // One more payment from SUB_1 in March (should not inflate cohort size).
    await processEvent(pool, makePayment(SUB_1, CREATOR_A, amount, MARCH_2024 + 86400n * 2n, true, 103));

    const result = await pool.query<{ retention_rate: number; cohort_size: number }>(
      `SELECT retention_rate, cohort_size FROM cohort_retention
       WHERE creator_address = $1 AND cohort_month = '2024-03' AND months_since_join = 0`,
      [CREATOR_A]
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].retention_rate).toBeCloseTo(1.0, 5);
    expect(result.rows[0].cohort_size).toBe(2); // SUB_1 and SUB_2
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: Entropy score
// ---------------------------------------------------------------------------

describe('computeEntropyScore', () => {
  /**
   * Creates a minimal PaymentRow for entropy testing.
   * We only need amount_stroops and payment_timestamp.
   */
  function makeRow(amount: number, timestamp: number): PaymentRow {
    return {
      id: 1,
      subscriber_address: SUB_1,
      creator_address: CREATOR_A,
      amount_stroops: amount.toString(),
      payment_timestamp: timestamp.toString(),
      is_renewal: false,
      ledger_sequence: '100',
      transaction_hash: 'txhash',
      recorded_at: new Date(),
    };
  }

  it('uniform payments (same amount, same interval) → low entropy (< 0.3)', () => {
    // 10 payments every exactly 30 days, all 10 USDC.
    const DAY = 86400;
    const rows: PaymentRow[] = Array.from({ length: 10 }, (_, i) =>
      makeRow(10_000_000, 1_700_000_000 + i * 30 * DAY)
    );
    const score = computeEntropyScore(rows);
    expect(score).toBeLessThan(0.3);
  });

  it('varied amounts and intervals → higher entropy (> 0.5)', () => {
    // 10 payments with irregular timing and varied amounts.
    const baseTs = 1_700_000_000;
    const rows: PaymentRow[] = [
      makeRow(10_000_000, baseTs),
      makeRow(25_000_000, baseTs + 15 * 86400),   // 15 days later, 2.5 USDC
      makeRow(5_000_000,  baseTs + 17 * 86400),   // 2 days later, 0.5 USDC
      makeRow(50_000_000, baseTs + 45 * 86400),   // 28 days, 5 USDC
      makeRow(10_000_000, baseTs + 47 * 86400),   // 2 days
      makeRow(30_000_000, baseTs + 90 * 86400),   // 43 days, 3 USDC
      makeRow(15_000_000, baseTs + 92 * 86400),   // 2 days, 1.5 USDC
      makeRow(60_000_000, baseTs + 150 * 86400),  // 58 days, 6 USDC
      makeRow(10_000_000, baseTs + 152 * 86400),  // 2 days
      makeRow(40_000_000, baseTs + 210 * 86400),  // 58 days, 4 USDC
    ];
    const score = computeEntropyScore(rows);
    expect(score).toBeGreaterThan(0.5);
  });

  it('returns 0.5 (neutral) with fewer than 2 payments', () => {
    const score = computeEntropyScore([makeRow(10_000_000, 1_700_000_000)]);
    expect(score).toBe(0.5);
  });

  it('score is always in [0, 1]', () => {
    // Stress test with random-ish data.
    const rows: PaymentRow[] = Array.from({ length: 50 }, (_, i) =>
      makeRow(
        Math.floor(Math.random() * 100_000_000) + 1,
        1_700_000_000 + Math.floor(Math.random() * 365 * 86400)
      )
    );
    const score = computeEntropyScore(rows);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test suite 4: Raw event storage
// ---------------------------------------------------------------------------

describe('Raw event storage', () => {
  it('every processEvent call inserts a row into raw_events', async () => {
    await processEvent(pool, makeCreatorRegistered());
    await processEvent(pool, makePayment(SUB_1, CREATOR_A, 10_000_000n, MARCH_2024, false, 101));
    await processEvent(pool, makeCancellation(SUB_1, CREATOR_A, MARCH_2024 + 1000n, 102));

    const result = await pool.query(`SELECT COUNT(*) AS count FROM raw_events`);
    expect(parseInt(result.rows[0].count, 10)).toBe(3);
  });

  it('raw_events stores the correct event_type', async () => {
    await processEvent(pool, makeCreatorRegistered());
    await processEvent(pool, makePayment(SUB_1, CREATOR_A, 10_000_000n, MARCH_2024, false, 101));

    const result = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM raw_events ORDER BY id`
    );
    expect(result.rows[0].event_type).toBe('CreatorRegistered');
    expect(result.rows[1].event_type).toBe('PaymentRecorded');
  });
});
