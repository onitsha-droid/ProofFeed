/**
 * processor.ts
 *
 * Takes a typed ProofFeed SorobanEvent and persists it to the database,
 * then triggers derived-metrics recomputation for the affected creator.
 *
 * This is the integration point between the event listener (which fetches raw
 * events from the Soroban RPC) and the metrics engine (which computes
 * retention curves, entropy scores, etc.).
 */

import { Pool } from 'pg';
import {
  SorobanEvent,
  isCreatorRegisteredEvent,
  isPaymentRecordedEvent,
  isSubscriptionCancelledEvent,
} from './types';
import { computeCreatorMetrics, computeCohortRetention } from './metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the creator address from any ProofFeed event so we know which
 * creator's metrics to recompute after inserting.
 */
function creatorOf(event: SorobanEvent): string | null {
  if (isCreatorRegisteredEvent(event)) return event.creator;
  if (isPaymentRecordedEvent(event)) return event.creator;
  if (isSubscriptionCancelledEvent(event)) return event.creator;
  return null;
}

/**
 * Returns a JSON-serialisable representation of the event for storage in
 * raw_events.payload. bigint values are converted to strings because
 * JSON.stringify doesn't handle bigint natively.
 */
function eventToPayload(event: SorobanEvent): object {
  return JSON.parse(
    JSON.stringify(event, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  );
}

// ---------------------------------------------------------------------------
// processEvent
// ---------------------------------------------------------------------------

/**
 * Persists a typed Soroban event to the database and recomputes derived
 * metrics for the affected creator.
 *
 * Steps:
 *   1. Insert into raw_events (every event, regardless of type).
 *   2. Route to the appropriate typed table:
 *      - CreatorRegistered  → creator_registrations (upsert)
 *      - PaymentRecorded    → payment_events (insert)
 *      - SubscriptionCancelled → subscription_cancellations (insert)
 *   3. Recompute creator_metrics and cohort_retention for the affected creator.
 *
 * All three DB writes happen inside a single transaction so a partial failure
 * doesn't leave the raw_events table and the typed tables out of sync.
 *
 * @param pool — pg connection pool
 * @param event — typed ProofFeed event from parser.ts
 */
export async function processEvent(pool: Pool, event: SorobanEvent): Promise<void> {
  const creator = creatorOf(event);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ------------------------------------------------------------------
    // 1. Insert into raw_events
    // ------------------------------------------------------------------
    let eventType: string;
    if (isCreatorRegisteredEvent(event)) eventType = 'CreatorRegistered';
    else if (isPaymentRecordedEvent(event)) eventType = 'PaymentRecorded';
    else eventType = 'SubscriptionCancelled';

    await client.query(
      `
      INSERT INTO raw_events
        (contract_id, event_type, ledger_sequence, transaction_hash, payload)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        event.contractId,
        eventType,
        event.ledgerSequence,
        event.transactionHash,
        JSON.stringify(eventToPayload(event)),
      ]
    );

    // ------------------------------------------------------------------
    // 2. Insert into the typed table
    // ------------------------------------------------------------------
    if (isCreatorRegisteredEvent(event)) {
      // Upsert: a creator may re-register to update their tiers.
      await client.query(
        `
        INSERT INTO creator_registrations
          (creator_address, tier_count, registered_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (creator_address) DO UPDATE SET
          tier_count    = EXCLUDED.tier_count,
          registered_at = NOW()
        `,
        [event.creator, event.tierCount]
      );
    } else if (isPaymentRecordedEvent(event)) {
      await client.query(
        `
        INSERT INTO payment_events
          (subscriber_address, creator_address, amount_stroops,
           payment_timestamp, is_renewal, ledger_sequence, transaction_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          event.subscriber,
          event.creator,
          event.amountStroops.toString(), // pg stores as BIGINT; pass as string
          event.timestamp.toString(),
          event.isRenewal,
          event.ledgerSequence,
          event.transactionHash,
        ]
      );
    } else if (isSubscriptionCancelledEvent(event)) {
      await client.query(
        `
        INSERT INTO subscription_cancellations
          (subscriber_address, creator_address, cancel_timestamp, ledger_sequence)
        VALUES ($1, $2, $3, $4)
        `,
        [
          event.subscriber,
          event.creator,
          event.timestamp.toString(),
          event.ledgerSequence,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // ------------------------------------------------------------------
  // 3. Recompute derived metrics (outside the transaction — these are
  //    best-effort and can be retried independently if they fail).
  // ------------------------------------------------------------------
  if (creator) {
    try {
      await computeCreatorMetrics(pool, creator);
    } catch (err) {
      console.error(
        `[processor] computeCreatorMetrics failed for ${creator}:`,
        err
      );
    }

    // Only recompute cohort retention for payment events (cancellations don't
    // change cohort membership; creator registrations have no payments yet).
    if (isPaymentRecordedEvent(event)) {
      try {
        await computeCohortRetention(pool, creator);
      } catch (err) {
        console.error(
          `[processor] computeCohortRetention failed for ${creator}:`,
          err
        );
      }
    }
  }
}
