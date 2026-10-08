/**
 * types.ts
 *
 * TypeScript interfaces for the three ProofFeed Soroban contract events emitted
 * by the SubscriptionRegistry contract.
 *
 * These mirror the Rust structs in contracts/subscription_registry/src/lib.rs:
 *   - CreatorRegistered  { creator: Address, tier_count: u32 }
 *   - PaymentRecorded    { subscriber: Address, creator: Address, amount: i128,
 *                          timestamp: u64, is_renewal: bool }
 *   - SubscriptionCancelled { subscriber: Address, creator: Address,
 *                             timestamp: u64 }
 *
 * All Stellar Address values are represented as their strkey-encoded string
 * form (e.g. "G..." for public keys, "C..." for contract addresses).
 *
 * i128 / u64 Soroban values are mapped to bigint because JavaScript's number
 * type cannot safely represent 64-bit integers without precision loss.
 */

// ---------------------------------------------------------------------------
// CreatorRegistered
// ---------------------------------------------------------------------------

/**
 * Emitted when a creator calls register_creator() on the contract.
 * Signals that a new creator is onboarded and their tiers are set up.
 */
export interface CreatorRegisteredEvent {
  /** Contract address that emitted the event (strkey "C..." form). */
  contractId: string;
  /** Ledger sequence number at the time the event was emitted. */
  ledgerSequence: number;
  /** Transaction hash that produced this event. */
  transactionHash: string;
  /** Creator's Stellar public key (strkey "G..." form). */
  creator: string;
  /** Number of subscription tiers the creator registered. */
  tierCount: number;
}

// ---------------------------------------------------------------------------
// PaymentRecorded
// ---------------------------------------------------------------------------

/**
 * Emitted when a subscriber calls subscribe() or renew() on the contract.
 * This is the primary event for building retention curves, revenue aggregates,
 * and payment entropy scores.
 */
export interface PaymentRecordedEvent {
  /** Contract address that emitted the event. */
  contractId: string;
  /** Ledger sequence number at the time the event was emitted. */
  ledgerSequence: number;
  /** Transaction hash that produced this event. */
  transactionHash: string;
  /** Subscriber's Stellar public key. */
  subscriber: string;
  /** Creator's Stellar public key. */
  creator: string;
  /**
   * Payment amount in stablecoin base units (stroops for USDC-on-Stellar,
   * i.e. 1 USDC = 10,000,000 stroops). Stored as bigint because i128 exceeds
   * JavaScript's safe integer range.
   */
  amountStroops: bigint;
  /**
   * Ledger timestamp in seconds since Unix epoch. Stored as bigint because
   * Soroban u64 can exceed Number.MAX_SAFE_INTEGER in the distant future.
   */
  timestamp: bigint;
  /** false = initial subscription, true = renewal. */
  isRenewal: boolean;
}

// ---------------------------------------------------------------------------
// SubscriptionCancelled
// ---------------------------------------------------------------------------

/**
 * Emitted when a subscriber calls cancel() on the contract.
 */
export interface SubscriptionCancelledEvent {
  /** Contract address that emitted the event. */
  contractId: string;
  /** Ledger sequence number at the time the event was emitted. */
  ledgerSequence: number;
  /** Transaction hash that produced this event. */
  transactionHash: string;
  /** Subscriber's Stellar public key. */
  subscriber: string;
  /** Creator's Stellar public key. */
  creator: string;
  /** Ledger timestamp of cancellation, in seconds since Unix epoch. */
  timestamp: bigint;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all three ProofFeed contract events.
 * Use with type guards (isPaymentRecordedEvent etc.) or switch on a tag field
 * added by the parser.
 */
export type SorobanEvent =
  | CreatorRegisteredEvent
  | PaymentRecordedEvent
  | SubscriptionCancelledEvent;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** True when e is a CreatorRegisteredEvent. */
export function isCreatorRegisteredEvent(
  e: SorobanEvent
): e is CreatorRegisteredEvent {
  return 'tierCount' in e;
}

/** True when e is a PaymentRecordedEvent. */
export function isPaymentRecordedEvent(
  e: SorobanEvent
): e is PaymentRecordedEvent {
  return 'amountStroops' in e;
}

/** True when e is a SubscriptionCancelledEvent. */
export function isSubscriptionCancelledEvent(
  e: SorobanEvent
): e is SubscriptionCancelledEvent {
  return !('tierCount' in e) && !('amountStroops' in e) && 'timestamp' in e;
}

// ---------------------------------------------------------------------------
// Internal DB row shapes (used by metrics.ts)
// ---------------------------------------------------------------------------

/** A row from the payment_events table, as returned by pg. */
export interface PaymentRow {
  id: number;
  subscriber_address: string;
  creator_address: string;
  /** pg returns BIGINT as string by default; parse with BigInt(). */
  amount_stroops: string;
  /** Ledger timestamp (seconds since epoch), returned as string by pg. */
  payment_timestamp: string;
  is_renewal: boolean;
  ledger_sequence: string;
  transaction_hash: string;
  recorded_at: Date;
}
