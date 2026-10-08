import React from 'react';

interface EntropyBarProps {
  score: number; // 0–1
  disclaimer: string;
}

function getEntropyColor(score: number): string {
  if (score >= 0.7) return 'var(--color-success)';
  if (score >= 0.4) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

function getEntropyLabel(score: number): string {
  if (score >= 0.7) return 'High irregularity — consistent with organic audience';
  if (score >= 0.4) return 'Moderate irregularity';
  return 'Low irregularity — warrants further review';
}

export function EntropyBar({ score, disclaimer }: EntropyBarProps) {
  const clamped = Math.min(1, Math.max(0, score));
  const pct = Math.round(clamped * 100);
  const color = getEntropyColor(clamped);
  const label = getEntropyLabel(clamped);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
          Payment Pattern Irregularity Score
        </span>
        <span
          style={{
            fontSize: '1.4rem',
            fontWeight: 700,
            color,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {clamped.toFixed(2)}
          <span style={{ fontSize: '0.75rem', fontWeight: 400, color: 'var(--color-text-muted)', marginLeft: 4 }}>
            / 1.00
          </span>
        </span>
      </div>

      {/* Track */}
      <div
        style={{
          height: 12,
          borderRadius: 6,
          background: 'var(--color-surface-2)',
          overflow: 'hidden',
          position: 'relative',
        }}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Entropy score: ${pct}%`}
      >
        {/* Fill */}
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            borderRadius: 6,
            background: color,
            transition: 'width 0.4s ease',
          }}
        />
      </div>

      <span style={{ fontSize: '0.8rem', color }}>
        {label}
      </span>

      {/* Required disclaimer per README Anti-Fraud section */}
      <p
        style={{
          fontSize: '0.75rem',
          color: 'var(--color-text-muted)',
          lineHeight: 1.5,
          padding: '10px 14px',
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
        }}
      >
        {disclaimer}
      </p>
    </div>
  );
}
