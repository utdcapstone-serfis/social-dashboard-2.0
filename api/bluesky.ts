/**
 * Vercel serverless function: GET /api/bluesky?date=YYYY-MM-DD
 *
 * Pulls the account's profile and most recent posts from the Bluesky public
 * AppView (public.api.bsky.app) and returns them in the dashboard's metric
 * shape. The public AppView needs no authentication, so there is no token.
 *
 * Environment variables (Vercel -> Project -> Settings -> Environment Variables,
 * or .env.local for `npm run dev`):
 *   BLUESKY_HANDLE   the account handle to track, e.g. serfis.bsky.app (a leading
 *                    @ is tolerated). A DID (did:plc:...) works too.
 *
 * Rate limits. The public AppView is rate limited per IP (roughly 3,000
 * requests per 5 minutes per docs.bsky.app/docs/advanced-guides/rate-limits),
 * far above what one dashboard needs. This function still makes only two
 * requests per refresh, caches the result in memory for CACHE_TTL_MS, and lets
 * the edge cache absorb repeat loads for an hour (see GET below), for parity
 * with the other endpoints.
 *
 * Metric mapping. Bluesky exposes no view or impression counts at all, and the
 * feed counters are lifetime totals per post with no daily breakdown, so the
 * card shows engagement per follower across the most recent original posts:
 *   views          not exposed by Bluesky -> 0 (the card shows 0 views)
 *   retentionRate  not exposed by Bluesky -> 0 (the card shows 0.0%)
 *   likesPerView   sum of likeCount / followersCount
 *   shareRate      (sum of repostCount + quoteCount) / followersCount
 * Reposts of other accounts' posts (feed items with a `reason`) are skipped so
 * only this account's own posts are counted. previousViews is reported as 0,
 * matching views; this function keeps no history.
 */

const API_BASE = "https://public.api.bsky.app/xrpc";
const DAY_SECONDS = 24 * 60 * 60;
/** Posts summed per request; 100 is the API maximum for one page. */
const MAX_POSTS = 100;
/** Reuse the last successful result this long before fetching again. */
const CACHE_TTL_MS = 60 * 60 * 1000;

interface BlueskyMetric {
  id: "bluesky";
  name: "Bluesky";
  views: number;
  retentionRate: number;
  likesPerView: number;
  shareRate: number;
  lastUpdated: string;
  source: "bluesky";
}

export interface BlueskyPayload {
  /** The dashboard's calendar day this payload was requested for. */
  date: string;
  /** The last complete UTC day (date - 1), kept for parity with the other endpoints. */
  liveDate: string;
  syncedAt: string;
  metrics: BlueskyMetric[];
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

function resolveHandle(): string {
  const handle = env("BLUESKY_HANDLE")?.replace(/^@/, "");
  if (!handle) throw new Error("BLUESKY_HANDLE not configured");
  return handle;
}

/** XRPC error body: { error: "InvalidRequest", message: "Profile not found" }. */
interface XrpcError {
  error?: string;
  message?: string;
}

/** GET an XRPC method on the public AppView; turns API and rate-limit errors into readable messages. */
async function bskyGet<T>(method: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}/${method}`);
  url.search = new URLSearchParams(params).toString();
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as T & XrpcError;

  if (res.status === 429) {
    const reset = Number(res.headers.get("ratelimit-reset"));
    const when = reset ? ` until ${new Date(reset * 1000).toISOString()}` : "";
    throw new Error(`Bluesky rate limit exceeded${when}`);
  }
  if (!res.ok) {
    const detail = body.message ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`Bluesky API ${method}: ${detail}`);
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* profile and feed                                                    */
/* ------------------------------------------------------------------ */

interface Profile {
  did?: string;
  handle?: string;
  followersCount?: number;
  postsCount?: number;
}

interface FeedItem {
  post: {
    uri?: string;
    likeCount?: number;
    repostCount?: number;
    quoteCount?: number;
    replyCount?: number;
  };
  /** Present when the item is a repost of someone else's post. */
  reason?: { $type?: string };
}

async function getProfile(actor: string): Promise<Profile> {
  return bskyGet<Profile>("app.bsky.actor.getProfile", { actor });
}

async function listPosts(actor: string): Promise<FeedItem[]> {
  const body = await bskyGet<{ feed?: FeedItem[] }>("app.bsky.feed.getAuthorFeed", {
    actor,
    limit: String(MAX_POSTS),
    filter: "posts_no_replies",
  });
  // Reposts carry the original author's counters, not this account's reach.
  return (body.feed ?? []).filter((item) => item.reason === undefined);
}

/** Last successful result, reused for CACHE_TTL_MS. */
let cachedResult: { value: { metric: BlueskyMetric; previousViews: number }; expiresAt: number } | null = null;

async function fetchBluesky(): Promise<{ metric: BlueskyMetric; previousViews: number }> {
  if (cachedResult && cachedResult.expiresAt > Date.now()) return cachedResult.value;

  const actor = resolveHandle();
  const [profile, posts] = await Promise.all([getProfile(actor), listPosts(actor)]);
  const followers = profile.followersCount ?? 0;
  const sum = (k: "likeCount" | "repostCount" | "quoteCount"): number =>
    posts.reduce((s, item) => s + (item.post?.[k] ?? 0), 0);

  const value = {
    metric: {
      id: "bluesky" as const,
      name: "Bluesky" as const,
      views: 0, // Bluesky exposes no impressions; the card shows 0 views
      retentionRate: 0, // not exposed either; the card shows 0.0%
      likesPerView: clamp01(ratio(sum("likeCount"), followers)),
      shareRate: clamp01(ratio(sum("repostCount") + sum("quoteCount"), followers)),
      lastUpdated: new Date().toISOString(),
      source: "bluesky" as const,
    },
    // No views, so no view history either.
    previousViews: 0,
  };
  cachedResult = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

export async function buildBlueskyPayload(requestedDay: Date): Promise<BlueskyPayload> {
  const payload: BlueskyPayload = {
    date: dateKey(requestedDay),
    liveDate: dateKey(new Date(requestedDay.getTime() - DAY_SECONDS * 1000)),
    syncedAt: new Date().toISOString(),
    metrics: [],
    previousViews: {},
    errors: {},
  };

  try {
    const r = await fetchBluesky();
    payload.metrics.push(r.metric);
    payload.previousViews.bluesky = r.previousViews;
  } catch (err) {
    payload.errors.bluesky = err instanceof Error ? err.message : String(err);
  }
  return payload;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const payload = await buildBlueskyPayload(parseDateParam(url.searchParams.get("date")));
  const failed = payload.metrics.length === 0;
  return new Response(JSON.stringify(payload), {
    status: failed ? 502 : 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Counters move slowly; let the edge cache absorb repeat loads for an hour.
      "Cache-Control": failed
        ? "no-store"
        : "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
