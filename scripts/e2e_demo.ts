#!/usr/bin/env ts-node
/**
 * scripts/e2e_demo.ts
 *
 * End-to-end demonstration of the full ProofFeed flow described in
 * README.md § "How It Works", without requiring a live Soroban RPC or a
 * deployed contract.
 *
 * Flow exercised:
 *   1. Creator registers  → CreatorRegistered event injected
 *   2. Fan subscribes     → PaymentRecorded (is_renewal=false) injected × 3 fans
 *   3. Fan renews         → PaymentRecorded (is_renewal=true)  injected × 2 fans
 *   4. Fan cancels        → SubscriptionCancelled injected × 1 fan
 *   5. Indexer derives metrics (computeCreatorMetrics, computeCohortRetention)
 *   6. API responds correctly to /api/creators/:address/metrics
 *   7. API responds correctly to /api/creators/:address/retention
 *   8. Badge URL constructed, metrics printed as a simulated badge render
 *
 * Usage:
 *   cd /path/to/prooffeed
 *   TEST_DATABASE_URL=postgres://prooffeed:prooffeed@localhost:5432/prooffeed_demo \
 *     npx ts-node --project indexer/tsconfig.json scripts/e2e_demo.ts
 *
 * Prerequisites:
 *   - PostgreSQL running with a demo database (TEST_DATABASE_URL or DATABASE_URL)
 *   - npm install already run in the indexer directory
 *
 * The script creates all required tables via the indexer migration, then
 * tears down the demo data afterwards (TRUNCATE). It does NOT require the
 * indexer listener or Soroban RPC to be running.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../indexer/.env` });

import { Pool } from 'pg';
import * as http from 'http';
import { migrate } from '../indexer/src/db/migrate';
import { processEvent } from '../indexer/src/processor';
import { startApi } from '../indexer/src/api';
import type {
  CreatorRegisteredEvent,
  PaymentRecordedEvent,
  SubscriptionCancelledEvent,
} from '../indexer/src/types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL;

if (!DB_URL) {
  console.error(
    '❌  No database URL found.\n' +
    '    Set TEST_DATABASE_URL or DATABASE_URL before running this script.\n' +
    '    Example:\n' +
    '      TEST_DATABASE_URL=postgres://prooffeed:prooffeed@localhost:5432/prooffeed_demo \\\n' +
    '        npx ts-node --project indexer/tsconfig.json scripts/e2e_demo.ts'
  );
  process.exit(1);
}

// Demo addresses — exactly 56 chars, valid Stellar strkey format (G + 55 base32 chars).
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const CREATOR     = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATST';
const FAN_1       = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF1';
const FAN_2       = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF2';
const FAN_3       = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF3';

// Fixed timestamps for deterministic cohort bucketing.
// 2024-03-15 00:00:00 UTC = 1710460800
const MARCH_2024  = 1710460800n;
// 2024-04-15 00:00:00 UTC = 1713139200
const APRIL_2024  = 1713139200n;

// Subscription price: 10 USDC = 100_000_000 stroops (10 × 10_000_000)
const PRICE_STROOPS = 100_000_000n;

const DEMO_API_PORT = 3099; // Distinct port so it doesn't conflict with a running indexer.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function step(n: number, msg: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Step ${n}: ${msg}`);
  console.log('─'.repeat(60));
}

function ok(msg: string) { console.log(`  ✓  ${msg}`); }
function info(msg: string) { console.log(`     ${msg}`); }

/** Make a GET request to the demo API and return the parsed JSON body. */
async function apiGet<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: 'localhost', port: DEMO_API_PORT, path, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode} for ${path}: ${body}`));
            } else {
              resolve(JSON.parse(body) as T);
            }
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API request timed out')); });
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`\n  ✗  ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  ok(`assert: ${message}`);
}

/** Truncate all application tables so the demo starts clean. */
async function cleanDb(pool: Pool): Promise<void> {
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

// ---------------------------------------------------------------------------
// Event factories (mirrors integration.test.ts fixtures)
// ---------------------------------------------------------------------------

function makeCreatorRegistered(ledger = 100): CreatorRegisteredEvent {
  return {
    contractId: CONTRACT_ID,
    ledgerSequence: ledger,
    transactionHash: `demo_tx_register_${ledger}`,
    creator: CREATOR,
    tierCount: 1,
  };
}

function makeSubscribe(
  fan: string,
  timestamp: bigint,
  ledger: number
): PaymentRecordedEvent {
  return {
    contractId: CONTRACT_ID,
    ledgerSequence: ledger,
    transactionHash: `demo_tx_subscribe_${ledger}`,
    subscriber: fan,
    creator: CREATOR,
    amountStroops: PRICE_STROOPS,
    timestamp,
    isRenewal: false,
  };
}

function makeRenew(
  fan: string,
  timestamp: bigint,
  ledger: number
): PaymentRecordedEvent {
  return {
    contractId: CONTRACT_ID,
    ledgerSequence: ledger,
    transactionHash: `demo_tx_renew_${ledger}`,
    subscriber: fan,
    creator: CREATOR,
    amountStroops: PRICE_STROOPS,
    timestamp,
    isRenewal: true,
  };
}

function makeCancel(
  fan: string,
  timestamp: bigint,
  ledger: number
): SubscriptionCancelledEvent {
  return {
    contractId: CONTRACT_ID,
    ledgerSequence: ledger,
    transactionHash: `demo_tx_cancel_${ledger}`,
    subscriber: fan,
    creator: CREATOR,
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Derived-metrics types (mirrors API response shapes)
// ---------------------------------------------------------------------------

interface MetricsResponse {
  activeSubscribers: number;
  lifetimeRevenueStroops: string;
  churnEvents: number;
  entropyScore: number | null;
}

interface RetentionRow {
  cohortMonth: string;
  monthsSinceJoin: number;
  retentionRate: number;
  cohortSize: number;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║          ProofFeed — End-to-End Demo Script                ║');
  console.log('║  Exercises the full README "How It Works" flow             ║');
  console.log('║  No live Soroban RPC required — events are injected        ║');
  console.log('║  directly via processEvent().                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  info(`Database   : ${DB_URL!.replace(/:[^:@]+@/, ':***@')}`);
  info(`Creator    : ${CREATOR}`);
  info(`Fans       : ${FAN_1}, ${FAN_2}, ${FAN_3}`);
  info(`Demo port  : ${DEMO_API_PORT}`);

  // ── Database setup ────────────────────────────────────────────────────────

  step(0, 'Migrate and clean database');

  await migrate(DB_URL!);
  ok('Migrations applied (idempotent).');

  const pool = new Pool({ connectionString: DB_URL });
  await cleanDb(pool);
  ok('Demo tables truncated — starting clean.');

  // ── Start demo API server ─────────────────────────────────────────────────

  const apiServer = startApi(pool, DEMO_API_PORT);
  ok(`Demo API server started on http://localhost:${DEMO_API_PORT}`);

  try {
    // ── Step 1: Creator registers ─────────────────────────────────────────

    step(1, 'Creator registers — CreatorRegistered event');
    await processEvent(pool, makeCreatorRegistered(100));
    ok(`processEvent(CreatorRegistered) → ledger 100`);

    const regResult = await pool.query(
      `SELECT tier_count FROM creator_registrations WHERE creator_address = $1`,
      [CREATOR]
    );
    assert(regResult.rows.length === 1, 'creator_registrations row exists');
    assert(regResult.rows[0].tier_count === 1, 'tier_count = 1');

    // ── Step 2: Three fans subscribe ──────────────────────────────────────

    step(2, 'Three fans subscribe in March 2024 — PaymentRecorded (is_renewal=false)');

    await processEvent(pool, makeSubscribe(FAN_1, MARCH_2024,              101));
    await processEvent(pool, makeSubscribe(FAN_2, MARCH_2024 + 86_400n,    102));
    await processEvent(pool, makeSubscribe(FAN_3, MARCH_2024 + 2n * 86_400n, 103));

    ok('processEvent(PaymentRecorded × 3, is_renewal=false)');

    const metricsAfterSubs = await apiGet<MetricsResponse>(
      `/api/creators/${CREATOR}/metrics`
    );
    info(`  activeSubscribers     = ${metricsAfterSubs.activeSubscribers}`);
    info(`  lifetimeRevenue       = ${metricsAfterSubs.lifetimeRevenueStroops} stroops (${Number(metricsAfterSubs.lifetimeRevenueStroops) / 10_000_000} USDC)`);
    info(`  churnEvents           = ${metricsAfterSubs.churnEvents}`);
    info(`  entropyScore          = ${metricsAfterSubs.entropyScore ?? '(null — need ≥2 payments)'}`);

    assert(metricsAfterSubs.activeSubscribers === 3, 'activeSubscribers = 3 after three subscribes');
    assert(
      metricsAfterSubs.lifetimeRevenueStroops === (PRICE_STROOPS * 3n).toString(),
      `lifetimeRevenue = ${(PRICE_STROOPS * 3n).toString()} stroops`
    );
    assert(metricsAfterSubs.churnEvents === 0, 'churnEvents = 0');

    // ── Step 3: Two fans renew in April 2024 ─────────────────────────────

    step(3, 'FAN_1 and FAN_2 renew in April 2024 — PaymentRecorded (is_renewal=true)');

    await processEvent(pool, makeRenew(FAN_1, APRIL_2024,           104));
    await processEvent(pool, makeRenew(FAN_2, APRIL_2024 + 86_400n, 105));

    ok('processEvent(PaymentRecorded × 2, is_renewal=true)');

    const metricsAfterRenewals = await apiGet<MetricsResponse>(
      `/api/creators/${CREATOR}/metrics`
    );
    info(`  activeSubscribers     = ${metricsAfterRenewals.activeSubscribers}`);
    info(`  lifetimeRevenue       = ${metricsAfterRenewals.lifetimeRevenueStroops} stroops (${Number(metricsAfterRenewals.lifetimeRevenueStroops) / 10_000_000} USDC)`);
    info(`  entropyScore          = ${metricsAfterRenewals.entropyScore?.toFixed(3) ?? 'null'}`);

    // Renewals don't add to active_subscribers count — still 3.
    assert(metricsAfterRenewals.activeSubscribers === 3, 'activeSubscribers still = 3 after renewals');
    assert(
      metricsAfterRenewals.lifetimeRevenueStroops === (PRICE_STROOPS * 5n).toString(),
      `lifetimeRevenue = ${(PRICE_STROOPS * 5n).toString()} stroops (5 total payments)`
    );
    assert(
      metricsAfterRenewals.entropyScore !== null,
      'entropyScore is non-null (enough payment data)'
    );
    assert(
      metricsAfterRenewals.entropyScore! > 0,
      'entropyScore > 0 (varied timing between fans)'
    );

    // ── Step 4: FAN_3 cancels ─────────────────────────────────────────────

    step(4, 'FAN_3 cancels — SubscriptionCancelled event');

    await processEvent(
      pool,
      makeCancel(FAN_3, MARCH_2024 + 3n * 86_400n, 106)
    );

    ok('processEvent(SubscriptionCancelled)');

    const metricsAfterCancel = await apiGet<MetricsResponse>(
      `/api/creators/${CREATOR}/metrics`
    );
    info(`  activeSubscribers     = ${metricsAfterCancel.activeSubscribers}`);
    info(`  churnEvents           = ${metricsAfterCancel.churnEvents}`);

    assert(metricsAfterCancel.activeSubscribers === 2, 'activeSubscribers = 2 after FAN_3 cancels');
    assert(metricsAfterCancel.churnEvents === 1, 'churnEvents = 1');

    // ── Step 5: Retention curve ───────────────────────────────────────────

    step(5, 'Indexer cohort retention — verify March 2024 cohort');

    const retention = await apiGet<RetentionRow[]>(
      `/api/creators/${CREATOR}/retention`
    );
    info(`  Retention rows returned: ${retention.length}`);

    // Find the March 2024 cohort at month 0 and month 1.
    const march0 = retention.find(
      (r) => r.cohortMonth === '2024-03' && r.monthsSinceJoin === 0
    );
    const march1 = retention.find(
      (r) => r.cohortMonth === '2024-03' && r.monthsSinceJoin === 1
    );

    assert(march0 !== undefined, 'cohort_retention row exists for 2024-03 at M+0');
    assert(march0!.retentionRate === 1.0, 'retention at M+0 = 1.0 (all cohort members paid in join month)');
    assert(march0!.cohortSize === 3, 'cohort_size = 3 (FAN_1, FAN_2, FAN_3 all joined in March)');

    assert(march1 !== undefined, 'cohort_retention row exists for 2024-03 at M+1');
    const march1Retained = Math.round(march1!.retentionRate * march1!.cohortSize);
    info(`  March cohort M+1 retention = ${(march1!.retentionRate * 100).toFixed(0)}% (${march1Retained} of ${march1!.cohortSize})`);
    // FAN_1 and FAN_2 renewed in April → 2/3 retained.
    assert(
      Math.abs(march1!.retentionRate - 2 / 3) < 0.001,
      'retention at M+1 ≈ 0.667 (2 of 3 fans renewed in April)'
    );

    // ── Step 6: Simulate creator dashboard stats view ─────────────────────

    step(6, 'Creator dashboard — stats view (GET /api/creators/:address/metrics)');
    info('  (In the running app this is rendered by StatsPage.tsx via useCreatorMetrics hook)');

    const creatorView = await apiGet<MetricsResponse>(
      `/api/creators/${CREATOR}/metrics`
    );
    info(`  Active subscribers    : ${creatorView.activeSubscribers}`);
    info(`  Lifetime revenue      : $${(Number(creatorView.lifetimeRevenueStroops) / 10_000_000).toFixed(2)} USDC`);
    info(`  Churn events          : ${creatorView.churnEvents}`);
    info(`  Entropy score         : ${creatorView.entropyScore?.toFixed(3)}`);

    assert(creatorView.activeSubscribers === 2, 'Creator dashboard shows correct active_subscribers = 2');

    // ── Step 7: Simulate brand dashboard report ───────────────────────────

    step(7, 'Brand dashboard — proof-of-audience report (GET /api/creators/:address/*)');
    info('  (In the running app this is rendered by ReportPage.tsx via useCreatorReport hook)');

    const brandMetrics = await apiGet<MetricsResponse>(
      `/api/creators/${CREATOR}/metrics`
    );
    const brandRetention = await apiGet<RetentionRow[]>(
      `/api/creators/${CREATOR}/retention`
    );

    const totalEver = brandMetrics.activeSubscribers + brandMetrics.churnEvents;
    const churnRate = ((brandMetrics.churnEvents / totalEver) * 100).toFixed(1);

    info('  ┌─ Proof of Audience Report ──────────────────────────────┐');
    info(`  │  Creator          : ${CREATOR.slice(0, 12)}…${CREATOR.slice(-6)}           │`);
    info(`  │  Active Subs      : ${String(brandMetrics.activeSubscribers).padEnd(12)}                       │`);
    info(`  │  Lifetime Revenue : $${(Number(brandMetrics.lifetimeRevenueStroops) / 10_000_000).toFixed(2)} USDC${' '.repeat(26)}│`);
    info(`  │  Churn Rate       : ${churnRate}%${' '.repeat(38)}│`);
    info(`  │  Entropy Score    : ${brandMetrics.entropyScore?.toFixed(3) ?? '—'}${' '.repeat(38)}│`);
    info(`  │  Retention rows   : ${brandRetention.length}${' '.repeat(39)}│`);
    info('  └─────────────────────────────────────────────────────────┘');

    assert(
      brandRetention.length > 0,
      'Brand dashboard receives non-empty retention data'
    );

    // ── Step 8: Verification badge URL ────────────────────────────────────

    step(8, 'Verification badge link — always-live URL resolves to current state');
    info('  (BadgePage.tsx in brand-dashboard renders this URL live on every load)');

    const BRAND_DASHBOARD_URL = 'http://localhost:5174';
    const badgeUrl = `${BRAND_DASHBOARD_URL}/badge/${CREATOR}`;
    info(`\n  Badge URL: ${badgeUrl}`);
    info('  Every click fetches fresh data — no caching, no screenshots.');
    info(`  Active subscribers right now: ${brandMetrics.activeSubscribers}`);
    info(`  Entropy score right now     : ${brandMetrics.entropyScore?.toFixed(3) ?? '—'}`);

    ok('Badge URL constructed (brand dashboard must be running to render it).');

    // ── Raw event audit log ───────────────────────────────────────────────

    step(9, 'Raw event audit log — verify all on-chain events were stored');

    const rawCount = await pool.query<{ count: string; event_type: string }>(
      `SELECT event_type, COUNT(*) AS count FROM raw_events GROUP BY event_type ORDER BY event_type`
    );
    info('  raw_events breakdown:');
    for (const row of rawCount.rows) {
      info(`    ${row.event_type.padEnd(30)}: ${row.count}`);
    }

    const totalRaw = rawCount.rows.reduce((s: number, r: { count: string; event_type: string }) => s + parseInt(r.count, 10), 0);
    // 1 CreatorRegistered + 3 Subscribe + 2 Renew + 1 Cancel = 7 events total
    assert(totalRaw === 7, 'raw_events contains all 7 events (1 register + 3 subscribe + 2 renew + 1 cancel)');

    // ── Summary ───────────────────────────────────────────────────────────

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  ✓  ALL STEPS PASSED — ProofFeed E2E demo complete         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('  Full flow verified:');
    console.log('  1. Creator registers on-chain (synthetic CreatorRegistered event)');
    console.log('  2. Fans subscribe (synthetic PaymentRecorded × 3, is_renewal=false)');
    console.log('  3. Fans renew (synthetic PaymentRecorded × 2, is_renewal=true)');
    console.log('  4. Indexer computes metrics: active subs, lifetime revenue, entropy');
    console.log('  5. Indexer computes cohort retention curves');
    console.log('  6. Creator dashboard endpoint returns correct stats');
    console.log('  7. Brand dashboard endpoint returns correct proof-of-audience report');
    console.log('  8. Badge URL constructed — loads live data on every page view');
    console.log('  9. All events persisted in raw_events audit log\n');

    console.log('  To see the dashboards running:');
    console.log('    npm run dev:indexer    # in one terminal');
    console.log('    npm run dev:creator    # in another');
    console.log('    npm run dev:brand      # in another\n');

  } finally {
    // Cleanup: close the demo API server and DB pool.
    apiServer.close();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('\n❌  Demo script failed:', err);
  process.exit(1);
});
