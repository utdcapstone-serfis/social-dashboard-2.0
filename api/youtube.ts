/**
 * Vercel serverless function: GET /api/youtube?date=YYYY-MM-DD
 *
 * Pulls channel-level daily numbers from the YouTube Analytics API using a
 * long-lived OAuth refresh token, and returns them in the dashboard's metric
 * shape. The refresh token and the short-lived access tokens minted from it
 * never leave this function.
 *
 * Environment variables (Vercel -> Project -> Settings -> Environment Variables,
 * or .env.local for `npm run dev`):
 *   YOUTUBE_CLIENT_ID       OAuth client id (Web application)
 *   YOUTUBE_CLIENT_SECRET   OAuth client secret
 *   YOUTUBE_REFRESH_TOKEN   refresh token authorized as the channel owner with
 *                           yt-analytics.readonly + youtube.readonly
 *
 * Metric mapping (YouTube Analytics `reports.query`, dimensions=day):
 *   views          views
 *   retentionRate  averageViewPercentage / 100
 *   likesPerView   likes / views
 *   shareRate      shares / views
 *
 * YouTube Analytics data lags real time by roughly 2-3 days, so the function
 * reports the most recent day inside the lookback window that has any rows.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANALYTICS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";
const DAY_SECONDS = 24 * 60 * 60;
/** How many days back from the requested day we search for the latest complete day. */
const LOOKBACK_DAYS = 7;

interface YouTubeMetric {
  id: "youtube";
  name: "YouTube";
  views: number;
  retentionRate: number;
  likesPerView: number;
  shareRate: number;
  lastUpdated: string;
  source: "youtube";
}

export interface YouTubePayload {
  /** The dashboard's calendar day this payload was requested for. */
  date: string;
  /** The UTC day the YouTube numbers describe (latest day with data). */
  liveDate: string;
  syncedAt: string;
  metrics: YouTubeMetric[];
  previousViews: Record<string, number>;
  /** Per-platform error messages; a platform with an error is omitted from `metrics`. */
  errors: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const ratio = (num: number, den: number): number =>
  den > 0 ? Number((num / den).toFixed(4)) : 0;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDateParam(raw: string | null): Date {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(`${dateKey(new Date())}T00:00:00.000Z`);
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/* ------------------------------------------------------------------ */
/* OAuth: refresh token -> access token                                */
/* ------------------------------------------------------------------ */

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Module-level cache so warm invocations reuse the access token until it expires. */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const clientId = env("YOUTUBE_CLIENT_ID");
  const clientSecret = env("YOUTUBE_CLIENT_SECRET");
  const refreshToken = env("YOUTUBE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN not configured",
    );
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`YouTube token refresh failed: ${detail}`);
  }
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}

/* ------------------------------------------------------------------ */
/* YouTube Analytics                                                   */
/* ------------------------------------------------------------------ */

interface AnalyticsResponse {
  columnHeaders?: Array<{ name: string }>;
  rows?: Array<Array<string | number>>;
  error?: { message?: string; code?: number };
}

const YT_METRICS = ["views", "likes", "shares", "averageViewPercentage"] as const;

/** byDay[YYYY-MM-DD][metricName] = value, for every day YouTube has reported. */
async function ytDailySeries(
  token: string,
  startDay: Date,
  endDay: Date,
): Promise<Record<string, Record<string, number>>> {
  const url = new URL(ANALYTICS_URL);
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", dateKey(startDay));
  url.searchParams.set("endDate", dateKey(endDay));
  url.searchParams.set("metrics", YT_METRICS.join(","));
  url.searchParams.set("dimensions", "day");
  url.searchParams.set("sort", "day");

  // Token goes in a header, never in the URL, so it can't leak into logs.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as AnalyticsResponse;
  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `YouTube Analytics HTTP ${res.status}`);
  }

  const headers = (body.columnHeaders ?? []).map((h) => h.name);
  const dayIdx = headers.indexOf("day");
  const byDay: Record<string, Record<string, number>> = {};
  for (const row of body.rows ?? []) {
    const day = String(row[dayIdx]);
    const vals: Record<string, number> = {};
    headers.forEach((name, i) => {
      if (i === dayIdx) return;
      const n = Number(row[i]);
      vals[name] = Number.isFinite(n) ? n : 0;
    });
    byDay[day] = vals;
  }
  return byDay;
}

async function fetchYouTube(
  requestedDay: Date,
): Promise<{ metric: YouTubeMetric; previousViews: number; liveDate: string }> {
  const token = await getAccessToken();

  // Latest possible complete day is yesterday; look back far enough to cover the reporting lag.
  const newest = new Date(requestedDay.getTime() - DAY_SECONDS * 1000);
  const oldest = new Date(newest.getTime() - LOOKBACK_DAYS * DAY_SECONDS * 1000);
  const byDay = await ytDailySeries(token, oldest, newest);

  const days = Object.keys(byDay).sort();
  if (days.length === 0) {
    throw new Error(
      `No YouTube Analytics rows between ${dateKey(oldest)} and ${dateKey(newest)}`,
    );
  }
  const liveKey = days[days.length - 1];
  const prevKey = dateKey(
    new Date(new Date(`${liveKey}T00:00:00.000Z`).getTime() - DAY_SECONDS * 1000),
  );
  const today = byDay[liveKey] ?? {};
  const prev = byDay[prevKey] ?? {};
  const views = today.views ?? 0;

  return {
    metric: {
      id: "youtube",
      name: "YouTube",
      views,
      retentionRate: clamp01((today.averageViewPercentage ?? 0) / 100),
      likesPerView: clamp01(ratio(today.likes ?? 0, views)),
      shareRate: clamp01(ratio(today.shares ?? 0, views)),
      lastUpdated: new Date().toISOString(),
      source: "youtube",
    },
    previousViews: prev.views ?? 0,
    liveDate: liveKey,
  };
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

export async function buildYouTubePayload(requestedDay: Date): Promise<YouTubePayload> {
  const payload: YouTubePayload = {
    date: dateKey(requestedDay),
    liveDate: dateKey(new Date(requestedDay.getTime() - DAY_SECONDS * 1000)),
    syncedAt: new Date().toISOString(),
    metrics: [],
    previousViews: {},
    errors: {},
  };

  try {
    const r = await fetchYouTube(requestedDay);
    payload.metrics.push(r.metric);
    payload.previousViews.youtube = r.previousViews;
    payload.liveDate = r.liveDate;
  } catch (err) {
    payload.errors.youtube = err instanceof Error ? err.message : String(err);
  }
  return payload;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const payload = await buildYouTubePayload(parseDateParam(url.searchParams.get("date")));
  const failed = payload.metrics.length === 0;
  return new Response(JSON.stringify(payload), {
    status: failed ? 502 : 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Analytics data is daily; let Vercel's edge cache absorb repeat loads for an hour.
      "Cache-Control": failed
        ? "no-store"
        : "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
