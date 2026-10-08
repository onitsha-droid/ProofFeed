/**
 * @prooffeed/shared — Shared types used by both creator-dashboard and brand-dashboard.
 *
 * These mirror the indexer API response shapes.
 * Do not add runtime code here — types only.
 */

/**
 * Aggregate metrics for a single creator, as returned by:
 *   GET /api/creators/:address/metrics
 *
 * Privacy note: this is AGGREGATE data only. Individual subscriber wallets
 * or payment transactions are never surfaced to brand-facing interfaces.
 */
export interface CreatorMetrics {
  /** Number of subscriptions that are currently active (not cancelled). */
  activeSubscribers: number;

  /**
   * Total revenue received over the creator's lifetime, in stroops.
   * 1 USDC = 10,000,000 stroops.
   */
  lifetimeRevenueStroops: number;

  /**
   * Total number of subscription cancellation events recorded on-chain.
   * Used to derive churn rate: churnEvents / (activeSubscribers + churnEvents).
   */
  churnEvents: number;

  /**
   * Payment Pattern Irregularity Score (0–1).
   *   Higher → more irregular → more consistent with an organic audience.
   *   Lower  → more uniform  → warrants further review for sybil activity.
   *
   * IMPORTANT: This is a confidence signal only — not proof of fraud or its absence.
   * See README Anti-Fraud & Sybil Resistance section.
   */
  entropyScore: number;
}

/**
 * A single data point in a creator's cohort retention curve, as returned by:
 *   GET /api/creators/:address/retention
 *
 * The full array is pivoted into a table where rows = cohort months and
 * columns = months since joining (M+0, M+1, …).
 */
export interface RetentionPoint {
  /**
   * The calendar month when subscribers in this cohort first subscribed.
   * ISO 8601 year-month string, e.g. "2024-03".
   */
  cohortMonth: string;

  /**
   * How many months after joining this measurement was taken.
   * 0 = the joining month (always 100% by definition).
   */
  monthsSinceJoin: number;

  /**
   * Fraction of the original cohort still subscribed at this point (0–1).
   * Multiply by 100 for a percentage.
   */
  retentionRate: number;

  /** Number of subscribers in this cohort at month 0. */
  cohortSize: number;
}

/**
 * Subscription tier defined by a creator.
 * Used in the creator-dashboard onboarding flow when calling register_creator.
 */
export interface Tier {
  id: number;
  name: string;
  /** Price in stroops (1 USDC = 10,000,000 stroops). */
  priceStroops: number;
}

/**
 * A payment event emitted by the SubscriptionRegistry contract.
 * Consumed by the indexer; never directly exposed to brand-facing UIs
 * (brands only see aggregate CreatorMetrics, not individual events).
 */
export interface PaymentEvent {
  subscriber: string;
  creator: string;
  amountStroops: number;
  timestamp: number; // Unix seconds
  isRenewal: boolean;
}
