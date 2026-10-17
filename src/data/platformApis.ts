import type { DailyPayload, PlatformName } from "../types";
import { DAY_MS } from "../lib/utils";

/**
 * What each platform's API can actually tell us, and how to keep its key alive.
 *
 * Every API exposes something different (YouTube has watch-time retention,
 * Pinterest has saves and outbound clicks, Bluesky has no views at all), so the
 * dashboard's four columns mean slightly different things per platform. A null
 * metric label means the API does not report it: the cell shows "n/a" and the
 * platform is left out of that column's cross-platform average.
 */
export interface PlatformApiProfile {
  /** Short API name shown under the platform. */
  api: string;
  /** "daily" = numbers for one finished day; "lifetime" = running totals over recent posts. */
  window: "daily" | "lifetime";
  /** One-line description of the window, e.g. "Lifetime · last 100 posts". */
  windowLabel: string;
  /** What "views" means here, or null when the API has no view count. */
  views: string | null;
  retention: string | null;
  likes: string | null;
  share: string | null;
  /** Env vars holding the credential. Empty for platforms with no integration. */
  envVars: string[];
  /** Typical lifetime of the stored key, for the connection panel. */
  keyLifetime: string;
  /** Step-by-step fix when the key is missing, expired or rejected. */
  fix: string[];
}

export const PLATFORM_APIS: Partial<Record<PlatformName, PlatformApiProfile>> = {
  Instagram: {
    api: "Meta Graph API",
    window: "daily",
    windowLabel: "Daily account insights",
    views: "Views (account insights)",
    retention: "Engagement rate: accounts engaged ÷ accounts reached",
    likes: "Likes ÷ views",
    share: "Shares ÷ views",
    envVars: ["META_ACCESS_TOKEN", "META_IG_USER_ID"],
    keyLifetime: "Long-lived user token: ~60 days",
    fix: [
      "Open developers.facebook.com/tools/explorer, pick the Serfis app, and generate a User token with instagram_basic, instagram_manage_insights, pages_show_list, pages_read_engagement and read_insights.",
      "Exchange it for a 60-day token: GET /oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN.",
      "Paste the long-lived token into META_ACCESS_TOKEN in .env.local and in Vercel → Settings → Environment Variables.",
      "Redeploy on Vercel (or run Restart Dashboard.bat locally), then press Reload.",
    ],
  },
  Facebook: {
    api: "Meta Graph API",
    window: "daily",
    windowLabel: "Daily Page insights",
    views: "Page media views",
    retention: "Post engagements ÷ unique viewers",
    likes: "Like reactions ÷ views",
    share: "Shares on that day's posts ÷ views",
    envVars: ["META_PAGE_ACCESS_TOKEN", "META_PAGE_ID"],
    keyLifetime: "Page token: no expiry while the user token's 90-day data access lasts",
    fix: [
      "Generate a fresh long-lived User token first (see the Instagram steps).",
      "Call GET /me/accounts with that token and copy the access_token of the Serfis Page; Page tokens made from a long-lived user token do not expire.",
      "Paste it into META_PAGE_ACCESS_TOKEN in .env.local and Vercel, then redeploy and press Reload.",
      "Page tokens are also revoked if the admin changes their Facebook password or removes the app, so repeat these steps after either.",
    ],
  },
  YouTube: {
    api: "YouTube Analytics API",
    window: "daily",
    windowLabel: "Daily channel report (2–3 day lag)",
    views: "Views",
    retention: "Average % of each video watched",
    likes: "Likes ÷ views",
    share: "Shares ÷ views",
    envVars: ["YOUTUBE_REFRESH_TOKEN", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"],
    keyLifetime: "Refresh token: no expiry once the OAuth app is In production (7 days while Testing)",
    fix: [
      "Open developers.google.com/oauthplayground, click the gear, tick 'Use your own OAuth credentials' and paste YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET.",
      "Authorize yt-analytics.readonly and youtube.readonly as the channel owner, then 'Exchange authorization code for tokens'.",
      "Copy the refresh token into YOUTUBE_REFRESH_TOKEN in .env.local and Vercel, redeploy, press Reload.",
      "If it keeps expiring every 7 days: Google Cloud → OAuth consent screen → Publish app (Testing-mode tokens expire weekly).",
    ],
  },
  TikTok: {
    api: "TikTok Display API",
    window: "lifetime",
    windowLabel: "Lifetime · last 100 videos",
    views: "Video views (lifetime)",
    retention: null,
    likes: "Likes ÷ views",
    share: "Shares ÷ views",
    envVars: ["TIKTOK_REFRESH_TOKEN", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    keyLifetime: "Refresh token: 365 days",
    fix: [
      "Double-click 'Connect TikTok.bat' (or run npm run tiktok:auth) and sign in as the Serfis TikTok account.",
      "The script writes the new TIKTOK_REFRESH_TOKEN into .env.local for you.",
      "Copy the same value into Vercel → Settings → Environment Variables and redeploy, then press Reload.",
    ],
  },
  Twitter: {
    api: "X API v2",
    window: "lifetime",
    windowLabel: "Lifetime · last 100 posts",
    views: "Impressions (lifetime)",
    retention: null,
    likes: "Likes ÷ impressions",
    share: "Reposts + quotes ÷ impressions",
    envVars: ["X_BEARER_TOKEN", "X_USER_ID"],
    keyLifetime: "Bearer token: no expiry until regenerated; reads use prepaid credits",
    fix: [
      "X_USER_ID not configured: double-click 'Set X Account.bat' and enter the Serfis X handle (without the @).",
      "Sign in at console.x.com → your project → app → Keys and tokens.",
      "401/403: regenerate the Bearer Token and paste it into X_BEARER_TOKEN in .env.local and Vercel.",
      "402 or a credits message: add credits under Billing (X charges per post read).",
      "Redeploy (or Restart Dashboard.bat), then press Reload.",
    ],
  },
  Pinterest: {
    api: "Pinterest API v5",
    window: "daily",
    windowLabel: "Daily account analytics",
    views: "Impressions",
    retention: "Video 95% completions ÷ video starts",
    likes: "Saves ÷ impressions",
    share: "Outbound clicks ÷ impressions",
    envVars: ["PINTEREST_REFRESH_TOKEN", "PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
    keyLifetime: "Refresh token: 60 days, rotates on every refresh",
    fix: [
      "Not connected yet, or already expired: double-click 'Connect Pinterest.bat' (npm run pinterest:auth) and approve access as the Serfis business account.",
      "Still valid but expiring: run npm run pinterest:auth -- --refresh to rotate it for another 60 days.",
      "Copy PINTEREST_REFRESH_TOKEN and PINTEREST_REFRESH_TOKEN_EXPIRES_AT from .env.local into Vercel and redeploy, then press Reload.",
    ],
  },
  Snapchat: {
    api: "Snap Marketing API",
    window: "daily",
    windowLabel: "Daily ad-account stats (paid only)",
    views: "Ad impressions",
    retention: "Video completions ÷ video views",
    likes: "Saves ÷ impressions",
    share: "Shares ÷ impressions",
    envVars: ["SNAPCHAT_REFRESH_TOKEN", "SNAPCHAT_CLIENT_ID", "SNAPCHAT_CLIENT_SECRET", "SNAPCHAT_AD_ACCOUNT_ID"],
    keyLifetime: "Refresh token: long-lived until revoked",
    fix: [
      "Not connected yet, or revoked: fill in SNAPCHAT_CLIENT_ID, SNAPCHAT_CLIENT_SECRET and SNAPCHAT_AD_ACCOUNT_ID, then double-click 'Connect Snapchat.bat' (npm run snapchat:auth).",
      "Approve access as the Snapchat user that manages the Serfis ad account.",
      "Copy the SNAPCHAT_* values from .env.local into Vercel and redeploy, then press Reload.",
    ],
  },
  LinkedIn: {
    api: "LinkedIn Community Management API",
    window: "daily",
    windowLabel: "Daily Company Page post stats",
    views: "Post impressions",
    retention: null,
    likes: "Likes ÷ impressions",
    share: "Shares ÷ impressions",
    envVars: ["LINKEDIN_REFRESH_TOKEN", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_ORGANIZATION_ID"],
    keyLifetime: "Refresh token: 365 days, not rotated",
    fix: [
      "Not connected yet, or expired: fill in LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET, then double-click 'Connect LinkedIn.bat' (npm run linkedin:auth) and approve access as an administrator of the Serfis Company Page.",
      "403 errors: the app needs the Community Management API product approved, and the authorizing member must be a page ADMINISTRATOR.",
      "Copy the LINKEDIN_* values (including LINKEDIN_REFRESH_TOKEN_EXPIRES_AT) from .env.local into Vercel and redeploy, then press Reload.",
    ],
  },
  Bluesky: {
    api: "Bluesky public AppView",
    window: "lifetime",
    windowLabel: "Lifetime · last 100 posts, per follower",
    views: null,
    retention: null,
    likes: "Likes ÷ followers",
    share: "Reposts + quotes ÷ followers",
    envVars: ["BLUESKY_HANDLE"],
    keyLifetime: "No key needed (public API)",
    fix: [
      "Bluesky needs no token, only the account handle.",
      "Set BLUESKY_HANDLE (e.g. serfis.bsky.social) in .env.local and Vercel, redeploy, press Reload.",
    ],
  },
};

const NOT_WIRED_FIX = [
  "There is no API integration for this platform yet, so the dashboard shows demo numbers.",
  "Adding one means a new api/<platform>.ts function following api/tiktok.ts, a route in vite.config.ts LOCAL_API_ROUTES and src/data/metaApi.ts LIVE_ENDPOINTS.",
];

/* ------------------------------------------------------------------ */
/* connection health                                                   */
/* ------------------------------------------------------------------ */

export type ConnectionState =
  | "live" // data came back and the key is not close to expiring
  | "expiring" // data came back but the key expires within EXPIRY_WARN_DAYS
  | "expired" // the platform rejected the key
  | "missing" // env vars not set
  | "billing" // X: out of credits
  | "rate-limited"
  | "error" // anything else
  | "offline" // /api endpoints not reachable (static build)
  | "demo"; // no integration exists

export interface ConnectionStatus {
  name: PlatformName;
  state: ConnectionState;
  /** Short status text for the panel row. */
  summary: string;
  /** Raw error from the API, if any. */
  detail?: string;
  /** Days until the key expires, when known. */
  daysLeft?: number;
  /** True when someone needs to do something. */
  needsAction: boolean;
  fix: string[];
  envVars: string[];
  keyLifetime: string;
}

/** Warn this many days before a key expires. */
export const EXPIRY_WARN_DAYS = 14;

function classifyError(message: string): ConnectionState {
  if (/not configured/i.test(message)) return "missing";
  if (/rate limit|HTTP 429/i.test(message)) return "rate-limited";
  if (/HTTP 402|credit|payment/i.test(message)) return "billing";
  if (
    /expired|invalid_grant|invalid_token|token refresh failed|validating access token|revoked|unauthori[sz]ed|HTTP 40[13]|OAuthException|session has expired/i.test(
      message,
    )
  ) {
    return "expired";
  }
  return "error";
}

const STATE_SUMMARY: Record<ConnectionState, string> = {
  live: "Connected",
  expiring: "Key expiring soon",
  expired: "Key expired or rejected",
  missing: "Not configured",
  billing: "Out of API credits",
  "rate-limited": "Rate limited, retry later",
  error: "API error",
  offline: "API offline (static build)",
  demo: "No API yet · demo data",
};

export function assessConnections(payload: DailyPayload, now: Date): ConnectionStatus[] {
  return payload.metrics.map((m) => {
    const profile = PLATFORM_APIS[m.name];
    const base = {
      name: m.name,
      fix: profile?.fix ?? NOT_WIRED_FIX,
      envVars: profile?.envVars ?? [],
      keyLifetime: profile?.keyLifetime ?? "n/a",
    };
    if (!profile) {
      return { ...base, state: "demo", summary: STATE_SUMMARY.demo, needsAction: false };
    }
    if (!payload.apiReachable) {
      return { ...base, state: "offline", summary: STATE_SUMMARY.offline, needsAction: false };
    }

    const error = payload.errors?.[m.id];
    if (error) {
      const state = classifyError(error);
      return { ...base, state, summary: STATE_SUMMARY[state], detail: error, needsAction: state !== "rate-limited" };
    }

    if (m.source === "mock") {
      // The endpoint itself failed (e.g. a 500 from the dev middleware) without naming an error.
      return { ...base, state: "error", summary: "No response from the API", needsAction: true };
    }

    const token = payload.tokens?.[m.id];
    const daysLeft = token?.expiresAt
      ? Math.floor((new Date(token.expiresAt).getTime() - now.getTime()) / DAY_MS)
      : undefined;
    if (daysLeft !== undefined && daysLeft < 0) {
      return { ...base, state: "expired", summary: STATE_SUMMARY.expired, detail: token?.note, daysLeft, needsAction: true };
    }
    // A note (e.g. "refresh token rotated") only warns when there is no expiry date to go by.
    if (daysLeft !== undefined ? daysLeft <= EXPIRY_WARN_DAYS : !!token?.note) {
      const summary = daysLeft !== undefined ? `Key expires in ${daysLeft}d` : "Key rotated, update env var";
      return { ...base, state: "expiring", summary, detail: token?.note, daysLeft, needsAction: true };
    }
    const summary = daysLeft !== undefined ? `Connected · key good for ${daysLeft}d` : STATE_SUMMARY.live;
    return { ...base, state: "live", summary, daysLeft, needsAction: false };
  });
}
