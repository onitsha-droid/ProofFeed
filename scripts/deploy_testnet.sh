#!/usr/bin/env bash
# scripts/deploy_testnet.sh
#
# Build and deploy the SubscriptionRegistry contract to Stellar testnet.
#
# Prerequisites (from README.md "Getting Started"):
#   - Rust + wasm32-unknown-unknown target
#       rustup target add wasm32-unknown-unknown
#   - Soroban CLI
#       cargo install --locked soroban-cli
#   - A funded Stellar testnet account (identity already configured in
#     Soroban CLI, or use Friendbot: https://friendbot.stellar.org)
#
# Usage:
#   ./scripts/deploy_testnet.sh <identity-name>
#
# Example:
#   ./scripts/deploy_testnet.sh alice
#
# The script prints the deployed contract ID on success.

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument handling
# ---------------------------------------------------------------------------

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <soroban-identity-name>" >&2
  echo ""
  echo "  <soroban-identity-name>  Name of a Soroban CLI identity that has been"
  echo "                           funded on testnet."
  echo ""
  echo "  To create a new funded identity run:"
  echo "    soroban keys generate --network testnet alice"
  echo "    # Then fund it via Friendbot:"
  echo "    curl \"https://friendbot.stellar.org?addr=\$(soroban keys address alice)\""
  exit 1
fi

IDENTITY="$1"
NETWORK="testnet"
CONTRACT_DIR="contracts/subscription_registry"
WASM_PATH="target/wasm32-unknown-unknown/release/subscription_registry.wasm"

# ---------------------------------------------------------------------------
# Resolve repo root so the script works from any directory
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

echo "==> ProofFeed — SubscriptionRegistry testnet deploy"
echo "    Identity : ${IDENTITY}"
echo "    Network  : ${NETWORK}"
echo "    Repo root: ${REPO_ROOT}"
echo ""

# ---------------------------------------------------------------------------
# Step 1 — build the contract WASM
# ---------------------------------------------------------------------------
# Matches README.md:
#   cd contracts/subscription_registry
#   soroban contract build

echo "==> Building contract..."
cd "${CONTRACT_DIR}"
soroban contract build
cd "${REPO_ROOT}"

if [[ ! -f "${WASM_PATH}" ]]; then
  echo "ERROR: Expected WASM at ${WASM_PATH} — build may have failed." >&2
  exit 1
fi

echo "    WASM size: $(du -sh "${WASM_PATH}" | cut -f1)"
echo ""

# ---------------------------------------------------------------------------
# Step 2 — deploy to testnet
# ---------------------------------------------------------------------------
# Matches README.md:
#   soroban contract deploy \
#     --wasm target/wasm32-unknown-unknown/release/subscription_registry.wasm \
#     --source <your-identity> \
#     --network testnet

echo "==> Deploying to ${NETWORK}..."
CONTRACT_ID=$(soroban contract deploy \
  --wasm "${WASM_PATH}" \
  --source "${IDENTITY}" \
  --network "${NETWORK}")

echo ""
echo "==> Deployment successful!"
echo ""
echo "    Contract ID : ${CONTRACT_ID}"
echo ""
echo "    Verify on Stellar Expert:"
echo "    https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}"
echo ""
echo "    To call a function (example — get_creator_stats for a creator address):"
echo "    soroban contract invoke \\"
echo "      --id ${CONTRACT_ID} \\"
echo "      --source ${IDENTITY} \\"
echo "      --network ${NETWORK} \\"
echo "      -- get_creator_stats \\"
echo "      --creator <CREATOR_STELLAR_ADDRESS>"
