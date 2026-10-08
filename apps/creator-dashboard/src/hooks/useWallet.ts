/**
 * useWallet.ts
 *
 * Thin wrapper around @creit-tech/stellar-wallets-kit.
 *
 * Exposes:
 *   address      — the connected Stellar public key, or null
 *   isConnected  — boolean convenience flag
 *   connect()    — open the wallet-selection modal
 *   disconnect() — clear the connected address from state
 *   kit          — the underlying StellarWalletsKit instance (for signing txs)
 */

import { useState, useRef } from 'react';
import {
  StellarWalletsKit,
  WalletNetwork,
  allowAllModules,
  FREIGHTER_ID,
} from '@creit-tech/stellar-wallets-kit';

const NETWORK_PASSPHRASE =
  import.meta.env.VITE_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';

// Resolve the WalletNetwork enum value from the passphrase so the kit knows
// which network it is operating on.
function resolveNetwork(passphrase: string): WalletNetwork {
  if (passphrase.startsWith('Public Global Stellar Network')) {
    return WalletNetwork.PUBLIC;
  }
  return WalletNetwork.TESTNET;
}

// Initialise the kit once at module level so it is shared across re-renders.
// allowAllModules() registers every wallet the kit supports; the modal will
// only surface wallets that are actually installed in the browser.
const kit = new StellarWalletsKit({
  network: resolveNetwork(NETWORK_PASSPHRASE),
  selectedWalletId: FREIGHTER_ID,
  modules: allowAllModules(),
});

export interface WalletState {
  address: string | null;
  isConnected: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  kit: StellarWalletsKit;
}

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  // Keep a stable ref to `kit` so callers that destructure the hook don't
  // accidentally create stale closures.
  const kitRef = useRef(kit);

  const connect = async (): Promise<void> => {
    // openModal resolves once the user selects a wallet and approves the
    // connection request.  It throws if the user cancels.
    await kitRef.current.openModal({
      onWalletSelected: async (option) => {
        kitRef.current.setWallet(option.id);
        const { address: publicKey } = await kitRef.current.getAddress();
        setAddress(publicKey);
      },
    });
  };

  const disconnect = (): void => {
    setAddress(null);
  };

  return {
    address,
    isConnected: address !== null,
    connect,
    disconnect,
    kit: kitRef.current,
  };
}
