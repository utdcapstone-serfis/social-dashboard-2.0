/**
 * Vercel serverless function: GET /api/meta?date=YYYY-MM-DD
 *
 * Pulls Instagram and Facebook Page insights from the Meta Graph API using
 * server-side secrets, and returns them in the dashboard's metric shape.
 * The access tokens never leave this function.
 *
 * Environment variables (Vercel -> Project -> Settings -> Environment Variables,
 * or .env.local when running `vercel dev`):
 *   META_GRAPH_VERSION      e.g. v23.0
 *   META_IG_USER_ID         Instagram professional account id
 *   META_ACCESS_TOKEN       token with instagram_basic + instagram_manage_insights
 *   META_PAGE_ID            Facebook Page id
 *   META_PAGE_ACCESS_TOKEN  Page token with read_insights + pages_read_engagement
 *
 * Metric mapping. Account-level insights only expose aggregate counts, so the
 * dashboard's three ratios are defined as:
 *   views          IG `views`                    FB `page_media_view`
 *   retentionRate  IG accounts_engaged / reach   FB page_post_engagements / page_total_media_view_unique
 *                  (share of reached accounts that went on to engage)
 *   likesPerView   IG likes / views              FB page_actions_post_reactions_like_total / views
 *   shareRate      IG shares / views             FB shares on posts published that day / views
 */

const GRAPH_HOST = "https://graph.facebook.com";
const DAY_SECONDS = 24 * 60 * 60;
/** Meta insights window is 2 years; stay a little inside it. */
const MAX_LOOKBACK_DAYS = 700;

interface MetaMetric {
  id: "instagram" | "facebook";
  name: "Instagram" | "Facebook";
  views: number;
  retentionRate: number;
  likesPerView: number;
  shareRate: number;
  lastUpdated: string;
  source: "meta";
}

export interface MetaPayload {
  /** The dashboard's calendar day this payload was requested for. */
  date: string;
  /** The last complete UTC day the Meta numbers describe (date - 1). */
  liveDate: string;
  syncedAt: string;
  metrics: MetaMetric[];
  previousViews: Record<string, number>;
  /** Per-platform error messages; a platform with an error is omitted from `metrics`. */
  errors: Record<string, string>;
  /** Credential health the dashboard turns into "refresh your key" warnings. */
  tokens: Record<string, { expiresAt?: string; note?: string }>;
  /** Most-engaging recent Instagram and Facebook posts. */
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

/** How many of each platform's posts to hand the dashboard. */
const TOP_POSTS = 5;


interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number };
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

class GraphApiError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

async function graphGet<T>(
  version: string,
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<T> {
  const url = new URL(`${GRAPH_HOST}/${version}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Token goes in a header, never in the URL, so it can't leak into logs.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || body.error) {
    const e = body.error ?? {};
    throw new GraphApiError(e.message ?? `Graph API HTTP ${res.status}`, e.code);
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* Instagram                                                           */
/* ------------------------------------------------------------------ */

interface IgInsightsResponse {
  data: Array<{ name: string; total_value?: { value: number } }>;
}

const IG_METRICS = ["views", "reach", "likes", "shares", "accounts_engaged"] as const;

/** Account-level totals for one UTC day. */
async function igTotalsForDay(
  version: string,
  igUserId: string,
  token: string,
  day: Date,
): Promise<Record<string, number>> {
  const since = Math.floor(day.getTime() / 1000);
  const until = since + DAY_SECONDS - 1;
  const fetchMetrics = async (metrics: readonly string[]) => {
    const body = await graphGet<IgInsightsResponse>(
      version,
      `${igUserId}/insights`,
      {
        metric: metrics.join(","),
        period: "day",
        metric_type: "total_value",
        since: String(since),
        until: String(until),
      },
      token,
    );
    const out: Record<string, number> = {};
    for (const row of body.data ?? []) out[row.name] = row.total_value?.value ?? 0;
    return out;
  };

  try {
    return await fetchMetrics(IG_METRICS);
  } catch (err) {
    // If Meta retires one metric, retry individually and keep what still works.
    if (!(err instanceof GraphApiError) || err.code !== 100) throw err;
    const out: Record<string, number> = {};
    for (const m of IG_METRICS) {
      try {
        Object.assign(out, await fetchMetrics([m]));
      } catch {
        /* skip retired metric */
      }
    }
    if (Object.keys(out).length === 0) throw err;
    return out;
  }
}

async function fetchInstagram(
  version: string,
  liveDay: Date,
  prevDay: Date,
): Promise<{ metric: MetaMetric; previousViews: number }> {
  const igUserId = env("META_IG_USER_ID");
  const token = env("META_ACCESS_TOKEN");
  if (!igUserId || !token) throw new Error("META_IG_USER_ID / META_ACCESS_TOKEN not configured");

  const [today, prev] = await Promise.all([
    igTotalsForDay(version, igUserId, token, liveDay),
    igTotalsForDay(version, igUserId, token, prevDay),
  ]);

  const views = today.views ?? 0;
  return {
    metric: {
      id: "instagram",
      name: "Instagram",
      views,
      retentionRate: clamp01(ratio(today.accounts_engaged ?? 0, today.reach ?? 0)),
      likesPerView: clamp01(ratio(today.likes ?? 0, views)),
      shareRate: clamp01(ratio(today.shares ?? 0, views)),
      lastUpdated: new Date().toISOString(),
      source: "meta",
    },
    previousViews: prev.views ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Facebook Page                                                       */
/* ------------------------------------------------------------------ */

interface FbInsightsResponse {
  data: Array<{
    name: string;
    period: string;
    values: Array<{ value: number | Record<string, number>; end_time: string }>;
  }>;
}

interface FbPostsResponse {
  data: Array<{ id: string; shares?: { count: number } }>;
}

const FB_METRICS = [
  "page_media_view",
  "page_total_media_view_unique",
  "page_post_engagements",
  "page_actions_post_reactions_like_total",
] as const;

/**
 * Page insights with period=day return one value per day in the window.
 * Each value's `end_time` is the end of the day it describes (midnight
 * Pacific), so the UTC day key is end_time minus one day.
 */
function fbDayKeyOf(endTime: string): string {
  return dateKey(new Date(new Date(endTime).getTime() - DAY_SECONDS * 1000));
}

async function fbDailySeries(
  version: string,
  pageId: string,
  token: string,
  since: Date,
  until: Date,
): Promise<Record<string, Record<string, number>>> {
  const fetchMetrics = async (metrics: readonly string[]) => {
    const body = await graphGet<FbInsightsResponse>(
      version,
      `${pageId}/insights`,
      {
        metric: metrics.join(","),
        period: "day",
        since: String(Math.floor(since.getTime() / 1000)),
        until: String(Math.floor(until.getTime() / 1000)),
      },
      token,
    );
    // byDay[dayKey][metricName] = value
    const byDay: Record<string, Record<string, number>> = {};
    for (const row of body.data ?? []) {
      for (const v of row.values ?? []) {
        const key = fbDayKeyOf(v.end_time);
        const n = typeof v.value === "number" ? v.value : 0;
        (byDay[key] ??= {})[row.name] = n;
      }
    }
    return byDay;
  };

  try {
    return await fetchMetrics(FB_METRICS);
  } catch (err) {
    if (!(err instanceof GraphApiError) || err.code !== 100) throw err;
    const merged: Record<string, Record<string, number>> = {};
    for (const m of FB_METRICS) {
      try {
        const part = await fetchMetrics([m]);
        for (const [day, vals] of Object.entries(part)) Object.assign((merged[day] ??= {}), vals);
      } catch {
        /* skip retired metric */
      }
    }
    if (Object.keys(merged).length === 0) throw err;
    return merged;
  }
}

/** Sum of shares on posts published during [since, until). */
async function fbSharesOnPostsPublished(
  version: string,
  pageId: string,
  token: string,
  since: Date,
  until: Date,
): Promise<number> {
  try {
    const body = await graphGet<FbPostsResponse>(
      version,
      `${pageId}/published_posts`,
      {
        fields: "id,shares",
        limit: "100",
        since: String(Math.floor(since.getTime() / 1000)),
        until: String(Math.floor(until.getTime() / 1000)),
      },
      token,
    );
    return (body.data ?? []).reduce((s, p) => s + (p.shares?.count ?? 0), 0);
  } catch {
    return 0; // shares are a nice-to-have; don't fail the whole platform
  }
}

async function fetchFacebook(
  version: string,
  liveDay: Date,
  prevDay: Date,
): Promise<{ metric: MetaMetric; previousViews: number }> {
  const pageId = env("META_PAGE_ID");
  const token = env("META_PAGE_ACCESS_TOKEN") ?? env("META_ACCESS_TOKEN");
  if (!pageId || !token) throw new Error("META_PAGE_ID / META_PAGE_ACCESS_TOKEN not configured");

  const liveKey = dateKey(liveDay);
  const prevKey = dateKey(prevDay);
  // Window generously covers both days regardless of Meta's Pacific-time day boundaries.
  const windowStart = new Date(prevDay.getTime() - DAY_SECONDS * 1000);
  const windowEnd = new Date(liveDay.getTime() + 2 * DAY_SECONDS * 1000);
  const nextDay = new Date(liveDay.getTime() + DAY_SECONDS * 1000);

  const [byDay, shares] = await Promise.all([
    fbDailySeries(version, pageId, token, windowStart, windowEnd),
    fbSharesOnPostsPublished(version, pageId, token, liveDay, nextDay),
  ]);

  const today = byDay[liveKey] ?? {};
  const prev = byDay[prevKey] ?? {};
  const views = today.page_media_view ?? 0;

  return {
    metric: {
      id: "facebook",
      name: "Facebook",
      views,
      retentionRate: clamp01(
        ratio(today.page_post_engagements ?? 0, today.page_total_media_view_unique ?? 0),
      ),
      likesPerView: clamp01(ratio(today.page_actions_post_reactions_like_total ?? 0, views)),
      shareRate: clamp01(ratio(shares, views)),
      lastUpdated: new Date().toISOString(),
      source: "meta",
    },
    previousViews: prev.page_media_view ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* top posts                                                           */
/* ------------------------------------------------------------------ */

const oneLine = (text: string | undefined, fallback: string): string =>
  text?.replace(/\s+/g, " ").trim() || fallback;

/**
 * Instagram: the most-liked of the latest 25 media, then a per-media views
 * lookup for just those few. Best effort: [] on any failure.
 */
async function igTopPosts(version: string, igUserId: string, token: string): Promise<TopPost[]> {
  try {
    const body = await graphGet<{
      data?: Array<{ id: string; caption?: string; permalink?: string; timestamp?: string; like_count?: number }>;
    }>(version, `${igUserId}/media`, { fields: "id,caption,permalink,timestamp,like_count", limit: "25" }, token);
    const top = [...(body.data ?? [])]
      .sort((a, b) => (b.like_count ?? 0) - (a.like_count ?? 0))
      .slice(0, TOP_POSTS);
    return await Promise.all(
      top.map(async (m) => {
        let views: number | null = null;
        try {
          const ins = await graphGet<{ data?: Array<{ name: string; values?: Array<{ value: number }> }> }>(
            version,
            `${m.id}/insights`,
            { metric: "views" },
            token,
          );
          views = ins.data?.[0]?.values?.[0]?.value ?? null;
        } catch {
          /* older media types have no views insight */
        }
        return {
          platform: "instagram",
          id: m.id,
          title: oneLine(m.caption, "Instagram post"),
          url: m.permalink,
          views,
          likes: m.like_count ?? 0,
          publishedAt: m.timestamp,
        };
      }),
    );
  } catch {
    return [];
  }
}

/** Facebook: the most-reacted of the Page's latest 25 posts. Best effort: [] on any failure. */
async function fbTopPosts(version: string, pageId: string, token: string): Promise<TopPost[]> {
  try {
    const body = await graphGet<{
      data?: Array<{
        id: string;
        message?: string;
        permalink_url?: string;
        created_time?: string;
        reactions?: { summary?: { total_count?: number } };
      }>;
    }>(
      version,
      `${pageId}/published_posts`,
      { fields: "id,message,permalink_url,created_time,reactions.summary(total_count).limit(0)", limit: "25" },
      token,
    );
    return [...(body.data ?? [])]
      .sort((a, b) => (b.reactions?.summary?.total_count ?? 0) - (a.reactions?.summary?.total_count ?? 0))
      .slice(0, TOP_POSTS)
      .map((p) => ({
        platform: "facebook",
        id: p.id,
        title: oneLine(p.message, "Facebook post"),
        url: p.permalink_url,
        views: null,
        likes: p.reactions?.summary?.total_count ?? 0,
        publishedAt: p.created_time,
      }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* token health                                                        */
/* ------------------------------------------------------------------ */

interface DebugTokenResponse {
  data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number };
}

/**
 * Asks Graph's debug_token when a token stops working: the earlier of the token
 * expiry (0 = never, e.g. Page tokens from a long-lived user token) and the
 * 90-day data-access window. Best effort: returns undefined on any failure.
 */
async function tokenHealth(
  version: string,
  token: string | undefined,
): Promise<{ expiresAt?: string; note?: string } | undefined> {
  if (!token) return undefined;
  try {
    const body = await graphGet<DebugTokenResponse>(version, "debug_token", { input_token: token }, token);
    const d = body.data ?? {};
    if (d.is_valid === false) return { note: "Meta reports this token as invalid." };
    const ends = [d.expires_at, d.data_access_expires_at].filter((n): n is number => !!n && n > 0);
    return ends.length > 0 ? { expiresAt: new Date(Math.min(...ends) * 1000).toISOString() } : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

export async function buildMetaPayload(requestedDay: Date): Promise<MetaPayload> {
  const version = env("META_GRAPH_VERSION") ?? "v23.0";
  // Insights for a day are only complete after it ends, so report the last full UTC day.
  const liveDay = new Date(requestedDay.getTime() - DAY_SECONDS * 1000);
  const prevDay = new Date(liveDay.getTime() - DAY_SECONDS * 1000);

  const payload: MetaPayload = {
    date: dateKey(requestedDay),
    liveDate: dateKey(liveDay),
    syncedAt: new Date().toISOString(),
    metrics: [],
    previousViews: {},
    errors: {},
    tokens: {},
    posts: [],
  };

  const [results, igToken, fbToken] = await Promise.all([
    Promise.allSettled([fetchInstagram(version, liveDay, prevDay), fetchFacebook(version, liveDay, prevDay)]),
    tokenHealth(version, env("META_ACCESS_TOKEN")),
    tokenHealth(version, env("META_PAGE_ACCESS_TOKEN") ?? env("META_ACCESS_TOKEN")),
  ]);
  if (igToken) payload.tokens.instagram = igToken;
  if (fbToken) payload.tokens.facebook = fbToken;

  // Posts only for accounts whose insights worked, so a bad token reports one error, not two.
  const igId = env("META_IG_USER_ID");
  const igTok = env("META_ACCESS_TOKEN");
  const pageId = env("META_PAGE_ID");
  const pageTok = env("META_PAGE_ACCESS_TOKEN") ?? igTok;
  const [igPosts, fbPosts] = await Promise.all([
    results[0].status === "fulfilled" && igId && igTok ? igTopPosts(version, igId, igTok) : [],
    results[1].status === "fulfilled" && pageId && pageTok ? fbTopPosts(version, pageId, pageTok) : [],
  ]);
  payload.posts = [...igPosts, ...fbPosts];

  results.forEach((r, i) => {
    const id = i === 0 ? "instagram" : "facebook";
    if (r.status === "fulfilled") {
      payload.metrics.push(r.value.metric);
      payload.previousViews[id] = r.value.previousViews;
    } else {
      payload.errors[id] = r.reason instanceof Error ? r.reason.message : String(r.reason);
    }
  });
  return payload;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let requested = parseDateParam(url.searchParams.get("date"));

  // Meta only serves insights for the last 2 years and never for the future
  // (e.g. the dashboard's simulated day offset), else it answers "(#100) since param is not valid".
  const todayUtc = new Date(`${dateKey(new Date())}T00:00:00.000Z`);
  if (requested.getTime() > todayUtc.getTime()) requested = todayUtc;
  const oldest = new Date(todayUtc.getTime() - MAX_LOOKBACK_DAYS * DAY_SECONDS * 1000);
  if (requested.getTime() < oldest.getTime()) {
    return new Response(
      JSON.stringify({
        error: `date ${dateKey(requested)} is too old: Meta only provides insights for the last 2 years (earliest ${dateKey(oldest)}).`,
      }),
      { status: 400, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }

  const payload = await buildMetaPayload(requested);
  const allFailed = payload.metrics.length === 0;
  return new Response(JSON.stringify(payload), {
    status: allFailed ? 502 : 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Meta data is daily; let Vercel's edge cache absorb repeat loads for an hour.
      "Cache-Control": allFailed
        ? "no-store"
        : "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
