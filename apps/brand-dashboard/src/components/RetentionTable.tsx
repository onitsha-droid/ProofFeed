import React from 'react';
import type { RetentionPoint } from '../hooks/useCreatorReport';

interface RetentionTableProps {
  retention: RetentionPoint[];
}

function retentionColor(rate: number): string {
  if (rate >= 0.75) return '#3fb950'; // green
  if (rate >= 0.5) return '#d29922';  // amber
  if (rate >= 0.25) return '#f0883e'; // orange
  return '#f85149';                   // red
}

/**
 * Pivots the flat retention array into a table where:
 *   rows    = cohort months (earliest first)
 *   columns = months since join (0, 1, 2, …)
 *
 * Example output:
 *   Cohort     | M+0   | M+1   | M+2
 *   2024-01    | 100%  | 72%   | 58%
 *   2024-02    | 100%  | 68%   |
 */
export function RetentionTable({ retention }: RetentionTableProps) {
  if (retention.length === 0) {
    return (
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
        No retention data available yet.
      </p>
    );
  }

  // Build a sorted list of unique cohort months.
  const cohorts = Array.from(new Set(retention.map((r) => r.cohortMonth))).sort();

  // Build a sorted list of unique months-since-join values.
  const monthOffsets = Array.from(new Set(retention.map((r) => r.monthsSinceJoin))).sort(
    (a, b) => a - b,
  );

  // Build lookup: cohortMonth → monthsSinceJoin → RetentionPoint
  const lookup = new Map<string, Map<number, RetentionPoint>>();
  for (const point of retention) {
    if (!lookup.has(point.cohortMonth)) {
      lookup.set(point.cohortMonth, new Map());
    }
    lookup.get(point.cohortMonth)!.set(point.monthsSinceJoin, point);
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          fontSize: '0.82rem',
          borderCollapse: 'collapse',
          minWidth: '100%',
        }}
      >
        <thead>
          <tr style={{ background: 'var(--color-surface-2)' }}>
            <th
              style={{
                padding: '8px 14px',
                textAlign: 'left',
                color: 'var(--color-text-muted)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              Cohort
            </th>
            <th
              style={{
                padding: '8px 14px',
                textAlign: 'right',
                color: 'var(--color-text-muted)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              Size
            </th>
            {monthOffsets.map((m) => (
              <th
                key={m}
                style={{
                  padding: '8px 14px',
                  textAlign: 'right',
                  color: 'var(--color-text-muted)',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  borderBottom: '1px solid var(--color-border)',
                }}
              >
                M+{m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort, i) => {
            const cohortMap = lookup.get(cohort);
            // Use cohort size from month 0 if available, fall back to first entry.
            const cohortSize = cohortMap?.get(0)?.cohortSize ?? retention.find((r) => r.cohortMonth === cohort)?.cohortSize ?? 0;

            return (
              <tr
                key={cohort}
                style={{
                  background: i % 2 === 0 ? 'var(--color-surface)' : 'var(--color-bg)',
                }}
              >
                <td
                  style={{
                    padding: '8px 14px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text)',
                    borderBottom: '1px solid var(--color-border)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cohort}
                </td>
                <td
                  style={{
                    padding: '8px 14px',
                    textAlign: 'right',
                    color: 'var(--color-text-muted)',
                    borderBottom: '1px solid var(--color-border)',
                  }}
                >
                  {cohortSize.toLocaleString()}
                </td>
                {monthOffsets.map((m) => {
                  const point = cohortMap?.get(m);
                  if (!point) {
                    return (
                      <td
                        key={m}
                        style={{
                          padding: '8px 14px',
                          textAlign: 'right',
                          color: 'var(--color-text-muted)',
                          borderBottom: '1px solid var(--color-border)',
                        }}
                      >
                        —
                      </td>
                    );
                  }
                  const pct = Math.round(point.retentionRate * 100);
                  return (
                    <td
                      key={m}
                      style={{
                        padding: '8px 14px',
                        textAlign: 'right',
                        fontWeight: m === 0 ? 600 : 400,
                        color: retentionColor(point.retentionRate),
                        borderBottom: '1px solid var(--color-border)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {pct}%
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
