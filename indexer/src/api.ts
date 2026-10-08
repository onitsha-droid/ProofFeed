/**
 * api.ts
 *
 * ProofFeed Indexer — REST API server.
 *
 * Exposes computed creator metrics and retention data that the creator
 * and brand dashboards consume.  All data is derived from on-chain events
 * and stored in the PostgreSQL tables populated by the indexer loop.
 *
 * Endpoints:
 *   GET /health
 *   GET /api/creators/:address/metrics
 *   GET /api/creators/:address/retention
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreatorMetricsRow {
  creator: string;
  active_subscribers: string; // pg returns numeric columns as strings
  lifetime_revenue_stroops: string;
  churn_events: string;
  entropy_score: string;
  updated_at: string;
}

interface CohortRetentionRow {
  creator: string;
  cohort_month: string;
  months_since_join: string;
  cohort_size: string;
  retained_count: string;
  retention_rate: string;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function makeRouter(pool: Pool): express.Router {
  const router = express.Router();

  // ---- Health check -------------------------------------------------------
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // ---- Creator metrics ----------------------------------------------------
  //
  // Returns aggregated metrics for a single creator address.
  // The creator_metrics table is upserted by metrics.ts whenever new events
  // arrive, so this is always a fast point-lookup.
  //
  router.get(
    '/api/creators/:address/metrics',
    async (req: Request, res: Response, next: NextFunction) => {
      const { address } = req.params;

      try {
        const result = await pool.query<CreatorMetricsRow>(
          `SELECT
             creator,
             active_subscribers,
             lifetime_revenue_stroops,
             churn_events,
             entropy_score,
             updated_at
           FROM creator_metrics
           WHERE creator = $1`,
          [address]
        );

        if (result.rows.length === 0) {
          // Creator exists on-chain but the indexer hasn't seen any events yet,
          // or the address is simply unknown — return zeroed defaults so the
          // dashboard can still render without erroring.
          return res.json({
            activeSubscribers: 0,
            lifetimeRevenueStroops: '0',
            churnEvents: 0,
            entropyScore: null,
          });
        }

        const row = result.rows[0];
        return res.json({
          activeSubscribers: Number(row.active_subscribers),
          lifetimeRevenueStroops: row.lifetime_revenue_stroops,
          churnEvents: Number(row.churn_events),
          entropyScore:
            row.entropy_score != null ? Number(row.entropy_score) : null,
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  // ---- Cohort retention curve ---------------------------------------------
  //
  // Returns the full retention matrix for a creator: one row per
  // (cohort_month × months_since_join) pair.  The brand and creator
  // dashboards plot this as a retention curve.
  //
  router.get(
    '/api/creators/:address/retention',
    async (req: Request, res: Response, next: NextFunction) => {
      const { address } = req.params;

      try {
        const result = await pool.query<CohortRetentionRow>(
          `SELECT
             cohort_month,
             months_since_join,
             cohort_size,
             retained_count,
             retention_rate
           FROM cohort_retention
           WHERE creator = $1
           ORDER BY cohort_month ASC, months_since_join ASC`,
          [address]
        );

        const rows = result.rows.map((row) => ({
          cohortMonth: row.cohort_month,            // ISO date string YYYY-MM-DD
          monthsSinceJoin: Number(row.months_since_join),
          retentionRate: Number(row.retention_rate), // 0.0 – 1.0
          cohortSize: Number(row.cohort_size),
        }));

        return res.json(rows);
      } catch (err) {
        return next(err);
      }
    }
  );

  return router;
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

/**
 * Start the Express API server.
 *
 * @param pool  A connected pg Pool shared with the indexer listener.
 * @param port  TCP port to listen on (default: 3001).
 * @returns     The running http.Server (useful for graceful shutdown).
 */
export function startApi(pool: Pool, port = 3001): ReturnType<typeof express['prototype']['listen']> {
  const app = express();

  // Allow all origins in dev; in production, tighten this to your dashboard
  // domains via the CORS_ORIGIN env var.
  const corsOrigin = process.env.CORS_ORIGIN ?? '*';
  app.use(cors({ origin: corsOrigin }));

  app.use(express.json());

  // Mount all routes
  app.use('/', makeRouter(pool));

  // Generic error handler — must have 4 parameters for Express to recognise
  // it as an error handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[api] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(port, () => {
    console.log(`[api] REST API listening on http://localhost:${port}`);
  });

  return server;
}
