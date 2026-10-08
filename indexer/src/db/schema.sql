-- ProofFeed Indexer — PostgreSQL schema
-- All tables use IF NOT EXISTS so migrations are idempotent.

-- ---------------------------------------------------------------------------
-- raw_events
-- Stores every event exactly as received from Soroban RPC before any parsing.
-- This is the audit log — nothing is ever deleted from here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_events (
    id               SERIAL PRIMARY KEY,
    contract_id      TEXT        NOT NULL,
    event_type       TEXT        NOT NULL
                         CHECK (event_type IN (
                             'CreatorRegistered',
                             'PaymentRecorded',
                             'SubscriptionCancelled'
                         )),
    ledger_sequence  BIGINT      NOT NULL,
    transaction_hash TEXT        NOT NULL,
    payload          JSONB       NOT NULL,
    indexed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- creator_registrations
-- One row per creator. Upserted whenever a CreatorRegistered event arrives.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creator_registrations (
    creator_address  TEXT        PRIMARY KEY,
    tier_count       INT         NOT NULL,
    registered_at    TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------
-- payment_events
-- One row per PaymentRecorded event (both initial subscriptions and renewals).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_events (
    id                 SERIAL PRIMARY KEY,
    subscriber_address TEXT        NOT NULL,
    creator_address    TEXT        NOT NULL,
    amount_stroops     BIGINT      NOT NULL,
    payment_timestamp  BIGINT      NOT NULL,
    is_renewal         BOOL        NOT NULL,
    ledger_sequence    BIGINT      NOT NULL,
    transaction_hash   TEXT        NOT NULL,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Efficient lookup of all payments for a given creator (retention curves,
-- revenue aggregates).
CREATE INDEX IF NOT EXISTS idx_payment_events_creator
    ON payment_events (creator_address);

-- Efficient lookup of a specific subscriber's history with a creator (churn
-- logic, active-subscription check).
CREATE INDEX IF NOT EXISTS idx_payment_events_subscriber_creator
    ON payment_events (subscriber_address, creator_address);

-- Efficient time-range queries (cohort bucketing by month).
CREATE INDEX IF NOT EXISTS idx_payment_events_timestamp
    ON payment_events (payment_timestamp);

-- ---------------------------------------------------------------------------
-- subscription_cancellations
-- One row per SubscriptionCancelled event.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_cancellations (
    id                 SERIAL PRIMARY KEY,
    subscriber_address TEXT        NOT NULL,
    creator_address    TEXT        NOT NULL,
    cancel_timestamp   BIGINT      NOT NULL,
    ledger_sequence    BIGINT      NOT NULL,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- creator_metrics
-- Derived / computed table. Rebuilt whenever new events arrive for a creator.
-- Never queried for historical accuracy — use raw_events / payment_events for
-- that. This is the hot-path read table for the brand dashboard.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creator_metrics (
    creator_address          TEXT             PRIMARY KEY,
    active_subscribers       INT              NOT NULL DEFAULT 0,
    lifetime_revenue_stroops BIGINT           NOT NULL DEFAULT 0,
    churn_events             INT              NOT NULL DEFAULT 0,
    entropy_score            DOUBLE PRECISION,
    last_computed_at         TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- cohort_retention
-- One row per (creator, cohort_month, months_since_join).
-- cohort_month is in YYYY-MM format (e.g. '2024-03').
-- months_since_join = 0 means the cohort's own month (always 1.0 retention).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cohort_retention (
    creator_address   TEXT             NOT NULL,
    cohort_month      TEXT             NOT NULL,   -- YYYY-MM
    months_since_join INT              NOT NULL,
    retained_count    INT              NOT NULL,
    cohort_size       INT              NOT NULL,
    retention_rate    DOUBLE PRECISION NOT NULL,
    computed_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    PRIMARY KEY (creator_address, cohort_month, months_since_join)
);

-- ---------------------------------------------------------------------------
-- indexer_state
-- Key-value store for indexer bookkeeping (e.g. last processed ledger).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS indexer_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
