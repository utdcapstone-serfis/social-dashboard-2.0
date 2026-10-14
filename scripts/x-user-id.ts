/**
 * One-time X / Twitter user-id lookup.
 *
 *   npm run x:id -- <handle>
 *
 * Reads X_BEARER_TOKEN from .env.local, asks the X API for the numeric id of
 * the given @handle (or X_USERNAME when no argument is passed), and writes it
 * to .env.local as X_USER_ID so api/x.ts never has to look it up again.
 * Costs one request against the 300/15min per-app limit on
 * GET /2/users/by/username/:username. Restart the server afterwards.
 */
import { readFile, writeFile } from "node:fs/promises";

const ENV_FILE = ".env.local";
const token = process.env.X_BEARER_TOKEN?.trim();
const handle = (process.argv[2] ?? process.env.X_USERNAME ?? "").trim().replace(/^@/, "");

if (!token) {
  console.error(`Set X_BEARER_TOKEN in ${ENV_FILE} first (console.x.com -> your app -> Keys and tokens -> Bearer Token).`);
  process.exit(1);
}
if (!handle) {
  console.error("Usage: npm run x:id -- <handle>   (the account's @name without the @)");
  process.exit(1);
}

const res = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const json = (await res.json().catch(() => ({}))) as {
  data?: { id: string; name: string; username: string };
  errors?: { detail?: string; title?: string }[];
  detail?: string;
  title?: string;
};
if (!res.ok || !json.data?.id) {
  const detail = json.errors?.[0]?.detail ?? json.detail ?? json.title ?? `HTTP ${res.status}`;
  console.error(`\nLookup failed: ${detail}`);
  if (res.status === 401) console.error("The Bearer Token was rejected. Regenerate it in Keys and tokens and paste the new value.");
  if (res.status === 403) console.error("The project tier does not include this endpoint. Check the Products tab in console.x.com.");
  if (res.status === 429) console.error(`Rate limited; retry after ${res.headers.get("x-rate-limit-reset") ?? "the window resets"} (unix seconds).`);
  process.exit(1);
}

let envText = "";
try { envText = await readFile(ENV_FILE, "utf8"); } catch { /* create it */ }
const line = `X_USER_ID=${json.data.id}`;
envText = /^X_USER_ID=.*$/m.test(envText)
  ? envText.replace(/^X_USER_ID=.*$/m, line)
  : envText.replace(/\s*$/, "\n") + line + "\n";
await writeFile(ENV_FILE, envText, { mode: 0o600 });

console.log(`\n@${json.data.username} (${json.data.name}) has id ${json.data.id}.`);
console.log(`Saved X_USER_ID to ${ENV_FILE}. Restart the dev server (Restart Dashboard.bat), or add X_BEARER_TOKEN and X_USER_ID to the Vercel env vars, to start pulling X data.`);
