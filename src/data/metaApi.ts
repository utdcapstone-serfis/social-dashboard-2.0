import type { DailyPayload, PlatformDailyMetric, TokenHealth } from "../types";

/** Shape returned by the Vercel functions in /api/meta.ts, /api/youtube.ts, /api/tiktok.ts, /api/x.ts, /api/pinterest.ts and /api/bluesky.ts. */
export interface LiveApiResponse {
  date: string;
  liveDate: string;
  syncedAt: string;
  metrics: PlatformDailyMetric[];
  previousViews: Record<string, number>;
  errors: Record<string, string>;
  tokens: Record<string, TokenHealth>;
}

/** @deprecated use LiveApiResponse */
export type MetaApiResponse = LiveApiResponse;

/** Live endpoints, in display priority order (the first one's liveDate wins). */
const LIVE_ENDPOINTS = ["/api/meta", "/api/youtube", "/api/tiktok", "/api/x", "/api/pinterest", "/api/bluesky"] as const;

/**
 * Fetches one serverless endpoint. Resolves to null when it is unavailable
 * (e.g. the GitHub Pages build, or a 500 from the dev middleware), so callers
 * can fall back to mock data for that endpoint's platforms.
 */
async function fetchEndpoint(path: string, date: string): Promise<LiveApiResponse | null> {
  try {
    const res = await fetch(`${path}?date=${date}`, { headers: { Accept: "application/json" } });
    if (!res.ok && res.status !== 502) return null;
    const body = (await res.json()) as Partial<LiveApiResponse>;
    if (!Array.isArray(body.metrics)) return null;
    return {
      date: body.date ?? date,
      liveDate: body.liveDate ?? date,
      syncedAt: body.syncedAt ?? new Date().toISOString(),
      metrics: body.metrics,
      previousViews: body.previousViews ?? {},
      errors: body.errors ?? {},
      tokens: body.tokens ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Fetches live Instagram + Facebook (Meta), YouTube, TikTok and X metrics in parallel and
 * combines them. Resolves to null only when every endpoint is unavailable.
 */
export async function fetchLivePayload(day: Date): Promise<LiveApiResponse | null> {
  const date = day.toISOString().slice(0, 10);
  const results = await Promise.all(LIVE_ENDPOINTS.map((p) => fetchEndpoint(p, date)));
  const available = results.filter((r): r is LiveApiResponse => r !== null);
  if (available.length === 0) return null;

  const combined: LiveApiResponse = {
    date,
    liveDate: available[0].liveDate,
    syncedAt: new Date().toISOString(),
    metrics: [],
    previousViews: {},
    errors: {},
    tokens: {},
  };
  for (const r of available) {
    combined.metrics.push(...r.metrics);
    Object.assign(combined.previousViews, r.previousViews);
    Object.assign(combined.errors, r.errors);
    Object.assign(combined.tokens, r.tokens);
  }
  return combined;
}

/** @deprecated use fetchLivePayload */
export const fetchMetaPayload = fetchLivePayload;

/** Overlays live metrics onto a full 11-platform payload. */
export function mergeLivePayload(base: DailyPayload, live: LiveApiResponse): DailyPayload {
  const liveById = new Map(live.metrics.map((m) => [m.id, m]));
  return {
    ...base,
    syncedAt: live.syncedAt,
    liveDate: live.liveDate,
    metrics: base.metrics.map((m) => liveById.get(m.id) ?? { ...m, source: "mock" }),
    previousViews: { ...base.previousViews, ...live.previousViews },
    apiReachable: true,
    errors: live.errors,
    tokens: live.tokens,
  };
}

/** @deprecated use mergeLivePayload */
export const mergeMetaPayload = mergeLivePayload;
