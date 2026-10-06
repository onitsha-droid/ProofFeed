# ProofFeed

**On-chain proof of audience for creators. Verifiable reach for brands.**

ProofFeed is a Stellar/Soroban-powered trust layer that turns a creator's subscription and payment history into cryptographically verifiable, tamper-proof data — so brands and sponsors can evaluate creator partnerships based on real, auditable numbers instead of screenshots and self-reported media kits.

> Don't trust the screenshot. Verify the ledger.

---

## Table of Contents

- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [How It Works](#how-it-works)
- [Core Concepts](#core-concepts)
- [Architecture](#architecture)
- [Smart Contract Design](#smart-contract-design)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Usage](#usage)
- [Anti-Fraud & Sybil Resistance](#anti-fraud--sybil-resistance)
- [Privacy Considerations](#privacy-considerations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## The Problem

Influencer and creator fraud costs brands billions of dollars a year. The core issue isn't a lack of analytics tools — it's that **every number a creator shows a sponsor is self-reported**:

- Follower counts can be bought.
- Engagement can be farmed.
- "Average views" and subscriber screenshots can be cherry-picked, edited, or simply fabricated.
- Third-party audit tools (HypeAuditor, Modash, etc.) only estimate from public-facing APIs the creator's platform controls — they don't see ground-truth revenue or retention data.

There is currently no neutral, tamper-evident source of truth that a brand can check *without* trusting the creator, their agency, or the platform hosting them.

## The Solution

ProofFeed routes real creator monetization — subscriptions, tips, pay-per-post unlocks — through Soroban smart contracts on Stellar. Because the contract settles real stablecoin payments on a public ledger, the resulting data is:

- **Tamper-proof** — transactions can't be edited or deleted after the fact.
- **Timestamped** — every payment and renewal has a verifiable on-chain time.
- **Independently queryable** — anyone can verify it directly from the contract, not from a dashboard the creator controls.

Instead of competing with Patreon or OnlyFans on creator UX, ProofFeed competes on **trust infrastructure** — a B2B verification layer with a lightweight creator-monetization tool as the on-ramp.

## How It Works

1. **Creator onboards** and sets up subscription tiers / pay-per-unlock pricing, routed through a Soroban contract instead of (or alongside) their existing platform.
2. **Fans subscribe or pay** in stablecoin. Each payment is recorded on-chain: payer wallet, amount, timestamp, and whether it's a new subscription or a renewal.
3. **The contract accumulates a verifiable history**: subscriber counts over time, renewal/retention curves, churn, revenue concentration, and payment entropy.
4. **Brands query the data directly** — via a public dashboard or a shareable "verification badge" link that always resolves to live, current on-chain state (never a stale screenshot).
5. **Optional performance-based sponsorship deals** can be structured natively: a brand funds a contract that pays out automatically based on verified subscriber growth over a defined period, with no manual reconciliation.

## Core Concepts

| Concept | What it means here |
|---|---|
| **Proof of Audience** | Verified subscriber/payment history, not follower counts |
| **Retention Curve** | % of subscribers from cohort X still paying N months later, computed from real renewal events |
| **Payment Entropy Score** | A measure of how "naturally irregular" a creator's payment patterns look, used to flag potential sybil/fake subscriber activity |
| **Verification Badge** | A public, live link brands can check that resolves directly to on-chain contract state |
| **Reputation Stake** | Optional collateral a creator locks, slashable if a brand successfully disputes fraudulent activity through arbitration |

## Architecture

```
┌─────────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│   Creator App    │       │   Soroban Contracts    │       │   Brand Dashboard │
│  (subscribe mgmt,│──────▶│  Subscription Registry │◀──────│ (verified reports,│
│   payout setup)  │       │  Payment Ledger         │       │  badge resolver)  │
└─────────────────┘       │  Reputation / Staking   │       └─────────────────┘
                           └──────────┬───────────┘
                                      │
                           ┌──────────▼───────────┐
                           │   Stellar Network      │
                           │ (settlement, anchors,  │
                           │  stablecoin rails)      │
                           └──────────────────────┘
```

**Off-chain services** (indexer, analytics engine, dashboards) read contract events and compute derived metrics (retention curves, entropy scores) without altering the on-chain source of truth.

## Smart Contract Design

### `SubscriptionRegistry` contract

Core responsibilities:
- Register creators and their subscription tiers/pricing.
- Accept subscription payments and pay-per-unlock payments in a supported stablecoin.
- Emit structured events for every payment: `subscriber`, `creator`, `amount`, `timestamp`, `is_renewal`.
- Track per-creator aggregate state: active subscriber count, lifetime revenue, churn events.

Representative interface (illustrative — not final):

```rust
pub trait SubscriptionRegistry {
    fn register_creator(env: Env, creator: Address, tiers: Vec<Tier>);
    fn subscribe(env: Env, subscriber: Address, creator: Address, tier_id: u32);
    fn renew(env: Env, subscriber: Address, creator: Address);
    fn cancel(env: Env, subscriber: Address, creator: Address);
    fn get_creator_stats(env: Env, creator: Address) -> CreatorStats;
    fn get_subscriber_history(env: Env, subscriber: Address, creator: Address) -> Vec<PaymentEvent>;
}
```

### `ReputationStake` contract

- Allows creators to lock collateral as a trust signal.
- Defines a lightweight dispute/arbitration flow for brands to challenge suspected fraud.
- Slashes stake on a successful dispute, returns stake after a cooldown period with no disputes.

### `SponsorshipEscrow` contract (stretch goal)

- Holds brand-funded sponsorship payouts.
- Releases funds automatically based on verified subscriber growth thresholds read from `SubscriptionRegistry`.

## Tech Stack

| Layer | Technology |
|---|---|
| Smart contracts | Soroban (Rust) |
| Settlement network | Stellar |
| Stablecoin rails | Stellar anchors / USDC-on-Stellar |
| Backend / indexer | Node.js or Rust service consuming Soroban RPC events |
| Frontend | React + TypeScript |
| Wallet integration | Freighter / Stellar Wallets Kit |
| Analytics storage | PostgreSQL (for derived, off-chain-computed metrics) |
| Hosting | TBD (Vercel/Netlify for frontend, containerized backend) |

## Project Structure

```
prooffeed/
├── contracts/
│   ├── subscription_registry/
│   ├── reputation_stake/
│   └── sponsorship_escrow/
├── indexer/              # listens to Soroban events, computes derived metrics
├── apps/
│   ├── creator-dashboard/
│   └── brand-dashboard/
├── packages/
│   └── shared/           # shared types, contract bindings, utils
├── scripts/               # deployment and local network scripts
└── README.md
```

## Getting Started

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) + `wasm32-unknown-unknown` target
- [Soroban CLI](https://soroban.stellar.org/docs/getting-started/setup)
- Node.js 18+
- A funded Stellar testnet account ([Friendbot](https://friendbot.stellar.org))

### Clone and install

```bash
git clone https://github.com/<your-org>/prooffeed.git
cd prooffeed
npm install
```

### Build and deploy contracts (testnet)

```bash
cd contracts/subscription_registry
soroban contract build
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/subscription_registry.wasm \
  --source <your-identity> \
  --network testnet
```

### Run the apps

```bash
# Creator dashboard
cd apps/creator-dashboard
npm run dev

# Brand dashboard
cd apps/brand-dashboard
npm run dev
```

## Usage

1. **Creator**: connect a Stellar wallet, register as a creator, define subscription tiers.
2. **Fan**: connect a wallet, subscribe to a creator, pay in stablecoin.
3. **Brand**: open the brand dashboard, enter a creator's contract address (or follow their verification badge link), view the auto-generated proof-of-audience report.

## Anti-Fraud & Sybil Resistance

Routing payments on-chain doesn't automatically prevent fake subscribers — someone could still pay themselves from many wallets. ProofFeed mitigates this with layered defenses rather than a single silver bullet:

- **Friction at the edge**: subscriber wallets funded through KYC'd anchors carry more trust weight than freshly created, unfunded wallets.
- **Payment entropy scoring**: real subscriber bases show irregular payment timing, amounts, and churn; sybil farms tend to look suspiciously uniform. This is surfaced to brands as a confidence score alongside raw counts.
- **Reputation staking**: creators can opt to stake collateral, slashable through a dispute process if a brand proves fraud — this filters out bad actors before most brands need to investigate manually.
- **Transparency over certainty**: the goal isn't to claim fraud is impossible, but to make it expensive, visible, and statistically detectable — a meaningfully higher bar than a screenshot.

## Privacy Considerations

Full on-chain transparency creates tension with subscriber privacy. ProofFeed's approach:

- Subscriber wallets are pseudonymous by default; brand-facing reports surface **aggregate** data (counts, curves, scores), not individual subscriber identities or spending.
- A future version may incorporate zero-knowledge proofs (e.g., "this creator has more than N subscribers paying above $X") to let creators prove audience claims without exposing any individual transaction — Soroban does not have native ZK support today, so this is tracked as a longer-term research item rather than an MVP feature.

## Roadmap

- [ ] `SubscriptionRegistry` contract (subscribe, renew, cancel, stats)
- [ ] Creator dashboard: onboarding, tier setup, self-view of verified stats
- [ ] Brand dashboard: lookup by contract address, auto-generated proof-of-audience report
- [ ] Shareable, live-resolving verification badge
- [ ] Payment entropy scoring engine
- [ ] `ReputationStake` contract + dispute/arbitration flow
- [ ] `SponsorshipEscrow` contract for performance-based sponsorship payouts
- [ ] Multi-currency / anchor integration for regional stablecoin rails
- [ ] Zero-knowledge aggregate proofs (research phase)

## Contributing

Contributions are welcome. Please open an issue to discuss significant changes before submitting a pull request. For contract changes, include tests covering the new or modified behavior.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Push and open a PR

## License

[MIT](LICENSE)
