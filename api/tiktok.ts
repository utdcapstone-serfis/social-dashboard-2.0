/**
 * Vercel serverless function: GET /api/tiktok?date=YYYY-MM-DD
 *
 * Pulls the connected TikTok account's videos through the Display API using a
 * long-lived OAuth refresh token, and returns them in the dashboard's metric
 * shape. The refresh token and the short-lived access tokens minted from it
 * never leave this function.
 *
 * Environment variables (Vercel -> Project -> Settings -> Environment Variables,
 * or .env.local for `npm run dev`):
 *   TIKTOK_CLIENT_KEY      client key from the TikTok for Developers portal
 *                          (use the Sandbox key while the app is unaudited)
 *   TIKTOK_CLIENT_SECRET   the matching client secret
 *   TIKTOK_REFRESH_TOKEN   refresh token from `npm run tiktok:auth`, authorized
 *                          as the account owner with user.info.basic + video.list
 *
 * Metric mapping. The Display API only exposes lifetime counters per video, with
 * no daily breakdown, so the card shows totals across the most recent videos:
 *   views          sum of view_count
 *   retentionRate  not exposed by TikTok -> 0 (renders as n/a)
 *   likesPerView   sum of like_count / views
 *   shareRate      sum of share_count / views
 * previousViews is reported equal to views, so the day-over-day delta is 0
 * rather than a misleading number; this function keeps no history.
 */

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const VIDEO_LIST_URL = "https://open.tiktokapis.com/v2/video/list/";
const VIDEO_FIELDS = "id,title,share_url,create_time,view_count,like_count,comment_count,share_count";
const DAY_SECONDS = 24 * 60 * 60;
/** Upper bound on videos summed per request (5 pages of 20). */
const MAX_VIDEOS = 100;

interface TikTokMetric {
  id: "tiktok";
  name: "TikTok";
  views: number;
  retentionRate: number;
  likesPerView: number;
  shareRate: number;
  lastUpdated: string;
  source: "tiktok";
}

export interface TikTokPayload {
  /** The dashboard's calendar day this payload was requested for. */
  date: string;
  /** The last complete UTC day (date - 1), kept for parity with the other endpoints. */
  liveDate: string;
  syncedAt: string;
  metrics: TikTokMetric[];
  previousViews: Record<string, number>;
  /** Per-platform error messages; a platform with an error is omitted from `metrics`. */
  errors: Record<string, string>;
  /** Credential health the dashboard turns into "refresh your key" warnings. */
  tokens: Record<string, { expiresAt?: string; note?: string }>;
  /** This account's most-viewed videos. */
  posts: TopPost[];
}

/** One post for the dashboard's "Top posts" panel. views is null when the API has no view count. */
export interface TopPost {
  platform: string;
  id: string;
  title: string;
  url?: string;
  views: number | null;
  likes: number;
  publishedAt?: string;
}

/** How many of this platform's posts to hand the dashboard. */
const TOP_POSTS = 5;


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
  /** Seconds until the refresh token itself expires (365 days at issue). */
  refresh_expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Module-level cache so warm invocations reuse the access token until it expires. */
let cachedToken: { value: string; expiresAt: number } | null = null;
/** TikTok may hand back a rotated refresh token; prefer the newest one this instance has seen. */
let latestRefreshToken: string | null = null;
/** What the last refresh said about the stored refresh token, for the dashboard's key-health panel. */
let refreshTokenHealth: { expiresAt?: string; note?: string } = {};

async function getAccessToken(): Promise<string> {
  const clientKey = env("TIKTOK_CLIENT_KEY");
  const clientSecret = env("TIKTOK_CLIENT_SECRET");
  const refreshToken = latestRefreshToken ?? env("TIKTOK_REFRESH_TOKEN");
  if (!clientKey || !clientSecret || !refreshToken) {
    throw new Error("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / TIKTOK_REFRESH_TOKEN not configured");
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`TikTok token refresh failed: ${detail}`);
  }
  refreshTokenHealth = {
    expiresAt: body.refresh_expires_in
      ? new Date(Date.now() + body.refresh_expires_in * 1000).toISOString()
      : undefined,
  };
  if (body.refresh_token && body.refresh_token !== refreshToken) {
    latestRefreshToken = body.refresh_token;
    refreshTokenHealth.note = "TikTok rotated the refresh token; the stored TIKTOK_REFRESH_TOKEN is now stale.";
    console.warn(
      "[tiktok] TikTok rotated the refresh token; update TIKTOK_REFRESH_TOKEN before this instance is recycled.",
    );
  }
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 86_400) * 1000,
  };
  return body.access_token;
}

/* ------------------------------------------------------------------ */
/* Display API                                                         */
/* ------------------------------------------------------------------ */

interface Video {
  id: string;
  title?: string;
  share_url?: string;
  create_time?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
}

interface VideoListResponse {
  data?: { videos?: Video[]; cursor?: number; has_more?: boolean };
  error?: { code?: string; message?: string; log_id?: string };
}

async function listVideos(token: string): Promise<Video[]> {
  const videos: Video[] = [];
  let cursor: number | undefined;
  while (videos.length < MAX_VIDEOS) {
    // Token goes in a header, never in the URL, so it can't leak into logs.
    const res = await fetch(`${VIDEO_LIST_URL}?fields=${VIDEO_FIELDS}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ max_count: 20, ...(cursor ? { cursor } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as VideoListResponse;
    const errCode = body.error?.code;
    if (!res.ok || (errCode && errCode !== "ok")) {
      throw new Error(body.error?.message ?? `TikTok video.list HTTP ${res.status}`);
    }
    videos.push(...(body.data?.videos ?? []));
    if (!body.data?.has_more || !body.data.cursor) break;
    cursor = body.data.cursor;
  }
  return videos;
}

async function fetchTikTok(): Promise<{ metric: TikTokMetric; previousViews: number; posts: TopPost[] }> {
  const token = await getAccessToken();
  const videos = await listVideos(token);
  const sum = (k: "view_count" | "like_count" | "share_count"): number =>
    videos.reduce((s, v) => s + (v[k] ?? 0), 0);
  const views = sum("view_count");

  return {
    metric: {
      id: "tiktok",
      name: "TikTok",
      views,
      retentionRate: 0, // TikTok does not expose retention; the card renders n/a
      likesPerView: clamp01(ratio(sum("like_count"), views)),
      shareRate: clamp01(ratio(sum("share_count"), views)),
      lastUpdated: new Date().toISOString(),
      source: "tiktok",
    },
    // Lifetime counters with no stored history: report a flat day-over-day delta.
    previousViews: views,
    posts: [...videos]
      .sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0) || (b.like_count ?? 0) - (a.like_count ?? 0))
      .slice(0, TOP_POSTS)
      .map((v) => ({
        platform: "tiktok",
        id: v.id,
        title: v.title?.trim() || "Untitled video",
        url: v.share_url,
        views: v.view_count ?? 0,
        likes: v.like_count ?? 0,
        publishedAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : undefined,
      })),
  };
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

export async function buildTikTokPayload(requestedDay: Date): Promise<TikTokPayload> {
  const payload: TikTokPayload = {
    date: dateKey(requestedDay),
    liveDate: dateKey(new Date(requestedDay.getTime() - DAY_SECONDS * 1000)),
    syncedAt: new Date().toISOString(),
    metrics: [],
    previousViews: {},
    errors: {},
    tokens: {},
    posts: [],
  };

  try {
    const r = await fetchTikTok();
    payload.metrics.push(r.metric);
    payload.previousViews.tiktok = r.previousViews;
    payload.posts = r.posts;
  } catch (err) {
    payload.errors.tiktok = err instanceof Error ? err.message : String(err);
  }
  if (refreshTokenHealth.expiresAt || refreshTokenHealth.note) payload.tokens.tiktok = refreshTokenHealth;
  return payload;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const payload = await buildTikTokPayload(parseDateParam(url.searchParams.get("date")));
  const failed = payload.metrics.length === 0;
  return new Response(JSON.stringify(payload), {
    status: failed ? 502 : 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Counters move slowly; let Vercel's edge cache absorb repeat loads for an hour.
      "Cache-Control": failed
        ? "no-store"
        : "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
