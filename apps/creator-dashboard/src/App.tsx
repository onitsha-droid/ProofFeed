/**
 * App.tsx
 *
 * Root component — sets up client-side routing and enforces the
 * connect → onboard → stats flow.
 *
 * Route map:
 *   /                → HomeRoute  (smart redirect based on connection state)
 *   /onboarding      → OnboardingPage
 *   /stats           → StatsPage
 *   /badge/:address  → BadgeRedirect
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useWallet, WalletState } from './hooks/useWallet';
import ConnectWallet from './components/ConnectWallet';
import OnboardingPage from './pages/OnboardingPage';
import StatsPage from './pages/StatsPage';
import BadgeRedirect from './pages/BadgeRedirect';

// ---------------------------------------------------------------------------
// Wallet context — makes wallet state available to the whole tree without
// prop-drilling through every intermediate component.
// ---------------------------------------------------------------------------

const WalletContext = createContext<WalletState | null>(null);

export function useWalletContext(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWalletContext must be used inside <App>');
  return ctx;
}

// ---------------------------------------------------------------------------
// Registration context — tracks whether the connected creator has already
// called register_creator.  Stored in sessionStorage so a page refresh
// doesn't send them back through onboarding unnecessarily during the same
// browser session.
// ---------------------------------------------------------------------------

interface RegistrationContextValue {
  isRegistered: boolean;
  setRegistered: (v: boolean) => void;
}

const RegistrationContext = createContext<RegistrationContextValue>({
  isRegistered: false,
  setRegistered: () => undefined,
});

export function useRegistration(): RegistrationContextValue {
  return useContext(RegistrationContext);
}

// ---------------------------------------------------------------------------
// HomeRoute — smart redirect based on auth / registration state
// ---------------------------------------------------------------------------

function HomeRoute(): React.ReactElement {
  const { isConnected } = useWalletContext();
  const { isRegistered } = useRegistration();

  if (!isConnected) {
    // Not connected → show the connect-wallet prompt inline
    return <ConnectWallet />;
  }

  if (!isRegistered) {
    return <Navigate to="/onboarding" replace />;
  }

  return <Navigate to="/stats" replace />;
}

// ---------------------------------------------------------------------------
// RequireWallet — guard for pages that need a connected wallet
// ---------------------------------------------------------------------------

function RequireWallet({ children }: { children: React.ReactElement }): React.ReactElement {
  const { isConnected } = useWalletContext();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isConnected) {
      navigate('/', { replace: true });
    }
  }, [isConnected, navigate]);

  if (!isConnected) return <></>;
  return children;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App(): React.ReactElement {
  const wallet = useWallet();

  // Persist registration state in sessionStorage keyed to the address so
  // different creators using the same browser don't share state.
  const storageKey = wallet.address ? `pf_registered_${wallet.address}` : null;
  const [isRegistered, setIsRegisteredState] = useState<boolean>(() => {
    if (!storageKey) return false;
    return sessionStorage.getItem(storageKey) === 'true';
  });

  // Re-sync when the address changes (e.g. user disconnects and reconnects
  // with a different wallet).
  useEffect(() => {
    if (!storageKey) {
      setIsRegisteredState(false);
      return;
    }
    setIsRegisteredState(sessionStorage.getItem(storageKey) === 'true');
  }, [storageKey]);

  const setRegistered = (v: boolean) => {
    if (storageKey) {
      if (v) {
        sessionStorage.setItem(storageKey, 'true');
      } else {
        sessionStorage.removeItem(storageKey);
      }
    }
    setIsRegisteredState(v);
  };

  return (
    <WalletContext.Provider value={wallet}>
      <RegistrationContext.Provider value={{ isRegistered, setRegistered }}>
        <Routes>
          <Route path="/" element={<HomeRoute />} />
          <Route
            path="/onboarding"
            element={
              <RequireWallet>
                <OnboardingPage />
              </RequireWallet>
            }
          />
          <Route
            path="/stats"
            element={
              <RequireWallet>
                <StatsPage />
              </RequireWallet>
            }
          />
          <Route path="/badge/:address" element={<BadgeRedirect />} />
          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </RegistrationContext.Provider>
    </WalletContext.Provider>
  );
}
