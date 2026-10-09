# ProofFeed Architecture

This document describes the **as-built** system as of the integration day
handoff. It maps directly to the code in this repository. Where the
implementation diverges from the architecture diagram in README.md, the
deviation and its reason are called out explicitly.

---

## Table of Contents

- [High-Level Diagram (as built)](#high-level-diagram-as-built)
- [Component Inventory](#component-inventory)
- [Data Flow](#data-flow)
- [Layer Details](#layer-details)
  - [Smart Contracts (Soroban / Rust)](#smart-contracts-soroban--rust)
  - [Indexer (Node.js / TypeScript)](#indexer-nodejs--typescript)
  - [Creator Dashboard (React / TypeScript)](#creator-dashboard-react--typescript)
  - [Brand Dashboard (React / TypeScript)](#brand-dashboard-react--typescript)
  - [Shared Package](#shared-package)
- [Database Schema Summary](#database-schema-summary)
- [API Endpoints](#api-endpoints)
- [Deviations from README Diagram](#deviations-from-readme-diagram)
- [Known Gaps (Not Yet Built)](#known-gaps-not-yet-built)

---

## High-Level Diagram (as built)

```
┌──────────────────────┐       ┌───────────────────────────────┐
│   Creator Dashboard   │       │       Soroban Contracts        │
│  (React, :5173)       │──────▶│  SubscriptionRegistry          │
│                       │       │  ReputationStake               │
│  • ConnectWallet      │       │                                │
│  • OnboardingPage     │       │  (sponsorship_escrow: stub)    │
│  • StatsPage          │◀ ─ ─ ─└──────────────┬────────────────┘
│  • BadgeRedirect      │   (via indexer API)   │ events
└──────────────────────┘                        │
                                                ▼
┌──────────────────────────────────────────────────────────────┐
│  Indexer  (Node.js, :3001)                                    │
│                                                               │
│  listener.ts   ──polls──▶  Soroban RPC getEvents()           │
│  parser.ts     ──decodes──▶ typed ProofFeed events           │
│  processor.ts  ──persists──▶ PostgreSQL (raw_events,         │
│                              payment_events, ...)             │
│  metrics.ts    ──computes──▶ creator_metrics, cohort_retention│
│  api.ts        ──serves───▶ REST GET /api/creators/:addr/...  │
└──────────────────────────────────────────────────────────────┘
                         ▲                    │
                         │ (polls RPC)        │ (REST)
                         │                   ▼
                  Stellar Network    ┌────────────────────┐
                  (testnet)          │   Brand Dashboard   │
                                     │  (React, :5174)     │
                                     │                     │
                                     │  • LookupPage       │
                                     │  • ReportPage       │
                                     │  • BadgePage        │
                                     └────────────────────┘
```

---

## Component Inventory

| Component | Path | Language | Status |
|---|---|---|---|
| SubscriptionRegistry contract | `contracts/subscription_registry/` | Rust / Soroban | ✅ Built & tested |
| ReputationStake contract | `contracts/reputation_stake/` | Rust / Soroban | ✅ Built & tested |
| SponsorshipEscrow contract | `contracts/sponsorship_escrow/` | — | 🚧 Stub only |
| Indexer event listener | `indexer/src/listener.ts` | TypeScript | ✅ Built |
| Indexer event parser | `indexer/src/parser.ts` | TypeScript | ✅ Built |
| Indexer event processor | `indexer/src/processor.ts` | TypeScript | ✅ Built |
| Indexer metrics engine | `indexer/src/metrics.ts` | TypeScript | ✅ Built |
| Indexer REST API | `indexer/src/api.ts` | TypeScript | ✅ Built |
| PostgreSQL schema | `indexer/src/db/schema.sql` | SQL | ✅ Built |
| Creator dashboard | `apps/creator-dashboard/` | React / TypeScript | ✅ Built |
| Brand dashboard | `apps/brand-dashboard/` | React / TypeScript | ✅ Built |
| Shared types package | `packages/shared/` | TypeScript | ✅ Built |
| Testnet deploy script | `scripts/deploy_testnet.sh` | Bash | ✅ Built |
| E2E demo script | `scripts/e2e_demo.ts` | TypeScript | ✅ Built |

---

## Data Flow

### Creator registration

1. Creator connects a Stellar wallet (Freighter) in the creator dashboard.
2. `OnboardingPage.tsx` calls `registerCreator()` in `lib/contract.ts`.
3. `contract.ts` builds a Soroban transaction, simulates it via
   `SorobanRpc.Server.simulateTransaction()`, signs it with the wallet kit,
   and submits via `server.sendTransaction()`.
4. The `SubscriptionRegistry` contract stores the creator's tier list and
   emits a `CreatorRegistered` event on-chain.
5. The indexer's polling loop picks up the event, calls `processEvent()`, and
   upserts a row into `creator_registrations`.

### Fan subscribes / renews

The same transaction flow applies for `subscribe()` and `renew()`:

1. Fan submits a transaction (subscribe or renew) to the `SubscriptionRegistry`
   contract. *(The fan-side transaction building is not yet in the creator
   dashboard UI — see Deviations below.)*
2. The contract emits a `PaymentRecorded` event (`is_renewal: false` or `true`).
3. Indexer picks up the event, inserts into `payment_events`, then calls:
   - `computeCreatorMetrics()` — upserts `creator_metrics`
   - `computeCohortRetention()` — upserts `cohort_retention`

### Brand looks up a creator

1. Brand opens the brand dashboard and enters a creator's Stellar address.
2. `LookupPage.tsx` validates the address format (`/^G[A-Z2-7]{55}$/`) and
   navigates to `/report/:address`.
3. `ReportPage.tsx` calls `useCreatorReport()` which fires two parallel
   `fetch` requests:
   - `GET /api/creators/:address/metrics` → `creator_metrics` row
   - `GET /api/creators/:address/retention` → `cohort_retention` rows
4. The report renders metric cards, the entropy bar, the retention table, and
   a copy-able badge URL.

### Verification badge

1. Creator copies their badge URL from `StatsPage.tsx` (creator dashboard) or
   `ReportPage.tsx` (brand dashboard). Format:
   `http://<brand-dashboard>/badge/<creator-address>`
2. Whoever clicks the link lands on `BadgePage.tsx` in the brand dashboard.
3. `BadgePage.tsx` calls `useCreatorReport()` on every mount — no caching,
   no `localStorage`. The displayed subscriber count and entropy score always
   reflect the latest indexed data.
4. If the creator dashboard badge link is shared instead
   (`/badge/:address` on creator dashboard), `BadgeRedirect.tsx` immediately
   redirects to the brand dashboard badge page using `VITE_BRAND_DASHBOARD_URL`.

---

## Layer Details

### Smart Contracts (Soroban / Rust)

**`SubscriptionRegistry`** (`contracts/subscription_registry/src/lib.rs`)

Public interface implemented:

```rust
fn register_creator(env, creator: Address, tiers: Vec<Tier>)
fn subscribe(env, subscriber: Address, creator: Address, tier_id: u32) -> Result<(), ContractError>
fn renew(env, subscriber: Address, creator: Address) -> Result<(), ContractError>
fn cancel(env, subscriber: Address, creator: Address)
fn get_creator_stats(env, creator: Address) -> CreatorStats
fn get_subscriber_history(env, subscriber: Address, creator: Address) -> Vec<PaymentEvent>
```

On-chain state stored in `persistent` storage:
- `CreatorStats` per creator (active subscribers, lifetime revenue, churn events)
- `Vec<Tier>` per creator
- `Vec<PaymentEvent>` per (subscriber, creator) pair
- `bool` active-subscription flag per (subscriber, creator)

Events emitted: `CreatorRegistered`, `PaymentRecorded`, `SubscriptionCancelled`.

**Important**: Token transfers (`subscribe`/`renew` do not yet move stablecoin
tokens). This is marked `TODO(payment)` throughout the contract. The contract
tracks counts and emits events correctly, but no real USDC moves until the
stablecoin integration is implemented.

**`ReputationStake`** (`contracts/reputation_stake/src/lib.rs`)

Public interface implemented:

```rust
fn initialize(env, arbitrator: Address, cooldown_ledgers: u32) -> Result<(), ContractError>
fn stake(env, creator: Address, amount: i128) -> Result<(), ContractError>
fn withdraw(env, creator: Address) -> Result<(), ContractError>
fn raise_dispute(env, creator: Address, disputer: Address, evidence_ref: String) -> Result<u32, ContractError>
fn resolve_dispute(env, dispute_id: u32, slash: bool) -> Result<(), ContractError>
fn get_stake(env, creator: Address) -> Option<StakeRecord>
fn get_dispute(env, dispute_id: u32) -> Option<Dispute>
```

Events emitted: `StakeDeposited`, `StakeWithdrawn`, `DisputeOpened`,
`DisputeResolved`, `StakeSlashed`.

Also marked `TODO(payment)` — stake/slash manipulate in-contract counters
without actual token transfers.

---

### Indexer (Node.js / TypeScript)

**`listener.ts`** — polls `SorobanRpc.Server.getEvents()` on an interval
(default 5 s). Persists `last_processed_ledger` in the `indexer_state` table
so restarts resume from the correct position. Uses exponential backoff (1 s →
60 s) on RPC errors.

**`parser.ts`** — converts raw `xdr.ScVal` event payloads from the Soroban
SDK into typed `SorobanEvent` objects. Skips unknown event types gracefully.
Contains `TODO(prod)` comments marking where generated contract bindings
should replace manual XDR decoding.

**`processor.ts`** — routes typed events to the correct database tables inside
a single `BEGIN`/`COMMIT` transaction. Triggers metric recomputation
afterwards (outside the transaction).

**`metrics.ts`** — implements:
- `computeEntropyScore(payments)` — pure function, testable without a DB.
  Computes coefficient of variation of inter-payment intervals and amounts,
  normalised via `tanh`. Returns `0.5` (neutral) when fewer than 2 payments.
- `computeCreatorMetrics(pool, creatorAddress)` — upserts `creator_metrics`.
- `computeCohortRetention(pool, creatorAddress)` — upserts `cohort_retention`.

**`api.ts`** — Express server exposing:
- `GET /health`
- `GET /api/creators/:address/metrics`
- `GET /api/creators/:address/retention`

The API is intentionally read-only and stateless. CORS is open (`*`) in
development; tighten via `CORS_ORIGIN` env var in production.

---

### Creator Dashboard (React / TypeScript)

**Routes:**
- `/` → `ConnectWallet` (if no wallet) or redirect to `/onboarding` / `/stats`
- `/onboarding` → `OnboardingPage` — tier setup + `register_creator` tx
- `/stats` → `StatsPage` — live metrics via `useCreatorMetrics` hook
- `/badge/:address` → `BadgeRedirect` — redirects to brand dashboard badge URL

**`useCreatorMetrics`** (`src/hooks/useCreatorMetrics.ts`) — fetches both
`/metrics` and `/retention` endpoints in parallel. Re-fetches on every mount
and exposes a `refetch()` method for manual refresh after a transaction lands.

**`lib/contract.ts`** — implements `registerCreator()` using the Stellar
Wallets Kit for signing. Only `register_creator` is wired up; `subscribe()`
is a `TODO` comment.

---

### Brand Dashboard (React / TypeScript)

**Routes:**
- `/` → `LookupPage` — Stellar address input with regex validation
- `/report/:address` → `ReportPage` — full proof-of-audience report
- `/badge/:address` → `BadgePage` — compact always-live badge

**`useCreatorReport`** (`src/hooks/useCreatorReport.ts`) — same shape as
`useCreatorMetrics` but without a `refetch()` method (badges are always
fresh on mount). Deliberately no caching.

The brand dashboard has **no wallet dependency** — it is purely a read-only
consumer of the indexer REST API.

---

### Shared Package

`packages/shared/src/index.ts` exports TypeScript interfaces only:

- `CreatorMetrics` — matches the `/metrics` API response
- `RetentionPoint` — matches each element of the `/retention` API response
- `Tier` — subscription tier definition (used by creator dashboard)
- `PaymentEvent` — on-chain payment event shape (used by indexer types)

`lifetimeRevenueStroops` is typed as `string` (not `number`) throughout to
prevent silent precision loss for high-revenue creators whose total exceeds
`Number.MAX_SAFE_INTEGER`.

`entropyScore` is typed as `number | null` because the indexer returns `null`
when fewer than 2 payments have been recorded.

---

## Database Schema Summary

All tables live in the PostgreSQL database pointed to by `DATABASE_URL`. The
full DDL is in `indexer/src/db/schema.sql`.

| Table | Purpose | Primary Key |
|---|---|---|
| `raw_events` | Audit log — every Soroban event, never deleted | `id` (serial) |
| `creator_registrations` | One row per registered creator | `creator_address` |
| `payment_events` | One row per PaymentRecorded event | `id` (serial) |
| `subscription_cancellations` | One row per SubscriptionCancelled event | `id` (serial) |
| `creator_metrics` | Derived aggregates — rebuilt on every new event | `creator_address` |
| `cohort_retention` | Derived retention curves | `(creator_address, cohort_month, months_since_join)` |
| `indexer_state` | Key-value bookkeeping (last processed ledger) | `key` |

---

## API Endpoints

All endpoints are served by the indexer on `API_PORT` (default 3001).

### `GET /health`

Returns `{ "ok": true }`. Used by load balancers and uptime checks.

### `GET /api/creators/:address/metrics`

Returns aggregated metrics for a creator. If no data exists yet, returns
zeroed defaults (not a 404) so dashboards can render an empty state.

```json
{
  "activeSubscribers": 142,
  "lifetimeRevenueStroops": "14200000000",
  "churnEvents": 8,
  "entropyScore": 0.743
}
```

`entropyScore` is `null` when fewer than 2 payments have been indexed.
`lifetimeRevenueStroops` is always a JSON string (never a number) to avoid
JavaScript precision loss for large values.

### `GET /api/creators/:address/retention`

Returns an array of cohort retention data points, ordered by
`cohort_month ASC, months_since_join ASC`.

```json
[
  { "cohortMonth": "2024-03", "monthsSinceJoin": 0, "retentionRate": 1.0,  "cohortSize": 42 },
  { "cohortMonth": "2024-03", "monthsSinceJoin": 1, "retentionRate": 0.71, "cohortSize": 42 }
]
```

---

## Deviations from README Diagram

The README "Architecture" section shows this simplified diagram:

```
Creator App  ──▶  Soroban Contracts  ◀──  Brand Dashboard
                        │
                  Stellar Network
```

The as-built system deviates in the following ways:

### 1. Off-chain indexer is a first-class component

**README diagram:** The off-chain indexer is mentioned in the prose below the
diagram ("Off-chain services (indexer, analytics engine, dashboards) read
contract events…") but does not appear as a box in the diagram.

**As built:** The indexer is a critical intermediary — neither dashboard reads
from the Soroban RPC directly. All metric queries go through the indexer's
REST API which reads from PostgreSQL. The brand dashboard has **zero** on-chain
calls; the creator dashboard only calls the chain for write operations
(register, subscribe).

**Why:** Querying retention curves and entropy scores directly from on-chain
state on every page load would be slow, expensive (RPC rate limits), and
require complex aggregation logic on the client. The indexer pattern is
established Soroban MVP practice.

### 2. Brand dashboard does not read contracts directly

**README diagram:** The brand dashboard has a bidirectional arrow to the
contracts (`◀──`).

**As built:** The brand dashboard (`apps/brand-dashboard/`) has no Stellar SDK
dependency at all. It is a read-only React app that fetches pre-computed
metrics from the indexer's REST API. It does not connect to a wallet, build
transactions, or call any Soroban RPC.

**Why:** Brands are not Stellar users — they don't have Stellar wallets and
shouldn't need one to view a creator report. Pre-computed metrics are also
significantly faster to load than live contract queries.

### 3. Creator dashboard reads stats from the indexer, not the contract

**README diagram:** The creator app is shown with a direct arrow to the
Soroban contracts.

**As built:** The creator dashboard reads its stats display (`StatsPage.tsx`)
from the **indexer API** (`useCreatorMetrics` hook), not from the contract's
`get_creator_stats()` view function. Only write operations (register, and
eventually subscribe/renew) go to the chain.

**Why:** The on-chain `CreatorStats` struct provides only `active_subscribers`,
`lifetime_revenue`, and `churn_events`. Retention curves and entropy scores
are off-chain derived metrics that the contract does not compute. Reading from
the same indexer API as the brand dashboard also ensures both views are
consistent.

### 4. Creator-app badge link redirects to brand dashboard

**README diagram:** The badge is described as a single URL that resolves to
live contract state.

**As built:** There are two badge entry points:
- `/badge/:address` on the **creator dashboard** (`BadgeRedirect.tsx`) — a
  zero-render redirect component that immediately forwards to the brand
  dashboard using `window.location.replace()` and `VITE_BRAND_DASHBOARD_URL`.
- `/badge/:address` on the **brand dashboard** (`BadgePage.tsx`) — the actual
  badge render.

Creators share the creator-dashboard URL; it transparently redirects. This
separation exists because the badge rendering needs no wallet, so it belongs
in the brand dashboard bundle.

### 5. `ReputationStake` contract is not surfaced in the brand dashboard

**README diagram:** "Reputation / Staking" is shown as a contract alongside
`Subscription Registry` and `Payment Ledger`.

**As built:** The `ReputationStake` contract is fully implemented and tested
(`contracts/reputation_stake/`), but:
- The indexer does not listen to `ReputationStake` events.
- The brand dashboard does not display stake or dispute information.

This is acknowledged in the README Roadmap with the note: *(contract
implemented and tested; brand-facing UI surface for staking/dispute status
not yet built)*. See CONTRIBUTING.md "Good First Issues" #4 for the work
needed to surface it.

### 6. Fan-side subscription UI not implemented in creator dashboard

**README diagram / "How It Works":** Step 2 is "Fans subscribe or pay in
stablecoin."

**As built:** The creator dashboard has no fan-facing subscribe/renew UI.
`lib/contract.ts` has a `// TODO(payment): subscribe() call would go here`
comment. The `SubscriptionRegistry` contract's `subscribe()` and `renew()`
functions are fully implemented on-chain and callable via the Soroban CLI or
a future fan UI — they are simply not wired to a UI page yet. This is an MVP
scope decision: the priority was creator onboarding and brand verification.

### 7. Stablecoin token transfers are not implemented in contracts

**README "Smart Contract Design":** Contracts accept "subscription payments
and pay-per-unlock payments in a supported stablecoin."

**As built:** Both `SubscriptionRegistry` and `ReputationStake` track
counters and emit events correctly, but do not yet call a stablecoin
contract's `transfer` function. Every `subscribe`, `renew`, `stake`, and
`slash` call has a `TODO(payment)` comment marking this gap. The contracts
are production-shaped (correct events, correct state transitions, correct
auth) but require stablecoin integration before real money can move.

---

## Known Gaps (Not Yet Built)

These are items from the README Roadmap that have no code in this repository:

| Gap | Location | Notes |
|---|---|---|
| `SponsorshipEscrow` contract | `contracts/sponsorship_escrow/` | `.gitkeep` only |
| Multi-currency / anchor integration | contracts, indexer, dashboards | Depends on stablecoin token transfer TODOs |
| Zero-knowledge aggregate proofs | — | Research phase; Soroban has no native ZK support |
| Brand-facing stake/dispute UI | `apps/brand-dashboard/` | Contract built; indexer listener and API endpoint not built |
| Fan-side subscribe/renew UI | `apps/creator-dashboard/` | Contract built; UI page not built |
| Real stablecoin token transfers | Both contracts | `TODO(payment)` throughout |
| Indexer event pagination | `indexer/src/listener.ts` | `TODO(prod)` in `pollOnce()` |
| XDR parsing via generated bindings | `indexer/src/parser.ts` | `TODO(prod)` — currently manual |
