//! Unit tests for SubscriptionRegistry — happy path for all 6 interface
//! functions.
//!
//! Uses the Soroban `testutils` harness so tests run entirely in-process
//! without a running network.

#![cfg(test)]

use soroban_sdk::{
    symbol_short, testutils::Address as _, vec, Address, Env,
};

use crate::{SubscriptionRegistry, SubscriptionRegistryClient, Tier};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Stand up a fresh Env, deploy the contract, and return the client.
///
/// The `Env` is returned first so the caller owns it for the lifetime of
/// the test; the client holds a reference to it.
fn setup() -> (Env, Address) {
    let env = Env::default();
    let contract_id = env.register(SubscriptionRegistry, ());
    (env, contract_id)
}

/// Build a small Vec<Tier> for use in registration tests.
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
// register_creator
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
// subscribe
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

    let event = history.get(0).unwrap();
    assert_eq!(event.subscriber, subscriber);
    assert_eq!(event.creator, creator);
    assert_eq!(event.amount, 5_000_000_i128); // tier 1 price
    assert!(!event.is_renewal);
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
// renew
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
    // Renewing does not add a new active subscriber.
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
    client.renew(&subscriber, &creator);          // +15_000_000

    let stats = client.get_creator_stats(&creator);
    assert_eq!(stats.lifetime_revenue, 30_000_000);
}

// ---------------------------------------------------------------------------
// cancel
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
    // subscribe → renew → renew produces 3 events, all on the same
    // (subscriber, creator) pair, in order.
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
    assert!(history.get(1).unwrap().is_renewal);  // first renewal
    assert!(history.get(2).unwrap().is_renewal);  // second renewal
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
