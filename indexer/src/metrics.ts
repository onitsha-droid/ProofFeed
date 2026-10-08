/**
 * metrics.ts
 *
 * Computes derived metrics from indexed on-chain data stored in PostgreSQL.
 *
 * Exports:
 *   - computeCreatorMetrics(pool, creatorAddress) — active subscribers,
 *     lifetime revenue, churn, entropy score → upserted into creator_metrics
 *   - computeEntropyScore(payments) — Payment Entropy Score algorithm
 *   - computeCohortRetention(pool, creatorAddress) — cohort retention curves
 *     → upserted into cohort_retention
 */

import { Pool } from 'pg';
import { PaymentRow } from './types';

// ---------------------------------------------------------------------------
// computeEntropyScore
// ---------------------------------------------------------------------------

/**
 * Payment Entropy Score (MVP)
 *
 * Measures irregularity of payment timing and amounts.
 * High entropy (near 1.0) = natural, irregular pattern typical of real subscribers.
 * Low entropy (near 0.0) = suspiciously uniform — could indicate sybil/bot activity.
 *
 * Algorithm:
 * 1. Compute inter-payment intervals (gaps between consecutive payment timestamps)
 *    for each subscriber cohort.
 * 2. Compute coefficient of variation (CV = stddev/mean) of those intervals.
 * 3. Compute CV of payment amounts.
 * 4. Normalize both CVs to [0,1] using tanh(cv) so the score saturates gracefully.
 * 5. Return weighted average: 0.6 * timing_entropy + 0.4 * amount_entropy.
 *
 * Rationale: Real subscriber bases show irregular timing (people pay when they
 * remember, billing cycles vary) and varied amounts (different tiers). Sybil farms
 * tend to pay at exactly regular intervals with identical amounts.
 *
 * @param payments — array of payment rows from the payment_events table
 * @returns score in [0, 1]; returns 0.5 (neutral) when there is insufficient data
 */
export function computeEntropyScore(payments: PaymentRow[]): number {
  if (payments.length < 2) {
    // Not enough data to compute variability — return neutral score.
    return 0.5;
  }

  // --- Timing entropy ---
  // Sort all payments by timestamp and compute inter-payment intervals.
  const timestamps = payments
    .map((p) => Number(p.payment_timestamp))
    .sort((a, b) => a - b);

  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }

  const timingCV = coefficientOfVariation(intervals);
  // Normalise to [0, 1] via tanh so the score saturates gracefully for very
  // high CVs (extremely irregular timing doesn't push the score above 1).
  const timingEntropy = Math.tanh(timingCV);

  // --- Amount entropy ---
  const amounts = payments.map((p) => Number(BigInt(p.amount_stroops)));
  const amountCV = coefficientOfVariation(amounts);
  const amountEntropy = Math.tanh(amountCV);

  // --- Weighted average ---
  const score = 0.6 * timingEntropy + 0.4 * amountEntropy;

  // Clamp to [0, 1] as a safety net (tanh already guarantees < 1, but the
  // weighted sum with non-tanh'd inputs could theoretically drift slightly).
  return Math.min(1, Math.max(0, score));
}

/**
 * Computes the coefficient of variation (stddev / mean) for an array of numbers.
 * Returns 0 when the mean is 0 or the array has fewer than 2 elements.
 */
function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean === 0) return 0;

  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);

  return stddev / mean;
}

// ---------------------------------------------------------------------------
// computeCreatorMetrics
// ---------------------------------------------------------------------------

/**
 * Queries the DB for all payment and cancellation events for a creator, then
 * computes:
 *   - active_subscribers: subscribers with ≥ 1 payment and no subsequent
 *     cancellation
 *   - lifetime_revenue_stroops: sum of all payments
 *   - churn_events: total cancellation count
 *   - entropy_score: from computeEntropyScore()
 *
 * Upserts the result into the creator_metrics table.
 */
export async function computeCreatorMetrics(
  pool: Pool,
  creatorAddress: string
): Promise<void> {
  // Fetch all payment events for this creator.
  const paymentsResult = await pool.query<PaymentRow>(
    `SELECT * FROM payment_events WHERE creator_address = $1 ORDER BY payment_timestamp ASC`,
    [creatorAddress]
  );
  const payments = paymentsResult.rows;

  // Lifetime revenue: simple sum.
  const lifetimeRevenue = payments.reduce(
    (sum, p) => sum + BigInt(p.amount_stroops),
    0n
  );

  // Churn events: count of cancellation rows.
  const churnResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM subscription_cancellations WHERE creator_address = $1`,
    [creatorAddress]
  );
  const churnEvents = parseInt(churnResult.rows[0].count, 10);

  // Active subscribers:
  // A subscriber is active if they appear in payment_events but NOT in
  // subscription_cancellations (for this creator) after their last payment.
  //
  // Query: subscribers whose latest payment_timestamp is AFTER their latest
  // cancel_timestamp (or who have no cancellation row at all).
  const activeResult = await pool.query<{ count: string }>(
    `
    SELECT COUNT(DISTINCT pe.subscriber_address) AS count
    FROM payment_events pe
    WHERE pe.creator_address = $1
      AND NOT EXISTS (
        SELECT 1
        FROM subscription_cancellations sc
        WHERE sc.subscriber_address = pe.subscriber_address
          AND sc.creator_address    = pe.creator_address
          AND sc.cancel_timestamp   >= pe.payment_timestamp
      )
    `,
    [creatorAddress]
  );
  const activeSubscribers = parseInt(activeResult.rows[0].count, 10);

  // Entropy score from all payment rows.
  const entropyScore = computeEntropyScore(payments);

  // Upsert into creator_metrics.
  await pool.query(
    `
    INSERT INTO creator_metrics
      (creator_address, active_subscribers, lifetime_revenue_stroops,
       churn_events, entropy_score, last_computed_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (creator_address) DO UPDATE SET
      active_subscribers       = EXCLUDED.active_subscribers,
      lifetime_revenue_stroops = EXCLUDED.lifetime_revenue_stroops,
      churn_events             = EXCLUDED.churn_events,
      entropy_score            = EXCLUDED.entropy_score,
      last_computed_at         = NOW()
    `,
    [
      creatorAddress,
      activeSubscribers,
      lifetimeRevenue.toString(), // pg driver accepts numeric strings for BIGINT
      churnEvents,
      entropyScore,
    ]
  );
}

// ---------------------------------------------------------------------------
// computeCohortRetention
// ---------------------------------------------------------------------------

/**
 * Computes cohort retention curves for a creator.
 *
 * A cohort is defined by the month of a subscriber's FIRST payment to this
 * creator (cohort_month in YYYY-MM format).
 *
 * For each cohort month C and each subsequent month M (months_since_join = 0,
 * 1, 2, …), we compute:
 *   retained_count: how many subscribers from cohort C made at least one
 *                   payment in month M
 *   cohort_size:    how many subscribers are in cohort C
 *   retention_rate: retained_count / cohort_size
 *
 * months_since_join = 0 is the cohort's own month and always has retention
 * rate 1.0 (by definition, all members paid in their first month).
 *
 * Results are upserted into the cohort_retention table.
 */
export async function computeCohortRetention(
  pool: Pool,
  creatorAddress: string
): Promise<void> {
  // Find the first payment month for each subscriber.
  const cohortResult = await pool.query<{
    subscriber_address: string;
    cohort_month: string; // YYYY-MM
  }>(
    `
    SELECT
      subscriber_address,
      TO_CHAR(
        TO_TIMESTAMP(MIN(payment_timestamp)),
        'YYYY-MM'
      ) AS cohort_month
    FROM payment_events
    WHERE creator_address = $1
    GROUP BY subscriber_address
    `,
    [creatorAddress]
  );

  if (cohortResult.rows.length === 0) return;

  // Group subscribers by cohort month.
  const cohorts = new Map<string, Set<string>>();
  for (const row of cohortResult.rows) {
    if (!cohorts.has(row.cohort_month)) {
      cohorts.set(row.cohort_month, new Set());
    }
    cohorts.get(row.cohort_month)!.add(row.subscriber_address);
  }

  // For each cohort, determine which months appear in the payment data.
  const allMonthsResult = await pool.query<{ payment_month: string }>(
    `
    SELECT DISTINCT TO_CHAR(TO_TIMESTAMP(payment_timestamp), 'YYYY-MM') AS payment_month
    FROM payment_events
    WHERE creator_address = $1
    ORDER BY payment_month ASC
    `,
    [creatorAddress]
  );
  const allMonths = allMonthsResult.rows.map((r) => r.payment_month);

  // For each cohort month, compute retention at each subsequent month.
  for (const [cohortMonth, cohortMembers] of cohorts.entries()) {
    const cohortSize = cohortMembers.size;
    // Find the index of this cohort month in the sorted month list.
    const cohortMonthIndex = allMonths.indexOf(cohortMonth);

    for (
      let offset = 0;
      cohortMonthIndex + offset < allMonths.length;
      offset++
    ) {
      const targetMonth = allMonths[cohortMonthIndex + offset];

      // Count how many cohort members paid in targetMonth.
      const retainedResult = await pool.query<{ count: string }>(
        `
        SELECT COUNT(DISTINCT pe.subscriber_address) AS count
        FROM payment_events pe
        WHERE pe.creator_address    = $1
          AND pe.subscriber_address = ANY($2::text[])
          AND TO_CHAR(TO_TIMESTAMP(pe.payment_timestamp), 'YYYY-MM') = $3
        `,
        [creatorAddress, [...cohortMembers], targetMonth]
      );
      const retainedCount = parseInt(retainedResult.rows[0].count, 10);
      const retentionRate = cohortSize > 0 ? retainedCount / cohortSize : 0;

      // Upsert this data point.
      await pool.query(
        `
        INSERT INTO cohort_retention
          (creator_address, cohort_month, months_since_join,
           retained_count, cohort_size, retention_rate, computed_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (creator_address, cohort_month, months_since_join) DO UPDATE SET
          retained_count = EXCLUDED.retained_count,
          cohort_size    = EXCLUDED.cohort_size,
          retention_rate = EXCLUDED.retention_rate,
          computed_at    = NOW()
        `,
        [
          creatorAddress,
          cohortMonth,
          offset,
          retainedCount,
          cohortSize,
          retentionRate,
        ]
      );
    }
  }
}
