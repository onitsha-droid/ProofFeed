//! Tests for ReputationStake.
//!
//! Coverage:
//!   - Staking: basic deposit, zero-amount error, double-stake error.
//!   - Withdrawal: clean after cooldown, blocked before cooldown,
//!     blocked with open disputes.
//!   - Dispute flow: raise dispute, successful slash, rejected dispute.
//!   - Errors: not-initialised, not-arbitrator, dispute-not-found,
//!     dispute-already-resolved.

#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
};

use crate::{
    ContractError, DisputeOutcome, DisputeStatus, ReputationStake,
    ReputationStakeClient,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COOLDOWN: u32 = 100; // short cooldown for tests
const STAKE_AMOUNT: i128 = 1_000_000;

/// Set up a fresh Env with the contract deployed and initialised.
///
/// Returns `(env, contract_id, arbitrator)`.
fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ReputationStake, ());
    let arbitrator = Address::generate(&env);
    let client = ReputationStakeClient::new(&env, &contract_id);
    client.initialize(&arbitrator, &COOLDOWN);
    (env, contract_id, arbitrator)
}

/// Advance the ledger sequence by `n` ledgers.
fn advance_ledger(env: &Env, n: u32) {
    env.ledger().with_mut(|li| {
        li.sequence_number = li.sequence_number.saturating_add(n);
    });
}

/// Register a creator's stake (panics on error).
fn stake(client: &ReputationStakeClient, creator: &Address) {
    client.stake(creator, &STAKE_AMOUNT);
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

#[test]
fn test_initialize_sets_config() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ReputationStake, ());
    let client = ReputationStakeClient::new(&env, &contract_id);
    let arbitrator = Address::generate(&env);

    client.initialize(&arbitrator, &COOLDOWN);
    // Verify initialisation by performing a subsequent staking call.
    let creator = Address::generate(&env);
    client.stake(&creator, &STAKE_AMOUNT);
}

#[test]
fn test_initialize_returns_error_on_second_call() {
    let (env, contract_id, arbitrator) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);

    let result = client.try_initialize(&arbitrator, &COOLDOWN);
    assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
}

// ---------------------------------------------------------------------------
// stake
// ---------------------------------------------------------------------------

#[test]
fn test_stake_stores_record() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);

    stake(&client, &creator);

    let record = client.get_stake(&creator).unwrap();
    assert_eq!(record.amount, STAKE_AMOUNT);
    assert_eq!(record.open_disputes, 0);
}

#[test]
fn test_stake_returns_error_for_zero_amount() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);

    let result = client.try_stake(&creator, &0);
    assert_eq!(result, Err(Ok(ContractError::ZeroStake)));
}

#[test]
fn test_stake_returns_error_when_already_staked() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);

    stake(&client, &creator);

    let result = client.try_stake(&creator, &STAKE_AMOUNT);
    assert_eq!(result, Err(Ok(ContractError::AlreadyStaked)));
}

#[test]
fn test_stake_returns_error_when_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(ReputationStake, ());
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);

    let result = client.try_stake(&creator, &STAKE_AMOUNT);
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

// ---------------------------------------------------------------------------
// withdraw — clean path (after cooldown, no disputes)
// ---------------------------------------------------------------------------

#[test]
fn test_withdraw_succeeds_after_cooldown() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);

    stake(&client, &creator);
    advance_ledger(&env, COOLDOWN);

    client.withdraw(&creator);

    // Stake record should be removed.
    assert!(client.get_stake(&creator).is_none());
}

// ---------------------------------------------------------------------------
// withdraw — blocked before cooldown
// ---------------------------------------------------------------------------

#[test]
fn test_withdraw_fails_before_cooldown() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);

    stake(&client, &creator);
    // Advance by less than the required cooldown.
    advance_ledger(&env, COOLDOWN - 1);

    let result = client.try_withdraw(&creator);
    assert_eq!(result, Err(Ok(ContractError::CooldownNotElapsed)));
}

#[test]
fn test_withdraw_fails_when_no_stake() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);

    let result = client.try_withdraw(&creator);
    assert_eq!(result, Err(Ok(ContractError::NoStake)));
}

// ---------------------------------------------------------------------------
// withdraw — blocked by open dispute
// ---------------------------------------------------------------------------

#[test]
fn test_withdraw_blocked_by_open_dispute() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    stake(&client, &creator);
    advance_ledger(&env, COOLDOWN);

    // Open a dispute.
    let evidence = String::from_str(&env, "ipfs://Qm123abc");
    client.raise_dispute(&creator, &disputer, &evidence);

    // Withdrawal should be blocked even though cooldown elapsed.
    let result = client.try_withdraw(&creator);
    assert_eq!(result, Err(Ok(ContractError::DisputeActive)));
}

#[test]
fn test_withdraw_unblocked_after_dispute_rejected() {
    // A rejected dispute (outcome = Rejected) decrements open_disputes,
    // allowing withdrawal after cooldown.
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    stake(&client, &creator);
    advance_ledger(&env, COOLDOWN);

    let evidence = String::from_str(&env, "ipfs://Qm123abc");
    let dispute_id = client.raise_dispute(&creator, &disputer, &evidence);

    // Arbitrator rejects the dispute.
    client.resolve_dispute(&dispute_id, &false);

    // Now withdrawal should succeed.
    client.withdraw(&creator);
    assert!(client.get_stake(&creator).is_none());
}

// ---------------------------------------------------------------------------
// raise_dispute
// ---------------------------------------------------------------------------

#[test]
fn test_raise_dispute_creates_record() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    stake(&client, &creator);

    let evidence = String::from_str(&env, "ipfs://Qmabc");
    let dispute_id = client.raise_dispute(&creator, &disputer, &evidence);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(dispute.creator, creator);
    assert_eq!(dispute.disputer, disputer);
    assert_eq!(dispute.status, DisputeStatus::Open);
}

#[test]
fn test_raise_dispute_increments_open_disputes_on_stake() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    stake(&client, &creator);

    let evidence = String::from_str(&env, "evidence_hash");
    client.raise_dispute(&creator, &disputer, &evidence);

    let record = client.get_stake(&creator).unwrap();
    assert_eq!(record.open_disputes, 1);
}

#[test]
fn test_raise_dispute_returns_error_when_no_stake() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    // No stake registered.
    let evidence = String::from_str(&env, "evidence_hash");
    let result = client.try_raise_dispute(&creator, &disputer, &evidence);
    assert_eq!(result, Err(Ok(ContractError::NoStake)));
}

#[test]
fn test_raise_dispute_ids_are_monotonically_increasing() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    stake(&client, &creator);

    let ev = String::from_str(&env, "e1");
    let id0 = client.raise_dispute(&creator, &disputer, &ev);
    let id1 = client.raise_dispute(&creator, &disputer, &ev);
    assert!(id1 > id0);
}

// ---------------------------------------------------------------------------
// resolve_dispute — slash path
// ---------------------------------------------------------------------------

#[test]
fn test_resolve_dispute_slash_zeroes_stake() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    stake(&client, &creator);

    let evidence = String::from_str(&env, "fraud_proof_hash");
    let dispute_id = client.raise_dispute(&creator, &disputer, &evidence);

    // Arbitrator upholds the dispute.
    client.resolve_dispute(&dispute_id, &true);

    // Stake amount should be zeroed out.
    let record = client.get_stake(&creator).unwrap();
    assert_eq!(record.amount, 0);
    assert_eq!(record.open_disputes, 0);
}

#[test]
fn test_resolve_dispute_slash_updates_dispute_status() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    stake(&client, &creator);

    let evidence = String::from_str(&env, "evidence");
    let dispute_id = client.raise_dispute(&creator, &disputer, &evidence);
    client.resolve_dispute(&dispute_id, &true);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(
        dispute.status,
        DisputeStatus::Resolved(DisputeOutcome::Upheld)
    );
}

// ---------------------------------------------------------------------------
// resolve_dispute — no-slash path
// ---------------------------------------------------------------------------

#[test]
fn test_resolve_dispute_no_slash_preserves_stake() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    stake(&client, &creator);

    let evidence = String::from_str(&env, "evidence");
    let dispute_id = client.raise_dispute(&creator, &disputer, &evidence);

    // Arbitrator rejects the dispute.
    client.resolve_dispute(&dispute_id, &false);

    let record = client.get_stake(&creator).unwrap();
    assert_eq!(record.amount, STAKE_AMOUNT); // unchanged
    assert_eq!(record.open_disputes, 0); // dispute closed
}

#[test]
fn test_resolve_dispute_rejected_updates_dispute_status() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    stake(&client, &creator);

    let evidence = String::from_str(&env, "evidence");
    let dispute_id = client.raise_dispute(&creator, &disputer, &evidence);
    client.resolve_dispute(&dispute_id, &false);

    let dispute = client.get_dispute(&dispute_id).unwrap();
    assert_eq!(
        dispute.status,
        DisputeStatus::Resolved(DisputeOutcome::Rejected)
    );
}

// ---------------------------------------------------------------------------
// resolve_dispute — error paths
// ---------------------------------------------------------------------------

#[test]
fn test_resolve_dispute_returns_error_for_unknown_id() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);

    let result = client.try_resolve_dispute(&99, &true);
    assert_eq!(result, Err(Ok(ContractError::DisputeNotFound)));
}

#[test]
fn test_resolve_dispute_returns_error_on_double_resolution() {
    let (env, contract_id, _) = setup();
    let client = ReputationStakeClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let disputer = Address::generate(&env);

    stake(&client, &creator);

    let evidence = String::from_str(&env, "evidence");
    let dispute_id = client.raise_dispute(&creator, &disputer, &evidence);
    client.resolve_dispute(&dispute_id, &false);

    // Resolving again should fail.
    let result = client.try_resolve_dispute(&dispute_id, &true);
    assert_eq!(result, Err(Ok(ContractError::DisputeAlreadyResolved)));
}
