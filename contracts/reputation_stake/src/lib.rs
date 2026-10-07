//! ReputationStake — collateral and lightweight dispute contract for ProofFeed.
//!
//! ## Overview
//!
//! Creators can lock collateral (a "stake") as a trust signal visible to brands.
//! A brand can open a dispute against a creator's stake by submitting an evidence
//! reference.  A designated arbitrator resolves the dispute:
//!   - A successful resolution slashes the creator's stake (funds are burned /
//!     sent to a configurable destination — currently zeroed out as a placeholder
//!     until the stablecoin contract integration is finalised).
//!   - An unsuccessful resolution leaves the stake intact.
//!
//! After the configurable `cooldown_ledgers` have elapsed with no active or
//! resolved-in-creator's-favour disputes, the creator may withdraw their stake.
//!
//! ## Design decisions
//!
//! See `DESIGN.md` for a detailed explanation of the arbitration model and
//! explicit out-of-scope items.
//!
//! ## TODOs for future contributors
//!
//! TODO(payment): `stake` and `slash` currently manipulate an in-contract
//!   counter instead of transferring stablecoin tokens.  A production
//!   implementation must call the stablecoin contract's `transfer` to move
//!   funds from the staker/to the slash destination.
//!
//! TODO(multi-arbitrator): The arbitrator is a single address set at
//!   initialisation.  Upgrading to a multi-sig or DAO governance model is
//!   explicitly out of scope for MVP.
//!
//! TODO(appeals): There is no appeal mechanism.  A resolved dispute is final.

#![no_std]

use soroban_sdk::{
    contract, contractevent, contractimpl, contracterror, contracttype,
    Address, Env, String,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default cooldown in ledgers before a stake can be withdrawn.
/// ~7 days at ~5 seconds per ledger ≈ 120_960 ledgers.
pub const DEFAULT_COOLDOWN_LEDGERS: u32 = 120_960;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// All error conditions that the ReputationStake contract can return.
#[contracterror]
#[derive(Clone, Debug, PartialEq)]
pub enum ContractError {
    /// The contract has already been initialised; calling `initialize` again
    /// is not allowed.
    AlreadyInitialized = 1,

    /// The contract has not been initialised yet.
    NotInitialized = 2,

    /// The creator does not have an active stake.
    NoStake = 3,

    /// The creator already has a stake; they must withdraw before staking again.
    AlreadyStaked = 4,

    /// Withdrawal attempted before the cooldown period has elapsed.
    CooldownNotElapsed = 5,

    /// Withdrawal blocked because there is at least one open dispute against
    /// this creator.
    DisputeActive = 6,

    /// The dispute ID provided does not exist.
    DisputeNotFound = 7,

    /// The caller is not the designated arbitrator.
    NotArbitrator = 8,

    /// The dispute has already been resolved; calling `resolve_dispute` again
    /// is not allowed.
    DisputeAlreadyResolved = 9,

    /// The stake amount must be greater than zero.
    ZeroStake = 10,
}

// ---------------------------------------------------------------------------
// Storage key tags
// ---------------------------------------------------------------------------

/// Top-level storage key discriminants.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Contract-level configuration, stored once at initialisation.
    Config,
    /// Per-creator staking record.  Key: creator Address.
    Stake(Address),
    /// Per-dispute record.  Key: dispute_id u32.
    Dispute(u32),
    /// Monotonically increasing counter used to assign dispute IDs.
    DisputeCounter,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Emitted when a creator stakes collateral.
#[contractevent]
pub struct StakeDeposited {
    pub creator: Address,
    /// Amount staked, in stablecoin base units.
    pub amount: i128,
    pub ledger: u32,
}

/// Emitted when a creator successfully withdraws their stake.
#[contractevent]
pub struct StakeWithdrawn {
    pub creator: Address,
    pub amount: i128,
    pub ledger: u32,
}

/// Emitted when a dispute is opened against a creator.
#[contractevent]
pub struct DisputeOpened {
    pub dispute_id: u32,
    pub creator: Address,
    pub disputer: Address,
    /// Short reference to off-chain evidence (hash, URL, IPFS CID, etc.).
    pub evidence_ref: String,
    pub ledger: u32,
}

/// Emitted when a dispute is resolved by the arbitrator.
#[contractevent]
pub struct DisputeResolved {
    pub dispute_id: u32,
    pub creator: Address,
    /// `true` = dispute upheld, creator's stake slashed.
    /// `false` = dispute rejected, stake preserved.
    pub slashed: bool,
    pub ledger: u32,
}

/// Emitted when a creator's stake is slashed after a successful dispute.
#[contractevent]
pub struct StakeSlashed {
    pub creator: Address,
    pub amount: i128,
    pub ledger: u32,
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/// Outcome of a resolved dispute.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum DisputeOutcome {
    /// Dispute upheld — stake was slashed.
    Upheld,
    /// Dispute rejected — stake was preserved.
    Rejected,
}

/// Status of a dispute.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum DisputeStatus {
    /// Dispute is open and awaiting arbitration.
    Open,
    /// Dispute has been resolved with the given outcome.
    Resolved(DisputeOutcome),
}

/// A dispute record stored on-chain.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Dispute {
    pub id: u32,
    pub creator: Address,
    pub disputer: Address,
    /// Short reference to off-chain evidence (hash, URL, IPFS CID, etc.).
    pub evidence_ref: String,
    /// Ledger sequence number when the dispute was opened.
    pub opened_at: u32,
    pub status: DisputeStatus,
}

/// Per-creator staking record.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct StakeRecord {
    /// Staked amount in stablecoin base units.
    pub amount: i128,
    /// Ledger sequence number when the most recent stake deposit was recorded.
    /// Used to enforce the withdrawal cooldown.
    pub staked_at: u32,
    /// Number of currently open disputes against this creator.
    /// Withdrawal is blocked while this is non-zero.
    pub open_disputes: u32,
}

/// Contract-level configuration, set once at initialisation.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// The single address authorised to resolve disputes (the arbitrator).
    pub arbitrator: Address,
    /// Minimum number of ledgers that must pass after staking before a
    /// creator can withdraw, provided there are no open disputes.
    pub cooldown_ledgers: u32,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ReputationStake;

#[contractimpl]
impl ReputationStake {
    // -----------------------------------------------------------------------
    // initialize
    // -----------------------------------------------------------------------

    /// Initialise the contract with the designated arbitrator address and the
    /// withdrawal cooldown period.
    ///
    /// Must be called exactly once.  Subsequent calls return
    /// [`ContractError::AlreadyInitialized`].
    ///
    /// # Errors
    ///
    /// - [`ContractError::AlreadyInitialized`] — contract is already set up.
    pub fn initialize(
        env: Env,
        arbitrator: Address,
        cooldown_ledgers: u32,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(ContractError::AlreadyInitialized);
        }
        let config = Config {
            arbitrator,
            cooldown_ledgers,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // stake
    // -----------------------------------------------------------------------

    /// Lock `amount` units of collateral for `creator`.
    ///
    /// The `creator` address must authorise this call.  The creator must not
    /// already have an active stake (call `withdraw` first to re-stake).
    ///
    /// Emits [`StakeDeposited`].
    ///
    /// # Errors
    ///
    /// - [`ContractError::NotInitialized`] — contract not yet set up.
    /// - [`ContractError::ZeroStake`] — amount must be greater than zero.
    /// - [`ContractError::AlreadyStaked`] — creator already has an active stake.
    ///
    /// # TODOs
    ///
    /// TODO(payment): transfer `amount` of stablecoin from `creator` into the
    ///   contract's escrow account.
    pub fn stake(
        env: Env,
        creator: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        Self::require_initialized(&env)?;
        creator.require_auth();

        if amount <= 0 {
            return Err(ContractError::ZeroStake);
        }

        if env
            .storage()
            .persistent()
            .has(&DataKey::Stake(creator.clone()))
        {
            return Err(ContractError::AlreadyStaked);
        }

        let record = StakeRecord {
            amount,
            staked_at: env.ledger().sequence(),
            open_disputes: 0,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Stake(creator.clone()), &record);

        env.events().publish_event(&StakeDeposited {
            creator,
            amount,
            ledger: env.ledger().sequence(),
        });

        Ok(())
    }

    // -----------------------------------------------------------------------
    // withdraw
    // -----------------------------------------------------------------------

    /// Withdraw the creator's stake.
    ///
    /// Withdrawal is only permitted when:
    ///   1. The creator has an active stake.
    ///   2. At least `cooldown_ledgers` have elapsed since the stake was
    ///      deposited.
    ///   3. There are no currently open disputes against this creator.
    ///
    /// The `creator` address must authorise this call.
    ///
    /// Emits [`StakeWithdrawn`].
    ///
    /// # Errors
    ///
    /// - [`ContractError::NotInitialized`] — contract not yet set up.
    /// - [`ContractError::NoStake`] — creator has no stake to withdraw.
    /// - [`ContractError::CooldownNotElapsed`] — cooldown period has not passed.
    /// - [`ContractError::DisputeActive`] — there is at least one open dispute.
    ///
    /// # TODOs
    ///
    /// TODO(payment): transfer the staked amount from the contract's escrow
    ///   back to `creator`.
    pub fn withdraw(
        env: Env,
        creator: Address,
    ) -> Result<(), ContractError> {
        Self::require_initialized(&env)?;
        creator.require_auth();

        let config = Self::load_config(&env);
        let record: StakeRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Stake(creator.clone()))
            .ok_or(ContractError::NoStake)?;

        // Guard: cooldown must have elapsed.
        let current = env.ledger().sequence();
        if current < record.staked_at.saturating_add(config.cooldown_ledgers) {
            return Err(ContractError::CooldownNotElapsed);
        }

        // Guard: no open disputes.
        if record.open_disputes > 0 {
            return Err(ContractError::DisputeActive);
        }

        let amount = record.amount;

        // Remove the stake record.
        env.storage()
            .persistent()
            .remove(&DataKey::Stake(creator.clone()));

        env.events().publish_event(&StakeWithdrawn {
            creator,
            amount,
            ledger: current,
        });

        Ok(())
    }

    // -----------------------------------------------------------------------
    // raise_dispute
    // -----------------------------------------------------------------------

    /// Open a dispute against a creator's stake.
    ///
    /// Anyone (the `disputer`) may raise a dispute by providing an
    /// `evidence_ref` — a short string referencing off-chain evidence (e.g. an
    /// IPFS CID, a URL, or a content hash).  Full evidence storage is
    /// intentionally out of scope for MVP.
    ///
    /// The `disputer` address must authorise this call.
    ///
    /// Returns the newly assigned `dispute_id`.
    ///
    /// Emits [`DisputeOpened`].
    ///
    /// # Errors
    ///
    /// - [`ContractError::NotInitialized`] — contract not yet set up.
    /// - [`ContractError::NoStake`] — there is no stake to dispute against.
    pub fn raise_dispute(
        env: Env,
        creator: Address,
        disputer: Address,
        evidence_ref: String,
    ) -> Result<u32, ContractError> {
        Self::require_initialized(&env)?;
        disputer.require_auth();

        // Guard: creator must have an active stake.
        let mut record: StakeRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Stake(creator.clone()))
            .ok_or(ContractError::NoStake)?;

        // Assign a new dispute ID.
        let dispute_id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::DisputeCounter)
            .unwrap_or(0u32);
        let next_id = dispute_id.saturating_add(1);
        env.storage()
            .instance()
            .set(&DataKey::DisputeCounter, &next_id);

        let current = env.ledger().sequence();

        let dispute = Dispute {
            id: dispute_id,
            creator: creator.clone(),
            disputer: disputer.clone(),
            evidence_ref: evidence_ref.clone(),
            opened_at: current,
            status: DisputeStatus::Open,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Dispute(dispute_id), &dispute);

        // Increment open dispute count on the stake record.
        record.open_disputes = record.open_disputes.saturating_add(1);
        env.storage()
            .persistent()
            .set(&DataKey::Stake(creator.clone()), &record);

        env.events().publish_event(&DisputeOpened {
            dispute_id,
            creator,
            disputer,
            evidence_ref,
            ledger: current,
        });

        Ok(dispute_id)
    }

    // -----------------------------------------------------------------------
    // resolve_dispute
    // -----------------------------------------------------------------------

    /// Resolve a dispute.
    ///
    /// Only the designated arbitrator may call this function.  `slash = true`
    /// upholds the dispute and slashes the creator's stake; `slash = false`
    /// rejects the dispute and leaves the stake intact.
    ///
    /// The arbitrator address must authorise this call.
    ///
    /// Emits [`DisputeResolved`] and, if the stake is slashed, [`StakeSlashed`].
    ///
    /// # Errors
    ///
    /// - [`ContractError::NotInitialized`] — contract not yet set up.
    /// - [`ContractError::NotArbitrator`] — caller is not the arbitrator.
    /// - [`ContractError::DisputeNotFound`] — the dispute ID is unknown.
    /// - [`ContractError::DisputeAlreadyResolved`] — dispute already closed.
    ///
    /// # TODOs
    ///
    /// TODO(payment): when slashing, transfer the staked amount to a designated
    ///   slash destination address rather than zeroing it out.
    pub fn resolve_dispute(
        env: Env,
        dispute_id: u32,
        slash: bool,
    ) -> Result<(), ContractError> {
        Self::require_initialized(&env)?;

        let config = Self::load_config(&env);
        // Access control: only the arbitrator may resolve.
        config.arbitrator.require_auth();

        let mut dispute: Dispute = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
            .ok_or(ContractError::DisputeNotFound)?;

        // Guard: must be open.
        if dispute.status != DisputeStatus::Open {
            return Err(ContractError::DisputeAlreadyResolved);
        }

        let current = env.ledger().sequence();

        // Update dispute status.
        dispute.status = if slash {
            DisputeStatus::Resolved(DisputeOutcome::Upheld)
        } else {
            DisputeStatus::Resolved(DisputeOutcome::Rejected)
        };
        env.storage()
            .persistent()
            .set(&DataKey::Dispute(dispute_id), &dispute);

        // Decrement open dispute count on the stake record (if it still exists).
        if let Some(mut record) = env
            .storage()
            .persistent()
            .get::<DataKey, StakeRecord>(&DataKey::Stake(dispute.creator.clone()))
        {
            record.open_disputes = record.open_disputes.saturating_sub(1);

            if slash {
                // Slash: zero out the stake amount.
                // TODO(payment): send record.amount to a slash destination instead.
                let slashed_amount = record.amount;
                record.amount = 0;
                env.storage()
                    .persistent()
                    .set(&DataKey::Stake(dispute.creator.clone()), &record);

                env.events().publish_event(&StakeSlashed {
                    creator: dispute.creator.clone(),
                    amount: slashed_amount,
                    ledger: current,
                });
            } else {
                env.storage()
                    .persistent()
                    .set(&DataKey::Stake(dispute.creator.clone()), &record);
            }
        }

        env.events().publish_event(&DisputeResolved {
            dispute_id,
            creator: dispute.creator,
            slashed: slash,
            ledger: current,
        });

        Ok(())
    }

    // -----------------------------------------------------------------------
    // get_stake
    // -----------------------------------------------------------------------

    /// Return the staking record for a creator, or `None` if they have no
    /// active stake.
    pub fn get_stake(env: Env, creator: Address) -> Option<StakeRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Stake(creator))
    }

    // -----------------------------------------------------------------------
    // get_dispute
    // -----------------------------------------------------------------------

    /// Return the dispute record for a given `dispute_id`, or `None` if the
    /// ID is unknown.
    pub fn get_dispute(env: Env, dispute_id: u32) -> Option<Dispute> {
        env.storage()
            .persistent()
            .get(&DataKey::Dispute(dispute_id))
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn require_initialized(env: &Env) -> Result<(), ContractError> {
        if !env.storage().instance().has(&DataKey::Config) {
            return Err(ContractError::NotInitialized);
        }
        Ok(())
    }

    fn load_config(env: &Env) -> Config {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .expect("contract not initialized")
    }
}

mod tests;
