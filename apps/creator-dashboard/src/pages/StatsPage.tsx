/**
 * StatsPage.tsx
 *
 * Shows the creator's live proof-of-audience stats fetched from the indexer:
 *   • Metrics cards (active subscribers, lifetime revenue, churn, entropy)
 *   • Retention curve table
 *   • Copy-to-clipboard verification badge link
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWalletContext, useRegistration } from '../App';
import { useCreatorMetrics } from '../hooks/useCreatorMetrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a stroops string to a human-readable USDC amount.
 * 1 USDC = 10_000_000 stroops.
 */
function stroopsToUsdc(stroops: string): string {
  const n = BigInt(stroops);
  const whole = n / 10_000_000n;
  const remainder = n % 10_000_000n;
  const decimals = remainder.toString().padStart(7, '0').replace(/0+$/, '') || '00';
  return `$${whole.toLocaleString()}.${decimals.slice(0, 2)} USDC`;
}

/**
 * Format a retention rate (0–1) as a percentage string.
 */
function fmtRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Format a YYYY-MM-DD cohort month as a readable label.
 */
function fmtCohortMonth(iso: string): string {
  const [year, month] = iso.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'var(--color-bg)',
    padding: '2rem 1rem',
  },
  container: {
    maxWidth: '860px',
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    flexWrap: 'wrap' as const,
    gap: '0.75rem',
    marginBottom: '2rem',
  },
  title: {
    fontSize: '1.75rem',
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  addressBadge: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    color: 'var(--color-muted)',
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    padding: '0.3rem 0.6rem',
    maxWidth: '200px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
    gap: '1rem',
    marginBottom: '2rem',
  },
  card: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    padding: '1.25rem',
  },
  cardLabel: {
    fontSize: '0.75rem',
    color: 'var(--color-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    marginBottom: '0.5rem',
  },
  cardValue: {
    fontSize: '1.75rem',
    fontWeight: 700,
    color: 'var(--color-text)',
    lineHeight: 1.1,
  },
  cardSub: {
    fontSize: '0.75rem',
    color: 'var(--color-muted)',
    marginTop: '0.25rem',
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
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '0.875rem',
  },
  th: {
    textAlign: 'left' as const,
    padding: '0.5rem 0.75rem',
    color: 'var(--color-muted)',
    fontSize: '0.75rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    borderBottom: '1px solid var(--color-border)',
  },
  td: {
    padding: '0.5rem 0.75rem',
    color: 'var(--color-text)',
    borderBottom: '1px solid var(--color-border)',
  },
  tdMuted: {
    padding: '0.5rem 0.75rem',
    color: 'var(--color-muted)',
    borderBottom: '1px solid var(--color-border)',
    fontFamily: 'monospace',
  },
  emptyRow: {
    padding: '1.5rem 0.75rem',
    color: 'var(--color-muted)',
    textAlign: 'center' as const,
    fontStyle: 'italic',
  },
  badgeBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.6rem 1.25rem',
    background: 'var(--color-accent)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: '#fff',
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  copiedBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.6rem 1.25rem',
    background: 'var(--color-success)',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: '#fff',
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'default',
  },
  error: {
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid var(--color-danger)',
    borderRadius: 'var(--radius)',
    color: 'var(--color-danger)',
    padding: '0.75rem 1rem',
    fontSize: '0.875rem',
    marginBottom: '1.5rem',
  },
  skeleton: {
    background: 'linear-gradient(90deg, var(--color-surface) 25%, var(--color-border) 50%, var(--color-surface) 75%)',
    backgroundSize: '200% 100%',
    animation: 'shimmer 1.5s infinite',
    borderRadius: '4px',
    height: '1.75rem',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexWrap: 'wrap' as const,
    marginTop: '0.5rem',
  },
  disconnectBtn: {
    background: 'transparent',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    color: 'var(--color-muted)',
    padding: '0.4rem 0.9rem',
    fontSize: '0.8rem',
    cursor: 'pointer',
  },
};

// ---------------------------------------------------------------------------
// Skeleton card
// ---------------------------------------------------------------------------

function SkeletonCard(): React.ReactElement {
  return (
    <div style={S.card}>
      <div style={{ ...S.skeleton, height: '0.8rem', width: '60%', marginBottom: '0.75rem' }} />
      <div style={{ ...S.skeleton, height: '1.75rem', width: '80%' }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entropy label
// ---------------------------------------------------------------------------

function entropyLabel(score: number | null): string {
  if (score === null) return 'Insufficient data';
  if (score >= 0.7) return 'High — looks organic';
  if (score >= 0.4) return 'Moderate';
  return 'Low — patterns may be uniform';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StatsPage(): React.ReactElement {
  const { address, disconnect } = useWalletContext();
  const { setRegistered } = useRegistration();
  const { metrics, retention, loading, error, refetch } = useCreatorMetrics(address);
  const [copied, setCopied] = useState(false);

  const badgeUrl = address
    ? `${window.location.origin}/badge/${address}`
    : '';

  const copyBadge = async () => {
    if (!badgeUrl) return;
    try {
      await navigator.clipboard.writeText(badgeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback for browsers where clipboard API is blocked
      prompt('Copy this link:', badgeUrl);
    }
  };

  const handleDisconnect = () => {
    setRegistered(false);
    disconnect();
  };

  return (
    <main style={S.page} role="main">
      {/* Shimmer keyframe injected once */}
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>

      <div style={S.container}>
        {/* ---- Header ---- */}
        <div style={S.header}>
          <h1 style={S.title}>Your ProofFeed Stats</h1>
          <span
            style={S.addressBadge}
            title={address ?? ''}
            aria-label="Connected wallet address"
          >
            {address}
          </span>
        </div>

        {/* ---- Error ---- */}
        {error && (
          <div style={S.error} role="alert">
            <strong>Could not load metrics:</strong> {error}
            <button
              onClick={refetch}
              style={{
                marginLeft: '0.75rem',
                background: 'none',
                border: 'none',
                color: 'var(--color-accent)',
                cursor: 'pointer',
                fontSize: '0.875rem',
                textDecoration: 'underline',
              }}
            >
              Retry
            </button>
          </div>
        )}

        {/* ---- Metrics Cards ---- */}
        <div style={S.cardGrid}>
          {loading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : (
            <>
              {/* Active Subscribers */}
              <div style={S.card} aria-label="Active Subscribers">
                <div style={S.cardLabel}>Active Subscribers</div>
                <div style={S.cardValue}>
                  {metrics?.activeSubscribers?.toLocaleString() ?? '—'}
                </div>
              </div>

              {/* Lifetime Revenue */}
              <div style={S.card} aria-label="Lifetime Revenue">
                <div style={S.cardLabel}>Lifetime Revenue</div>
                <div style={{ ...S.cardValue, fontSize: '1.35rem' }}>
                  {metrics ? stroopsToUsdc(metrics.lifetimeRevenueStroops) : '—'}
                </div>
                {metrics && (
                  <div style={S.cardSub}>
                    {metrics.lifetimeRevenueStroops} stroops
                  </div>
                )}
              </div>

              {/* Churn Events */}
              <div style={S.card} aria-label="Churn Events">
                <div style={S.cardLabel}>Churn Events</div>
                <div style={S.cardValue}>
                  {metrics?.churnEvents?.toLocaleString() ?? '—'}
                </div>
                <div style={S.cardSub}>cancellations</div>
              </div>

              {/* Entropy Score */}
              <div style={S.card} aria-label="Entropy Score">
                <div style={S.cardLabel}>Payment Pattern Irregularity</div>
                <div style={S.cardValue}>
                  {metrics?.entropyScore != null
                    ? metrics.entropyScore.toFixed(2)
                    : '—'}
                </div>
                <div style={S.cardSub}>
                  {metrics ? entropyLabel(metrics.entropyScore) : 'Score 0–1'}
                </div>
              </div>
            </>
          )}
        </div>

        {/* ---- Retention Curve Table ---- */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Subscriber Retention Curve</div>
          {loading ? (
            <div style={{ ...S.skeleton, height: '8rem' }} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table} aria-label="Subscriber retention curve">
                <thead>
                  <tr>
                    <th style={S.th}>Cohort Month</th>
                    <th style={S.th}>Cohort Size</th>
                    <th style={S.th}>Months Since Join</th>
                    <th style={S.th}>Retention Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {retention.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={S.emptyRow}>
                        No retention data yet — retention curves appear after
                        subscribers renew their first payment.
                      </td>
                    </tr>
                  ) : (
                    retention.map((row) => (
                      <tr
                        key={`${row.cohortMonth}-${row.monthsSinceJoin}`}
                      >
                        <td style={S.tdMuted}>{fmtCohortMonth(row.cohortMonth)}</td>
                        <td style={S.td}>{row.cohortSize.toLocaleString()}</td>
                        <td style={S.td}>{row.monthsSinceJoin}</td>
                        <td style={{
                          ...S.td,
                          color: row.retentionRate >= 0.7
                            ? 'var(--color-success)'
                            : row.retentionRate >= 0.4
                              ? 'var(--color-warning)'
                              : 'var(--color-danger)',
                          fontWeight: 600,
                        }}>
                          {fmtRate(row.retentionRate)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ---- Actions ---- */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Share Your Verification Badge</div>
          <p style={{ color: 'var(--color-muted)', fontSize: '0.875rem', marginBottom: '1rem' }}>
            Send this link to sponsors. It resolves directly to your live
            on-chain stats — no screenshots, no self-reporting.
          </p>
          <div style={S.actions}>
            <button
              style={copied ? S.copiedBadge : S.badgeBtn}
              onClick={() => void copyBadge()}
              aria-label="Copy verification badge link to clipboard"
              disabled={!address}
            >
              {copied ? '✓ Copied!' : '⧉ Copy Verification Badge Link'}
            </button>
            <button
              style={S.disconnectBtn}
              onClick={handleDisconnect}
              type="button"
            >
              Disconnect
            </button>
          </div>
          {address && (
            <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--color-muted)' }}>
              <Link
                to={`/badge/${address}`}
                style={{ color: 'var(--color-accent)' }}
              >
                Preview badge redirect →
              </Link>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
