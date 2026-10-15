/**
 * Prints the health of every platform's API key, the same check the dashboard's
 * "API connections" panel does, without opening the browser.
 *
 *   npm run keys:check
 *
 * Calls each api/*.ts function once (one dashboard reload's worth of requests;
 * X bills it as up to 100 post reads) and reports errors and known expiry dates.
 */
import { buildMetaPayload } from "../api/meta.ts";
import { buildYouTubePayload } from "../api/youtube.ts";
import { buildTikTokPayload } from "../api/tiktok.ts";
import { buildXPayload } from "../api/x.ts";
import { buildPinterestPayload } from "../api/pinterest.ts";
import { buildBlueskyPayload } from "../api/bluesky.ts";

const WARN_DAYS = 14;
const LABEL: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  tiktok: "TikTok",
  twitter: "Twitter / X",
  pinterest: "Pinterest",
  bluesky: "Bluesky",
};
const FIX: Record<string, string> = {
  instagram: "New long-lived token from Graph API Explorer -> META_ACCESS_TOKEN (see DEPLOY.md)",
  facebook: "GET /me/accounts with a fresh user token -> META_PAGE_ACCESS_TOKEN (see DEPLOY.md)",
  youtube: "New refresh token from OAuth Playground -> YOUTUBE_REFRESH_TOKEN (see DEPLOY.md)",
  tiktok: 'Run "Connect TikTok.bat"',
  twitter: 'Run "Set X Account.bat"; for 401/403 regenerate X_BEARER_TOKEN; for 402 add credits',
  pinterest: 'Run "Connect Pinterest.bat"',
  bluesky: "Set BLUESKY_HANDLE in .env.local",
};

interface Result {
  metrics: Array<{ id: string }>;
  errors: Record<string, string>;
  tokens?: Record<string, { expiresAt?: string; note?: string }>;
}

const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
console.log("Checking API keys (reads .env.local)...\n");

const results = (await Promise.all([
  buildMetaPayload(today),
  buildYouTubePayload(today),
  buildTikTokPayload(today),
  buildXPayload(today),
  buildPinterestPayload(today),
  buildBlueskyPayload(today),
])) as Result[];

let problems = 0;
for (const r of results) {
  const ids = new Set([...r.metrics.map((m) => m.id), ...Object.keys(r.errors)]);
  for (const id of ids) {
    const name = (LABEL[id] ?? id).padEnd(12);
    const error = r.errors[id];
    const token = r.tokens?.[id];
    const days = token?.expiresAt
      ? Math.floor((new Date(token.expiresAt).getTime() - Date.now()) / 86_400_000)
      : undefined;
    if (error) {
      problems++;
      console.log(`  [FIX]  ${name} ${error}`);
      console.log(`         -> ${FIX[id]}`);
    } else if ((days !== undefined && days <= WARN_DAYS) || token?.note) {
      problems++;
      console.log(`  [SOON] ${name} ${days !== undefined ? `key expires in ${days} days` : token?.note}`);
      console.log(`         -> ${FIX[id]}`);
    } else {
      console.log(`  [OK]   ${name} connected${days !== undefined ? `, key good for ${days} days` : ""}`);
    }
  }
}
console.log(`\nLinkedIn, Snapchat, Threads and Reddit have no API integration yet (demo data).`);
console.log(problems === 0 ? "All keys OK." : `${problems} need attention.`);
process.exit(0);
