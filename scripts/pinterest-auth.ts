/**
 * One-time Pinterest authorization helper (plus manual token rotation).
 *
 *   npm run pinterest:auth              connect the account for the first time
 *   npm run pinterest:auth -- --refresh rotate the stored refresh token
 *
 * First connection:
 * 1. Prints the authorize URL. Open it in a browser signed in to the Pinterest
 *    BUSINESS account you want the dashboard to track (the one that owns the
 *    app, while the app is on Trial access).
 * 2. After you click "Give access", Pinterest sends the browser to the redirect
 *    URI. Copy the code shown on that page and paste it here.
 * 3. The script exchanges the code for tokens and writes PINTEREST_REFRESH_TOKEN
 *    into .env.local. Restart the server afterwards.
 *
 * --refresh: Pinterest's continuous refresh tokens expire 60 days after they
 * were issued, and every refresh issues a new one. Run this before the 60 days
 * are up; it swaps the stored token for a fresh one and prints the new expiry.
 * Copy the new value into the Vercel environment variables as well.
 */
import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const ENV_FILE = ".env.local";
const TOKEN_URL = "https://api.pinterest.com/v5/oauth/token";
const appId = process.env.PINTEREST_APP_ID?.trim();
const appSecret = process.env.PINTEREST_APP_SECRET?.trim();
const redirectUri = process.env.PINTEREST_REDIRECT_URI || "https://serfis-site.vercel.app/pinterest/callback";
const scope = process.env.PINTEREST_SCOPES || "user_accounts:read,pins:read,boards:read";
const refreshMode = process.argv.includes("--refresh");

if (!appId || !appSecret) {
  console.error(`Set PINTEREST_APP_ID and PINTEREST_APP_SECRET in ${ENV_FILE} first (developers.pinterest.com -> My apps).`);
  process.exit(1);
}

interface TokenJson {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  code?: number;
  message?: string;
  error?: string;
  error_description?: string;
}

/** Pinterest authenticates the app with HTTP Basic (app_id:app_secret). */
async function requestToken(body: Record<string, string>): Promise<{ res: Response; json: TokenJson }> {
  const basic = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as TokenJson;
  return { res, json };
}

async function saveRefreshToken(token: string, expiresIn?: number): Promise<void> {
  let env = "";
  try { env = await readFile(ENV_FILE, "utf8"); } catch { /* create it */ }
  const set = (name: string, value: string): void => {
    const line = `${name}=${value}`;
    const re = new RegExp(`^${name}=.*$`, "m");
    env = re.test(env) ? env.replace(re, line) : env.replace(/\s*$/, "\n") + line + "\n";
  };
  set("PINTEREST_REFRESH_TOKEN", token);
  // Lets /api/pinterest warn the dashboard before the 60-day refresh token lapses.
  if (expiresIn) set("PINTEREST_REFRESH_TOKEN_EXPIRES_AT", new Date(Date.now() + expiresIn * 1000).toISOString());
  await writeFile(ENV_FILE, env, { mode: 0o600 });
}

const days = (s?: number): string => (s ? `${Math.round(s / 86_400)} days` : "unknown");

if (refreshMode) {
  const current = process.env.PINTEREST_REFRESH_TOKEN?.trim();
  if (!current) {
    console.error(`No PINTEREST_REFRESH_TOKEN in ${ENV_FILE}. Run \`npm run pinterest:auth\` without --refresh first.`);
    process.exit(1);
  }
  const { res, json } = await requestToken({ grant_type: "refresh_token", refresh_token: current });
  if (!res.ok || !json.refresh_token) {
    console.error("\nRefresh failed:", json.message ?? json.error ?? res.status, json.error_description ?? "");
    console.error("If the stored token is older than 60 days it has expired: run `npm run pinterest:auth` to connect again.");
    process.exit(1);
  }
  await saveRefreshToken(json.refresh_token, json.refresh_token_expires_in);
  console.log(`\nRotated. New refresh token saved to ${ENV_FILE}; it expires in ${days(json.refresh_token_expires_in)}.`);
  console.log("Copy the new PINTEREST_REFRESH_TOKEN and PINTEREST_REFRESH_TOKEN_EXPIRES_AT into the Vercel environment variables too, then redeploy or restart.");
  process.exit(0);
}

const state = randomBytes(8).toString("hex");
const authorize = new URL("https://www.pinterest.com/oauth/");
authorize.search = new URLSearchParams({
  client_id: appId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope,
  state,
}).toString();

console.log("\nRedirect URI in use (must match the app's Configure -> Redirect URIs exactly):\n  " + redirectUri);
console.log("\n1. Open this URL while signed in to the Pinterest business account to track:\n\n  " + authorize.toString() + "\n");
console.log(`2. Click "Give access". On the Serfis page that opens, expand the authorization code section and copy it.`);
console.log(`   (The page also shows state ${state}; it should match.)\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question("3. Paste the code here: ")).trim();
rl.close();
if (!code) {
  console.error("No code entered.");
  process.exit(1);
}

const { res, json } = await requestToken({
  grant_type: "authorization_code",
  code,
  redirect_uri: redirectUri,
  // Apps created before 2025-09-25 need this to get a continuous refresh token; newer apps ignore it.
  continuous_refresh: "true",
});
if (!res.ok || !json.refresh_token) {
  console.error("\nToken exchange failed:", json.message ?? json.error ?? res.status, json.error_description ?? "");
  console.error("Common causes: code already used or expired, redirect_uri differs from the one registered in the app, or the app secret is wrong.");
  process.exit(1);
}

await saveRefreshToken(json.refresh_token, json.refresh_token_expires_in);

console.log(`\nConnected with scopes: ${json.scope ?? scope}`);
console.log(`Access token lifetime ${days(json.expires_in)}; refresh token lifetime ${days(json.refresh_token_expires_in)}.`);
console.log(`Refresh token saved to ${ENV_FILE}. Restart the dev server (Restart Dashboard.bat), or add it to the Vercel env vars, to start pulling Pinterest data.`);
console.log("Reminder: run `npm run pinterest:auth -- --refresh` before the refresh token expires and update Vercel with the new value.");
