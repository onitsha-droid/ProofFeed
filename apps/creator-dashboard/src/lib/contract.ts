/**
 * contract.ts
 *
 * Soroban contract interaction helpers for the creator dashboard.
 *
 * This module builds, simulates, and submits transactions to the
 * SubscriptionRegistry Soroban contract.
 *
 * Environment variables required:
 *   VITE_SOROBAN_RPC_URL      — e.g. https://soroban-testnet.stellar.org
 *   VITE_CONTRACT_ID          — the deployed SubscriptionRegistry contract ID
 *   VITE_NETWORK_PASSPHRASE   — e.g. "Test SDF Network ; September 2015"
 */

import {
  Contract,
  Networks,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Address,
  xdr,
} from '@stellar/stellar-sdk';
import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL =
  import.meta.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID as string;
const NETWORK_PASSPHRASE =
  import.meta.env.VITE_NETWORK_PASSPHRASE ??
  Networks.TESTNET;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single subscription tier offered by a creator. */
export interface Tier {
  id: number;
  /** Price in stroops (1 USDC = 10_000_000 stroops). */
  price: bigint;
  name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Tier array to the ScVal representation expected by the contract. */
function tiersToScVal(tiers: Tier[]): xdr.ScVal {
  // The contract expects a Vec<Map<Symbol, Val>> where each map has keys:
  //   "id"    → u32
  //   "name"  → String
  //   "price" → i128
  const tierVals = tiers.map((tier) => {
    return xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('id'),
        val: nativeToScVal(tier.id, { type: 'u32' }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('name'),
        val: nativeToScVal(tier.name, { type: 'string' }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('price'),
        val: nativeToScVal(tier.price, { type: 'i128' }),
      }),
    ]);
  });
  return xdr.ScVal.scvVec(tierVals);
}

// ---------------------------------------------------------------------------
// registerCreator
// ---------------------------------------------------------------------------

/**
 * Build, simulate, sign, and submit a `register_creator` transaction to the
 * SubscriptionRegistry contract.
 *
 * @param kit      The connected StellarWalletsKit instance (holds the signer).
 * @param address  The creator's Stellar public key.
 * @param tiers    The subscription tiers to register.
 * @returns        The transaction hash of the submitted transaction.
 *
 * @throws If simulation fails, the user rejects signing, or the tx errors.
 */
export async function registerCreator(
  kit: StellarWalletsKit,
  address: string,
  tiers: Tier[]
): Promise<string> {
  if (!CONTRACT_ID) {
    throw new Error(
      'VITE_CONTRACT_ID is not set. Copy .env.example to .env and deploy the contract first.'
    );
  }

  const server = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
  const contract = new Contract(CONTRACT_ID);

  // ---- 1. Fetch the creator's account to get the sequence number ----------
  const account = await server.getAccount(address);

  // ---- 2. Build the transaction --------------------------------------------
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'register_creator',
        // creator: Address
        new Address(address).toScVal(),
        // tiers: Vec<Tier>
        tiersToScVal(tiers)
      )
    )
    .setTimeout(30)
    .build();

  // ---- 3. Simulate to get the resource footprint ---------------------------
  const simResult = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  // Assemble the transaction with the simulated auth and resource limits.
  const preparedTx = SorobanRpc.assembleTransaction(
    tx,
    simResult
  ).build();

  // ---- 4. Sign the transaction via the connected wallet --------------------
  const { signedTxXdr } = await kit.signTransaction(preparedTx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  // ---- 5. Submit -----------------------------------------------------------
  const signedTx = TransactionBuilder.fromXDR(
    signedTxXdr,
    NETWORK_PASSPHRASE
  ) as Transaction;

  const sendResult = await server.sendTransaction(signedTx);

  if (sendResult.status === 'ERROR') {
    throw new Error(
      `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`
    );
  }

  // Poll until the transaction is confirmed (DUPLICATE or SUCCESS) or fails.
  const txHash = sendResult.hash;
  let attempts = 0;
  const MAX_ATTEMPTS = 20;
  const POLL_INTERVAL_MS = 2_000;

  while (attempts < MAX_ATTEMPTS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusResult = await server.getTransaction(txHash);

    if (statusResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return txHash;
    }

    if (statusResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed on-chain. Hash: ${txHash}`);
    }

    // Status is NOT_FOUND (still pending) — keep polling.
    attempts++;
  }

  throw new Error(
    `Transaction not confirmed after ${MAX_ATTEMPTS} attempts. Hash: ${txHash}`
  );
}

// TODO(payment): subscribe() call would go here for fan flow
// export async function subscribe(kit, subscriberAddress, creatorAddress, tierId) { ... }
