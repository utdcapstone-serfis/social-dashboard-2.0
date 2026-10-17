/**
 * Vercel serverless function: GET /api/pinterest?date=YYYY-MM-DD
 *
 * Pulls account-level daily numbers from the Pinterest API v5
 * (GET /v5/user_account/analytics) using a continuous refresh token, and
 * returns them in the dashboard's metric shape. The refresh token and the
 * access tokens minted from it never leave this function.
 *
 * Environment variables (Vercel -> Project -> Settings -> Environment Variables,
 * or .env.local for `npm run dev`):
 *   PINTEREST_APP_ID         App ID from developers.pinterest.com -> My apps
 *   PINTEREST_APP_SECRET     the matching App secret
 *   PINTEREST_REFRESH_TOKEN  refresh token from `npm run pinterest:auth`, authorized
 *                            as the business account owner with user_accounts:read
 *
 * Tokens. Access tokens live 30 days. Continuous refresh tokens live 60 days and
 * every refresh hands back a NEW refresh token with a fresh 60-day window, so the
 * stored env var slowly goes stale. This function keeps the newest refresh token
 * it has seen in memory and logs a warning when it rotates; re-run
 * `npm run pinterest:auth -- --refresh` and update the Vercel variable before
 * the 60 days are up (see DEPLOY.md).
 *
 * Rate limits. Trial access allows 1,000 requests per day per app across every
 * endpoint (org_analytics is also capped at 1,000/day). One analytics call per
 * sync, a one-hour in-memory cache and a one-hour edge cache keep this well
 * under 50 requests a day.
 *
 * Metric mapping (daily_metrics, NO_SPLIT):
 *   views          IMPRESSION
 *   retentionRate  QUARTILE_95_PERCENT_VIEW / VIDEO_START when Pinterest returns
 *                  video metrics for the day, otherwise 0 (renders as n/a)
 *   likesPerView   SAVE / IMPRESSION   (saves are Pinterest's "like")
 *   shareRate      OUTBOUND_CLICK / IMPRESSION
 *
 * Pinterest finalises a day's numbers with a lag of a day or two (data_status
 * PROCESSING -> ESTIMATE -> READY), so the function reports the most recent day
 * inside the lookback window whose status is READY, falling back to ESTIMATE.
 */

const TOKEN_URL = "https://api.pinterest.com/v5/oauth/token";
const ANALYTICS_URL = "https://api.pinterest.com/v5/user_account/analytics";
const DAY_SECONDS = 24 * 60 * 60;
/** How many days back from the requested day we search for the latest finished day. */
const LOOKBACK_DAYS = 7;
/** Reuse the last successful result this long to stay far below the Trial 1,000/day cap. */
const CACHE_TTL_MS = 60 * 60 * 1000;

interface PinterestMetric {
  id: "pinterest";
  name: "Pinterest";
  views: number;
  retentionRate: number;
  likesPerView: number;
  shareRate: number;
  lastUpdated: string;
  source: "pinterest";
}

export interface PinterestPayload {
  /** The dashboard's calendar day this payload was requested for. */
  date: string;
  /** The UTC day the Pinterest numbers describe (latest day with finished data). */
  liveDate: string;
  syncedAt: string;
  metrics: PinterestMetric[];
  previousViews: Record<string, number>;
  /** Per-platform error messages; a platform with an error is omitted from `metrics`. */
  errors: Record<string, string>;
  /** Credential health the dashboard turns into "refresh your key" warnings. */
  tokens: Record<string, { expiresAt?: string; note?: string }>;
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
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  message?: string;
  error_description?: string;
}

/** Module-level cache so warm invocations reuse the access token until it expires. */
let cachedToken: { value: string; expiresAt: number } | null = null;
/** Pinterest rotates the refresh token on every refresh; prefer the newest one this instance has seen. */
let latestRefreshToken: string | null = null;
/** What the last refresh said about the stored refresh token, for the dashboard's key-health panel. */
let refreshTokenHealth: { expiresAt?: string; note?: string } = {};

async function getAccessToken(): Promise<string> {
  const appId = env("PINTEREST_APP_ID");
  const appSecret = env("PINTEREST_APP_SECRET");
  const refreshToken = latestRefreshToken ?? env("PINTEREST_REFRESH_TOKEN");
  if (!appId || !appSecret || !refreshToken) {
    throw new Error("PINTEREST_APP_ID / PINTEREST_APP_SECRET / PINTEREST_REFRESH_TOKEN not configured");
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  // Pinterest authenticates the app with HTTP Basic (app_id:app_secret), not body fields.
  const basic = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    const detail = body.message ?? body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`Pinterest token refresh failed: ${detail}`);
  }
  if (body.refresh_token && body.refresh_token !== refreshToken) {
    // Rotation starts a fresh 60-day window for the NEW token only; the stored env var keeps
    // aging, so report the rotation instead of the new token's (misleadingly late) expiry.
    refreshTokenHealth = {
      note: "Pinterest rotated the refresh token; the stored PINTEREST_REFRESH_TOKEN expires within 60 days of when it was issued.",
    };
    latestRefreshToken = body.refresh_token;
    const days = body.refresh_token_expires_in
      ? ` It expires in ${Math.round(body.refresh_token_expires_in / DAY_SECONDS)} days.`
      : "";
    console.warn(
      `[pinterest] Pinterest rotated the refresh token.${days} Run \`npm run pinterest:auth -- --refresh\` and update PINTEREST_REFRESH_TOKEN before the stored one expires.`,
    );
  }
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 30 * DAY_SECONDS) * 1000,
  };
  return body.access_token;
}

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

type DataStatus = "PROCESSING" | "READY" | "ESTIMATE" | string;

interface DailyMetrics {
  date?: string;
  data_status?: DataStatus;
  metrics?: Record<string, number>;
}

interface AnalyticsGroup {
  daily_metrics?: DailyMetrics[];
  summary_metrics?: Record<string, number>;
}

interface AnalyticsError {
  code?: number;
  message?: string;
}

type DaySeries = Record<string, { status: DataStatus; metrics: Record<string, number> }>;

/**
 * Pinterest keys the response by split group ("all" for NO_SPLIT). Returns
 * byDay[YYYY-MM-DD] = { status, metrics } for every day Pinterest reported.
 */
async function pinterestDailySeries(token: string, startDay: Date, endDay: Date): Promise<DaySeries> {
  const url = new URL(ANALYTICS_URL);
  url.searchParams.set("start_date", dateKey(startDay));
  url.searchParams.set("end_date", dateKey(endDay));
  url.searchParams.set("split_field", "NO_SPLIT");
  // metric_types is left unset so Pinterest returns every metric it has for the
  // account, including the video ones that are not in the request enum.

  // Token goes in a header, never in the URL, so it can't leak into logs.
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & AnalyticsError;
  if (!res.ok) {
    let detail = body.message ?? `HTTP ${res.status}`;
    if (res.status === 401) detail += " (access token rejected; re-run `npm run pinterest:auth`)";
    if (res.status === 403) detail += " (analytics need a Pinterest Business account and the user_accounts:read scope)";
    if (res.status === 429) detail += " (Pinterest rate limit; Trial access allows 1,000 requests per day)";
    throw new Error(`Pinterest analytics failed: ${detail}`);
  }

  const isGroup = (g: unknown): g is AnalyticsGroup =>
    !!g && typeof g === "object" && "daily_metrics" in (g as Record<string, unknown>);
  const group: AnalyticsGroup | undefined = isGroup(body.all) ? body.all : Object.values(body).find(isGroup);

  const byDay: DaySeries = {};
  for (const row of group?.daily_metrics ?? []) {
    if (!row.date) continue;
    const metrics: Record<string, number> = {};
    for (const [k, v] of Object.entries(row.metrics ?? {})) {
      const n = Number(v);
      metrics[k] = Number.isFinite(n) ? n : 0;
    }
    byDay[row.date] = { status: row.data_status ?? "READY", metrics };
  }
  return byDay;
}

interface PinterestResult {
  metric: PinterestMetric;
  previousViews: number;
  liveDate: string;
}

/** Last successful result, reused for CACHE_TTL_MS. */
let cachedResult: { key: string; value: PinterestResult; expiresAt: number } | null = null;

async function fetchPinterest(requestedDay: Date): Promise<PinterestResult> {
  const cacheKey = dateKey(requestedDay);
  if (cachedResult && cachedResult.key === cacheKey && cachedResult.expiresAt > Date.now()) {
    return cachedResult.value;
  }

  const token = await getAccessToken();

  // Latest possible complete day is yesterday; look back far enough to cover the processing lag,
  // plus one extra day so the chosen day's "previous day" is in the same response.
  const newest = new Date(requestedDay.getTime() - DAY_SECONDS * 1000);
  const oldest = new Date(newest.getTime() - (LOOKBACK_DAYS + 1) * DAY_SECONDS * 1000);
  const byDay = await pinterestDailySeries(token, oldest, newest);

  const days = Object.keys(byDay).sort();
  if (days.length === 0) {
    throw new Error(`No Pinterest analytics rows between ${dateKey(oldest)} and ${dateKey(newest)}`);
  }
  const newestWith = (ok: (s: DataStatus) => boolean): string | undefined =>
    [...days].reverse().find((d) => ok(byDay[d].status));
  const liveKey =
    newestWith((s) => s === "READY") ?? newestWith((s) => s === "ESTIMATE") ?? days[days.length - 1];
  const prevKey = dateKey(new Date(new Date(`${liveKey}T00:00:00.000Z`).getTime() - DAY_SECONDS * 1000));
  const today = byDay[liveKey]?.metrics ?? {};
  const prev = byDay[prevKey]?.metrics ?? {};
  const views = today.IMPRESSION ?? 0;

  const videoStarts = today.VIDEO_START ?? 0;
  const completes = today.QUARTILE_95_PERCENT_VIEW ?? 0;

  const value: PinterestResult = {
    metric: {
      id: "pinterest",
      name: "Pinterest",
      views,
      retentionRate: videoStarts > 0 ? clamp01(ratio(completes, videoStarts)) : 0,
      likesPerView: clamp01(ratio(today.SAVE ?? 0, views)),
      shareRate: clamp01(ratio(today.OUTBOUND_CLICK ?? 0, views)),
      lastUpdated: new Date().toISOString(),
      source: "pinterest",
    },
    previousViews: prev.IMPRESSION ?? 0,
    liveDate: liveKey,
  };
  cachedResult = { key: cacheKey, value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

export async function buildPinterestPayload(requestedDay: Date): Promise<PinterestPayload> {
  const payload: PinterestPayload = {
    date: dateKey(requestedDay),
    liveDate: dateKey(new Date(requestedDay.getTime() - DAY_SECONDS * 1000)),
    syncedAt: new Date().toISOString(),
    metrics: [],
    previousViews: {},
    errors: {},
    tokens: {},
  };

  try {
    const r = await fetchPinterest(requestedDay);
    payload.metrics.push(r.metric);
    payload.previousViews.pinterest = r.previousViews;
    payload.liveDate = r.liveDate;
  } catch (err) {
    payload.errors.pinterest = err instanceof Error ? err.message : String(err);
  }
  // Written by `npm run pinterest:auth`; the only reliable expiry for the stored token.
  const storedExpiry = env("PINTEREST_REFRESH_TOKEN_EXPIRES_AT");
  // With a known expiry the rotation note is just noise: the dashboard warns 14 days before
  // that date. Without one, the note is the only signal that the stored token is aging.
  if (storedExpiry) payload.tokens.pinterest = { expiresAt: storedExpiry };
  else if (refreshTokenHealth.note) payload.tokens.pinterest = refreshTokenHealth;
  return payload;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const payload = await buildPinterestPayload(parseDateParam(url.searchParams.get("date")));
  const failed = payload.metrics.length === 0;
  return new Response(JSON.stringify(payload), {
    status: failed ? 502 : 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Analytics data is daily and Trial access is capped per day; let the edge cache absorb repeat loads for an hour.
      "Cache-Control": failed
        ? "no-store"
        : "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
