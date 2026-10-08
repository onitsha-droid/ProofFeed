import React from 'react';

interface MetricCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
}

export function MetricCard({ label, value, subtitle }: MetricCardProps) {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: '0.75rem',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--color-text-muted)',
          fontWeight: 500,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: '2rem',
          fontWeight: 700,
          color: 'var(--color-text)',
          lineHeight: 1.1,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </span>
      {subtitle && (
        <span
          style={{
            fontSize: '0.8rem',
            color: 'var(--color-text-muted)',
          }}
        >
          {subtitle}
        </span>
      )}
    </div>
  );
}
