# Chomkhao — Accommodation Booking Website

> Copy of the Phasakura code for chomkhao.com (own Worker, D1, R2 and secrets). Production status and how to pull
> fixes from Phasakura: `docs/PRODUCTION.md`.

React + TypeScript frontend and a Cloudflare Worker backend (D1 + R2), deployed as a single Worker.
Full requirements and phase status: [`MASTER_SPEC.md`](./MASTER_SPEC.md).

## Getting started

```bash
npm install
cp .dev.vars.example .dev.vars          # local non-secret config, gitignored

# one-time Cloudflare setup
npx wrangler login
npx wrangler d1 create chomkhao-db     # copy database_id into wrangler.jsonc
npx wrangler r2 bucket create chomkhao-media-public
npx wrangler r2 bucket create chomkhao-media-private

# run locally (two terminals)
npm run dev:worker                      # Worker API on :8787 (local D1/R2)
npm run dev                             # Vite on :5173, proxies /api → :8787
```

## First admin account

No default admin or password ships with the app. Create the first SUPER_ADMIN once:

```bash
npm run admin:bootstrap -- --email you@example.com --name "Your Name" --out bootstrap.sql
npx wrangler d1 execute chomkhao-db --local --file bootstrap.sql    # or --remote
rm bootstrap.sql
```

The temporary password is printed once; you must change it at first sign-in at `/th/admin/login`.

## Quality gates

```bash
npm run typecheck
npm run lint
npm run check:static     # project rules: SQL built from reviewed fragments only, no raw HTML / eval, hooks order, secrets …
npm test                 # unit + integration + API + security tests (real migrations in SQLite)
npm run build
```

More testing (Phase 15):

```bash
npm run test:coverage    # same tests with line / branch / function coverage of src/
npx playwright install chromium
npm run test:e2e         # browser suites (all phases + responsive sweep) against a local HTTPS server
npm run test:e2e -- phase14 responsive    # only some suites
```

`test:e2e` builds the client, creates a throw-away certificate with `openssl`, draws its own test images and
starts a fresh in-memory server for each suite (fake LINE / Meta / Google APIs — nothing leaves your machine).
Screenshots land in `tests/e2e/.output/`. The Phase 12 font upload check needs a real WOFF2 file:
`E2E_FONT_FILE=/path/to/font.woff2 npm run test:e2e -- phase12` (skipped otherwise).

When `check:static` reports `sql/dynamic`, a new piece of SQL is built from a variable: make sure it can only
contain code constants or `?` placeholders (never request input), then accept it with
`npx tsx scripts/static-checks.ts --update-sql-baseline` and commit `scripts/sql-fragments.json`.

## Deploy

**Production runbook: [`docs/PRODUCTION.md`](docs/PRODUCTION.md)** (Workers Paid plan, custom domain + SSL, secrets,
backup & restore, monitoring, incident response, final smoke test).

```bash
npm run preflight                               # config check before deploy (no network); exit 1 on any error
npm run release                                 # preflight → D1 backup → migrations (remote) → build → deploy
npm run smoke -- https://www.your-domain.com    # read-only post-deploy checks (add SMOKE_ADMIN_* env for System status)
npm run db:backup                               # Time Travel bookmark + D1 export to backups/ (gitignored)
```

Secrets are never committed. Set them with `npx wrangler secret put <NAME>`.
After deploy, Admin → **System status** lists everything that is not production-ready yet, the cron heartbeat,
queued / failed deliveries and recent server errors; uptime monitors use `GET /api/health` (200 / 503).

### LINE notifications (Phase 11)

1. LINE Developers console → create a **Messaging API** channel for your LINE Official Account.
2. Store the channel credentials as Cloudflare Secrets (never in Git / D1):
   ```bash
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN   # Messaging API tab → long-lived channel access token
   npx wrangler secret put LINE_CHANNEL_SECRET         # Basic settings tab → channel secret
   ```
3. Set `APP_BASE_URL` (https) in `wrangler.jsonc` so messages can link back to the site.
4. Admin → Settings → LINE: copy the **Webhook URL** into the channel (Messaging API → Webhook URL, turn on
   "Use webhook"), press **Check connection**, turn notifications on, then add staff chats with a link code.
   For group chats, allow the bot to join groups in LINE Official Account Manager first.
5. The cron trigger (every minute) sends due notifications and the daily check-in / kitchen digests.
6. Chats with **New bookings** ticked get every new booking at once: booking ID, the guest's name with half of the
   phone number and e-mail hidden (`081*****78`, `som****@gmail.com` — the full contact stays in the admin),
   dates, stay, guests, food, total, pay-by time, and a link to the booking in the admin. Opened without a session
   (e.g. in LINE's browser) the link goes through the login page and back to that booking.

### Images and fonts (Phase 12)

- **Compression happens in the admin's browser**: photos are scaled to the purpose's maximum width
  (slides / gallery 2400 px, rooms / history / home sections 2000 px, dishes 1600 px), re-encoded as WebP
  (JPEG where the browser cannot encode WebP; camera metadata such as GPS is dropped), and smaller
  renditions are uploaded with them for `srcset`. The Worker re-checks every file from its bytes
  (type, size, dimensions, same picture as the original). Logos, favicons and QR codes are kept as uploaded.
- **Public bucket, private until published**: `/media/*` serves an image only while the content that uses
  it is published (gallery photo + category, slide inside its schedule, active house, active dish…).
  Drafts are visible to signed-in staff only (`Cache-Control: private, no-store`). Payment slips stay in
  the private bucket and are never served from `/media/*`.
- **Uploaded fonts**: Admin → Settings → Theme → *Uploaded fonts* (WOFF2 / WOFF, 2 MB, one file per weight
  and style). Only faces of the families the published theme uses are sent to visitors. Make sure the font
  licence allows web embedding.
- **Separate media domain** (`PUBLIC_MEDIA_BASE_URL`, e.g. an R2 custom domain): add that origin to
  `font-src` in `public/_headers`, and allow your site origin in the bucket's CORS rules — browsers fetch
  fonts with CORS. With the default (`/media/*` on the same Worker) nothing extra is needed.

### SEO, Search Console and site search (Phase 13)

- The Worker renders every page's `<head>` (title, description, canonical, hreflang TH / EN / ZH-Hans + x-default,
  Open Graph, JSON-LD) and returns real 404s. Texts come from Website → SEO, with automatic defaults.
- `/robots.txt` and `/sitemap.xml` are generated. **Only `APP_ENV=production` is indexable** — any other value
  serves `Disallow: /` and `X-Robots-Tag: noindex` so staging / preview copies never appear in Google.
- Set `APP_BASE_URL` to the public https origin so canonical, hreflang, OG and sitemap URLs use it.
- Google Search Console: add a **Domain** property (verified with a DNS TXT record) — or a URL-prefix property and
  paste the HTML-tag code into Admin → Marketing → GA4 / Search Console — then submit `https://<domain>/sitemap.xml`.
- Site search uses `search_index` (rebuilt by the cron when content changes, or from Website → SEO → Site search).
  It only finds candidates; what a result shows and whether a stay is free are read live from D1.

### Cookie consent, GA4, Meta Pixel, Conversions API, rate limits (Phase 14)

- **Consent first.** The cookie banner appears as soon as GA4 or Meta Pixel is switched on (Admin → Marketing).
  GA4 loads only after *Analytics* consent, Meta Pixel and the Conversions API only after *Marketing* consent.
  Banner text, how long a choice lasts, "ask everyone again" and the privacy policy page (`/{lang}/privacy`) are in
  Admin → Settings → Privacy. Write the policy before switching trackers on.
- **GA4** (Admin → Marketing → GA4): Measurement ID. The site sends page views itself with a cleaned URL (only
  `utm_*`, `gclid`, `fbclid` are kept), so in GA4 → Data streams → Enhanced measurement turn **off** "Page changes
  based on browser history events" to avoid double page views. Purchase = Booking ID / total / THB, sent when the
  guest sees the booking confirmed.
- **Meta Pixel**: Pixel ID. In Events Manager → the Pixel's settings turn **off "Automatic advanced matching"**
  so the Pixel never reads names or phone numbers from the booking form (the site never sends them).
- **Conversions API** (server-side Lead at booking, Purchase when payment is confirmed; same `event_id` as the
  browser Pixel so Meta counts once):
  ```bash
  npx wrangler secret put META_CAPI_ACCESS_TOKEN   # Events Manager → dataset → Settings → Conversions API → Generate access token
  npx wrangler secret put META_TEST_EVENT_CODE     # optional, while testing: every event goes to "Test events" — delete it afterwards
  npx wrangler secret put META_PIXEL_ID            # optional: overrides the Pixel ID from Admin (a mismatch is flagged)
  ```
  Then tick "Enable CAPI". Delivery log and "Send test event": Admin → Marketing → CAPI. Browser ids (`_fbp`, `_fbc`,
  IP, user agent) are kept only with Marketing consent and erased after 8 days; the log after 90 days.
- **Dashboard visitors / page views / funnel** come from the GA4 Data API: create a Google Cloud service account,
  enable "Google Analytics Data API", add the service account's e-mail as **Viewer** in GA4 → Property access
  management, then `npx wrangler secret put GA4_SERVICE_ACCOUNT_KEY` (paste the JSON key) and enter the numeric
  property ID in Admin → Marketing → GA4. Reports are cached for 3 hours. Money figures always come from D1.
- **Rate limits** use Workers Rate Limiting bindings (`ratelimits` in `wrangler.jsonc`, per client IP): public pages /
  reads 300 per minute, public writes 30, sign-in 10, admin API 600. Over the limit → `429` + `Retry-After`, and one
  `RATE_LIMITED` security event per IP per minute. The `namespace_id` values must be unique in your Cloudflare
  account; change them if another Worker already uses 1001–1004. Without the bindings (local dev) nothing is limited.

## Push to GitHub

```bash
git remote add origin git@github.com:<you>/chomkhao.git
git push -u origin main
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and build on every push and PR.
Commit the generated `package-lock.json` after the first `npm install`.
