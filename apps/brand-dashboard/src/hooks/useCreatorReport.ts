import { useEffect, useState } from 'react';

export interface CreatorMetrics {
  activeSubscribers: number;
  /**
   * Total revenue in stroops as a string. Kept as string (not number) to avoid
   * precision loss for large values that exceed Number.MAX_SAFE_INTEGER.
   * 1 USDC = 10,000,000 stroops.
   */
  lifetimeRevenueStroops: string;
  churnEvents: number;
  /** 0–1 irregularity score, or null when insufficient data is available. */
  entropyScore: number | null;
}

export interface RetentionPoint {
  cohortMonth: string;
  monthsSinceJoin: number;
  retentionRate: number;
  cohortSize: number;
}

interface UseCreatorReportResult {
  metrics: CreatorMetrics | null;
  retention: RetentionPoint[];
  loading: boolean;
  error: string | null;
}

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL ?? 'http://localhost:3001';

/**
 * Fetches creator metrics and retention data from the indexer API.
 *
 * DESIGN: This hook intentionally does NOT use any localStorage or sessionStorage
 * caching. The badge page is a core trust signal — its whole purpose is to show
 * LIVE on-chain data every time a brand or sponsor loads it. Stale cached values
 * would undermine the "not a screenshot" guarantee that differentiates ProofFeed.
 * Every mount triggers a fresh fetch pair.
 */
export function useCreatorReport(creatorAddress: string): UseCreatorReportResult {
  const [metrics, setMetrics] = useState<CreatorMetrics | null>(null);
  const [retention, setRetention] = useState<RetentionPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!creatorAddress) {
      setLoading(false);
      setError('No creator address provided.');
      return;
    }

    let cancelled = false;

    async function fetchAll() {
      setLoading(true);
      setError(null);
      setMetrics(null);
      setRetention([]);

      try {
        const [metricsRes, retentionRes] = await Promise.all([
          fetch(`${INDEXER_URL}/api/creators/${encodeURIComponent(creatorAddress)}/metrics`),
          fetch(`${INDEXER_URL}/api/creators/${encodeURIComponent(creatorAddress)}/retention`),
        ]);

        if (!metricsRes.ok) {
          throw new Error(`Metrics fetch failed: HTTP ${metricsRes.status}`);
        }
        if (!retentionRes.ok) {
          throw new Error(`Retention fetch failed: HTTP ${retentionRes.status}`);
        }

        const [metricsData, retentionData] = await Promise.all([
          metricsRes.json() as Promise<CreatorMetrics>,
          retentionRes.json() as Promise<RetentionPoint[]>,
        ]);

        if (!cancelled) {
          setMetrics(metricsData);
          setRetention(Array.isArray(retentionData) ? retentionData : []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error fetching creator data.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchAll();

    return () => {
      // Cancel in-flight state updates if component unmounts mid-fetch.
      cancelled = true;
    };
  }, [creatorAddress]); // Re-run whenever the address changes (or on fresh mount).

  return { metrics, retention, loading, error };
}
