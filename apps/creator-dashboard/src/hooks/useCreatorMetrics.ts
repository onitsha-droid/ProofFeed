/**
 * useCreatorMetrics.ts
 *
 * Fetches creator metrics and retention data from the ProofFeed indexer API.
 *
 * Endpoints consumed:
 *   GET {VITE_INDEXER_URL}/api/creators/:address/metrics
 *   GET {VITE_INDEXER_URL}/api/creators/:address/retention
 */

import { useState, useEffect } from 'react';

const INDEXER_URL =
  import.meta.env.VITE_INDEXER_URL ?? 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreatorMetrics {
  activeSubscribers: number;
  /** Raw stroops value as a string (can be very large). */
  lifetimeRevenueStroops: string;
  churnEvents: number;
  /** 0–1 irregularity score; null means insufficient data. */
  entropyScore: number | null;
}

export interface RetentionRow {
  cohortMonth: string;       // ISO date string YYYY-MM-DD
  monthsSinceJoin: number;
  retentionRate: number;     // 0.0 – 1.0
  cohortSize: number;
}

export interface UseCreatorMetricsResult {
  metrics: CreatorMetrics | null;
  retention: RetentionRow[];
  loading: boolean;
  error: string | null;
  /** Call this to manually re-fetch (e.g. after a new transaction lands). */
  refetch: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCreatorMetrics(address: string | null): UseCreatorMetricsResult {
  const [metrics, setMetrics] = useState<CreatorMetrics | null>(null);
  const [retention, setRetention] = useState<RetentionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Incrementing this counter triggers a re-fetch without changing address.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!address) {
      setMetrics(null);
      setRetention([]);
      setError(null);
      return;
    }

    let cancelled = false;

    const fetchAll = async () => {
      setLoading(true);
      setError(null);

      try {
        const [metricsRes, retentionRes] = await Promise.all([
          fetch(`${INDEXER_URL}/api/creators/${encodeURIComponent(address)}/metrics`),
          fetch(`${INDEXER_URL}/api/creators/${encodeURIComponent(address)}/retention`),
        ]);

        if (!metricsRes.ok) {
          throw new Error(
            `Metrics request failed: ${metricsRes.status} ${metricsRes.statusText}`
          );
        }
        if (!retentionRes.ok) {
          throw new Error(
            `Retention request failed: ${retentionRes.status} ${retentionRes.statusText}`
          );
        }

        const metricsData: CreatorMetrics = await metricsRes.json();
        const retentionData: RetentionRow[] = await retentionRes.json();

        if (!cancelled) {
          setMetrics(metricsData);
          setRetention(retentionData);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void fetchAll();

    return () => {
      cancelled = true;
    };
  }, [address, tick]);

  const refetch = () => setTick((t) => t + 1);

  return { metrics, retention, loading, error, refetch };
}
