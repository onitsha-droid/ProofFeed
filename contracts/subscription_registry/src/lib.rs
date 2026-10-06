//! SubscriptionRegistry — core ProofFeed Soroban contract.
//!
//! Responsibilities (from README.md "Smart Contract Design"):
//!   • Register creators and their subscription tiers/pricing.
//!   • Accept subscription and pay-per-unlock payments in a supported stablecoin.
//!   • Emit structured events for every payment: subscriber, creator, amount,
//!     timestamp, is_renewal.
//!   • Track per-creator aggregate state: active subscriber count, lifetime
//!     revenue, churn events.
//!
//! TODOs for future contributors:
//!   TODO(auth): All mutating functions should require the caller to be the
//!     address they are acting on behalf of (subscriber or creator).
//!     `Address::require_auth()` calls are stubbed with comments to make the
//!     required slots obvious.
//!   TODO(payment): The subscribe/renew functions currently do NOT transfer
//!     stablecoin tokens. A production implementation must invoke the
//!     stablecoin contract's `transfer` to move funds from the subscriber to
//!     the creator (or an escrow address). The stablecoin contract address
//!     should be stored in contract storage during initialisation.
//!   TODO(tier-validation): subscribe() does not verify that tier_id exists
//!     in the creator's tier list. Add a bounds-check once the Tier storage
//!     layout is settled.
//!   TODO(renewal-window): renew() does not enforce a cooldown or expiry
//!     window. A production contract should reject renewals that arrive before
//!     the current subscription period ends.

#![no_std]

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, vec, Address, Env, Vec,
};

// ---------------------------------------------------------------------------
// Storage key tags
// ---------------------------------------------------------------------------

/// Top-level storage key discriminants.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Per-creator aggregate stats.  Key: creator Address.
    CreatorStats(Address),
    /// Per-creator tier list.  Key: creator Address.
    Tiers(Address),
    /// Per-(subscriber, creator) payment history.  Key: (subscriber, creator).
    PaymentHistory(Address, Address),
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Emitted by `register_creator`.
#[contractevent]
pub struct CreatorRegistered {
    pub creator: Address,
    pub tier_count: u32,
}

/// Emitted by `subscribe` and `renew`.
#[contractevent]
pub struct PaymentRecorded {
    pub subscriber: Address,
    pub creator: Address,
    pub amount: i128,
    pub timestamp: u64,
    pub is_renewal: bool,
}

/// Emitted by `cancel`.
#[contractevent]
pub struct SubscriptionCancelled {
    pub subscriber: Address,
    pub creator: Address,
    pub timestamp: u64,
}

// ---------------------------------------------------------------------------
// Public data structures
// ---------------------------------------------------------------------------

/// A subscription tier defined by a creator.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Tier {
    /// Monotonic identifier assigned by the creator at registration time.
    pub id: u32,
    /// Price per period, denominated in the stablecoin's smallest unit
    /// (e.g. stroops for USDC-on-Stellar).
    pub price: i128,
    /// Human-readable label (e.g. "Basic", "Pro").
    /// TODO(encoding): Currently stored as a raw symbol; consider a
    /// Bytes field for longer names once the UX requirements are clear.
    pub name: soroban_sdk::Symbol,
}

/// Per-creator aggregate state stored on-chain.
///
/// Fields map directly to README.md "Smart Contract Design":
///   "active subscriber count, lifetime revenue, churn events".
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CreatorStats {
    /// Number of subscribers who are currently active (subscribed but not
    /// cancelled).
    pub active_subscribers: u32,
    /// Sum of all payment amounts ever received, in stablecoin base units.
    pub lifetime_revenue: i128,
    /// Number of cancel events recorded against this creator.
    pub churn_events: u32,
}

/// An individual payment record stored in a subscriber's history for a given
/// creator.
///
/// Fields match the README.md event schema:
///   subscriber, creator, amount, timestamp, is_renewal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PaymentEvent {
    pub subscriber: Address,
    pub creator: Address,
    /// Payment amount in stablecoin base units.
    pub amount: i128,
    /// Ledger timestamp (seconds since Unix epoch) at the time of the call.
    pub timestamp: u64,
    /// `false` for an initial subscription, `true` for a renewal.
    pub is_renewal: bool,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct SubscriptionRegistry;

#[contractimpl]
impl SubscriptionRegistry {
    // -----------------------------------------------------------------------
    // register_creator
    // -----------------------------------------------------------------------

    /// Register a creator and their initial set of subscription tiers.
    ///
    /// Overwrites any previously registered tier list for the same creator.
    /// If the creator has no existing `CreatorStats` record one is created
    /// with all counters zeroed.
    ///
    /// TODO(auth): add `creator.require_auth()` before writing storage.
    pub fn register_creator(env: Env, creator: Address, tiers: Vec<Tier>) {
        // TODO(auth): creator.require_auth();

        // Persist the tier list.
        env.storage()
            .persistent()
            .set(&DataKey::Tiers(creator.clone()), &tiers);

        // Initialise stats only if they don't exist yet so a re-registration
        // doesn't reset counters.
        if !env
            .storage()
            .persistent()
            .has(&DataKey::CreatorStats(creator.clone()))
        {
            let stats = CreatorStats {
                active_subscribers: 0,
                lifetime_revenue: 0,
                churn_events: 0,
            };
            env.storage()
                .persistent()
                .set(&DataKey::CreatorStats(creator.clone()), &stats);
        }

        env.events().publish_event(&CreatorRegistered {
            creator,
            tier_count: tiers.len(),
        });
    }

    // -----------------------------------------------------------------------
    // subscribe
    // -----------------------------------------------------------------------

    /// Record a new subscription from `subscriber` to `creator` under
    /// `tier_id`.
    ///
    /// Emits a `PaymentRecorded` event with `is_renewal = false`.
    /// Increments `active_subscribers` and `lifetime_revenue` in
    /// `CreatorStats`.
    ///
    /// TODO(auth): add `subscriber.require_auth()`.
    /// TODO(payment): transfer stablecoin from subscriber to creator.
    /// TODO(tier-validation): verify tier_id exists in creator's tier list
    ///   and use its price rather than hard-coding 0.
    pub fn subscribe(
        env: Env,
        subscriber: Address,
        creator: Address,
        tier_id: u32,
    ) {
        // TODO(auth): subscriber.require_auth();

        let amount = Self::tier_price(&env, &creator, tier_id);
        let timestamp = env.ledger().timestamp();

        // Record payment event in subscriber history.
        let event = PaymentEvent {
            subscriber: subscriber.clone(),
            creator: creator.clone(),
            amount,
            timestamp,
            is_renewal: false,
        };
        Self::append_payment_event(&env, &subscriber, &creator, event);

        // Update creator aggregate stats.
        let mut stats = Self::load_or_default_stats(&env, &creator);
        stats.active_subscribers = stats.active_subscribers.saturating_add(1);
        stats.lifetime_revenue = stats.lifetime_revenue.saturating_add(amount);
        env.storage()
            .persistent()
            .set(&DataKey::CreatorStats(creator.clone()), &stats);

        // Emit on-chain event (README: subscriber, creator, amount, timestamp,
        // is_renewal).
        env.events().publish_event(&PaymentRecorded {
            subscriber,
            creator,
            amount,
            timestamp,
            is_renewal: false,
        });
    }

    // -----------------------------------------------------------------------
    // renew
    // -----------------------------------------------------------------------

    /// Record a subscription renewal for an existing subscriber/creator pair.
    ///
    /// Emits a `PaymentRecorded` event with `is_renewal = true`.
    /// Adds to `lifetime_revenue`; does NOT change `active_subscribers`
    /// because the subscriber is already counted as active.
    ///
    /// TODO(auth): add `subscriber.require_auth()`.
    /// TODO(payment): transfer stablecoin from subscriber to creator.
    /// TODO(renewal-window): enforce that a previous subscription exists and
    ///   the renewal window is open.
    pub fn renew(env: Env, subscriber: Address, creator: Address) {
        // TODO(auth): subscriber.require_auth();

        // Derive renewal amount from the subscriber's most recent payment.
        let history = Self::load_history(&env, &subscriber, &creator);
        // TODO(renewal-window): return an error if history is empty.
        let amount = if history.is_empty() {
            0_i128
        } else {
            history.get(history.len() - 1).unwrap().amount
        };

        let timestamp = env.ledger().timestamp();

        let event = PaymentEvent {
            subscriber: subscriber.clone(),
            creator: creator.clone(),
            amount,
            timestamp,
            is_renewal: true,
        };
        Self::append_payment_event(&env, &subscriber, &creator, event);

        // Only update revenue; active count stays the same.
        let mut stats = Self::load_or_default_stats(&env, &creator);
        stats.lifetime_revenue = stats.lifetime_revenue.saturating_add(amount);
        env.storage()
            .persistent()
            .set(&DataKey::CreatorStats(creator.clone()), &stats);

        env.events().publish_event(&PaymentRecorded {
            subscriber,
            creator,
            amount,
            timestamp,
            is_renewal: true,
        });
    }

    // -----------------------------------------------------------------------
    // cancel
    // -----------------------------------------------------------------------

    /// Record a subscription cancellation.
    ///
    /// Decrements `active_subscribers` (floored at 0) and increments
    /// `churn_events` in `CreatorStats`.
    ///
    /// Does NOT emit a `PaymentRecorded` event because no money moves on
    /// cancel.
    ///
    /// TODO(auth): add `subscriber.require_auth()`.
    pub fn cancel(env: Env, subscriber: Address, creator: Address) {
        // TODO(auth): subscriber.require_auth();

        let mut stats = Self::load_or_default_stats(&env, &creator);
        stats.active_subscribers = stats.active_subscribers.saturating_sub(1);
        stats.churn_events = stats.churn_events.saturating_add(1);
        env.storage()
            .persistent()
            .set(&DataKey::CreatorStats(creator.clone()), &stats);

        env.events().publish_event(&SubscriptionCancelled {
            subscriber,
            creator,
            timestamp: env.ledger().timestamp(),
        });
    }

    // -----------------------------------------------------------------------
    // get_creator_stats
    // -----------------------------------------------------------------------

    /// Return the current aggregate stats for a creator.
    ///
    /// Returns a zeroed `CreatorStats` if the creator has never been
    /// registered (caller should treat this as "not found").
    pub fn get_creator_stats(env: Env, creator: Address) -> CreatorStats {
        Self::load_or_default_stats(&env, &creator)
    }

    // -----------------------------------------------------------------------
    // get_subscriber_history
    // -----------------------------------------------------------------------

    /// Return all recorded `PaymentEvent`s for a (subscriber, creator) pair,
    /// ordered from oldest to newest.
    ///
    /// Returns an empty list if no history exists.
    pub fn get_subscriber_history(
        env: Env,
        subscriber: Address,
        creator: Address,
    ) -> Vec<PaymentEvent> {
        Self::load_history(&env, &subscriber, &creator)
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn load_or_default_stats(env: &Env, creator: &Address) -> CreatorStats {
        env.storage()
            .persistent()
            .get(&DataKey::CreatorStats(creator.clone()))
            .unwrap_or(CreatorStats {
                active_subscribers: 0,
                lifetime_revenue: 0,
                churn_events: 0,
            })
    }

    fn load_history(
        env: &Env,
        subscriber: &Address,
        creator: &Address,
    ) -> Vec<PaymentEvent> {
        env.storage()
            .persistent()
            .get(&DataKey::PaymentHistory(
                subscriber.clone(),
                creator.clone(),
            ))
            .unwrap_or_else(|| vec![env])
    }

    fn append_payment_event(
        env: &Env,
        subscriber: &Address,
        creator: &Address,
        event: PaymentEvent,
    ) {
        let mut history = Self::load_history(env, subscriber, creator);
        history.push_back(event);
        env.storage().persistent().set(
            &DataKey::PaymentHistory(subscriber.clone(), creator.clone()),
            &history,
        );
    }

    /// Look up the price for a given tier_id.
    ///
    /// Returns 0 if the creator is not registered or the tier is not found.
    /// TODO(tier-validation): propagate an error instead of silently returning 0.
    fn tier_price(env: &Env, creator: &Address, tier_id: u32) -> i128 {
        let tiers: Vec<Tier> = env
            .storage()
            .persistent()
            .get(&DataKey::Tiers(creator.clone()))
            .unwrap_or_else(|| vec![env]);

        for i in 0..tiers.len() {
            let tier = tiers.get(i).unwrap();
            if tier.id == tier_id {
                return tier.price;
            }
        }
        // TODO(tier-validation): return an error here instead.
        0
    }
}

mod tests;
