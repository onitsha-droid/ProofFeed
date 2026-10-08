import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export function LookupPage() {
  const [address, setAddress] = useState('');
  const [touched, setTouched] = useState(false);
  const navigate = useNavigate();

  const isValid = STELLAR_ADDRESS_REGEX.test(address);
  const showError = touched && address.length > 0 && !isValid;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (isValid) {
      navigate(`/report/${address}`);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 20px',
        background: 'var(--color-bg)',
      }}
    >
      {/* Logo / title area */}
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 12,
          }}
        >
          <span
            style={{
              fontSize: '1.6rem',
              background: 'linear-gradient(135deg, #58a6ff, #3fb950)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              fontWeight: 800,
              letterSpacing: '-0.5px',
            }}
          >
            ProofFeed
          </span>
          <span
            style={{
              fontSize: '0.65rem',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              padding: '2px 8px',
              background: 'rgba(88, 166, 255, 0.15)',
              border: '1px solid rgba(88, 166, 255, 0.3)',
              borderRadius: 4,
              color: 'var(--color-accent)',
            }}
          >
            Brand
          </span>
        </div>
        <h1
          style={{
            fontSize: '1.9rem',
            fontWeight: 700,
            color: 'var(--color-text)',
            marginBottom: 12,
            lineHeight: 1.2,
          }}
        >
          Verify a creator's audience
        </h1>
        <p
          style={{
            fontSize: '1rem',
            color: 'var(--color-text-muted)',
            maxWidth: 480,
            margin: '0 auto',
            lineHeight: 1.6,
          }}
        >
          Reports are generated live from on-chain data.{' '}
          <strong style={{ color: 'var(--color-text)' }}>No screenshots. No self-reported numbers.</strong>
        </p>
      </div>

      {/* Lookup card */}
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          padding: '32px',
          boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
        }}
      >
        <form onSubmit={handleSubmit} noValidate>
          <div style={{ marginBottom: 20 }}>
            <label
              htmlFor="creator-address"
              style={{
                display: 'block',
                fontSize: '0.85rem',
                fontWeight: 500,
                color: 'var(--color-text-muted)',
                marginBottom: 8,
              }}
            >
              Creator Stellar address
            </label>
            <input
              id="creator-address"
              type="text"
              placeholder="G... (56 characters)"
              value={address}
              onChange={(e) => setAddress(e.target.value.trim())}
              onBlur={() => setTouched(true)}
              autoComplete="off"
              spellCheck={false}
              style={{
                width: '100%',
                padding: '12px 14px',
                background: 'var(--color-bg)',
                border: `1px solid ${showError ? 'var(--color-danger)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius)',
                color: 'var(--color-text)',
                fontSize: '0.9rem',
                fontFamily: 'var(--font-mono)',
                outline: 'none',
                transition: 'border-color 0.15s',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-accent)';
              }}
              onBlurCapture={(e) => {
                if (!showError) e.currentTarget.style.borderColor = 'var(--color-border)';
              }}
            />
            {showError && (
              <p
                role="alert"
                style={{
                  marginTop: 6,
                  fontSize: '0.78rem',
                  color: 'var(--color-danger)',
                }}
              >
                Must start with G and be exactly 56 characters.
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={!isValid && touched}
            style={{
              width: '100%',
              padding: '12px',
              background: 'var(--color-accent)',
              color: '#0d1117',
              border: 'none',
              borderRadius: 'var(--radius)',
              fontWeight: 700,
              fontSize: '0.95rem',
              cursor: isValid ? 'pointer' : 'not-allowed',
              opacity: touched && !isValid ? 0.5 : 1,
              transition: 'opacity 0.15s, background 0.15s',
            }}
            onMouseEnter={(e) => {
              if (isValid) e.currentTarget.style.background = 'var(--color-accent-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-accent)';
            }}
          >
            View Report
          </button>
        </form>
      </div>

      {/* How it works note */}
      <div
        style={{
          marginTop: 48,
          maxWidth: 520,
          textAlign: 'center',
        }}
      >
        <p style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
          ProofFeed reads aggregate subscriber and payment data directly from Soroban smart
          contracts on the Stellar network. Individual subscriber identities are never exposed.{' '}
          <a
            href="https://stellar.org"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--color-accent)' }}
          >
            Learn more about Stellar →
          </a>
        </p>
      </div>
    </div>
  );
}
