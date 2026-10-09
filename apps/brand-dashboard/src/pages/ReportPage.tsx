import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useCreatorReport } from '../hooks/useCreatorReport';
import { MetricCard } from '../components/MetricCard';
import { EntropyBar } from '../components/EntropyBar';
import { RetentionTable } from '../components/RetentionTable';

const ENTROPY_DISCLAIMER =
  'This score reflects statistical irregularity in payment timing and amounts. A higher score ' +
  'suggests more natural variation typical of organic audiences. This is a confidence signal ' +
  'only — it is not proof of fraud or its absence. ProofFeed cannot guarantee subscriber authenticity.';

function truncateAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-8)}`;
}

/**
 * Convert a stroops string to a human-readable USDC amount.
 * 1 USDC = 10,000,000 stroops.
 *
 * Accepts the value as a string (not number) because lifetimeRevenueStroops
 * can exceed Number.MAX_SAFE_INTEGER (~9 quadrillion stroops ≈ $900M USDC)
 * for high-volume creators, causing precision loss with plain JS numbers.
 */
function stroopsToUsdc(stroops: string): string {
  const n = BigInt(stroops);
  const whole = n / 10_000_000n;
  const remainder = n % 10_000_000n;
  // Two decimal places; pad remainder to 7 digits then take first 2.
  const cents = remainder.toString().padStart(7, '0').slice(0, 2);
  return `${whole.toLocaleString('en-US')}.${cents}`;
}

export function ReportPage() {
  const { address } = useParams<{ address: string }>();
  const creatorAddress = address ?? '';

  const { metrics, retention, loading, error } = useCreatorReport(creatorAddress);
  const [copied, setCopied] = useState(false);

  const generatedAt = new Date().toISOString();
  const badgeUrl = `${window.location.origin}/badge/${creatorAddress}`;

  function copyBadgeUrl() {
    navigator.clipboard.writeText(badgeUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback: select from a temporary input
      const el = document.createElement('input');
      el.value = badgeUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (loading) {
    return (
      <div style={pageWrapStyle}>
        <div style={spinnerWrapStyle}>
          <div style={spinnerStyle} />
          <p style={{ color: 'var(--color-text-muted)', marginTop: 16 }}>
            Fetching live on-chain data…
          </p>
        </div>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div style={pageWrapStyle}>
        <div
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-danger)',
            borderRadius: 'var(--radius)',
            padding: '32px',
            maxWidth: 520,
            textAlign: 'center',
          }}
        >
          <p style={{ color: 'var(--color-danger)', fontWeight: 600, marginBottom: 8 }}>
            Failed to load report
          </p>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem', marginBottom: 20 }}>
            {error ?? 'No data returned. The creator address may be invalid or not yet registered.'}
          </p>
          <Link to="/" style={{ color: 'var(--color-accent)', fontSize: '0.9rem' }}>
            ← Back to lookup
          </Link>
        </div>
      </div>
    );
  }

  // Derived metrics
  const totalEverSubscribed = metrics.activeSubscribers + metrics.churnEvents;
  const churnRate =
    totalEverSubscribed > 0
      ? ((metrics.churnEvents / totalEverSubscribed) * 100).toFixed(1)
      : '0.0';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg)',
        padding: '40px 20px',
      }}
    >
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        {/* ── Header ── */}
        <div style={{ marginBottom: 32 }}>
          <Link
            to="/"
            style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', display: 'inline-block', marginBottom: 20 }}
          >
            ← Back to lookup
          </Link>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <div>
              <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: 4 }}>
                Creator address
              </p>
              <p
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.9rem',
                  color: 'var(--color-text)',
                  wordBreak: 'break-all',
                }}
              >
                {creatorAddress}
              </p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: '0.75rem',
                  color: 'var(--color-verified)',
                  fontWeight: 600,
                  padding: '4px 10px',
                  background: 'rgba(63, 185, 80, 0.1)',
                  border: '1px solid rgba(63, 185, 80, 0.3)',
                  borderRadius: 20,
                }}
              >
                ✓ Proof of Audience Report
              </span>
            </div>
          </div>

          <h1
            style={{
              fontSize: '1.6rem',
              fontWeight: 700,
              color: 'var(--color-text)',
              marginTop: 16,
              marginBottom: 4,
            }}
          >
            Proof of Audience Report
          </h1>
          <p style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
            Generated live — {generatedAt}
          </p>
        </div>

        {/* ── Metric cards ── */}
        <section style={{ marginBottom: 40 }}>
          <h2 style={sectionHeadingStyle}>Audience Metrics</h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 16,
            }}
          >
            <MetricCard
              label="Active Subscribers"
              value={metrics.activeSubscribers.toLocaleString()}
            />
            <MetricCard
              label="Lifetime Revenue"
              value={`$${stroopsToUsdc(metrics.lifetimeRevenueStroops)}`}
              subtitle="USDC (on-chain)"
            />
            <MetricCard
              label="Churn Events"
              value={metrics.churnEvents.toLocaleString()}
            />
            <MetricCard
              label="Churn Rate"
              value={`${churnRate}%`}
              subtitle={`${metrics.churnEvents} of ${totalEverSubscribed.toLocaleString()} ever-subscribed`}
            />
          </div>
        </section>

        {/* ── Entropy Score ── */}
        <section
          style={{
            marginBottom: 40,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            padding: '24px',
          }}
        >
          <h2 style={{ ...sectionHeadingStyle, marginBottom: 16 }}>Audience Authenticity Signal</h2>
          <EntropyBar score={metrics.entropyScore} disclaimer={ENTROPY_DISCLAIMER} />
        </section>

        {/* ── Retention Curve ── */}
        <section
          style={{
            marginBottom: 40,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            padding: '24px',
          }}
        >
          <h2 style={{ ...sectionHeadingStyle, marginBottom: 4 }}>Retention Curve</h2>
          <p style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)', marginBottom: 16 }}>
            Percentage of each subscriber cohort still active N months after joining.
          </p>
          <RetentionTable retention={retention} />
        </section>

        {/* ── Sharing + badge ── */}
        <section
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            padding: '24px',
            marginBottom: 32,
          }}
        >
          <h2 style={{ ...sectionHeadingStyle, marginBottom: 12 }}>Verification Badge</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', marginBottom: 16 }}>
            The live badge always resolves to current on-chain state — never a stale screenshot.
            Share it with sponsors or embed it in a media kit.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            <button
              onClick={copyBadgeUrl}
              style={{
                padding: '10px 20px',
                background: 'var(--color-accent)',
                color: '#0d1117',
                border: 'none',
                borderRadius: 'var(--radius)',
                fontWeight: 700,
                fontSize: '0.9rem',
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-accent-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-accent)'; }}
            >
              {copied ? '✓ Copied!' : '📋 Share Verification Badge'}
            </button>
            <Link
              to={`/badge/${creatorAddress}`}
              style={{
                padding: '10px 20px',
                background: 'transparent',
                color: 'var(--color-accent)',
                border: '1px solid var(--color-accent)',
                borderRadius: 'var(--radius)',
                fontWeight: 600,
                fontSize: '0.9rem',
              }}
            >
              View Live Badge →
            </Link>
          </div>
          <p
            style={{
              marginTop: 12,
              fontSize: '0.75rem',
              color: 'var(--color-text-muted)',
              fontFamily: 'var(--font-mono)',
              wordBreak: 'break-all',
            }}
          >
            {badgeUrl}
          </p>
        </section>

        {/* ── Privacy note ── */}
        <p
          style={{
            fontSize: '0.75rem',
            color: 'var(--color-text-muted)',
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          🔒 This report shows aggregate statistics only. Individual subscriber identities are not
          exposed.
        </p>
      </div>
    </div>
  );
}

const pageWrapStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--color-bg)',
  padding: '40px 20px',
};

const spinnerWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
};

const spinnerStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  border: '3px solid var(--color-border)',
  borderTopColor: 'var(--color-accent)',
  borderRadius: '50%',
  animation: 'spin 0.8s linear infinite',
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--color-text-muted)',
  marginBottom: 16,
};
