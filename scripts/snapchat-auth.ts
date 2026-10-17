/**
 * One-time Snapchat authorization helper.
 *
 *   npm run snapchat:auth
 *
 * 1. Prints the authorize URL. Open it signed in to the Snapchat account that
 *    belongs to the Serfis Business organization (and has access to the ad account).
 * 2. After you click "Continue", Snapchat sends the browser to the redirect URI.
 *    Copy the code shown on that page and paste it here.
 * 3. The script exchanges the code and writes SNAPCHAT_REFRESH_TOKEN into
 *    .env.local. Restart the server afterwards and copy the value to Vercel.
 */
import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const ENV_FILE = ".env.local";
const AUTHORIZE_URL = "https://accounts.snapchat.com/accounts/oauth2/auth";
const TOKEN_URL = "https://accounts.snapchat.com/login/oauth2/access_token";
const clientId = process.env.SNAPCHAT_CLIENT_ID?.trim();
const clientSecret = process.env.SNAPCHAT_CLIENT_SECRET?.trim();
const redirectUri = process.env.SNAPCHAT_REDIRECT_URI || "https://serfis-site.vercel.app/snapchat/callback";

if (!clientId || !clientSecret) {
  console.error(`Set SNAPCHAT_CLIENT_ID and SNAPCHAT_CLIENT_SECRET in ${ENV_FILE} first (business.snapchat.com -> Business Details -> OAuth Apps).`);
  process.exit(1);
}

const state = randomBytes(8).toString("hex");
const authorize = new URL(AUTHORIZE_URL);
authorize.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "snapchat-marketing-api",
  state,
}).toString();

console.log("\nRedirect URI in use (must match the OAuth app's Redirect URI exactly):\n  " + redirectUri);
console.log("\n1. Open this URL while signed in to the Snapchat account that manages the Serfis ad account:\n\n  " + authorize.toString() + "\n");
console.log(`2. Click "Continue". On the Serfis page that opens, copy the authorization code.`);
console.log(`   (The page also shows state ${state}; it should match.)\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question("3. Paste the code here: ")).trim();
rl.close();
if (!code) {
  console.error("No code entered.");
  process.exit(1);
}

const res = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  }),
});
const json = (await res.json().catch(() => ({}))) as {
  refresh_token?: string;
  error?: string;
  error_description?: string;
};
if (!res.ok || !json.refresh_token) {
  console.error("\nToken exchange failed:", json.error_description ?? json.error ?? res.status);
  console.error("Common causes: code already used or expired, redirect_uri differs from the one registered in the OAuth app, or the client secret is wrong.");
  process.exit(1);
}

let env = "";
try { env = await readFile(ENV_FILE, "utf8"); } catch { /* create it */ }
const re = /^SNAPCHAT_REFRESH_TOKEN=.*$/m;
const line = `SNAPCHAT_REFRESH_TOKEN=${json.refresh_token}`;
env = re.test(env) ? env.replace(re, line) : env.replace(/\s*$/, "\n") + line + "\n";
await writeFile(ENV_FILE, env, { mode: 0o600 });

console.log(`\nConnected. Refresh token saved to ${ENV_FILE}.`);
console.log("Also set SNAPCHAT_AD_ACCOUNT_ID (Business Settings -> Ad Accounts), restart the dev server (Restart Dashboard.bat), and copy the variables to Vercel.");
