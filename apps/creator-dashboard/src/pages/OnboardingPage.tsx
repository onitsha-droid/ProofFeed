/**
 * OnboardingPage.tsx
 *
 * Guides a newly-connected creator through registering on the
 * SubscriptionRegistry contract and defining their subscription tiers.
 *
 * Flow:
 *   1. Show connected wallet address.
 *   2. Dynamic tier editor (add / remove tiers).
 *   3. Submit → call registerCreator() → show success with link to /stats.
 */

import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useWalletContext, useRegistration } from '../App';
import { registerCreator, Tier } from '../lib/contract';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'var(--color-bg)',
    padding: '2rem 1rem',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  container: {
    maxWidth: '600px',
    width: '100%',
  },
  header: {
    marginBottom: '2rem',
  },
  title: {
    fontSize: '1.75rem',
    fontWeight: 700,
    color: 'var(--color-text)',
    marginBottom: '0.5rem',
  },
  subtitle: {
    color: 'var(--color-muted)',
    fontSize: '0.9rem',
  },
  addressBadge: {
    display: 'inline-block',
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    padding: '0.4rem 0.75rem',
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    color: 'var(--color-muted)',
    wordBreak: 'break-all',
    marginTop: '0.5rem',
  },
  section: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    padding: '1.5rem',
    marginBottom: '1.5rem',
  },
  sectionTitle: {
    fontSize: '1rem',
    fontWeight: 600,
    color: 'var(--color-text)',
    marginBottom: '1rem',
  },
  tierRow: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'center',
    marginBottom: '0.75rem',
  },
  input: {
    flex: 1,
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    padding: '0.5rem 0.75rem',
    color: 'var(--color-text)',
    fontSize: '0.9rem',
    outline: 'none',
  },
  inputPrice: {
    width: '120px',
    flex: 'none',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    padding: '0.5rem 0.75rem',
    color: 'var(--color-text)',
    fontSize: '0.9rem',
    outline: 'none',
  },
  removeBtn: {
    background: 'transparent',
    border: '1px solid var(--color-danger)',
    borderRadius: 'var(--radius)',
    color: 'var(--color-danger)',
    padding: '0.4rem 0.65rem',
    fontSize: '0.85rem',
    cursor: 'pointer',
    flexShrink: 0,
  },
  addBtn: {
    background: 'transparent',
    border: '1px dashed var(--color-border)',
    borderRadius: 'var(--radius)',
    color: 'var(--color-muted)',
    padding: '0.5rem 1rem',
    fontSize: '0.875rem',
    cursor: 'pointer',
    width: '100%',
    marginTop: '0.25rem',
    transition: 'border-color 0.15s, color 0.15s',
  },
  submitBtn: {
    background: 'var(--color-accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: '#fff',
    padding: '0.75rem 2rem',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%',
    marginTop: '0.5rem',
    transition: 'background 0.15s',
  },
  labelRow: {
    display: 'flex',
    gap: '0.75rem',
    marginBottom: '0.4rem',
    paddingRight: '2.5rem', // account for remove button
  },
  label: {
    flex: 1,
    fontSize: '0.75rem',
    color: 'var(--color-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  labelPrice: {
    width: '120px',
    flex: 'none',
    fontSize: '0.75rem',
    color: 'var(--color-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  error: {
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid var(--color-danger)',
    borderRadius: 'var(--radius)',
    color: 'var(--color-danger)',
    padding: '0.75rem 1rem',
    fontSize: '0.875rem',
    marginBottom: '1rem',
  },
  success: {
    background: 'rgba(34,197,94,0.1)',
    border: '1px solid var(--color-success)',
    borderRadius: 'var(--radius)',
    color: 'var(--color-success)',
    padding: '1.25rem 1.5rem',
    fontSize: '0.95rem',
    textAlign: 'center' as const,
  },
  successLink: {
    display: 'inline-block',
    marginTop: '1rem',
    padding: '0.6rem 1.5rem',
    background: 'var(--color-success)',
    color: '#fff',
    borderRadius: 'var(--radius)',
    fontWeight: 600,
    fontSize: '0.9rem',
    textDecoration: 'none',
  },
  txHash: {
    fontFamily: 'monospace',
    fontSize: '0.78rem',
    wordBreak: 'break-all' as const,
    opacity: 0.7,
    marginTop: '0.5rem',
  },
  disconnectLink: {
    display: 'block',
    textAlign: 'right' as const,
    fontSize: '0.8rem',
    color: 'var(--color-muted)',
    marginBottom: '1.5rem',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
  },
};

// ---------------------------------------------------------------------------
// Tier form item (local, un-submitted state)
// ---------------------------------------------------------------------------

interface TierDraft {
  key: number;         // stable React key
  name: string;
  priceUsdc: string;   // user types a decimal USDC amount
}

let _keyCounter = 0;
function nextKey() { return ++_keyCounter; }

const DEFAULT_TIERS: TierDraft[] = [
  { key: nextKey(), name: 'Supporter', priceUsdc: '5.00' },
  { key: nextKey(), name: 'Member', priceUsdc: '10.00' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OnboardingPage(): React.ReactElement {
  const { address, kit, disconnect } = useWalletContext();
  const { setRegistered } = useRegistration();
  const navigate = useNavigate();

  const [tiers, setTiers] = useState<TierDraft[]>(DEFAULT_TIERS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // ---- Tier editor -------------------------------------------------------

  const updateTier = (key: number, field: 'name' | 'priceUsdc', value: string) => {
    setTiers((prev) =>
      prev.map((t) => (t.key === key ? { ...t, [field]: value } : t))
    );
  };

  const addTier = () => {
    setTiers((prev) => [
      ...prev,
      { key: nextKey(), name: '', priceUsdc: '' },
    ]);
  };

  const removeTier = (key: number) => {
    setTiers((prev) => prev.filter((t) => t.key !== key));
  };

  // ---- Validation --------------------------------------------------------

  const validate = (): string | null => {
    if (tiers.length === 0) return 'Add at least one subscription tier.';
    for (const t of tiers) {
      if (!t.name.trim()) return 'All tiers must have a name.';
      const price = parseFloat(t.priceUsdc);
      if (isNaN(price) || price <= 0) {
        return `Tier "${t.name}" has an invalid price.`;
      }
    }
    return null;
  };

  // ---- Submit ------------------------------------------------------------

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    if (!address) return;

    // Convert USDC decimal prices → stroops (bigint)
    const contractTiers: Tier[] = tiers.map((t, i) => ({
      id: i + 1,
      name: t.name.trim(),
      // 1 USDC = 10_000_000 stroops; parseFloat gives us the decimal USDC value
      price: BigInt(Math.round(parseFloat(t.priceUsdc) * 10_000_000)),
    }));

    setSubmitting(true);
    try {
      const hash = await registerCreator(kit, address, contractTiers);
      setTxHash(hash);
      setRegistered(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Render success state ---------------------------------------------

  if (txHash) {
    return (
      <main style={S.page} role="main">
        <div style={S.container}>
          <div style={S.success} role="status">
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🎉</div>
            <strong>You're registered on-chain!</strong>
            <p style={{ marginTop: '0.5rem', color: 'var(--color-text)', opacity: 0.8 }}>
              Your subscription tiers have been recorded in the SubscriptionRegistry
              contract. Brands can now verify your audience directly from the ledger.
            </p>
            <p style={S.txHash}>Tx: {txHash}</p>
            <Link to="/stats" style={S.successLink} onClick={() => navigate('/stats')}>
              View Your Stats →
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // ---- Render form -------------------------------------------------------

  return (
    <main style={S.page} role="main">
      <div style={S.container}>
        {/* Header */}
        <div style={S.header}>
          <h1 style={S.title}>Set Up Your Creator Profile</h1>
          <p style={S.subtitle}>
            Define your subscription tiers. These will be registered on the
            Stellar testnet via the SubscriptionRegistry contract.
          </p>
        </div>

        {/* Wallet info + disconnect */}
        <button
          style={S.disconnectLink}
          onClick={() => { disconnect(); navigate('/'); }}
          type="button"
        >
          Disconnect wallet
        </button>

        <form onSubmit={(e) => void handleSubmit(e)}>
          {/* Connected wallet */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Connected Wallet</div>
            <div style={S.addressBadge} aria-label="Connected wallet address">
              {address}
            </div>
          </div>

          {/* Tiers */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Subscription Tiers</div>

            {/* Column labels */}
            {tiers.length > 0 && (
              <div style={S.labelRow}>
                <span style={S.label}>Tier Name</span>
                <span style={S.labelPrice}>Price (USDC)</span>
              </div>
            )}

            {tiers.map((tier, idx) => (
              <div style={S.tierRow} key={tier.key}>
                <input
                  style={S.input}
                  type="text"
                  placeholder={`e.g. Tier ${idx + 1}`}
                  value={tier.name}
                  onChange={(e) => updateTier(tier.key, 'name', e.target.value)}
                  aria-label={`Tier ${idx + 1} name`}
                  maxLength={64}
                  required
                />
                <input
                  style={S.inputPrice}
                  type="number"
                  placeholder="5.00"
                  value={tier.priceUsdc}
                  onChange={(e) => updateTier(tier.key, 'priceUsdc', e.target.value)}
                  aria-label={`Tier ${idx + 1} price in USDC`}
                  min="0.01"
                  step="0.01"
                  required
                />
                <button
                  type="button"
                  style={S.removeBtn}
                  onClick={() => removeTier(tier.key)}
                  aria-label={`Remove tier ${idx + 1}`}
                  disabled={tiers.length === 1}
                >
                  ✕
                </button>
              </div>
            ))}

            <button type="button" style={S.addBtn} onClick={addTier}>
              + Add Tier
            </button>
          </div>

          {/* Error */}
          {error && (
            <div style={S.error} role="alert">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            style={{
              ...S.submitBtn,
              ...(submitting ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
            }}
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? 'Submitting to Stellar…' : 'Register as Creator'}
          </button>
        </form>
      </div>
    </main>
  );
}
