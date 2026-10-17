/**
 * One-time LinkedIn authorization helper.
 *
 *   npm run linkedin:auth
 *
 * 1. Prints the authorize URL. Open it in a browser signed in to the LinkedIn
 *    member who is an ADMINISTRATOR of the Serfis Company Page.
 * 2. After you click "Allow", LinkedIn sends the browser to the redirect URI.
 *    Copy the code shown on that page and paste it here.
 * 3. The script exchanges the code for tokens, writes LINKEDIN_REFRESH_TOKEN (and
 *    its expiry) into .env.local, and looks up the Company Page id for
 *    LINKEDIN_ORGANIZATION_ID. Restart the server afterwards.
 *
 * Requires the Community Management API product on the app, otherwise LinkedIn
 * rejects the r_organization_* scopes. LinkedIn refresh tokens last 365 days and
 * are not rotated; run this again before they lapse. Copy the new values into
 * the Vercel environment variables as well.
 */
import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const ENV_FILE = ".env.local";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const clientId = process.env.LINKEDIN_CLIENT_ID?.trim();
const clientSecret = process.env.LINKEDIN_CLIENT_SECRET?.trim();
const redirectUri = process.env.LINKEDIN_REDIRECT_URI || "https://serfis-site.vercel.app/linkedin/callback";
const scope = process.env.LINKEDIN_SCOPES || "r_organization_social r_organization_admin";
const apiVersion = process.env.LINKEDIN_API_VERSION || "202510";

if (!clientId || !clientSecret) {
  console.error(`Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in ${ENV_FILE} first (developer.linkedin.com -> your app -> Auth).`);
  process.exit(1);
}

interface TokenJson {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function saveEnv(values: Record<string, string>): Promise<void> {
  let env = "";
  try { env = await readFile(ENV_FILE, "utf8"); } catch { /* create it */ }
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${value}`;
    const re = new RegExp(`^${name}=.*$`, "m");
    env = re.test(env) ? env.replace(re, line) : env.replace(/\s*$/, "\n") + line + "\n";
  }
  await writeFile(ENV_FILE, env, { mode: 0o600 });
}

const days = (s?: number): string => (s ? `${Math.round(s / 86_400)} days` : "unknown");
const inSeconds = (s: number): string => new Date(Date.now() + s * 1000).toISOString();

const state = randomBytes(8).toString("hex");
const authorize = new URL("https://www.linkedin.com/oauth/v2/authorization");
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  state,
  scope,
}).toString();

console.log("\nRedirect URI in use (must match the app's Auth -> Authorized redirect URLs exactly):\n  " + redirectUri);
console.log("\n1. Open this URL while signed in as an administrator of the Serfis LinkedIn page:\n\n  " + authorize.toString() + "\n");
console.log(`2. Click "Allow". On the Serfis page that opens, expand the authorization code section and copy it.`);
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
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  }),
});
const json = (await res.json().catch(() => ({}))) as TokenJson;
if (!res.ok || !json.access_token) {
  console.error("\nToken exchange failed:", json.error ?? res.status, json.error_description ?? "");
  console.error("Common causes: code already used or expired (30 minutes), redirect_uri differs from the one registered in the app, or the client secret is wrong.");
  process.exit(1);
}

const toSave: Record<string, string> = {};
if (json.refresh_token) {
  toSave.LINKEDIN_REFRESH_TOKEN = json.refresh_token;
  if (json.refresh_token_expires_in) toSave.LINKEDIN_REFRESH_TOKEN_EXPIRES_AT = inSeconds(json.refresh_token_expires_in);
} else {
  // This app's tier issued no refresh token: fall back to the 60-day access token.
  toSave.LINKEDIN_ACCESS_TOKEN = json.access_token;
  if (json.expires_in) toSave.LINKEDIN_ACCESS_TOKEN_EXPIRES_AT = inSeconds(json.expires_in);
  console.log("\nNote: LinkedIn issued no refresh token for this app, so the 60-day access token was saved instead. Re-run this script before it expires.");
}

// Find the Company Page(s) this member administers so LINKEDIN_ORGANIZATION_ID can be filled in.
try {
  const acl = await fetch(
    "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED",
    {
      headers: {
        Authorization: `Bearer ${json.access_token}`,
        "LinkedIn-Version": apiVersion,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    },
  );
  const aclJson = (await acl.json().catch(() => ({}))) as { elements?: Array<{ organization?: string }>; message?: string };
  const ids = (aclJson.elements ?? [])
    .map((e) => e.organization?.match(/urn:li:organization:(\d+)/)?.[1])
    .filter((id): id is string => !!id);
  if (ids.length === 1) {
    toSave.LINKEDIN_ORGANIZATION_ID = ids[0];
    console.log(`\nFound the Company Page: LINKEDIN_ORGANIZATION_ID=${ids[0]}`);
  } else if (ids.length > 1) {
    console.log(`\nThis member administers ${ids.length} pages: ${ids.join(", ")}. Set LINKEDIN_ORGANIZATION_ID in ${ENV_FILE} to the right one.`);
  } else {
    console.log(`\nCould not list administered pages (${aclJson.message ?? `HTTP ${acl.status}`}). Set LINKEDIN_ORGANIZATION_ID in ${ENV_FILE} by hand: the number in linkedin.com/company/<id>/admin/.`);
  }
} catch {
  console.log(`\nCould not look up the Company Page id. Set LINKEDIN_ORGANIZATION_ID in ${ENV_FILE} by hand.`);
}

await saveEnv(toSave);

console.log(`\nConnected with scopes: ${json.scope ?? scope}`);
console.log(`Access token lifetime ${days(json.expires_in)}; refresh token lifetime ${days(json.refresh_token_expires_in)}.`);
console.log(`Saved to ${Object.keys(toSave).join(", ")} in ${ENV_FILE}. Restart the dev server (Restart Dashboard.bat), or add the LINKEDIN_* values to the Vercel env vars, to start pulling LinkedIn data.`);
