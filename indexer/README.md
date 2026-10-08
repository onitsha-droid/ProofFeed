# ProofFeed Indexer

The ProofFeed Indexer is a Node.js + TypeScript service that listens to events emitted by the `SubscriptionRegistry` Soroban smart contract on Stellar, persists them to PostgreSQL, and computes derived analytics metrics (retention curves, payment entropy scores) that power the brand-facing dashboard.

---

## Why Node.js + TypeScript?

- **Mature Stellar SDK**: `@stellar/stellar-sdk` is the reference SDK for Stellar/Soroban integration with first-class TypeScript support, well-maintained event subscription APIs, and active community support.
- **Fast iteration for MVP**: TypeScript gives type safety close to Rust without the compilation overhead, ideal for a schema that is still evolving.
- **Excellent pg ecosystem**: `node-postgres` (`pg`) is battle-tested, supports connection pooling out of the box, and pairs naturally with JSONB for the raw event store.
- **Unified stack**: The rest of the ProofFeed apps (creator-dashboard, brand-dashboard) are React + TypeScript, so sharing types and utility packages across the monorepo is straightforward.

---

## Prerequisites

| Dependency | Version |
|---|---|
| Node.js | 18 or higher |
| PostgreSQL | 14 or higher |
| A funded Stellar testnet account | (for local development) |

---

## Getting Started

### 1. Clone and install

```bash
cd indexer
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
DATABASE_URL=postgres://prooffeed:prooffeed@localhost:5432/prooffeed
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
CONTRACT_ID=<your-deployed-contract-id>
POLL_INTERVAL_MS=5000
```

### 3. Create the database

```bash
psql -U postgres -c "CREATE USER prooffeed WITH PASSWORD 'prooffeed';"
psql -U postgres -c "CREATE DATABASE prooffeed OWNER prooffeed;"
```

### 4. Run migrations

```bash
npm run migrate
```

The migration script reads `src/db/schema.sql` and executes it against `DATABASE_URL`. All statements use `IF NOT EXISTS` so the script is safe to run repeatedly.

### 5. Start the indexer

Development (ts-node, auto-reloads):

```bash
npm run dev
```

Production (compile first):

```bash
npm run build
npm start
```

---

## Running Tests

Integration tests require a test database:

```bash
psql -U postgres -c "CREATE DATABASE prooffeed_test OWNER prooffeed;"
```

Run the tests:

```bash
npm test
```

Tests use the database at `TEST_DATABASE_URL` (if set) or `DATABASE_URL` with `_test` appended to the database name. They run migrations automatically and clean up data between each test.

The Soroban RPC is not contacted during tests — all events are seeded directly by calling `processEvent()` with mock objects.

---

## Database Schema

### `raw_events`

Stores every event exactly as received from the Soroban RPC, before any parsing or transformation. This is the audit log — nothing is ever deleted from this table. Fields:

| Column | Type | Description |
|---|---|---|
| `id` | SERIAL | Auto-increment primary key |
| `contract_id` | TEXT | Stellar contract address that emitted the event |
| `event_type` | TEXT | One of `CreatorRegistered`, `PaymentRecorded`, `SubscriptionCancelled` |
| `ledger_sequence` | BIGINT | Stellar ledger number |
| `transaction_hash` | TEXT | Transaction that produced this event |
| `payload` | JSONB | Full parsed event as JSON |
| `indexed_at` | TIMESTAMPTZ | When the indexer stored this row |

### `creator_registrations`

One row per creator address. Upserted whenever a `CreatorRegistered` event arrives (a creator may re-register to update their tiers).

### `payment_events`

One row per `PaymentRecorded` event (both initial subscriptions and renewals). Indexed on `creator_address`, `(subscriber_address, creator_address)`, and `payment_timestamp` for efficient cohort and retention queries.

### `subscription_cancellations`

One row per `SubscriptionCancelled` event. Used to determine which subscribers are currently active and to compute churn rates.

### `creator_metrics`

Derived / computed table. Rebuilt every time a new event arrives for a creator. This is the hot-path read table for the brand dashboard — never query it for historical accuracy (use `payment_events` and `subscription_cancellations` for that).

| Column | Description |
|---|---|
| `active_subscribers` | Count of subscribers with ≥ 1 payment and no subsequent cancellation |
| `lifetime_revenue_stroops` | Sum of all `amount_stroops` from `payment_events` |
| `churn_events` | Total count of cancellation events |
| `entropy_score` | Payment Entropy Score in [0, 1] — see below |

### `cohort_retention`

One row per `(creator_address, cohort_month, months_since_join)`. Powers the retention curve chart in the brand dashboard. `cohort_month` is in `YYYY-MM` format. `months_since_join = 0` is the cohort's own month (always retention = 1.0).

### `indexer_state`

Key-value table for indexer bookkeeping. Currently stores `last_processed_ledger` so the indexer resumes from the correct position after a restart.

---

## Payment Entropy Score

The entropy score measures how "naturally irregular" a creator's subscriber payment patterns look. It is designed to surface sybil/bot activity to brands as a confidence signal alongside raw subscriber counts.

**Score interpretation:**
- Near **1.0** — high entropy, natural and irregular pattern typical of real subscribers.
- Near **0.0** — low entropy, suspiciously uniform — could indicate bot/sybil activity.

**Algorithm:**

```
1. Compute inter-payment intervals (gaps between consecutive payment timestamps).
2. Compute the coefficient of variation (CV = stddev / mean) of those intervals.
3. Compute CV of payment amounts.
4. Normalize both CVs to [0, 1] using tanh(cv) so the score saturates gracefully
   for very high CVs (extremely irregular timing doesn't push the score above 1).
5. Return weighted average: 0.6 * timing_entropy + 0.4 * amount_entropy.
```

**Rationale:** Real subscriber bases show irregular timing (people pay when they remember, billing cycles vary) and varied amounts (different tiers). Sybil farms tend to pay at exactly regular intervals with identical amounts. The 0.6/0.4 weighting favours timing irregularity because it is harder to fake at scale.

This is an MVP heuristic. Future versions may incorporate per-subscriber wallet age, anchor KYC signals, and cohort-level statistical tests.

---

## How Retention Curves Work

A **cohort** is defined by the month of a subscriber's *first* payment to a given creator (e.g. "all subscribers who first paid in March 2024").

For each cohort month `C` and each subsequent calendar month `M`:

- `months_since_join` = number of calendar months between `C` and `M` (0, 1, 2, …)
- `retained_count` = number of subscribers from cohort `C` who made at least one payment in month `M`
- `retention_rate` = `retained_count / cohort_size`

Month 0 always has retention rate 1.0 (by definition — all members paid in their first month).

The retention curve for a cohort is the sequence of `retention_rate` values at months_since_join = 0, 1, 2, …. A steep drop-off at month 1 indicates high churn; a flat curve indicates strong subscriber loyalty.

The brand dashboard uses this data to render a retention chart for each creator, helping brands evaluate the durability of a creator's audience before committing to a sponsorship deal.
