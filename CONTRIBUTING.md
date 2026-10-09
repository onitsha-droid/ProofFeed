# Contributing to ProofFeed

Thanks for your interest in contributing. This document covers local setup,
the conventions used across the codebase this week, how to run tests, and a
list of good first issues drawn directly from the remaining Roadmap items in
README.md.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [Running Tests](#running-tests)
- [End-to-End Demo Script](#end-to-end-demo-script)
- [Coding Conventions](#coding-conventions)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Good First Issues](#good-first-issues)

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 18+ | Indexer and dashboards |
| PostgreSQL | 14+ | Indexer persistence layer |
| Rust (stable) | — | Contract builds |
| `wasm32-unknown-unknown` target | — | `rustup target add wasm32-unknown-unknown` |
| Soroban CLI | — | `cargo install --locked soroban-cli` |
| A funded Stellar testnet account | — | [Friendbot](https://friendbot.stellar.org) |

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/<your-org>/prooffeed.git
cd prooffeed
```

Install indexer dependencies. Run from inside the `indexer/` directory with
`--workspaces=false` to avoid the monorepo workspace resolving the
creator-dashboard's wallet-kit dependency (which requires a separate install
step once that package is available):

```bash
cd indexer
npm install --workspaces=false
cd ..
```

Install each dashboard separately for the same reason:

```bash
cd apps/creator-dashboard && npm install && cd ../..
cd apps/brand-dashboard   && npm install && cd ../..
```

### 2. Start PostgreSQL and create databases

```bash
psql -U postgres -c "CREATE USER prooffeed WITH PASSWORD 'prooffeed';"
psql -U postgres -c "CREATE DATABASE prooffeed OWNER prooffeed;"
# Also create a test database for the integration tests:
psql -U postgres -c "CREATE DATABASE prooffeed_test OWNER prooffeed;"
```

### 3. Configure environment variables

```bash
# Indexer
cp indexer/.env.example indexer/.env
# Fill in CONTRACT_ID after deploying (see scripts/deploy_testnet.sh).

# Creator dashboard
cp apps/creator-dashboard/.env.example apps/creator-dashboard/.env
# Set VITE_CONTRACT_ID to the deployed SubscriptionRegistry address.

# Brand dashboard
cp apps/brand-dashboard/.env.example apps/brand-dashboard/.env
# Only needs VITE_INDEXER_URL; no Stellar keys required.
```

**Indexer environment variables** (see `indexer/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `CONTRACT_ID` | — | Deployed SubscriptionRegistry contract address |
| `POLL_INTERVAL_MS` | `5000` | Polling interval in milliseconds |
| `API_PORT` | `3001` | REST API listen port |

### 4. Run migrations

```bash
cd indexer && npm run migrate
```

`src/db/migrate.ts` reads `src/db/schema.sql` and executes it against
`DATABASE_URL`. Every statement uses `IF NOT EXISTS` — safe to run repeatedly.

### 5. Deploy the contracts (testnet)

```bash
./scripts/deploy_testnet.sh <your-soroban-identity-name>
```

Copy the printed contract ID into `indexer/.env` (`CONTRACT_ID`) and
`apps/creator-dashboard/.env` (`VITE_CONTRACT_ID`).

### 6. Start the services

```bash
# Terminal 1 — Indexer (event listener + REST API on :3001)
cd indexer && npm run dev

# Terminal 2 — Creator dashboard (Vite, :5173)
cd apps/creator-dashboard && npm run dev

# Terminal 3 — Brand dashboard (Vite, :5174)
cd apps/brand-dashboard && npm run dev
```

---

## Running Tests

### Indexer integration tests

Tests connect to a real PostgreSQL database, run migrations automatically,
and seed events via `processEvent()` — no live Soroban RPC required.

```bash
cd indexer
npm test
# or with an explicit test DB:
TEST_DATABASE_URL=postgres://prooffeed:prooffeed@localhost:5432/prooffeed_test npm test
```

Tests are serialised (`--runInBand`) because they share a database and
truncate tables in `beforeEach`. Do not add parallelism without switching to
per-test schema isolation first.

### Contract unit tests

```bash
cd contracts/subscription_registry && cargo test
cd contracts/reputation_stake      && cargo test
```

Tests use `soroban-sdk`'s `testutils` in-memory ledger — no live network
needed.

---

## End-to-End Demo Script

`scripts/e2e_demo.ts` runs the full README "How It Works" flow against a real
PostgreSQL database (no Soroban RPC needed). It seeds events, checks metrics,
verifies the retention curve, and prints a simulated brand report.

```bash
# Create a demo database first:
psql -U postgres -c "CREATE DATABASE prooffeed_demo OWNER prooffeed;"

# Run the script:
TEST_DATABASE_URL=postgres://prooffeed:prooffeed@localhost:5432/prooffeed_demo \
  npx ts-node --project indexer/tsconfig.json scripts/e2e_demo.ts
```

All nine assertions must pass. If any fail, the script exits non-zero with the
failing assertion printed.

---

## Coding Conventions

### Contracts (Rust / Soroban)

- Every public function has a doc comment covering: access control
  (`require_auth`), emitted events, and possible `ContractError` variants.
  Follow the pattern in `contracts/subscription_registry/src/lib.rs`.
- Error codes are stable `u32` values assigned in `#[contracterror]`. Never
  renumber existing variants — only append new ones at the end.
- Tests live in `src/tests.rs` imported via `mod tests;`. Each new behaviour
  needs a test in the same file, using the `soroban-sdk testutils` mock
  environment.
- Mark deferred production work with `TODO(tag):` comments (e.g.
  `TODO(payment):`) so they are grep-able:
  ```
  grep -r "TODO(payment)" contracts/
  ```

### Indexer (Node.js / TypeScript)

- **Strict TypeScript** (`"strict": true`). No implicit `any`.
- **`bigint` for on-chain numeric types.** Soroban `i128` and `u64` map to
  JavaScript `bigint` because values can exceed `Number.MAX_SAFE_INTEGER`.
  Use `Number()` only for display after confirming the value is safe.
- **Stroops ↔ string at the DB boundary.** PostgreSQL `BIGINT` columns are
  returned as strings by the `pg` driver. The pattern throughout the codebase
  is: `BigInt(row.amount_stroops)` to read; `.toString()` to write.
- **Column names must match `src/db/schema.sql` exactly.** Key facts:
  - `creator_metrics` primary key column is `creator_address`, not `creator`.
  - Timestamp column is `last_computed_at`, not `updated_at`.
  - `cohort_retention` primary key is `(creator_address, cohort_month, months_since_join)`.
- **Transactions for multi-table writes.** Any `processEvent` path that writes
  to more than one table must be wrapped in `BEGIN` / `COMMIT`. Derived metric
  recomputation happens outside the transaction so raw event storage is not
  rolled back on a metrics failure.

### Dashboards (React / TypeScript)

- **Strict TypeScript.** Props typed inline with `interface Props { ... }`.
- **`entropyScore` is `number | null`.** The indexer API returns `null` when
  fewer than 2 payments have been recorded. Every render path that uses
  `entropyScore` must guard the null case — render `—` or an "insufficient
  data" state, never call `.toFixed()` on a null.
- **`lifetimeRevenueStroops` is `string`.** It is stored and transported as a
  string everywhere in the frontend types (`useCreatorReport`, `useCreatorMetrics`,
  `packages/shared/src/index.ts`). Convert to `BigInt` for arithmetic; do not
  use `parseFloat` or `Number()`.
- **Brand dashboard is read-only.** It does not import `@stellar/stellar-sdk`
  or any wallet library. Keep it that way — it reduces the attack surface and
  bundle size.
- **Badge page: never cache.** `BadgePage.tsx` and `useCreatorReport.ts` must
  not use `localStorage`, `sessionStorage`, or any HTTP caching layer for the
  metrics endpoints. The "always live" guarantee is a core product differentiator.

### Shared package (`packages/shared/`)

`packages/shared/src/index.ts` contains **TypeScript interfaces only**. No
runtime code. Both dashboards import from it so the API response shape stays
in sync across the monorepo.

---

## Pull Request Guidelines

1. **Open an issue first** for significant changes (new features, schema
   changes, contract interface changes). Small bug fixes can go straight to PR.
2. **One concern per PR.** A bug fix should not include unrelated refactors.
3. **Tests are required** for:
   - Any change to `indexer/src/metrics.ts` or `indexer/src/processor.ts`
   - Any new or modified contract public function
   - Any new API endpoint
4. **Do not implement unchecked Roadmap items** in the same PR as a bug fix.
   SponsorshipEscrow, multi-currency rails, and ZK proofs are reserved for
   dedicated contributor PRs.
5. Keep PR titles under 70 characters.
6. Do not push directly to `main`. Use a feature branch:
   ```bash
   git checkout -b feature/your-feature
   ```

---

## Good First Issues

These are drawn directly from the unchecked items in README.md's Roadmap and
the `TODO` comments in the codebase. Each is a self-contained unit of work.

---

### 1. `SponsorshipEscrow` contract

**Difficulty:** Hard | **Location:** `contracts/sponsorship_escrow/`

The directory currently contains only a `.gitkeep`. Design and implement the
escrow contract described in README.md:

> Holds brand-funded sponsorship payouts. Releases funds automatically based
> on verified subscriber growth thresholds read from `SubscriptionRegistry`.

Suggested interface (to be refined):

```rust
pub trait SponsorshipEscrow {
    fn initialize(env: Env, registry_id: Address, stablecoin_id: Address);
    fn fund(env: Env, brand: Address, creator: Address, amount: i128,
            threshold_subscribers: u32, expiry_ledger: u32);
    fn claim(env: Env, creator: Address);   // releases if threshold met
    fn refund(env: Env, brand: Address);    // releases if expired unmet
}
```

Follow the established patterns from `subscription_registry` and
`reputation_stake`: `#[contracterror]` with stable codes, doc comments on
every public function, tests in `src/tests.rs`.

---

### 2. Multi-currency / anchor integration

**Difficulty:** Medium | **Location:** `contracts/subscription_registry/src/lib.rs`

All `TODO(payment)` comments in the contracts mark where stablecoin `transfer`
calls need to happen. Subscribe, renew, cancel, stake, slash, and withdraw
currently manipulate in-contract counters without moving tokens.

Steps:
1. Add an `initialize(env, stablecoin_contract: Address)` function to
   `SubscriptionRegistry` that stores the accepted token address in instance
   storage (matching the pattern already in `ReputationStake`).
2. In `subscribe` and `renew`, invoke the stablecoin contract's `transfer` to
   move funds from subscriber to creator (or to an escrow address).
3. Extend to support a list of accepted stablecoin addresses for regional
   anchor rails.
4. Update the indexer's `payment_events` schema to record `stablecoin_address`
   and update the API to surface per-currency revenue in `creator_metrics`.

---

### 3. Zero-knowledge aggregate proofs (research)

**Difficulty:** Research / exploratory

README.md "Privacy Considerations" notes:

> A future version may incorporate zero-knowledge proofs (e.g., "this creator
> has more than N subscribers paying above $X") … Soroban does not have native
> ZK support today.

Survey available ZK toolkits compatible with Soroban (e.g. Groth16 via a
WASM verifier contract, off-chain proof generation with on-chain hash
commitment, or Halo2/Nova if WASM constraints allow). Write findings as
`docs/zk-proof-research.md` covering: feasibility, proof size vs. Soroban
resource limits, UX tradeoffs, and a recommended implementation path.

---

### 4. Brand-facing ReputationStake indicator

**Difficulty:** Medium | **Location:** `apps/brand-dashboard/src/`

The `ReputationStake` contract is complete and tested, but the brand dashboard
does not yet surface whether a creator has an active stake or any dispute
history. This is listed in the README Roadmap note:

> *(contract implemented and tested; brand-facing UI surface for
> staking/dispute status not yet built)*

Steps:
1. Add a new indexer table `reputation_stakes` and a new listener that indexes
   `StakeDeposited`, `StakeWithdrawn`, `DisputeOpened`, `DisputeResolved`, and
   `StakeSlashed` events from the `ReputationStake` contract.
2. Add a new API endpoint `GET /api/creators/:address/stake` returning current
   stake amount and open/resolved dispute counts.
3. Add a `StakeIndicator` component to `apps/brand-dashboard/src/components/`
   and render it in `ReportPage.tsx` below the entropy score section.

---

### 5. Renewal window enforcement in `SubscriptionRegistry`

**Difficulty:** Small | **Location:** `contracts/subscription_registry/src/lib.rs`

The `TODO(renewal-window)` comment in `renew()` reads:

> TODO(renewal-window): renew() does not enforce a cooldown or expiry window.
> A production contract should reject renewals that arrive before the current
> subscription period ends.

Implement: store `last_payment_timestamp` per `(subscriber, creator)` in
persistent storage. In `renew()`, reject the call if the ledger timestamp is
less than `last_payment_timestamp + billing_period_seconds`. The billing
period should come from the tier definition.

Write tests covering the boundary (one second before and after the window).

---

### 6. Indexer event pagination

**Difficulty:** Small | **Location:** `indexer/src/listener.ts`

The `TODO(prod)` comment in `pollOnce()` reads:

> The Soroban RPC getEvents API has pagination; in production you must loop
> through pages using the paging_token until you've consumed all events up to
> the current ledger.

Implement a pagination loop inside `pollOnce()` using the `pagingToken` field
on each event response. Add a test in the integration test suite that seeds
more events than a single page would return and verifies all are processed.

---

### 7. Fix workspace-level `npm install`

**Difficulty:** Small | **Location:** `apps/creator-dashboard/package.json`

Running `npm install` from the repo root currently fails because
`@creit-tech/stellar-wallets-kit@1.3.0` is not resolvable from the npm
registry in this environment. Investigate whether a newer version is
available, whether the package was renamed, or whether it should be replaced
with a direct Freighter browser extension integration using
`@stellar/freighter-api`. Update `apps/creator-dashboard/package.json`
accordingly and verify `npm install` succeeds from the repo root.
