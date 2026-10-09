import React, { useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useCreatorReport } from '../hooks/useCreatorReport';

/**
 * DESIGN NOTE — "Always Live" Guarantee
 * ───────────────────────────────────────
 * This badge is ProofFeed's core trust signal. A brand or sponsor shares this URL
 * in a media kit, a Slack message, or a proposal — and every person who clicks it
 * sees the *current* on-chain state, not a cached snapshot from when the URL was
 * first shared.
 *
 * To enforce this:
 *  - useCreatorReport does NOT use localStorage or sessionStorage.
 *  - React's useEffect fires on every mount, so every fresh page load triggers a
 *    new network request to the indexer, which in turn reads directly from the
 *    Soroban contract state.
 *  - No HTTP cache headers trick: the indexer should serve these endpoints with
 *    Cache-Control: no-store (enforced server-side), but even if a CDN caches
 *    briefly, the client always *requests* fresh data.
 *
 * This is the whole point: "Don't trust the screenshot. Verify the ledger."
 */

function truncateAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-8)}`;
}

export function BadgePage() {
  const { address } = useParams<{ address: string }>();
  const creatorAddress = address ?? '';

  // useCreatorReport refetches on every mount — no caching, always live.
  const { metrics, loading, error } = useCreatorReport(creatorAddress);

  const loadedAt = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  // Update document meta tags for Open Graph previews when data arrives.
  useEffect(() => {
    if (!metrics) return;

    const ogTitle = `ProofFeed Verified — ${truncateAddress(creatorAddress)}`;
    const ogDesc =
      `${metrics.activeSubscribers.toLocaleString()} active subscribers · ` +
      (metrics.entropyScore !== null
        ? `Entropy score ${metrics.entropyScore.toFixed(2)} · `
        : '') +
      `Verified live from Stellar blockchain`;

    // og:title
    let metaTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
    if (!metaTitle) {
      metaTitle = document.createElement('meta');
      metaTitle.setAttribute('property', 'og:title');
      document.head.appendChild(metaTitle);
    }
    metaTitle.setAttribute('content', ogTitle);

    // og:description
    let metaDesc = document.querySelector<HTMLMetaElement>('meta[property="og:description"]');
    if (!metaDesc) {
      metaDesc = document.createElement('meta');
      metaDesc.setAttribute('property', 'og:description');
      document.head.appendChild(metaDesc);
    }
    metaDesc.setAttribute('content', ogDesc);

    // og:url
    let metaUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]');
    if (!metaUrl) {
      metaUrl = document.createElement('meta');
      metaUrl.setAttribute('property', 'og:url');
      document.head.appendChild(metaUrl);
    }
    metaUrl.setAttribute('content', window.location.href);

    // twitter:card
    let twitterCard = document.querySelector<HTMLMetaElement>('meta[name="twitter:card"]');
    if (!twitterCard) {
      twitterCard = document.createElement('meta');
      twitterCard.setAttribute('name', 'twitter:card');
      document.head.appendChild(twitterCard);
    }
    twitterCard.setAttribute('content', 'summary');

    document.title = ogTitle;
  }, [metrics, creatorAddress]);

  // ── Loading state ──
  if (loading) {
    return (
      <div style={outerStyle}>
        <div style={badgeCardStyle}>
          <div style={verifiedHeaderStyle}>
            <span style={{ fontSize: '1.1rem' }}>⏳</span>
            <span>Loading live data…</span>
          </div>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.82rem', textAlign: 'center' }}>
            Querying the Stellar blockchain…
          </p>
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (error || !metrics) {
    return (
      <div style={outerStyle}>
        <div style={{ ...badgeCardStyle, borderColor: 'var(--color-danger)' }}>
          <div
            style={{
              ...verifiedHeaderStyle,
              background: 'rgba(248, 81, 73, 0.1)',
              borderColor: 'rgba(248, 81, 73, 0.2)',
              color: 'var(--color-danger)',
            }}
          >
            <span>⚠</span>
            <span>Verification Unavailable</span>
          </div>
          <p
            style={{
              color: 'var(--color-text-muted)',
              fontSize: '0.82rem',
              textAlign: 'center',
              lineHeight: 1.6,
            }}
          >
            Could not load verification data. The creator address may be invalid or the indexer
            unavailable.
          </p>
          <Link
            to="/"
            style={{
              marginTop: 16,
              display: 'inline-block',
              fontSize: '0.8rem',
              color: 'var(--color-accent)',
              textAlign: 'center',
            }}
          >
            Try another address →
          </Link>
        </div>
      </div>
    );
  }

  // ── Badge ──
  return (
    <div style={outerStyle}>
      <div style={badgeCardStyle}>
        {/* ProofFeed Verified header */}
        <div style={verifiedHeaderStyle}>
          <span style={{ fontSize: '1.1rem' }}>✓</span>
          <span>ProofFeed Verified</span>
        </div>

        {/* Creator address */}
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <p style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginBottom: 4 }}>
            Creator address
          </p>
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.82rem',
              color: 'var(--color-text)',
              wordBreak: 'break-all',
            }}
            title={creatorAddress}
          >
            {truncateAddress(creatorAddress)}
          </p>
        </div>

        {/* Stats row */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            justifyContent: 'center',
            marginBottom: 20,
            flexWrap: 'wrap',
          }}
        >
          <StatPill label="Active Subscribers" value={metrics.activeSubscribers.toLocaleString()} />
          <StatPill
            label="Entropy Score"
            value={metrics.entropyScore !== null ? metrics.entropyScore.toFixed(2) : '—'}
            subtitle="/ 1.00"
          />
        </div>

        {/* Footer */}
        <div
          style={{
            borderTop: '1px solid var(--color-border)',
            paddingTop: 14,
            textAlign: 'center',
          }}
        >
          <p
            style={{
              fontSize: '0.7rem',
              color: 'var(--color-verified)',
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            ⛓ Verified live from Stellar blockchain
          </p>
          <p style={{ fontSize: '0.67rem', color: 'var(--color-text-muted)', marginBottom: 10 }}>
            {loadedAt}
          </p>
          <Link
            to={`/report/${creatorAddress}`}
            style={{
              fontSize: '0.78rem',
              color: 'var(--color-accent)',
              fontWeight: 500,
            }}
          >
            View full report →
          </Link>
        </div>
      </div>

      {/* Context note below card */}
      <p
        style={{
          marginTop: 20,
          fontSize: '0.72rem',
          color: 'var(--color-text-muted)',
          textAlign: 'center',
          maxWidth: 360,
          lineHeight: 1.6,
        }}
      >
        This badge fetches live data on every load. No screenshots. No cached numbers.{' '}
        <Link to="/" style={{ color: 'var(--color-accent)' }}>
          Verify another creator
        </Link>
      </p>
    </div>
  );
}

// ── Sub-component ──
function StatPill({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <div
      style={{
        background: 'var(--color-surface-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        padding: '10px 18px',
        textAlign: 'center',
        minWidth: 110,
      }}
    >
      <p style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)', marginBottom: 4 }}>
        {label}
      </p>
      <p style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>
        {value}
        {subtitle && (
          <span style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--color-text-muted)', marginLeft: 2 }}>
            {subtitle}
          </span>
        )}
      </p>
    </div>
  );
}

// ── Styles ──
const outerStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--color-bg)',
  padding: '40px 20px',
};

const badgeCardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 360,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 16,
  padding: '24px 28px',
  boxShadow: '0 4px 32px rgba(0, 0, 0, 0.4)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
};

const verifiedHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '8px 14px',
  borderRadius: 8,
  background: 'rgba(63, 185, 80, 0.1)',
  border: '1px solid rgba(63, 185, 80, 0.25)',
  color: 'var(--color-verified)',
  fontWeight: 700,
  fontSize: '0.95rem',
  marginBottom: 20,
};
