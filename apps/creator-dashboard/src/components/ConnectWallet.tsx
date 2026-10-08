/**
 * ConnectWallet.tsx
 *
 * Full-page prompt asking the creator to connect their Stellar wallet.
 * Rendered when the user lands on "/" without a connected wallet.
 */

import React, { useState } from 'react';
import { useWalletContext } from '../App';

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
    background: 'var(--color-bg)',
  },
  card: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    padding: '2.5rem 3rem',
    maxWidth: '420px',
    width: '100%',
    textAlign: 'center',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  },
  logo: {
    fontSize: '2rem',
    fontWeight: 700,
    letterSpacing: '-0.5px',
    color: 'var(--color-text)',
    marginBottom: '0.25rem',
  },
  logoAccent: {
    color: 'var(--color-accent)',
  },
  tagline: {
    fontSize: '0.875rem',
    color: 'var(--color-muted)',
    marginBottom: '2rem',
  },
  heading: {
    fontSize: '1.25rem',
    fontWeight: 600,
    color: 'var(--color-text)',
    marginBottom: '0.75rem',
  },
  body: {
    fontSize: '0.9rem',
    color: 'var(--color-muted)',
    lineHeight: 1.6,
    marginBottom: '2rem',
  },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    width: '100%',
    padding: '0.75rem 1.5rem',
    background: 'var(--color-accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius)',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.15s ease',
  },
  buttonDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  error: {
    marginTop: '1rem',
    padding: '0.75rem',
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid var(--color-danger)',
    borderRadius: 'var(--radius)',
    color: 'var(--color-danger)',
    fontSize: '0.85rem',
  },
  footnote: {
    marginTop: '1.5rem',
    fontSize: '0.8rem',
    color: 'var(--color-muted)',
  },
};

export default function ConnectWallet(): React.ReactElement {
  const { connect } = useWalletContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    setError(null);
    setLoading(true);
    try {
      await connect();
    } catch (err) {
      // User cancelled the modal — don't treat that as an error worth
      // showing, but do surface unexpected failures.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('cancel') && !msg.toLowerCase().includes('closed')) {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={styles.page} role="main">
      <div style={styles.card}>
        <div style={styles.logo}>
          Proof<span style={styles.logoAccent}>Feed</span>
        </div>
        <p style={styles.tagline}>On-chain proof of audience for creators.</p>

        <h1 style={styles.heading}>Creator Dashboard</h1>
        <p style={styles.body}>
          Connect your Stellar wallet to register as a creator, define your
          subscription tiers, and share a verifiable audience report with
          sponsors.
        </p>

        <button
          style={{
            ...styles.button,
            ...(loading ? styles.buttonDisabled : {}),
          }}
          onClick={() => void handleConnect()}
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? 'Connecting…' : 'Connect Wallet'}
        </button>

        {error && (
          <div style={styles.error} role="alert">
            {error}
          </div>
        )}

        <p style={styles.footnote}>
          Supports Freighter, xBull, and other Stellar wallets.
        </p>
      </div>
    </main>
  );
}
