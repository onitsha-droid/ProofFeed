//! Tests for SubscriptionRegistry.
//!
//! Coverage:
//!   - Happy-path behaviour for all six public functions.
//!   - Every error path defined in [`ContractError`].
//!   - Every emitted event ([`CreatorRegistered`], [`PaymentRecorded`],
//!     [`SubscriptionCancelled`]) verified via XDR comparison using the
//!     soroban-sdk 28 `contractevent::to_xdr` style.

#![cfg(test)]

extern crate std;

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events},
    vec, Address, Env, Event,
};

use crate::{
    ContractError, CreatorRegistered, PaymentRecorded, SubscriptionCancelled,
    SubscriptionRegistry, SubscriptionRegistryClient, Tier,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Stand up a fresh Env, deploy the contract, and return `(env, contract_id)`.
fn setup() -> (Env, Address) {
    let env = Env::default();
    // Allow all auth during tests so we don't have to mock individual signers.
    env.mock_all_auths();
    let contract_id = env.register(SubscriptionRegistry, ());
    (env, contract_id)
}

/// Build a small `Vec<Tier>` for use in registration tests.
fn make_tiers(env: &Env) -> soroban_sdk::Vec<Tier> {
    vec![
        env,
        Tier {
            id: 1,
            price: 5_000_000, // 5 USDC in base units
            name: symbol_short!("basic"),
        },
        Tier {
            id: 2,
            price: 15_000_000, // 15 USDC
            name: symbol_short!("pro"),
        },
    ]
}

// ---------------------------------------------------------------------------
// register_creator — happy path
// ---------------------------------------------------------------------------

#[test]
fn test_register_creator_initialises_stats() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let tiers = make_tiers(&env);

    client.register_creator(&creator, &tiers);

    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.active_subscribers, 0);
    assert_eq!(stats.lifetime_revenue, 0);
    assert_eq!(stats.churn_events, 0);
}

#[test]
fn test_register_creator_does_not_reset_existing_stats() {
    // If a creator re-registers (e.g. to update tiers), their aggregate
    // counters must be preserved.
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);
    let tiers = make_tiers(&env);

    client.register_creator(&creator, &tiers);
    client.subscribe(&subscriber, &creator, &1);

    // Re-register with different tiers.
    let new_tiers = vec![
        &env,
        Tier {
            id: 3,
            price: 25_000_000,
            name: symbol_short!("elite"),
        },
    ];
    client.register_creator(&creator, &new_tiers);

    let stats = client.get_creator_stats(&creator);
    // active_subscribers should still be 1 from the subscribe call above.
    assert_eq!(stats.active_subscribers, 1);
}

// ---------------------------------------------------------------------------
// register_creator — event
// ---------------------------------------------------------------------------

#[test]
fn test_register_creator_emits_creator_registered_event() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let tiers = make_tiers(&env);

    client.register_creator(&creator, &tiers);

    let expected = CreatorRegistered {
        creator: creator.clone(),
        tier_count: 2,
    };
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        std::vec![expected.to_xdr(&env, &contract_id)]
    );
}

// ---------------------------------------------------------------------------
// subscribe — happy path
// ---------------------------------------------------------------------------

#[test]
fn test_subscribe_increments_active_subscribers() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);

    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.active_subscribers, 1);
}

#[test]
fn test_subscribe_records_payment_event() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);

    let history = client.get_subscriber_history(&subscriber, &creator);
    assert_eq!(history.len(), 1);

    let ev = history.get(0).unwrap();
    assert_eq!(ev.subscriber, subscriber);
    assert_eq!(ev.creator, creator);
    assert_eq!(ev.amount, 5_000_000_i128); // tier 1 price
    assert!(!ev.is_renewal);
}

#[test]
fn test_subscribe_accumulates_lifetime_revenue() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let sub1 = Address::generate(&env);
    let sub2 = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&sub1, &creator, &1); // 5_000_000
    client.subscribe(&sub2, &creator, &2); // 15_000_000

    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.lifetime_revenue, 20_000_000);
    assert_eq!(stats.active_subscribers, 2);
}

// ---------------------------------------------------------------------------
// subscribe — event
// ---------------------------------------------------------------------------

#[test]
fn test_subscribe_emits_payment_recorded_event() {
    // Each client invocation is a separate simulated transaction; only events
    // from the most recent call are visible in env.events().all().  This test
    // therefore focuses on the subscribe call in isolation.
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &2); // tier 2 = 15_000_000

    let timestamp = env.ledger().timestamp();

    let expected_payment = PaymentRecorded {
        subscriber: subscriber.clone(),
        creator: creator.clone(),
        amount: 15_000_000_i128,
        timestamp,
        is_renewal: false,
    };
    // After subscribe, env.events() reflects only that invocation.
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        std::vec![expected_payment.to_xdr(&env, &contract_id)]
    );
}

// ---------------------------------------------------------------------------
// subscribe — error paths
// ---------------------------------------------------------------------------

#[test]
fn test_subscribe_returns_creator_not_found_for_unregistered_creator() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let unregistered_creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    let result = client.try_subscribe(&subscriber, &unregistered_creator, &1);
    assert_eq!(result, Err(Ok(ContractError::CreatorNotFound)));
}

#[test]
fn test_subscribe_returns_tier_not_found_for_invalid_tier() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    let result = client.try_subscribe(&subscriber, &creator, &99); // tier 99 does not exist
    assert_eq!(result, Err(Ok(ContractError::TierNotFound)));
}

#[test]
fn test_subscribe_returns_already_subscribed_on_duplicate() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);

    // Second subscribe for the same (subscriber, creator) pair must fail.
    let result = client.try_subscribe(&subscriber, &creator, &1);
    assert_eq!(result, Err(Ok(ContractError::AlreadySubscribed)));
}

#[test]
fn test_subscribe_allowed_again_after_cancel() {
    // After cancelling, a subscriber should be able to re-subscribe.
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);
    client.cancel(&subscriber, &creator);

    // Should succeed after cancel clears the active flag.
    client.subscribe(&subscriber, &creator, &1);
    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.active_subscribers, 1);
}

// ---------------------------------------------------------------------------
// renew — happy path
// ---------------------------------------------------------------------------

#[test]
fn test_renew_records_renewal_event() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);
    client.renew(&subscriber, &creator);

    let history = client.get_subscriber_history(&subscriber, &creator);
    assert_eq!(history.len(), 2);

    let renewal = history.get(1).unwrap();
    assert!(renewal.is_renewal);
    assert_eq!(renewal.subscriber, subscriber);
    assert_eq!(renewal.creator, creator);
    // Renewal amount should equal the original subscription amount.
    assert_eq!(renewal.amount, 5_000_000_i128);
}

#[test]
fn test_renew_does_not_change_active_subscriber_count() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);
    client.renew(&subscriber, &creator);

    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.active_subscribers, 1);
}

#[test]
fn test_renew_accumulates_lifetime_revenue() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &2); // 15_000_000
    client.renew(&subscriber, &creator); // +15_000_000

    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.lifetime_revenue, 30_000_000);
}

// ---------------------------------------------------------------------------
// renew — event
// ---------------------------------------------------------------------------

#[test]
fn test_renew_emits_payment_recorded_event_with_is_renewal_true() {
    // env.events() reflects only the most recent client invocation.
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);
    client.renew(&subscriber, &creator);

    let timestamp = env.ledger().timestamp();

    let expected_renewal = PaymentRecorded {
        subscriber: subscriber.clone(),
        creator: creator.clone(),
        amount: 5_000_000_i128,
        timestamp,
        is_renewal: true,
    };
    // After renew, env.events() reflects only the renew invocation.
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        std::vec![expected_renewal.to_xdr(&env, &contract_id)]
    );
}

// ---------------------------------------------------------------------------
// renew — error paths
// ---------------------------------------------------------------------------

#[test]
fn test_renew_returns_no_subscription_to_renew_with_no_history() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    // No subscribe call — renew should fail.
    let result = client.try_renew(&subscriber, &creator);
    assert_eq!(result, Err(Ok(ContractError::NoSubscriptionToRenew)));
}

// ---------------------------------------------------------------------------
// cancel — happy path
// ---------------------------------------------------------------------------

#[test]
fn test_cancel_decrements_active_subscribers() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);
    client.cancel(&subscriber, &creator);

    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.active_subscribers, 0);
}

#[test]
fn test_cancel_increments_churn_events() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);
    client.cancel(&subscriber, &creator);

    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.churn_events, 1);
}

#[test]
fn test_cancel_does_not_underflow_active_subscribers() {
    // cancel() on an unsubscribed address should saturate at 0, not panic.
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.cancel(&subscriber, &creator); // no prior subscribe

    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.active_subscribers, 0);
}

// ---------------------------------------------------------------------------
// cancel — event
// ---------------------------------------------------------------------------

#[test]
fn test_cancel_emits_subscription_cancelled_event() {
    // env.events() reflects only the most recent client invocation.
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);
    client.cancel(&subscriber, &creator);

    let timestamp = env.ledger().timestamp();

    let expected_cancel = SubscriptionCancelled {
        subscriber: subscriber.clone(),
        creator: creator.clone(),
        timestamp,
    };
    // After cancel, env.events() reflects only the cancel invocation.
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        std::vec![expected_cancel.to_xdr(&env, &contract_id)]
    );
}

// ---------------------------------------------------------------------------
// get_creator_stats
// ---------------------------------------------------------------------------

#[test]
fn test_get_creator_stats_returns_zeros_for_unknown_creator() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);

    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.active_subscribers, 0);
    assert_eq!(stats.lifetime_revenue, 0);
    assert_eq!(stats.churn_events, 0);
}

// ---------------------------------------------------------------------------
// get_subscriber_history
// ---------------------------------------------------------------------------

#[test]
fn test_get_subscriber_history_returns_empty_for_no_activity() {
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    let history = client.get_subscriber_history(&subscriber, &creator);
    assert!(history.is_empty());
}

#[test]
fn test_get_subscriber_history_full_lifecycle() {
    // subscribe → renew → renew produces 3 events, in order.
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let subscriber = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&subscriber, &creator, &1);
    client.renew(&subscriber, &creator);
    client.renew(&subscriber, &creator);

    let history = client.get_subscriber_history(&subscriber, &creator);
    assert_eq!(history.len(), 3);

    assert!(!history.get(0).unwrap().is_renewal); // initial subscribe
    assert!(history.get(1).unwrap().is_renewal); // first renewal
    assert!(history.get(2).unwrap().is_renewal); // second renewal
}

#[test]
fn test_get_subscriber_history_is_isolated_per_pair() {
    // Two different (subscriber, creator) pairs must not share history.
    let (env, contract_id) = setup();
    let client = SubscriptionRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let sub_a = Address::generate(&env);
    let sub_b = Address::generate(&env);

    client.register_creator(&creator, &make_tiers(&env));
    client.subscribe(&sub_a, &creator, &1);

    let history_b = client.get_subscriber_history(&sub_b, &creator);
    assert!(history_b.is_empty());
}
