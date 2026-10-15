# Deploying to Vercel with live Meta data

The dashboard is a static Vite app plus one serverless function, `api/meta.ts`,
which calls the Meta Graph API with secrets that live only on the server.
Instagram and Facebook cards show live numbers; the other nine platforms stay on
mock data until their APIs are wired up the same way.

## 1. Local development

```bash
npm install
cp .env.example .env.local   # then fill in the META_* values
npm run dev
```

`npm run dev` serves `/api/meta` through a small Vite plugin (see
`vite.config.ts`), so the Vercel CLI is not required locally. `.env.local` is
git-ignored and is never bundled into the browser build.

## 2. Push the repo to GitHub

Vercel deploys from a Git repository. Make sure `.env.local` is **not**
committed (`.gitignore` already excludes `.env` and `.env.*`).

## 3. Create the Vercel project

1. Go to <https://vercel.com/new> and import the repository.
2. Framework preset: **Vite** (auto-detected). Build command `npm run build`,
   output directory `dist`.
3. Before the first deploy, open **Environment Variables** and add, for
   Production and Preview:

   | Name | Value |
   | --- | --- |
   | `META_GRAPH_VERSION` | `v23.0` |
   | `META_IG_USER_ID` | your Instagram professional account id |
   | `META_ACCESS_TOKEN` | token with `instagram_basic`, `instagram_manage_insights` |
   | `META_PAGE_ID` | your Facebook Page id |
   | `META_PAGE_ACCESS_TOKEN` | Page token with `read_insights`, `pages_read_engagement` |

4. Click **Deploy**. The site is served from the domain root; `vite.config.ts`
   switches `base` to `/` automatically when the `VERCEL` env var is present.

Alternatively, with the CLI:

```bash
npm i -g vercel
vercel login
vercel link
vercel env add META_ACCESS_TOKEN production   # repeat for each variable
vercel --prod
```

## 4. Verify

Open `https://<your-project>.vercel.app/api/meta` — you should get JSON with
`metrics` for `instagram` and `facebook` and an empty `errors` object. Then load
the dashboard; the two cards show a green **Live** badge.

## Token lifetime

Long-lived user tokens expire after about 60 days. Page tokens derived from a
long-lived user token do not expire, but are invalidated if the user changes
their password or revokes the app. When `/api/meta` starts returning an
`errors` entry mentioning an expired session, generate a new token in the Meta
developer console and update the Vercel environment variable.

## GitHub Pages

The existing GitHub Pages workflow still works for a mock-data-only build. It
has no backend, so `/api/meta` 404s there and the dashboard falls back to mock
data for every platform.

## YouTube (live data via `api/youtube.ts`)

The YouTube card goes live the same way, through `GET /api/youtube`. It needs
three more environment variables, locally in `.env.local` and on Vercel for
Production and Preview:

| Name | Value |
| --- | --- |
| `YOUTUBE_CLIENT_ID` | OAuth client id (Web application) from Google Cloud Credentials |
| `YOUTUBE_CLIENT_SECRET` | the matching client secret |
| `YOUTUBE_REFRESH_TOKEN` | refresh token from the OAuth Playground, authorized as the channel owner with `yt-analytics.readonly` + `youtube.readonly` |

Enable **YouTube Data API v3** and **YouTube Analytics API** on the Google Cloud
project, and add `https://developers.google.com/oauthplayground` as an
authorized redirect URI on the OAuth client. Verify with
`https://<your-project>.vercel.app/api/youtube`.

Notes:

- YouTube Analytics lags 2-3 days, so the function reports the latest day with
  data inside a 7-day lookback and returns that day as `liveDate`.
- While the Google OAuth consent screen is in **Testing**, refresh tokens expire
  after 7 days. Publish the app to get a long-lived token.

## TikTok (live data via `api/tiktok.ts`)

The TikTok card goes live through `GET /api/tiktok`. It needs three more
environment variables, locally in `.env.local` and on Vercel for Production
and Preview:

| Name | Value |
| --- | --- |
| `TIKTOK_CLIENT_KEY` | client key from developers.tiktok.com -> Manage apps -> app -> **Sandbox** |
| `TIKTOK_CLIENT_SECRET` | the matching client secret |
| `TIKTOK_REFRESH_TOKEN` | refresh token written by `npm run tiktok:auth` (see below) |

Setup, once:

1. In the TikTok developer portal, switch the app to **Sandbox**, add **Login Kit**
   with the redirect URI `https://serfis-site.vercel.app/tiktok/callback`, add the
   `user.info.basic` and `video.list` scopes, and click **Apply changes**.
2. Under **Sandbox settings -> Target users**, add the Serfis TikTok account.
   Unaudited apps only accept logins from target users (up to 10), which is all
   a dashboard for your own accounts needs, so no app review is required.
3. Put the sandbox key and secret in `.env.local`, then run `npm run tiktok:auth`.
   Open the printed link while signed in to the Serfis TikTok account, click
   Authorize, copy the code from the Serfis page that opens, and paste it into
   the terminal. The script exchanges it and writes `TIKTOK_REFRESH_TOKEN`.
4. Copy the same three values into the Vercel environment variables and verify
   with `https://<your-project>.vercel.app/api/tiktok`.

Notes:

- The Display API only returns lifetime counters per video, so the card shows
  totals across the latest 100 videos, retention renders as *n/a*, and the
  day-over-day delta is 0.
- Refresh tokens last about a year. When `/api/tiktok` reports a token error,
  run `npm run tiktok:auth` again and update the Vercel variable.

## X / Twitter (live data via `api/x.ts`)

The Twitter / X card goes live through `GET /api/x`. It needs two more
environment variables, locally in `.env.local` and on Vercel for Production
and Preview:

| Name | Value |
| --- | --- |
| `X_BEARER_TOKEN` | Bearer Token from console.x.com -> project -> app -> **Keys and tokens** |
| `X_USER_ID` | numeric id of the account to track, written by `npm run x:id -- <handle>` |

Setup, once:

1. At <https://console.x.com> create a project and an app inside it, add a
   payment card under Billing and buy a small credit balance (X API v2 is
   pay-per-use with no tiers; saving a card earns $20 of free credits). Set a
   spending limit. The project's **Rate limits** page lists per-endpoint caps.
2. Under **Keys and tokens**, generate the **Bearer Token** and paste it into
   `.env.local` as `X_BEARER_TOKEN`.
3. Run `npm run x:id -- <handle>` (the account's @name without the @). The script
   calls `GET /2/users/by/username/<handle>` and writes `X_USER_ID` into
   `.env.local`. Alternatively set `X_USERNAME` and let the function resolve it.
4. Copy `X_BEARER_TOKEN` and `X_USER_ID` into the Vercel environment variables
   and verify with `https://<your-project>.vercel.app/api/x`.

Notes:

- The function reads the latest 100 original posts (reposts excluded) through
  `GET /2/users/:id/tweets` and sums `public_metrics`: views = impressions,
  likes per view = likes / impressions, share rate = (reposts + quotes) /
  impressions. X does not expose retention, so it renders as *n/a*, and the
  day-over-day delta is 0 because the counters are lifetime totals.
- Rate limits are not the constraint (the app cap on the timeline endpoint is
  10,000 requests per 15 minutes), but X bills per post read: $0.005 per post,
  or $0.001 when the app is owned by the account being read ("Owned Reads"),
  deduplicated per UTC day, so 100 posts a day costs about $0.50 (or $0.10). The function
  keeps the last result in memory for an hour and sets an hour-long edge cache,
  so expect about 24 requests of up to 100 posts per day per instance.
- A `401` in `/api/x` errors means the Bearer Token was regenerated or revoked;
  a `403` means the tier does not include the endpoint.

## Pinterest (live data via `api/pinterest.ts`)

The Pinterest card goes live through `GET /api/pinterest`. It needs three more
environment variables, locally in `.env.local` and on Vercel for Production
and Preview:

| Name | Value |
| --- | --- |
| `PINTEREST_APP_ID` | App ID from developers.pinterest.com -> **My apps** -> your app |
| `PINTEREST_APP_SECRET` | the matching App secret (shown on the same card once Trial access is approved) |
| `PINTEREST_REFRESH_TOKEN` | continuous refresh token written by `npm run pinterest:auth` (see below) |

Setup, once:

1. Sign in to <https://developers.pinterest.com> with the Serfis Pinterest
   **business** account (the API's account analytics only exist for business
   accounts, and apps registered after 14 Sep 2026 cannot read personal
   accounts' Pins at all). Convert the account to a business account first if
   needed, verify its email, and accept the Developer Terms under **My apps**.
2. Click **Connect app**, fill in the form (name, description, use case: internal
   analytics dashboard for the account's own content; privacy policy
   `https://serfis-site.vercel.app/privacy`) and submit the request for
   **Trial access**. Pinterest reviews on business days and emails the result;
   the App ID and App secret appear on the app card once approved. Trial access
   is all this dashboard needs: it reads only the owning account, and Pin and
   account analytics are included.
3. On the app card choose **Manage -> Configure -> Redirect URIs**, enter
   `https://serfis-site.vercel.app/pinterest/callback` and click **Add**. The
   value must match exactly (no trailing slash).
4. Put the App ID and secret in `.env.local`, then run `npm run pinterest:auth`
   (or double-click `Connect Pinterest.bat`). Open the printed link while signed
   in to the Serfis Pinterest account, click **Give access**, copy the code from
   the Serfis page that opens, and paste it into the terminal. The script
   exchanges it and writes `PINTEREST_REFRESH_TOKEN`.
5. Copy the same three values into the Vercel environment variables and verify
   with `https://<your-project>.vercel.app/api/pinterest`.

Notes:

- The function calls `GET /v5/user_account/analytics` (scope
  `user_accounts:read`) for the last 8 days and reports the newest day whose
  `data_status` is `READY` (falling back to `ESTIMATE`) as `liveDate`, so the
  day-over-day delta is real. Mapping: views = `IMPRESSION`, likes per view =
  `SAVE` / `IMPRESSION`, share rate = `OUTBOUND_CLICK` / `IMPRESSION`.
  Retention is `QUARTILE_95_PERCENT_VIEW` / `VIDEO_START` when Pinterest returns
  video metrics for the account, otherwise it renders as *n/a*.
- Trial access allows 1,000 requests per day per app in total. The function
  keeps the last result in memory for an hour and sets an hour-long edge cache,
  so expect well under 50 requests a day.
- **Token rotation.** Access tokens last 30 days. Continuous refresh tokens last
  60 days and every refresh returns a new one, so the value stored in Vercel
  slowly ages. The function keeps the newest token in memory and logs
  `Pinterest rotated the refresh token` when it happens. Before 60 days pass,
  run `npm run pinterest:auth -- --refresh` (it swaps the token in `.env.local`
  and prints the new expiry) and update the Vercel variable. If it has already
  expired, `/api/pinterest` reports a token refresh error: run
  `npm run pinterest:auth` again to reconnect.
- A `403` in `/api/pinterest` errors usually means the account is not a
  business account or the `user_accounts:read` scope was not granted; a `429`
  means the daily Trial quota is used up.

## Bluesky (live data via `api/bluesky.ts`)

The Bluesky card goes live through `GET /api/bluesky`. It needs one more
environment variable, locally in `.env.local` and on Vercel for Production and
Preview:

| Name | Value |
| --- | --- |
| `BLUESKY_HANDLE` | the account handle to track, e.g. `serfis.bsky.app` (a DID also works) |

No developer app, token or OAuth flow is needed: the function reads the public
AppView at `public.api.bsky.app`, which serves profiles and author feeds without
authentication. Set the variable and verify with
`https://<your-project>.vercel.app/api/bluesky`.

Notes:

- Bluesky exposes no view or impression counts, so the card shows 0 views and
  0.0% retention, and the day-over-day delta is 0. The function sums `likeCount`,
  `repostCount` and `quoteCount` across the latest 100 original posts (replies
  and reposts of other accounts excluded) and divides by `followersCount`:
  likes per view = likes / followers, share rate = (reposts + quotes) /
  followers.
- The public AppView is rate limited per IP at about 3,000 requests per 5
  minutes. The function makes two requests per refresh, keeps the last result
  in memory for an hour and sets an hour-long edge cache.
- A `Profile not found` error in `/api/bluesky` means the handle is misspelled
  or the account was renamed; a `429` means the AppView rate limit was hit.

## API key health on the dashboard

The **API connections** panel (and the red "keys need attention" pill in the header) is driven by the
`errors` and `tokens` fields every `/api/*` endpoint returns:

- An endpoint error is classified as *not configured*, *key expired/rejected*, *out of credits* (X),
  *rate limited* or a generic API error. Clicking a platform shows the raw error, which env vars hold
  its key, and step-by-step fix instructions (`src/data/platformApis.ts`).
- Where the platform tells us when a key stops working, the panel counts down and turns amber
  14 days before expiry: Meta via Graph `debug_token` (user token expiry and the 90-day data-access
  window), TikTok from the refresh response (365 days), and Pinterest from
  `PINTEREST_REFRESH_TOKEN_EXPIRES_AT`, which `npm run pinterest:auth` now writes next to the token
  (copy both to Vercel). A rotated TikTok/Pinterest refresh token is flagged too.
- YouTube and X give no expiry up front; they show up as soon as a call is rejected.
