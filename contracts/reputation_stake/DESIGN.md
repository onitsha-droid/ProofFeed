# ReputationStake — Design Notes

## Purpose

`ReputationStake` lets creators lock on-chain collateral as a trust signal for brands.
Because the stake is visible on-chain, a brand can immediately see whether a creator
has skin-in-the-game before engaging in a sponsorship deal.

The contract also defines a lightweight dispute mechanism: if a brand believes a creator
has committed fraud, they can open a dispute and submit an evidence reference.  A single
designated arbitrator resolves the dispute.  A successful (upheld) dispute slashes the
stake; an unsuccessful (rejected) dispute leaves it intact and returns withdrawal rights.

This design directly implements the README.md "Anti-Fraud & Sybil Resistance" principle:
> "Reputation staking: creators can opt to stake collateral, slashable through a dispute
> process if a brand proves fraud — this filters out bad actors before most brands need
> to investigate manually."

---

## Arbitration Model

### Single arbitrator (MVP)

For MVP, a **single arbitrator address** is configured at contract initialisation and
stored immutably in contract storage.  Every call to `resolve_dispute` requires this
address to authorise the transaction via `require_auth()`.

**Why a single arbitrator for MVP?**

The README.md describes the dispute flow explicitly as "lightweight" and categorises the
full DAO-court model as a future research item, not an MVP requirement.  A single trusted
arbitrator — e.g. a ProofFeed core team multi-sig — is the simplest mechanism that
satisfies the stated trust model: it removes the need for on-chain voting, token-weighted
quorums, and appeal queues, all of which add significant complexity before the protocol
has found product-market fit.

The arbitrator address can be a Soroban multi-sig wallet for additional safety without
touching the contract code.

### Dispute lifecycle

```
(any address)                 (arbitrator)
     │                             │
     │  raise_dispute(creator,     │
     │    disputer, evidence_ref)  │
     │ ──────────────────────────▶ │
     │                             │
     │   dispute.status = Open     │
     │   stake.open_disputes += 1  │
     │                             │
     │           resolve_dispute(  │
     │             dispute_id,     │
     │             slash=true|false│
     │           ) ◀─────────────── │
     │                             │
     │   if slash:                 │
     │     stake.amount = 0        │
     │     StakeSlashed emitted    │
     │   stake.open_disputes -= 1  │
     │   dispute.status = Resolved │
```

### Cooldown

A creator cannot withdraw their stake until at least `cooldown_ledgers` have elapsed
since they staked, **and** there are no open disputes.  The cooldown is configurable at
`initialize` time.  The default value (`DEFAULT_COOLDOWN_LEDGERS = 120_960`) corresponds
to approximately seven days at five seconds per ledger.

A rejected dispute closes (decrements `open_disputes`), so a brand cannot permanently
freeze a creator's stake with bad-faith disputes.

---

## Storage Layout

| Key | Type | Description |
|---|---|---|
| `DataKey::Config` | `Config` (instance) | Arbitrator address + cooldown |
| `DataKey::Stake(creator)` | `StakeRecord` (persistent) | Per-creator staking record |
| `DataKey::Dispute(id)` | `Dispute` (persistent) | Per-dispute record |
| `DataKey::DisputeCounter` | `u32` (instance) | Monotonic dispute ID counter |

---

## Events

| Event | When emitted |
|---|---|
| `StakeDeposited` | On successful `stake` |
| `StakeWithdrawn` | On successful `withdraw` |
| `DisputeOpened` | On successful `raise_dispute` |
| `DisputeResolved` | On successful `resolve_dispute` (either outcome) |
| `StakeSlashed` | On `resolve_dispute` with `slash = true` |

All events include a `ledger` field (the sequence number at emission) so the off-chain
indexer can reconstruct a timeline without parsing block timestamps.

---

## Out of scope for MVP

The following are explicitly **not** implemented and should not be assumed to exist by
contributors reading this code:

| Feature | Reason deferred |
|---|---|
| **Multi-arbitrator juries** | Requires on-chain voting or multi-sig quorum logic; too complex for MVP |
| **Appeals** | A resolved dispute is final.  Implementing an appeal changes the state machine significantly. |
| **Decentralised evidence storage** | `evidence_ref` is a short opaque string (e.g. IPFS CID, URL, hash).  Full evidence content is stored off-chain by the disputer; the contract only records a pointer. |
| **Stablecoin token transfer** | `stake` and `slash` currently update an in-contract counter.  A TODO marks where the `transfer` call to a stablecoin contract must be inserted when the token integration is finalised. |
| **Staking by delegates** | Only the creator address can stake on their own behalf (`creator.require_auth()`). |
| **Variable slash amounts** | A slash currently zeroes the full stake.  Partial slashes (e.g. slash 50 %) are not supported. |
| **Dispute expiry** | An open dispute never expires.  A creator whose stake is disputed is blocked from withdrawing indefinitely until the arbitrator acts.  A timeout mechanism is a reasonable future addition. |
| **Multiple concurrent stakes** | A creator can hold only one stake at a time.  They must withdraw before re-staking. |

---

## Relationship to SubscriptionRegistry

`ReputationStake` uses `Address` values that are the same identifiers registered in
`SubscriptionRegistry` — there is no on-chain link between the two contracts at the
code level.  The off-chain indexer correlates a creator's stake status with their
subscription history to produce the brand-facing trust score.

`SponsorshipEscrow` (future) may query this contract to block payouts if the creator's
stake has been slashed.
