/**
 * Vercel serverless function: GET /api/linkedin?date=YYYY-MM-DD
 *
 * Pulls daily Company Page post statistics from the LinkedIn Community Management
 * API (GET /rest/organizationalEntityShareStatistics, DAY granularity) and returns
 * them in the dashboard's metric shape. Tokens never leave this function.
 *
 * Needs the Community Management API product on the LinkedIn app (Development
 * tier is enough) and a member who is an ADMINISTRATOR of the Company Page to
 * authorize it with `npm run linkedin:auth`.
 *
 * Environment variables (Vercel -> Project -> Settings -> Environment Variables,
 * or .env.local for `npm run dev`):
 *   LINKEDIN_CLIENT_ID                  Client ID from developer.linkedin.com -> your app -> Auth
 *   LINKEDIN_CLIENT_SECRET              the matching Primary Client Secret
 *   LINKEDIN_REFRESH_TOKEN              refresh token from `npm run linkedin:auth`
 *   LINKEDIN_ORGANIZATION_ID            numeric Company Page id (the number in
 *                                       linkedin.com/company/<id>/admin/); the auth
 *                                       script fills it in when it can
 *   LINKEDIN_REFRESH_TOKEN_EXPIRES_AT   written by the auth script (dashboard warns 14 days ahead)
 * Optional:
 *   LINKEDIN_ACCESS_TOKEN               a 60-day access token, used only when no refresh token is set
 *   LINKEDIN_ACCESS_TOKEN_EXPIRES_AT    its expiry (written by the auth script)
 *   LINKEDIN_API_VERSION                LinkedIn-Version header, YYYYMM (default below); LinkedIn
 *                                       retires each version after about a year
 *
 * Tokens. Access tokens live 60 days. Refresh tokens live 365 days from the first
 * authorization and are NOT rotated: refreshing returns the same refresh token with
 * a shrinking lifetime, so after a year you must run `npm run linkedin:auth` again.
 *
 * Metric mapping (totalShareStatistics for the page's posts, per day):
 *   views          impressionCount
 *   retentionRate  not reported by LinkedIn -> 0 (renders as n/a)
 *   likesPerView   likeCount / impressionCount
 *   shareRate      shareCount / impressionCount
 *
 * LinkedIn lags a day, so the function reports yesterday (UTC) and compares it with
 * the day before.
 */

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const STATS_URL = "https://api.linkedin.com/rest/organizationalEntityShareStatistics";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_API_VERSION = "202510";
/** Reuse the last successful result this long to stay far below LinkedIn's daily app limits. */
const CACHE_TTL_MS = 60 * 60 * 1000;

interface LinkedInMetric {
  id: "linkedin";
  name: "LinkedIn";
  views: number;
  retentionRate: number;
  likesPerView: number;
  shareRate: number;
  lastUpdated: string;
  source: "linkedin";
}

export interface LinkedInPayload {
  /** The dashboard's calendar day this payload was requested for. */
  date: string;
  /** The UTC day the LinkedIn numbers describe. */
  liveDate: string;
  syncedAt: string;
  metrics: LinkedInMetric[];
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
  error_description?: string;
}

/** Module-level cache so warm invocations reuse the access token until it expires. */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const clientId = env("LINKEDIN_CLIENT_ID");
  const clientSecret = env("LINKEDIN_CLIENT_SECRET");
  const refreshToken = env("LINKEDIN_REFRESH_TOKEN");

  if (!refreshToken) {
    // Fallback for apps whose tier does not hand out refresh tokens: a pasted 60-day access token.
    const direct = env("LINKEDIN_ACCESS_TOKEN");
    if (direct) return direct;
    throw new Error("LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET / LINKEDIN_REFRESH_TOKEN not configured");
  }
  if (!clientId || !clientSecret) {
    throw new Error("LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET / LINKEDIN_REFRESH_TOKEN not configured");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`LinkedIn token refresh failed: ${detail}`);
  }
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 60 * 24 * 60 * 60) * 1000,
  };
  return body.access_token;
}

/* ------------------------------------------------------------------ */
/* Share statistics                                                    */
/* ------------------------------------------------------------------ */

interface ShareStatsElement {
  timeRange?: { start?: number; end?: number };
  totalShareStatistics?: {
    impressionCount?: number;
    uniqueImpressionsCount?: number;
    clickCount?: number;
    likeCount?: number;
    commentCount?: number;
    shareCount?: number;
    engagement?: number;
  };
}

interface StatsError {
  message?: string;
  status?: number;
  serviceErrorCode?: number;
}

type DayStats = NonNullable<ShareStatsElement["totalShareStatistics"]>;

async function linkedinDailySeries(
  token: string,
  orgId: string,
  startDay: Date,
  endDay: Date,
): Promise<Record<string, DayStats>> {
  // Rest.li query syntax: the parentheses and colons in timeIntervals must stay literal,
  // so only the organization URN is percent-encoded.
  const urn = encodeURIComponent(`urn:li:organization:${orgId}`);
  const url =
    `${STATS_URL}?q=organizationalEntity&organizationalEntity=${urn}` +
    `&timeIntervals=(timeRange:(start:${startDay.getTime()},end:${endDay.getTime()}),timeGranularityType:DAY)`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": env("LINKEDIN_API_VERSION") ?? DEFAULT_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      Accept: "application/json",
    },
  });
  const body = (await res.json().catch(() => ({}))) as { elements?: ShareStatsElement[] } & StatsError;
  if (!res.ok) {
    let detail = body.message ?? `HTTP ${res.status}`;
    if (res.status === 401) detail += " (access token rejected or expired; re-run `npm run linkedin:auth`)";
    if (res.status === 403) {
      detail += " (the authorizing member must be an ADMINISTRATOR of the Company Page and the app needs the Community Management API with r_organization_social)";
    }
    if (res.status === 426) detail += " (LinkedIn-Version retired; set LINKEDIN_API_VERSION to a current YYYYMM)";
    if (res.status === 429) detail += " (LinkedIn rate limit)";
    throw new Error(`LinkedIn statistics failed: ${detail}`);
  }

  const byDay: Record<string, DayStats> = {};
  for (const el of body.elements ?? []) {
    const start = el.timeRange?.start;
    if (typeof start !== "number") continue;
    byDay[dateKey(new Date(start))] = el.totalShareStatistics ?? {};
  }
  return byDay;
}

interface LinkedInResult {
  metric: LinkedInMetric;
  previousViews: number;
  liveDate: string;
}

/** Last successful result, reused for CACHE_TTL_MS. */
let cachedResult: { key: string; value: LinkedInResult; expiresAt: number } | null = null;

async function fetchLinkedIn(requestedDay: Date): Promise<LinkedInResult> {
  const cacheKey = dateKey(requestedDay);
  if (cachedResult && cachedResult.key === cacheKey && cachedResult.expiresAt > Date.now()) {
    return cachedResult.value;
  }

  const orgId = env("LINKEDIN_ORGANIZATION_ID");
  if (!orgId) {
    throw new Error("LINKEDIN_ORGANIZATION_ID not configured (run `npm run linkedin:auth`, or copy the number from linkedin.com/company/<id>/admin/)");
  }
  const token = await getAccessToken();

  // Yesterday is the latest complete day; fetch the two days up to and including it.
  const liveDay = new Date(requestedDay.getTime() - DAY_MS);
  const prevDay = new Date(liveDay.getTime() - DAY_MS);
  const byDay = await linkedinDailySeries(token, orgId, prevDay, requestedDay);

  const today = byDay[dateKey(liveDay)] ?? {};
  const prev = byDay[dateKey(prevDay)] ?? {};
  const views = today.impressionCount ?? 0;

  const value: LinkedInResult = {
    metric: {
      id: "linkedin",
      name: "LinkedIn",
      views,
      retentionRate: 0,
      likesPerView: clamp01(ratio(today.likeCount ?? 0, views)),
      shareRate: clamp01(ratio(today.shareCount ?? 0, views)),
      lastUpdated: new Date().toISOString(),
      source: "linkedin",
    },
    previousViews: prev.impressionCount ?? 0,
    liveDate: dateKey(liveDay),
  };
  cachedResult = { key: cacheKey, value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

export async function buildLinkedInPayload(requestedDay: Date): Promise<LinkedInPayload> {
  const payload: LinkedInPayload = {
    date: dateKey(requestedDay),
    liveDate: dateKey(new Date(requestedDay.getTime() - DAY_MS)),
    syncedAt: new Date().toISOString(),
    metrics: [],
    previousViews: {},
    errors: {},
    tokens: {},
  };

  try {
    const r = await fetchLinkedIn(requestedDay);
    payload.metrics.push(r.metric);
    payload.previousViews.linkedin = r.previousViews;
    payload.liveDate = r.liveDate;
  } catch (err) {
    payload.errors.linkedin = err instanceof Error ? err.message : String(err);
  }
  // Written by `npm run linkedin:auth`; the dashboard warns 14 days before the date.
  const expiry = env("LINKEDIN_REFRESH_TOKEN")
    ? env("LINKEDIN_REFRESH_TOKEN_EXPIRES_AT")
    : env("LINKEDIN_ACCESS_TOKEN_EXPIRES_AT");
  if (expiry) payload.tokens.linkedin = { expiresAt: expiry };
  return payload;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const payload = await buildLinkedInPayload(parseDateParam(url.searchParams.get("date")));
  const failed = payload.metrics.length === 0;
  return new Response(JSON.stringify(payload), {
    status: failed ? 502 : 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": failed
        ? "no-store"
        : "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
