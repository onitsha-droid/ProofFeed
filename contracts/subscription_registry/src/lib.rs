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
//! ## Access Control
//!
//! Every mutating function requires the relevant address to authorise the call
//! via `Address::require_auth()`:
//!   - `register_creator`: the `creator` address must authorise.
//!   - `subscribe` / `renew` / `cancel`: the `subscriber` address must
//!     authorise.
//!
//! ## Error Handling
//!
//! All invalid-state conditions are surfaced through [`ContractError`], which
//! is encoded as a `u32` in the Soroban error-type ABI so callers can pattern-
//! match the error code without inspecting strings.
//!
//! ## TODOs for future contributors
//!
//! TODO(payment): The subscribe/renew functions do NOT yet transfer stablecoin
//!   tokens. A production implementation must invoke the stablecoin contract's
//!   `transfer` to move funds from the subscriber to the creator (or an escrow
//!   address). The stablecoin contract address should be stored in contract
//!   storage during initialisation.
//!
//! TODO(renewal-window): renew() does not enforce a cooldown or expiry window.
//!   A production contract should reject renewals that arrive before the
//!   current subscription period ends.

#![no_std]

use soroban_sdk::{
    contract, contractevent, contractimpl, contracterror, contracttype,
    vec, Address, Env, Vec,
};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// All error conditions that the SubscriptionRegistry contract can return.
///
/// Variants are assigned stable `u32` codes so off-chain tooling can map them
/// to human-readable messages without depending on the contract binary.
#[contracterror]
#[derive(Clone, Debug, PartialEq)]
pub enum ContractError {
    /// The creator address has no registered tiers; they must call
    /// `register_creator` first.
    CreatorNotFound = 1,

    /// The `tier_id` supplied to `subscribe` does not match any tier in the
    /// creator's registered tier list.
    TierNotFound = 2,

    /// The subscriber already has an active subscription to this creator (i.e.
    /// a payment history entry exists with `is_renewal = false` and no
    /// subsequent cancellation).
    AlreadySubscribed = 3,

    /// `renew` was called but the subscriber has no prior payment history with
    /// this creator, so there is nothing to renew.
    NoSubscriptionToRenew = 4,
}

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
    /// Active subscription flag per (subscriber, creator).
    /// `true` when the subscriber has an active (non-cancelled) subscription.
    ActiveSub(Address, Address),
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
///
/// This is the primary event consumed by the ProofFeed indexer
/// (README.md "Architecture") to build retention curves, lifetime revenue
/// aggregates, and payment entropy scores.
///
/// Fields match the README.md event schema exactly:
///   subscriber, creator, amount, timestamp, is_renewal.
#[contractevent]
pub struct PaymentRecorded {
    /// The wallet that paid.
    pub subscriber: Address,
    /// The creator being subscribed to.
    pub creator: Address,
    /// Payment amount in stablecoin base units (e.g. stroops for USDC-on-Stellar).
    pub amount: i128,
    /// Ledger timestamp at the time of the call (seconds since Unix epoch).
    pub timestamp: u64,
    /// `false` for an initial subscription, `true` for a renewal.
    pub is_renewal: bool,
}

/// Emitted by `cancel`.
#[contractevent]
pub struct SubscriptionCancelled {
    pub subscriber: Address,
    pub creator: Address,
    /// Ledger timestamp at the time of cancellation.
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
    /// The `creator` address must authorise this call — it is not possible
    /// for a third party to register on behalf of a creator.
    ///
    /// Overwrites any previously registered tier list for the same creator.
    /// If the creator has no existing [`CreatorStats`] record, one is created
    /// with all counters zeroed.  A re-registration does NOT reset counters.
    ///
    /// Emits [`CreatorRegistered`].
    ///
    /// # Errors
    ///
    /// This function is infallible — there is no invalid state it can reach
    /// (a creator is free to re-register at any time).
    pub fn register_creator(env: Env, creator: Address, tiers: Vec<Tier>) {
        // Access control: only the creator themselves may register.
        creator.require_auth();

        let tier_count = tiers.len();

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
            tier_count,
        });
    }

    // -----------------------------------------------------------------------
    // subscribe
    // -----------------------------------------------------------------------

    /// Record a new subscription from `subscriber` to `creator` under
    /// `tier_id`.
    ///
    /// The `subscriber` address must authorise this call.
    ///
    /// Emits a [`PaymentRecorded`] event with `is_renewal = false`.
    /// Increments `active_subscribers` and `lifetime_revenue` in
    /// [`CreatorStats`].
    ///
    /// # Errors
    ///
    /// - [`ContractError::CreatorNotFound`] — the creator has never called
    ///   `register_creator`.
    /// - [`ContractError::TierNotFound`] — `tier_id` does not exist in the
    ///   creator's current tier list.
    /// - [`ContractError::AlreadySubscribed`] — the subscriber already has an
    ///   active subscription to this creator.
    ///
    /// # TODOs
    ///
    /// TODO(payment): transfer stablecoin from subscriber to creator.
    pub fn subscribe(
        env: Env,
        subscriber: Address,
        creator: Address,
        tier_id: u32,
    ) -> Result<(), ContractError> {
        // Access control: only the subscriber themselves may subscribe.
        subscriber.require_auth();

        // Guard: creator must be registered.
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Tiers(creator.clone()))
        {
            return Err(ContractError::CreatorNotFound);
        }

        // Guard: tier must exist and retrieve its price.
        let amount = Self::tier_price(&env, &creator, tier_id)
            .ok_or(ContractError::TierNotFound)?;

        // Guard: no duplicate active subscription.
        let already_active: bool = env
            .storage()
            .persistent()
            .get(&DataKey::ActiveSub(subscriber.clone(), creator.clone()))
            .unwrap_or(false);
        if already_active {
            return Err(ContractError::AlreadySubscribed);
        }

        let timestamp = env.ledger().timestamp();

        // Mark subscription as active.
        env.storage().persistent().set(
            &DataKey::ActiveSub(subscriber.clone(), creator.clone()),
            &true,
        );

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

        Ok(())
    }

    // -----------------------------------------------------------------------
    // renew
    // -----------------------------------------------------------------------

    /// Record a subscription renewal for an existing subscriber/creator pair.
    ///
    /// The `subscriber` address must authorise this call.
    ///
    /// Emits a [`PaymentRecorded`] event with `is_renewal = true`.
    /// Adds to `lifetime_revenue`; does NOT change `active_subscribers`
    /// because the subscriber is already counted as active.
    ///
    /// The renewal amount is taken from the subscriber's most recent payment
    /// entry, so the price always matches the tier the subscriber is on.
    ///
    /// # Errors
    ///
    /// - [`ContractError::NoSubscriptionToRenew`] — the subscriber has no
    ///   payment history with this creator (they must call `subscribe` first).
    ///
    /// # TODOs
    ///
    /// TODO(payment): transfer stablecoin from subscriber to creator.
    /// TODO(renewal-window): reject renewals that arrive before the current
    ///   subscription period ends.
    pub fn renew(
        env: Env,
        subscriber: Address,
        creator: Address,
    ) -> Result<(), ContractError> {
        // Access control: only the subscriber themselves may renew.
        subscriber.require_auth();

        // Derive renewal amount from the subscriber's most recent payment.
        let history = Self::load_history(&env, &subscriber, &creator);
        if history.is_empty() {
            return Err(ContractError::NoSubscriptionToRenew);
        }
        let amount = history.get(history.len() - 1).unwrap().amount;

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

        Ok(())
    }

    // -----------------------------------------------------------------------
    // cancel
    // -----------------------------------------------------------------------

    /// Record a subscription cancellation.
    ///
    /// The `subscriber` address must authorise this call.
    ///
    /// Decrements `active_subscribers` (floored at 0) and increments
    /// `churn_events` in [`CreatorStats`].  Clears the active-subscription
    /// flag so the subscriber may re-subscribe in future.
    ///
    /// Emits [`SubscriptionCancelled`].
    ///
    /// No money moves on cancel so no [`PaymentRecorded`] event is emitted.
    pub fn cancel(env: Env, subscriber: Address, creator: Address) {
        // Access control: only the subscriber themselves may cancel.
        subscriber.require_auth();

        // Clear active-subscription flag.
        env.storage().persistent().set(
            &DataKey::ActiveSub(subscriber.clone(), creator.clone()),
            &false,
        );

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
    /// Returns a zeroed [`CreatorStats`] if the creator has never been
    /// registered (caller should treat this as "not found").
    pub fn get_creator_stats(env: Env, creator: Address) -> CreatorStats {
        Self::load_or_default_stats(&env, &creator)
    }

    // -----------------------------------------------------------------------
    // get_subscriber_history
    // -----------------------------------------------------------------------

    /// Return all recorded [`PaymentEvent`]s for a (subscriber, creator) pair,
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

    /// Look up the price for a given `tier_id`.
    ///
    /// Returns `Some(price)` if the tier exists, `None` otherwise.
    fn tier_price(env: &Env, creator: &Address, tier_id: u32) -> Option<i128> {
        let tiers: Vec<Tier> = env
            .storage()
            .persistent()
            .get(&DataKey::Tiers(creator.clone()))
            .unwrap_or_else(|| vec![env]);

        for i in 0..tiers.len() {
            let tier = tiers.get(i).unwrap();
            if tier.id == tier_id {
                return Some(tier.price);
            }
        }
        None
    }
}

mod tests;
