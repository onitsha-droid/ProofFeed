/**
 * BadgeRedirect.tsx
 *
 * Reads the :address URL param and immediately redirects to the brand
 * dashboard's badge page.  This allows creators to share a link to their
 * own creator dashboard that automatically forwards brands to the right place.
 *
 * e.g. https://creator.prooffeed.xyz/badge/G...ABC
 *   → https://brand.prooffeed.xyz/badge/G...ABC
 */

import { useEffect } from 'react';
import { useParams } from 'react-router-dom';

const BRAND_DASHBOARD_URL =
  (import.meta.env.VITE_BRAND_DASHBOARD_URL as string | undefined) ??
  'http://localhost:5174';

export default function BadgeRedirect(): null {
  const { address } = useParams<{ address: string }>();

  useEffect(() => {
    if (!address) return;
    const target = `${BRAND_DASHBOARD_URL}/badge/${encodeURIComponent(address)}`;
    window.location.replace(target);
  }, [address]);

  // Nothing to render — the browser is being redirected.
  return null;
}
