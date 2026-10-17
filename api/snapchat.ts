/**
 * Vercel serverless function: GET /api/snapchat?date=YYYY-MM-DD
 *
 * Pulls daily ad-account stats from the Snap Marketing API
 * (GET /v1/adaccounts/{id}/stats, granularity DAY) using a refresh token, and
 * returns them in the dashboard's metric shape. Snapchat has no open analytics
 * API for organic posts, so this card reflects PAID delivery only; an ad
 * account with no running ads reports zeros.
 *
 * Environment variables (Vercel -> Project -> Settings -> Environment Variables,
 * or .env.local for `npm run dev`):
 *   SNAPCHAT_CLIENT_ID       OAuth app Client ID (business.snapchat.com -> Business Details -> OAuth Apps)
 *   SNAPCHAT_CLIENT_SECRET   the matching Client Secret
 *   SNAPCHAT_REFRESH_TOKEN   refresh token from `npm run snapchat:auth`
 *   SNAPCHAT_AD_ACCOUNT_ID   ad account UUID (Business Settings -> Ad Accounts)
 *   SNAPCHAT_TIMEZONE        optional IANA zone of the ad account (default America/Chicago).
 *                            Snap requires day boundaries in the account's own timezone.
 *
 * Metric mapping (DAY granularity):
 *   views          impressions
 *   retentionRate  view_completion / video_views (0 renders as n/a when no video ads ran)
 *   likesPerView   saves / impressions
 *   shareRate      shares / impressions
 *
 * Snap finalises stats with a lag, so the function reports the newest finished
 * day in the lookback window (today is never requested).
 */

const TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";
const API_BASE = "https://adsapi.snapchat.com/v1";
const DAY_MS = 24 * 60 * 60 * 1000;
/** How many days back from the requested day we ask for (plus one for the previous-day delta). */
const LOOKBACK_DAYS = 7;
const CACHE_TTL_MS = 60 * 60 * 1000;
const STAT_FIELDS = ["impressions", "swipes", "shares", "saves", "video_views", "view_completion"];

interface SnapchatMetric {
  id: "snapchat";
  name: "Snapchat";
  views: number;
  retentionRate: number;
  likesPerView: number;
  shareRate: number;
  lastUpdated: string;
  source: "snapchat";
}

export interface SnapchatPayload {
  date: string;
  liveDate: string;
  syncedAt: string;
  metrics: SnapchatMetric[];
  previousViews: Record<string, number>;
  errors: Record<string, string>;
  tokens: Record<string, { expiresAt?: string; note?: string }>;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const ratio = (num: number, den: number): number => (den > 0 ? Number((num / den).toFixed(4)) : 0);
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const dateKey = (d: Date): string => d.toISOString().slice(0, 10);

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

/** Minutes the zone is ahead of UTC at the given instant. */
function tzOffsetMinutes(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** ISO timestamp (with the zone's offset) for local midnight at the start of `day` (a UTC-midnight Date). */
function localMidnightIso(tz: string, day: Date): string {
  const wall = day.getTime(); // the wall-clock midnight, expressed as if it were UTC
  let offset = tzOffsetMinutes(tz, wall);
  offset = tzOffsetMinutes(tz, wall - offset * 60000); // re-check at the real instant (DST edges)
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${dateKey(day)}T00:00:00.000${sign}${hh}:${mm}`;
}

/* ------------------------------------------------------------------ */
/* OAuth: refresh token -> access token                                */
/* ------------------------------------------------------------------ */

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

let cachedToken: { value: string; expiresAt: number } | null = null;
/** Snap can hand back a new refresh token; prefer the newest one this instance has seen. */
let latestRefreshToken: string | null = null;
let refreshTokenHealth: { expiresAt?: string; note?: string } = {};

async function getAccessToken(): Promise<string> {
  const clientId = env("SNAPCHAT_CLIENT_ID");
  const clientSecret = env("SNAPCHAT_CLIENT_SECRET");
  const refreshToken = latestRefreshToken ?? env("SNAPCHAT_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("SNAPCHAT_CLIENT_ID / SNAPCHAT_CLIENT_SECRET / SNAPCHAT_REFRESH_TOKEN not configured");
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`Snapchat token refresh failed: ${detail} (re-run \`npm run snapchat:auth\` if the refresh token was revoked)`);
  }
  if (body.refresh_token && body.refresh_token !== refreshToken) {
    latestRefreshToken = body.refresh_token;
    refreshTokenHealth = {
      note: "Snapchat issued a new refresh token; update SNAPCHAT_REFRESH_TOKEN (run `npm run snapchat:auth`).",
    };
    console.warn("[snapchat] Snapchat issued a new refresh token. Run `npm run snapchat:auth` and update SNAPCHAT_REFRESH_TOKEN.");
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 1800) * 1000 };
  return body.access_token;
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

interface StatsTimeseriesRow {
  start_time?: string;
  stats?: Record<string, number>;
}

interface StatsResponse {
  request_status?: string;
  request_id?: string;
  debug_message?: string;
  error_code?: string;
  total_stats?: Array<{ total_stat?: { timeseries?: StatsTimeseriesRow[] } }>;
  timeseries_stats?: Array<{ timeseries_stat?: { timeseries?: StatsTimeseriesRow[] } }>;
}

type DaySeries = Record<string, Record<string, number>>;

async function snapchatDailySeries(token: string, adAccountId: string, startDay: Date, endDay: Date): Promise<DaySeries> {
  const tz = env("SNAPCHAT_TIMEZONE") ?? "America/Chicago";
  const url = new URL(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/stats`);
  url.searchParams.set("granularity", "DAY");
  // Account-level stats only allow `spend`; the other fields need a per-entity breakdown, summed below.
  url.searchParams.set("breakdown", "campaign");
  url.searchParams.set("fields", STAT_FIELDS.join(","));
  url.searchParams.set("start_time", localMidnightIso(tz, startDay));
  url.searchParams.set("end_time", localMidnightIso(tz, endDay));

  // Token goes in a header, never in the URL.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as StatsResponse;
  if (!res.ok || (body.request_status && body.request_status !== "SUCCESS")) {
    let detail = body.debug_message ?? body.error_code ?? `HTTP ${res.status}`;
    if (res.status === 401) detail += " (access token rejected; re-run `npm run snapchat:auth`)";
    if (res.status === 403) detail += " (the authorizing user needs access to this ad account, and SNAPCHAT_AD_ACCOUNT_ID must be its ID)";
    if (res.status === 400 && /time/i.test(detail)) detail += " (check SNAPCHAT_TIMEZONE matches the ad account's timezone)";
    throw new Error(`Snapchat stats failed: ${detail}`);
  }

  const byDay: DaySeries = {};
  // One timeseries per campaign (breakdown) or a single account-wide one; sum them per day.
  const series: StatsTimeseriesRow[][] = [
    ...(body.timeseries_stats ?? []).map((e) => e.timeseries_stat?.timeseries ?? []),
    ...(body.total_stats ?? []).map((e) => e.total_stat?.timeseries ?? []),
  ];
  for (const rows of series) {
    for (const row of rows) {
      if (!row.start_time) continue;
      // start_time is local midnight in the account's zone; its date part is the account's calendar day.
      const acc = (byDay[row.start_time.slice(0, 10)] ??= {});
      for (const [k, v] of Object.entries(row.stats ?? {})) {
        const n = Number(v);
        acc[k] = (acc[k] ?? 0) + (Number.isFinite(n) ? n : 0);
      }
    }
  }
  return byDay;
}

interface SnapchatResult {
  metric: SnapchatMetric;
  previousViews: number;
  liveDate: string;
}

let cachedResult: { key: string; value: SnapchatResult; expiresAt: number } | null = null;

async function fetchSnapchat(requestedDay: Date): Promise<SnapchatResult> {
  const cacheKey = dateKey(requestedDay);
  if (cachedResult && cachedResult.key === cacheKey && cachedResult.expiresAt > Date.now()) return cachedResult.value;

  const adAccountId = env("SNAPCHAT_AD_ACCOUNT_ID");
  if (!adAccountId) throw new Error("SNAPCHAT_AD_ACCOUNT_ID not configured");
  const token = await getAccessToken();

  // Latest possible complete day is yesterday (end_time is exclusive local midnight of the requested day).
  const oldest = new Date(requestedDay.getTime() - (LOOKBACK_DAYS + 1) * DAY_MS);
  const byDay = await snapchatDailySeries(token, adAccountId, oldest, requestedDay);

  // No campaigns/ads ran in the window: Snap returns no rows, which is a legitimate "zero" day, not an error.
  const days = Object.keys(byDay).sort();
  const liveKey = days.length > 0 ? days[days.length - 1] : dateKey(new Date(requestedDay.getTime() - DAY_MS));
  const prevKey = dateKey(new Date(new Date(`${liveKey}T00:00:00.000Z`).getTime() - DAY_MS));
  const today = byDay[liveKey] ?? {};
  const prev = byDay[prevKey] ?? {};
  const views = today.impressions ?? 0;
  const videoViews = today.video_views ?? 0;

  const value: SnapchatResult = {
    metric: {
      id: "snapchat",
      name: "Snapchat",
      views,
      retentionRate: videoViews > 0 ? clamp01(ratio(today.view_completion ?? 0, videoViews)) : 0,
      likesPerView: clamp01(ratio(today.saves ?? 0, views)),
      shareRate: clamp01(ratio(today.shares ?? 0, views)),
      lastUpdated: new Date().toISOString(),
      source: "snapchat",
    },
    previousViews: prev.impressions ?? 0,
    liveDate: liveKey,
  };
  cachedResult = { key: cacheKey, value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

export async function buildSnapchatPayload(requestedDay: Date): Promise<SnapchatPayload> {
  const payload: SnapchatPayload = {
    date: dateKey(requestedDay),
    liveDate: dateKey(new Date(requestedDay.getTime() - DAY_MS)),
    syncedAt: new Date().toISOString(),
    metrics: [],
    previousViews: {},
    errors: {},
    tokens: {},
  };

  try {
    const r = await fetchSnapchat(requestedDay);
    payload.metrics.push(r.metric);
    payload.previousViews.snapchat = r.previousViews;
    payload.liveDate = r.liveDate;
  } catch (err) {
    payload.errors.snapchat = err instanceof Error ? err.message : String(err);
  }
  if (refreshTokenHealth.note) payload.tokens.snapchat = { ...refreshTokenHealth };
  return payload;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const payload = await buildSnapchatPayload(parseDateParam(url.searchParams.get("date")));
  const failed = payload.metrics.length === 0;
  return new Response(JSON.stringify(payload), {
    status: failed ? 502 : 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": failed ? "no-store" : "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
