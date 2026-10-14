/**
 * One-time TikTok authorization helper.
 *
 *   npm run tiktok:auth
 *
 * 1. Prints the authorize URL. Open it in a browser signed in to the TikTok
 *    account you want the dashboard to track (it must be a sandbox target user
 *    while the app is unaudited).
 * 2. After you click Authorize, TikTok sends the browser to the redirect URI.
 *    Copy the code shown on that page and paste it here.
 * 3. The script exchanges the code for tokens and writes TIKTOK_REFRESH_TOKEN
 *    into .env.local. Restart the server afterwards.
 */
import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const ENV_FILE = ".env.local";
const clientKey = process.env.TIKTOK_CLIENT_KEY;
const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
const redirectUri = process.env.TIKTOK_REDIRECT_URI || "https://serfis-site.vercel.app/tiktok/callback";
const scope = process.env.TIKTOK_SCOPES || "user.info.basic,video.list";

if (!clientKey || !clientSecret) {
  console.error(`Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in ${ENV_FILE} first (use the sandbox values).`);
  process.exit(1);
}

const state = randomBytes(8).toString("hex");
const authorize = new URL("https://www.tiktok.com/v2/auth/authorize/");
authorize.search = new URLSearchParams({ client_key: clientKey, response_type: "code", scope, redirect_uri: redirectUri, state }).toString();

console.log("\nRedirect URI in use (must match Login Kit exactly):\n  " + redirectUri);
console.log("\n1. Open this URL while signed in to the TikTok account to track:\n\n  " + authorize.toString() + "\n");
console.log("2. Click Authorize. On the Serfis page that opens, expand the authorization code section and copy it.\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question("3. Paste the code here: ")).trim();
rl.close();
if (!code) {
  console.error("No code entered.");
  process.exit(1);
}

const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }),
});
const json = (await res.json()) as { refresh_token?: string; open_id?: string; scope?: string; error?: string; error_description?: string };
if (!res.ok || !json.refresh_token) {
  console.error("\nToken exchange failed:", json.error ?? res.status, json.error_description ?? "");
  console.error("Common causes: code already used or expired (they last a few minutes), redirect_uri differs from the one in Login Kit, or production keys used with a sandbox target user.");
  process.exit(1);
}

let env = "";
try { env = await readFile(ENV_FILE, "utf8"); } catch { /* create it */ }
const line = `TIKTOK_REFRESH_TOKEN=${json.refresh_token}`;
env = /^TIKTOK_REFRESH_TOKEN=.*$/m.test(env) ? env.replace(/^TIKTOK_REFRESH_TOKEN=.*$/m, line) : env.replace(/\s*$/, "\n") + line + "\n";
await writeFile(ENV_FILE, env, { mode: 0o600 });

console.log(`\nConnected TikTok open_id ${json.open_id} with scopes: ${json.scope}`);
console.log(`Refresh token saved to ${ENV_FILE}. Restart the dev server (Restart Dashboard.bat), or add it to the Vercel env vars, to start pulling TikTok data.`);
