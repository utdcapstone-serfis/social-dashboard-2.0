/**
 * Vercel serverless function: GET /api/x?date=YYYY-MM-DD
 *
 * Pulls the account's most recent posts from the X API v2 user timeline with an
 * app-only Bearer Token and returns them in the dashboard's metric shape. The
 * token never leaves this function.
 *
 * Environment variables (Vercel -> Project -> Settings -> Environment Variables,
 * or .env.local for `npm run dev`):
 *   X_BEARER_TOKEN   Bearer Token from console.x.com -> project -> app -> Keys and tokens.
 *                    Access is pay-per-use (no tiers): the account needs a credit balance.
 *   X_USER_ID        numeric id of the account to track. Run `npm run x:id -- <handle>`
 *                    to look it up and write it here, or leave it empty and set
 *   X_USERNAME       the @handle (without @); the id is then resolved once per
 *                    instance and cached.
 *
 * Rate limits and cost. Per docs.x.com/x-api/fundamentals/rate-limits the app
 * limits are 10,000/15min for GET /2/users/:id/tweets and 300/15min for the
 * username lookup, so the limiter is never the problem; billing is, because X
 * charges per post read. This function therefore makes a single request of
 * MAX_POSTS posts, caches the result in memory for CACHE_TTL_MS, and lets the
 * edge cache absorb repeat loads for an hour (see GET below). Expect roughly
 * 24 requests x MAX_POSTS post reads per day per running instance.
 *
 * Metric mapping. public_metrics are lifetime counters per post, with no daily
 * breakdown, so the card shows totals across the most recent posts:
 *   views          sum of impression_count
 *   retentionRate  not exposed by X -> 0 (renders as n/a)
 *   likesPerView   sum of like_count / views
 *   shareRate      (sum of retweet_count + quote_count) / views
 * previousViews is reported equal to views, so the day-over-day delta is 0
 * rather than a misleading number; this function keeps no history.
 */

const API_BASE = "https://api.x.com/2";
const TWEET_FIELDS = "created_at,public_metrics";
const DAY_SECONDS = 24 * 60 * 60;
/** Posts summed per request; 100 is the API maximum for one page. */
const MAX_POSTS = 100;
/** Reuse the last successful result this long before paying for another read. */
const CACHE_TTL_MS = 60 * 60 * 1000;

interface XMetric {
  id: "twitter";
  name: "Twitter";
  views: number;
  retentionRate: number;
  likesPerView: number;
  shareRate: number;
  lastUpdated: string;
  source: "x";
}

export interface XPayload {
  /** The dashboard's calendar day this payload was requested for. */
  date: string;
  /** The last complete UTC day (date - 1), kept for parity with the other endpoints. */
  liveDate: string;
  syncedAt: string;
  metrics: XMetric[];
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

interface XError {
  title?: string;
  detail?: string;
  message?: string;
  code?: number;
}

interface XEnvelope<T> {
  data?: T;
  meta?: { result_count?: number; next_token?: string };
  errors?: XError[];
  title?: string;
  detail?: string;
}

/** GET an X API v2 path with the bearer token; turns API and rate-limit errors into readable messages. */
async function xGet<T>(path: string, params: Record<string, string>): Promise<XEnvelope<T>> {
  const token = env("X_BEARER_TOKEN");
  if (!token) throw new Error("X_BEARER_TOKEN not configured");

  const url = new URL(`${API_BASE}${path}`);
  url.search = new URLSearchParams(params).toString();
  // Token goes in a header, never in the URL, so it cannot leak into logs.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as XEnvelope<T>;

  if (res.status === 429) {
    const reset = Number(res.headers.get("x-rate-limit-reset"));
    const when = reset ? ` until ${new Date(reset * 1000).toISOString()}` : "";
    throw new Error(`X rate limit exceeded${when}`);
  }
  if (!res.ok || body.errors?.length) {
    const first = body.errors?.[0];
    const detail = first?.detail ?? first?.message ?? body.detail ?? body.title ?? `HTTP ${res.status}`;
    // Keep the status in the message: the dashboard uses it to tell an invalid token (401/403) from no credits (402).
    throw new Error(`X API ${path} (HTTP ${res.status}): ${detail}`);
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* user id                                                             */
/* ------------------------------------------------------------------ */

/** Module-level cache so warm invocations skip the username lookup. */
let cachedUserId: string | null = null;

export async function resolveUserId(): Promise<string> {
  const fromEnv = env("X_USER_ID");
  if (fromEnv) return fromEnv;
  if (cachedUserId) return cachedUserId;

  const username = env("X_USERNAME")?.replace(/^@/, "");
  if (!username) throw new Error("X_USER_ID (or X_USERNAME) not configured; run `npm run x:id -- <handle>`");

  const body = await xGet<{ id: string; name?: string; username?: string }>(
    `/users/by/username/${encodeURIComponent(username)}`,
    {},
  );
  if (!body.data?.id) throw new Error(`X user @${username} not found`);
  cachedUserId = body.data.id;
  return cachedUserId;
}

/* ------------------------------------------------------------------ */
/* timeline                                                            */
/* ------------------------------------------------------------------ */

interface Post {
  id: string;
  created_at?: string;
  public_metrics?: {
    impression_count?: number;
    like_count?: number;
    retweet_count?: number;
    quote_count?: number;
    reply_count?: number;
    bookmark_count?: number;
  };
}

async function listPosts(userId: string): Promise<Post[]> {
  const body = await xGet<Post[]>(`/users/${encodeURIComponent(userId)}/tweets`, {
    max_results: String(MAX_POSTS),
    // Reposts carry the original author's counters, not this account's reach.
    exclude: "retweets",
    "tweet.fields": TWEET_FIELDS,
  });
  return body.data ?? [];
}

/** Last successful result, reused for CACHE_TTL_MS to keep the per-post read bill down. */
let cachedResult: { value: { metric: XMetric; previousViews: number }; expiresAt: number } | null = null;

async function fetchX(): Promise<{ metric: XMetric; previousViews: number }> {
  if (cachedResult && cachedResult.expiresAt > Date.now()) return cachedResult.value;
  if (!env("X_BEARER_TOKEN")) throw new Error("X_BEARER_TOKEN not configured");

  const userId = await resolveUserId();
  const posts = await listPosts(userId);
  const sum = (k: "impression_count" | "like_count" | "retweet_count" | "quote_count"): number =>
    posts.reduce((s, p) => s + (p.public_metrics?.[k] ?? 0), 0);
  const views = sum("impression_count");

  const value = {
    metric: {
      id: "twitter" as const,
      name: "Twitter" as const,
      views,
      retentionRate: 0, // X does not expose retention; the card renders n/a
      likesPerView: clamp01(ratio(sum("like_count"), views)),
      shareRate: clamp01(ratio(sum("retweet_count") + sum("quote_count"), views)),
      lastUpdated: new Date().toISOString(),
      source: "x" as const,
    },
    // Lifetime counters with no stored history: report a flat day-over-day delta.
    previousViews: views,
  };
  cachedResult = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

export async function buildXPayload(requestedDay: Date): Promise<XPayload> {
  const payload: XPayload = {
    date: dateKey(requestedDay),
    liveDate: dateKey(new Date(requestedDay.getTime() - DAY_SECONDS * 1000)),
    syncedAt: new Date().toISOString(),
    metrics: [],
    previousViews: {},
    errors: {},
  };

  try {
    const r = await fetchX();
    payload.metrics.push(r.metric);
    payload.previousViews.twitter = r.previousViews;
  } catch (err) {
    payload.errors.twitter = err instanceof Error ? err.message : String(err);
  }
  return payload;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const payload = await buildXPayload(parseDateParam(url.searchParams.get("date")));
  const failed = payload.metrics.length === 0;
  return new Response(JSON.stringify(payload), {
    status: failed ? 502 : 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Counters move slowly and every read is billed; let the edge cache absorb repeat loads for an hour.
      "Cache-Control": failed
        ? "no-store"
        : "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
