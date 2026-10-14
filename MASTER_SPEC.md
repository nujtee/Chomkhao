# MASTER_SPEC — Chomkhao Accommodation Booking Website (same code as Phasakura)

> เอกสารนี้คือ Source of Truth ของ Requirement ทั้งหมด
> ส่วน **A** คือสถานะโปรเจกต์และการตัดสินใจทางเทคนิค (อัปเดตทุก Phase)
> ส่วน **B** คือ Specification ต้นฉบับครบทุกข้อ (ห้ามแก้ความหมาย)

---

## A. Project Status & Technical Decisions

### A.1 Phase Tracker

| Phase | Scope | Status |
|---|---|---|
| 1 | Project Setup (React, TS, Workers, D1/R2 bindings, i18n, Layout, Header, Footer) | ✅ Done |
| 2 | Database migrations (72 tables, 10 migrations, dev seed) | ✅ Done |
| 3 | Authentication, RBAC, User Management, Admin login UI | ✅ Done |
| 4 | Accommodation (House, VIP, Camping, Images, Amenities, Translations, Availability) | ✅ Done |
| 5 | Booking flow, pricing rules, food, snapshots, Booking ID, lookup, hold expiry | ✅ Done |
| 6 | Camping capacity hardening (daily, multi-night, tents, race protection, integrity) | ✅ Done |
| 7 | Payment (receiving accounts, QR, account snapshot, record / refund, status) | ✅ Done |
| 8 | Slip verification (private R2 upload, manual queue, real auto-verification service adapter) | ✅ Done |
| 9 | Admin dashboard (dashboard, calendar, stay actions, payments list, food menu/capacity/kitchen orders, website, branding, theme, booking CTA, marketing IDs, SEO, Home/Gallery/History CMS) | ✅ Done |
| 10 | Reports (Revenue, Booking, Accommodation, Camping, Food, Kitchen, Payment; daily / monthly / yearly / custom; Excel + PDF) | ✅ Done |
| 11 | LINE (Official Account + Messaging API: check-in, food and payment notifications to staff chats; guest opt-in; retry, idempotency, delivery log; website LINE button) | ✅ Done |
| 12 | R2 & Images (browser compression + responsive renditions, public media access control, accommodation / food / home / gallery / history images, public Home / Gallery / History pages, uploaded fonts) | ✅ Done |
| 13 | i18n & SEO (server-rendered metadata TH / EN / ZH-CN, hreflang, canonical, OG, JSON-LD, sitemap, robots, redirects, real 404s, Search Console, translation coverage; plus Global Search §40–41 by agreement) | ✅ Done |
| 14 | Security & Marketing (cookie consent + privacy policy page, GA4 + Meta Pixel gated by consent, Meta Conversions API outbox with event_id dedup, GA4 Data API dashboard numbers, request rate limits, CSP per tracker, audit, accessibility audit) | ✅ Done |
| 15 | Testing (coverage matrix of the 28 areas, route security matrix over every endpoint, input fuzzing, concurrent model-based simulation of inventory invariants, snapshot immutability, deploy-order safety, i18n completeness, static checks, code coverage, browser suites in the repo + responsive sweep, CI) | ✅ Done |
| 16 | Production (monitoring: health with schema + cron heartbeat, server error log, Admin → System status with 19 readiness checks; one canonical host; preflight, release, D1 backup, post-deploy smoke test; production runbook; readiness report) | ✅ Done |

### A.2 Architecture Decisions (ADR)

| # | Decision | Reason |
|---|---|---|
| ADR-1 | Single Cloudflare Worker ให้บริการทั้ง API (`/api/*`) และ Static Assets (SPA) ผ่าน Workers Static Assets | Deploy ชิ้นเดียว, same-origin → ไม่ต้องเปิด CORS, cookie session ง่ายและปลอดภัยกว่า |
| ADR-2 | Worker ไม่ใช้ web framework; ใช้ Router ขนาดเล็กของโปรเจกต์ + Layer: Router → Controller → Service → Repository → D1 | ตาม B.4, dependency น้อย, test ได้ด้วย Web-standard Request/Response |
| ADR-3 | Frontend: React 19 + TypeScript + Vite; Router ภาษาเขียนเอง (`src/client/router`) | Route มีรูปแบบ `/{lang}/{page}` ชัดเจน, bundle เล็ก; หากต้องการ nested admin routes ซับซ้อนใน Phase 9 สามารถเปลี่ยนเป็น react-router ได้โดยไม่กระทบ page components |
| ADR-4 | i18n แบบ typed dictionary (`src/shared/i18n`) — TypeScript บังคับให้ทุกภาษามี key ครบ | ป้องกัน key หาย; รองรับ `th` (default), `en`, `zh-CN` (path `zh-cn`) |
| ADR-5 | R2 แยก 2 bucket: `MEDIA_PUBLIC` (รูปสาธารณะ) และ `MEDIA_PRIVATE` (สลิป/ไฟล์ส่วนตัว) | B.54 — แยก Access Policy ระดับ bucket ป้องกันการเปิดสลิปผิดพลาด |
| ADR-6 | Theme ใช้ CSS Variables (B.37); ค่าใน `tokens.css` เป็นเพียง **fallback กลาง** ก่อนโหลด Theme จาก D1 (Phase 9) | ห้าม Hard-code Theme — ค่าจริงมาจาก `theme_settings` |
| ADR-7 | Logo / Website Name โหลดจาก `GET /api/public/site` เท่านั้น; ถ้ายังไม่ตั้งค่า ระบบแสดง placeholder ที่เป็นกลาง (ไม่ใส่ชื่อ/โลโก้ใน code) | B.7, B.61 |
| ADR-8 | Test runner: `node:test` ผ่าน `tsx` (ไม่มี dependency เพิ่ม) | รันได้ทุก environment |
| ADR-9 | Secrets อยู่ใน `wrangler secret` / `.dev.vars` (gitignored) เท่านั้น — มี `.dev.vars.example` เป็นแม่แบบที่ไม่มีค่าจริง | B.45, B.61 |
| ADR-11 | (Phase 14) Tracking is **consent-gated in the browser and outboxed on the server**: GA4 / Meta Pixel scripts are loaded by the app only after the matching cookie category is accepted (IDs from D1, CSP widened only for enabled trackers); Meta Conversions API events are rows written in the same D1 batch as the booking / confirmation and delivered by the cron with the browser's `event_id`; dashboard web numbers come from the GA4 Data API (service-account secret, cached in D1) | Spec §43–46: consent must be respected, no PII, Purchase only after confirmed payment, dedup via `event_id`; an outbox never sends an event for a change that rolled back and survives Meta outages; analytics stay out of money figures |
| ADR-12 | (Phase 16) Production monitoring lives **in the app and D1**: the cron writes a heartbeat row every minute, unexpected errors (500, degraded pages, failed cron tasks) go to a scrubbed `error_events` table (no query strings, e-mails, phones, tokens; 20/min cap; 30 days), `/api/health` reports database + schema version + cron freshness (503 when degraded) and Admin → System status turns configuration into a checklist (secrets as booleans only). Workers Logs stay the full log. Pages on any other host redirect (301) to `APP_BASE_URL` | Needs no third-party APM and no extra secrets, and gives the owner — not only a developer — one place to see what is wrong; one host keeps SEO and the `__Host-` cookie consistent |
| ADR-10 | (Phase 13) Worker รันก่อนทุก request ยกเว้น `/assets/*`: สร้าง `<head>` ของแต่ละหน้า (metadata, hreflang, JSON-LD) ลงใน app shell, ตอบ 404 จริง, robots.txt / sitemap.xml / redirects — React ยังเป็น SPA เหมือนเดิม | Crawler และ link preview ต้องเห็น metadata ใน HTML แรกโดยไม่ต้องรัน JavaScript; ไม่ต้องทำ SSR ทั้งหน้า |

### A.3 Folder Structure

```text
src/
  shared/            โค้ดที่ใช้ทั้ง client และ worker (i18n config, types ของ API)
    i18n/            locales, dictionary th/en/zh-cn
  worker/            Cloudflare Worker (backend)
    index.ts         entry: fetch handler
    router.ts        router ขนาดเล็ก
    http/            response helpers, security headers, errors
    controllers/     รับ Request → เรียก Service → คืน Response
    services/        Business logic
    repositories/    ติดต่อ D1 เท่านั้น (prepared statements)
    cms/             generic back-office record engine (Phase 9)
    reports/         dependency-free XLSX writer + report → workbook (Phase 10)
    line/            LINE Messaging API client, webhook signature, message templates TH/EN/ZH (Phase 11)
    media/           image / font sniffing from bytes, responsive renditions → srcset (Phase 12)
    seo/             page handler: app shell + head tags, robots / sitemap / redirects (Phase 13)
    marketing/       Meta Conversions API client, GA4 Data API client (Phase 14)
    security/        sessions, passwords, CSRF / request guards, rate limits (Phase 14)
    env.ts           Env bindings (D1, R2, vars)
  client/            React app
    main.tsx, App.tsx
    router/          localized routing
    components/      Header, Footer, LanguageSwitcher, Layout
    pages/           Home, Gallery, Booking, History, NotFound
    content/         hero slideshow, lightbox, responsive image, CMS links (Phase 12)
    seo/             head manager for in-app navigation (Phase 13)
    search/          global search dialog (Phase 13)
    consent/         cookie banner, cookie settings dialog, consent provider (Phase 14)
    analytics/       consent-gated GA4 / Meta Pixel runtime, booking funnel events (Phase 14)
    media/           browser-side compression + renditions before upload (Phase 12)
    styles/          tokens.css (CSS variables), base.css, content.css
migrations/          D1 migrations 0001–0020 (see migrations/README.md)
seeds/dev.sql        ข้อมูลตัวอย่างสำหรับ local เท่านั้น
tests/               node:test suites: worker/ (API + services on real migrations), db/, shared/, client/
  e2e/               browser suites (Playwright) + runner, HTTPS test server with fake LINE / Meta / Google (Phase 15)
  helpers/           SQLite D1, harness, fake R2 / LINE / HTTP
scripts/             create-super-admin, static-checks (+ sql-fragments.json baseline, Phase 15),
                     preflight, smoke-test, backup-d1 (Phase 16)
docs/PRODUCTION.md   production runbook (Phase 16)
```

### A.4 Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server (frontend) — proxy `/api` ไป `wrangler dev` |
| `npm run dev:worker` | `wrangler dev` (Worker + D1/R2 local) |
| `npm run build` | Build frontend → `dist/client` |
| `npm test` | Unit / integration / API / security tests |
| `npm run test:coverage` | Same, with line / branch / function coverage of `src/` (Phase 15) |
| `npm run test:e2e` | Browser suites (Phases 9–14, 16 + responsive) — `tests/e2e/run.mjs` (Phase 15) |
| `npm run check:static` | Project static rules (SQL fragments, raw HTML / eval, hooks order, secrets, JSX a11y basics) (Phase 15) |
| `npm run typecheck` | `tsc` ทั้ง client และ worker |
| `npm run lint` | ESLint |
| `npm run deploy` | preflight + build + `wrangler deploy` |
| `npm run release` | preflight → `db:backup` → `db:migrate:remote` → build → deploy (Phase 16) |
| `npm run preflight` | Deploy configuration check, no network; `--secrets <file>` checks secret names (Phase 16) |
| `npm run smoke -- <https url>` | Read-only post-deploy smoke test; `SMOKE_ADMIN_IDENTIFIER` / `SMOKE_ADMIN_PASSWORD` env adds System status (Phase 16) |
| `npm run db:backup` | Time Travel bookmark + `wrangler d1 export` to `backups/` with SHA-256 (Phase 16) |
| `npm run db:migrate:local` / `db:seed:local` / `db:reset:local` | Local D1: migrate, dev seed, reset |
| `npm run db:migrate:remote` | Apply migrations to production D1 (backup first) |

### A.5 Database design (Phase 2)

Migrations: `migrations/0001…0010` (see `migrations/README.md`). Dev-only sample data: `seeds/dev.sql`.

| Rule | How it is enforced in D1 (not only in code) |
|---|---|
| No double booking (§16) | `booking_unit_nights` PRIMARY KEY `(unit_id, stay_date)`; one row per stay night inserted in the same atomic `batch()` as the booking. Check-out day is not a night. Admin blocks use the same table. |
| Camping capacity (§12.3) | `camping_night_inventory` per night: `INSERT OR IGNORE` (default capacity) + `UPDATE tents_used = tents_used + n` in the booking batch; `CHECK (tents_used <= max_tents)` rolls back the whole booking. |
| Food capacity (§22) | `food_daily_capacity` per category × date, same pattern, `CHECK (used_quantity <= max_quantity)`. |
| Price / payment-account / included-meal snapshots (§17, §20, §25) | Separate snapshot tables; `UPDATE`/`DELETE` blocked by triggers (`SNAPSHOT_IMMUTABLE`). Food line prices frozen by trigger. |
| Money | INTEGER satang everywhere; `total = subtotal − discount` and `subtotal = accommodation + food` as CHECKs. |
| Booking dates | `nights = check_out − check_in`, valid calendar dates, `BK-YYYYMMDD-XXXX` format + UNIQUE. |
| Soft delete users (§32) | Hard `DELETE` blocked; `status='DELETED' ⇔ deleted_at IS NOT NULL`. No cascades anywhere. |
| Last SUPER_ADMIN (§33) | Triggers block suspending/deleting/removing the role of the last ACTIVE SUPER_ADMIN (`LAST_SUPER_ADMIN`). Service layer checks first for a friendly error. |
| Audit log (§51) | Append-only (UPDATE/DELETE blocked); old/new values must be JSON. Same for `price_history`, `slip_verifications`. |
| Slips private (§27, §54) | `media_assets`: `purpose='PAYMENT_SLIP' ⇔ bucket='PRIVATE'`; payments may only reference PAYMENT_SLIP assets. |
| Duplicate slip / transaction (§27) | Partial UNIQUE on `payments.slip_sha256` for live payments; partial UNIQUE on `slip_verifications.transaction_ref` for PASSED results. |
| Secrets (§45, §61) | No token/secret columns except `token_hash` / `password_hash`. CAPI & LINE tokens only in Cloudflare Secrets. |
| Languages | `languages` table (FK from all translation tables) — not hard-coded in CHECKs. |
| Upload safety (§55) | R2 keys CHECKed against traversal/unsafe chars; MIME allow-list (no SVG/HTML). |
| Roles & permissions (§29–31) | Stored in DB (migration 0010): 6 roles × 54 permissions. No default user/password shipped. |

All tables are `STRICT`. Every rule above has a test in `tests/db/`.

### A.7 Authentication & authorization (Phase 3)

| Topic | Decision |
|---|---|
| Password hashing | PBKDF2-HMAC-SHA256, 100,000 iterations (Workers maximum), 16-byte salt, self-describing `pbkdf2_sha256$iter$salt$hash`; weaker hashes re-hashed on login. NFKC normalisation. |
| Password policy | ≥ 12 chars, ≤ 128, not common, not trivially simple, must not contain email/username/name. |
| Session | 256-bit random token in cookie `__Host-sid` (HttpOnly, Secure, SameSite=Strict, Path=/). Only SHA-256 stored in `sessions`. Browser session: 12 h absolute + 2 h idle. Remember me: 30 days. New session on every login; `POST /api/auth/refresh` rotates; logout / suspend / delete / password change / force logout revoke. |
| CSRF | SameSite=Strict + Origin (or Sec-Fetch-Site) must be same-origin + `X-Requested-With: phasakura` on every POST/PUT/PATCH/DELETE. |
| Brute force | 5 failures → account locked 15 min; 20 failures per IP / 15 min → 429. Same error for unknown user / wrong password / locked; dummy hash check equalises timing. |
| Forgot password | Always 202 (no enumeration); throttled per IP and per account; one-time token (SHA-256 stored), 30 min, token in URL **fragment**; newest link only. **Production has no email channel yet** — admins issue reset links from User Management (24 h). |
| Authorization | `AuthorizationService.requirePermission(user, "users.delete")`; effective = role perms ∪ user GRANT − user DENY, loaded from D1 each request. Frontend hides menus only. |
| SUPER_ADMIN rules | Only a SUPER_ADMIN can grant SUPER_ADMIN or act on a SUPER_ADMIN; nobody can delete/suspend self or change own roles/permissions; non-SUPER_ADMIN cannot grant permissions they don't hold; SUPER_ADMIN role permissions locked; DB triggers keep ≥ 1 active SUPER_ADMIN. |
| Audit | Every user/role change written in the same D1 batch as the change; secrets redacted by key name. |
| First admin | `npm run admin:bootstrap -- --email … --name …` → SQL with hash only (no-op if an active SUPER_ADMIN exists). |
| Admin URLs | `/{lang}/admin/*` (`/admin/*` → default language); `noindex`, `no-store`. |

### A.8 Accommodation & availability (Phase 4)

| Topic | Decision |
|---|---|
| Inventory | Each house / VIP tent is its own `accommodation_units` row; status DRAFT → ACTIVE requires a Thai (default-language) name. Soft delete refused while future bookings exist. |
| Prices | Integer satang in API/DB; UI enters THB (`parseBahtToSatang`), shows `฿2,450.50` / `฿3,500`. Changing a price requires `pricing.edit`; every change → `price_history` + audit. Seasonal/weekday rules (`pricing_settings`) are applied per night since Phase 5 (A.9). |
| Availability | Always computed live from D1 night-locks (`booking_unit_nights`) and camping inventory — never cached. Public API returns only available / fits-guests per unit (no booking data). Rules: check-in ≥ today (property time zone), ≤ 365 days ahead, 1–30 nights (`src/shared/booking-rules.ts`). |
| Date blocks | Admin blocks (`accommodation.block`) are night-locks without a booking; they cannot overlap bookings (DB UNIQUE) and unblocking never removes a booking's nights. |
| Camping | Default capacity in `camping_settings`; per-night rows in `camping_night_inventory` with `is_override` (migration 0011). Default changes apply to non-overridden future nights; CHECK rejects going below tents sold (atomic rollback). |
| Images | `POST /api/admin/media` (multipart). Type detected from **bytes** (JPEG/PNG/WebP/AVIF only — SVG/HTML rejected), ≤ 10 MB, ≤ 10,000 px per side, ≤ 50 MP. Server-generated R2 key `<purpose>/YYYY/MM/<uuid>.<ext>`; client file name never used. Upload permission depends on purpose. Alt/title/caption per language in `media_asset_translations`. Compression & responsive variants: see A.16. |
| Media serving | `GET /media/<key>` (Worker-first route) serves only ACTIVE + PUBLIC assets registered in D1, with `nosniff`, `CSP: sandbox`, immutable cache, ETag/304. Removing an image retires the asset and deletes the R2 object. |
| Public pages | `/{lang}/booking` (live availability search), `/{lang}/accommodation/{slug}` (photos, amenities, date check). Language switcher keeps the current path. Online booking: see A.9. |

### A.9 Booking flow (Phase 5)

| Topic | Decision |
|---|---|
| Scope | One booking = one accommodation choice: one house / VIP tent, or own-tent camping with N tents. Guests = adults (≥ 1) + children. |
| Price engine | `QuoteService` — the browser never sends a price. Per night: highest-priority ACTIVE `pricing_settings` rule matching date + weekday wins (ties: UNIT > UNIT_TYPE, then newest), else the unit base price. Camping = Σ nightly price × adults (children under the configured age free). Rules are managed at `/admin/pricing` (`accommodation.view` to see, `pricing.edit` to change; every change → `price_history` + audit). |
| Food | Service date = stay night + `food_categories.service_day_offset` (breakfast = next morning). Deadlines: `DAYS_BEFORE n` (today ≤ date − n) or `PREVIOUS_DAY_TIME` (before HH:MM the day before, property time zone). Child pricing FREE / FULL / HALF / SPECIAL_PRICE. Included meals become zero-priced lines (adults first, capped at guest count) and do **not** use kitchen capacity or deadlines. Extra portions reserve `food_daily_capacity`; NULL capacity = unlimited. |
| Atomic creation | One D1 batch: booking, item, night-locks (PK) or tent reservation (CHECK), immutable price snapshot (nightly JSON), included-meal snapshots, kitchen orders (+ `capacity_reserved`), price-frozen food lines, security event, audit. Any conflict rolls back everything → 409 `UNIT_UNAVAILABLE` / `CAMPING_FULL` / `FOOD_CAPACITY_EXCEEDED`. Verified by concurrent-request tests that hit the DB constraints. |
| Guards | `expectedTotalSatang` must equal the server total (else 409 `PRICE_CHANGED`); `idempotencyKey` (UNIQUE) makes retries return the same booking, reuse with another phone → 409; privacy acceptance required and timestamped; strict field allow-lists; ≤ 20 bookings / IP / hour. |
| Booking ID | `BK-YYYYMMDD-XXXX` (property date + 4 chars A–Z0–9 from CSPRNG, retry on collision). Public lookup = `POST /api/public/bookings/lookup {bookingCode, phone}` — POST keeps the phone out of URLs; identical 404 for unknown code / wrong phone; throttled 5 failures per code and 10 per IP per 15 min; returns masked phone only. |
| Holds | New bookings are PENDING / UNPAID until `expires_at` (`booking_settings.hold_minutes`, default 60). Cron `*/5 * * * *` (and every quote/create/lookup) expires overdue holds and releases nights, tents and kitchen portions; release statements are conditional on state, so they can never run twice. |
| Admin | `/admin/bookings` list (status, stay dates, search by code / phone / name; cursor pages), detail from snapshots, cancel with reason (`bookings.cancel`) releasing inventory + audit. |
| Logging | Security events / audit carry the Booking ID and amounts only — never name, phone or email. |
| Not yet | Payment account snapshot, QR and payment: Phase 7. Admin UI for booking settings and food menu: Phase 9. |

### A.10 Camping capacity (Phase 6)

| Topic | Decision |
|---|---|
| Daily capacity | `camping_night_inventory` row per night (created on demand at the default **read inside the booking transaction**, or set by an override). `CHECK (tents_used <= max_tents)` is the authority; default/override changes below tents sold are refused. |
| Multi-night | Every night of the stay is reserved in the same batch; one full night rejects the whole booking. Availability reports per-night remaining and names the short nights (`shortNights`). |
| Tent quantity | Capacity counts tents, price counts adults (§18). Guests need ≥ ⌈guests ÷ max guests per tent⌉ tents; ≤ `booking_settings.max_tents_per_booking` per booking. Availability returns `reason` (FULL / TOO_FEW_TENTS / TOO_MANY_TENTS) and `minTents`; the booking page offers a one-tap "use N tents". |
| Race protection | DB-enforced: CHECK on tents, triggers (migration 0013) refuse own-tent bookings while camping is disabled and unit bookings unless the unit is ACTIVE — closing the gap between quote and batch. Tested with 10-way, overlapping multi-night and capacity-change races; losers are stopped by the DB constraint and leave no rows. |
| Stale holds | Availability search first expires unpaid holds past their time (in addition to the 5-minute cron), so expired holds never show as "full". |
| Integrity | Truth per night = Σ ACTIVE own-tent items covering that night. `GET /api/admin/camping/integrity` (`camping.view`) lists nights where the counter differs; `POST /api/admin/camping/recalculate` (`camping.edit`, audited) resets counters from today in one batch and refuses (409 `OVERSOLD_NIGHTS`) if bookings exceed capacity. The cron only detects: one CRITICAL `CAMPING_INVENTORY_DRIFT` event per 6 h, never changes data. |

### A.11 Payment (Phase 7)

| Topic | Decision |
|---|---|
| Receiving accounts | `/admin/receiving-accounts` (`receiving_accounts.view` / `.edit`, all changes audited). Fields per §25; account number digits/dashes, PromptPay 10/13/15 digits (spaces/dashes stripped); at least one of the two. QR = uploaded `PAYMENT_QR` image (public bucket — it is meant to be shown to payers; byte-sniffed like all uploads). Exactly one primary (UNIQUE index); the primary cannot be deactivated or deleted; delete = soft (`DELETED`). |
| Snapshot | The primary ACTIVE account is copied into `payment_account_snapshots` **inside the booking batch**. If no primary exists the statement inserts NULLs → NOT NULL aborts the whole booking (409 `PAYMENT_NOT_CONFIGURED`) — a booking can never exist without payment details. Snapshots are immutable (trigger); QR assets referenced by snapshots are never retired. |
| Guest | Confirmation and lookup show payment instructions (bank, account, PromptPay, QR, exact amount, hold deadline) from the booking's own snapshot, only while it is PENDING and UNPAID/REJECTED. |
| Status | `payments.verify` records money received in full → booking CONFIRMED + PAID, hold cleared (never expires). One conditional batch: works only while PENDING and not past the hold; two staff at once → one payment. Payments on cancelled/expired bookings are refused by trigger. Amount/booking/method of a payment are frozen; refunded is final; payments are never deleted. |
| Refund | `payments.refund`, only after the booking is cancelled / no-show; amount ≤ paid; booking payment status → REFUNDED once no paid payment remains. Cancelling a paid booking keeps `PAID` until the refund is recorded. |
| Next | Slip upload (private R2), manual verify / reject, real auto-verification service: Phase 8. |

### A.12 Slip verification (Phase 8)

| Topic | Decision |
|---|---|
| Upload | `POST /api/public/bookings/slip` (multipart `bookingCode`, `phone`, `file`). Booking ID + phone prove ownership with the same throttle as lookup. JPEG/PNG/WebP sniffed from bytes, ≤ 10 MB; server-generated key `slips/YYYY/MM/<id>.<ext>` in the **PRIVATE** R2 bucket (`media_assets` CHECK: slips must be private); ≤ 5 slips / booking / day, ≤ 20 / IP / hour. One atomic batch claims the booking (PENDING + UNPAID/REJECTED + hold not over) → `PENDING_VERIFICATION` (hold kept until staff decide), inserts asset + payment; failures delete the R2 object. |
| Duplicates | Same image: `payments.slip_sha256` UNIQUE among live payments → 409 `DUPLICATE_SLIP`. Same bank transaction: `slip_verifications.transaction_ref` UNIQUE among PASSED → never confirms two bookings. |
| Auto verification | Real service only (`SlipVerifier` interface; EasySlip adapter). Enabled only when `SLIP_VERIFY_PROVIDER` (var) **and** `SLIP_VERIFICATION_API_KEY` (Cloudflare Secret) are set; otherwise every slip goes to staff. Never OCR. Checks: amount = booking total, transfer time within [booking created − 15 min, now + 5 min], destination = snapshot account or PromptPay (bank-masked digits, ≥ 4 visible), transaction not used before; sender/receiver bank recorded. All pass → payment VERIFIED + booking CONFIRMED. Anything else (failed check, not a slip, timeout 10 s, unexpected response, crash) → recorded and left for staff — the design can only fail towards manual review. Stored provider data excludes payer names and full numbers. |
| Provider contract | The EasySlip adapter follows the provider's v1 verify API (multipart `file`, Bearer key, `data.transRef/date/amount.amount/receiver.account…`). Its public field-level docs could not be fetched while building; **confirm the current contract before setting the key** — a mismatch only produces ERROR → manual review. |
| Staff | `/admin/slips` (`slips.view`): queue by status, verification history with reasons. Slip images only via `GET /api/admin/payments/:id/slip` (session + `slips.view`, `private, no-store`, nosniff, audited `VIEW_SLIP`); `/media` never serves private objects. Verify / reject need `payments.verify`; reject reason stays internal; the guest gets a fresh hold (`hold_minutes`) and can pay/upload again; unpaid rejected holds expire normally. Recording a manual payment is refused while a slip waits (`SLIP_PENDING_REVIEW`) — no double counting. |

### A.13 Admin dashboard & back office (Phase 9)

| Topic | Decision |
|---|---|
| Dashboard (§48) | `GET /api/admin/dashboard` (`dashboard.view`). Counts, tonight's free houses / VIP / tents, arrivals & departures, revenue, 14-day trend, 30-day summary — all from D1. **Widgets follow permissions**: customer names need `bookings.view`; money needs `payments.view` or `reports.view` (CONTENT_ADMIN sees counts only). **Revenue** = paid (`PAID`/`VERIFIED`) bookings in a sold status (`CONFIRMED`/`CHECKED_IN`/`CHECKED_OUT`/`NO_SHOW`) by **check-in date**, from booking snapshots (accommodation − discount, food, total). Visitors / page views / accommodation views / booking + checkout started come from the GA4 Data API (Phase 14, A.18; "—" when not connected); analytics never feed money figures. Days are property-time-zone days. |
| Calendar (§49) | `GET /api/admin/calendar?from&to` (`calendar.view`, ≤ 62 days): every unit × night from the night-locks (multi-night stays show every night, check-out day free), admin blocks, camping used/max per night, bookings overlapping the range. Day / Week (Mon–Sun) / Month / Custom views; names and totals only with `bookings.view`. |
| Stay actions | `POST /api/admin/bookings/:code/stay/check-in|check-out|no-show` (`bookings.edit`, audited). Check-in / no-show from the check-in date; nights stay reserved (the stay was sold). Migration 0015 trigger enforces the booking lifecycle in the DB: PENDING → CONFIRMED/EXPIRED/CANCELLED, CONFIRMED → CHECKED_IN/CANCELLED/NO_SHOW, CHECKED_IN → CHECKED_OUT; everything else `BOOKING_STATUS_TRANSITION`. |
| Payments list | `GET /api/admin/payments` (`payments.view`) with status / method / Booking ID / date filters, cursor paging. |
| Booking rules | `GET/PUT /api/admin/booking-settings` (edit: `settings.website`): hold minutes, max nights, max advance days, max tents — new bookings only. |
| Generic CMS engine | `/api/admin/cms/:entity` for food categories, dishes, included meals, home slides & sections, gallery categories & images, history sections & timeline, SEO redirects. One field schema (`src/shared/cms-schema.ts`) drives server validation **and** the admin forms. Strict allow-list (unknown → `UNKNOWN_FIELD`, `status` only via publish, immutable codes), per-kind validation (plain text only — never HTML; links `/path` or `https://` only, no `javascript:` / `//host`; colours `#RRGGBB`), reference + image-purpose checks (`WRONG_MEDIA_PURPOSE`), one atomic batch with the audit entry, constraint errors → 409/422. Table/column names are constants, never request data. Permissions per entity: view `content.view` / `food.view` / `seo.edit`, edit `content.home|gallery|history` / `food.edit` / `seo.edit`, publish `content.publish`. New records go to the end of the list; reorder = `PUT …/order {ids}`. |
| Content rules | Slides need a HOME_SLIDE image; publish → SCHEDULED until `startAt`, visitors see EXPIRED after `endAt` (computed, so no cron is needed); publishing a slide whose end has passed → `SLIDE_ENDED`. Gallery categories and timeline items need a Thai name/title; images show publicly only when published **and** in a published category (or none); a category with images cannot be deleted (`CATEGORY_NOT_EMPTY`). Gallery/history/dishes are soft-deleted; slides/sections/redirects are hard-deleted (content only, audit keeps the old values). |
| Public content API (§59) | `GET /api/public/home`, `/home/slides`, `/gallery`, `/gallery/categories`, `/history`, `/history/timeline` (`?lang=`): published + in-window only, ACTIVE public images only, language → Thai fallback, static SQL, cacheable 60 s. Public page rendering (slideshow, bento grid + lightbox, timeline): see A.16. |
| Food (§19–24) | Menu admin (dishes with pricing type / child pricing / set size / min-max, categories with deadlines, service time and service day, included meals per unit / unit type / camping). A new default daily limit also updates future days still on the old default; per-day overrides `PUT /api/admin/food/capacity/:categoryId/:date` (null = default; below sold → `CAPACITY_BELOW_USED`). Kitchen orders `GET/PATCH /api/admin/food-orders`: optimistic (`expectedStatus`), forward-only (DB trigger `FOOD_ORDER_STATUS_TRANSITION`), only once the booking is confirmed, cancellation only through the booking. Kitchen report: Phase 10 (A.14). |
| Website & branding (§36–37) | `PUT /api/admin/settings/website` (name / tagline / address / footer per language, contact, LINE OA & map https URLs) and `/branding` (main, mobile, login logo = LOGO images; favicon = FAVICON image). UPSERTs, so a fresh production DB works without the dev seed. The public site reads everything at runtime — no deploy. Default language, time zone and currency are fixed (shown read-only). |
| Theme (§37–38) | Tokens = the CSS variables of §37 (+ text-on-primary). Values are a closed set: `#RRGGBB`, listed system font stacks (Thai + Chinese coverage, no external font requests; uploaded WOFF2 / WOFF families since Phase 12, see A.16), radius 0–48 px, three shadow levels — so a theme can never inject CSS. 10 presets. Draft → preview (in-admin live preview + "preview on the live website" `?themePreview=1`, draft tokens served only to a session with `settings.theme`) → publish (previous version ARCHIVED) → rollback (an archived version becomes live again). One published version (unique index); archived/published tokens frozen by trigger (`THEME_VERSION_IMMUTABLE`). Applied on `:root` via CSSOM (CSP-safe), re-validated on the way out; admin keeps its neutral look. Contrast warnings below 4.5:1. |
| Floating booking CTA (§39) | Settings → Booking CTA (`settings.booking_cta`): enabled, desktop/mobile visibility and position (mobile full-width bar default), size, icon, colour (or theme primary), animation (off with reduced motion), closeable (per session), pages, label per language. Links to `/{lang}/booking`. Never shown on the booking pages (cannot cover the booking form); pages reserve space for the mobile bar; iPhone safe area respected; `--cta-offset` for the LINE button / cookie banner (Phases 11 & 14). |
| Marketing (§43–45) | `GET` `marketing.view`, `PUT` `marketing.edit`: GA4 ID, Pixel ID, CAPI on/off, Search Console code. **The CAPI token is never stored or returned**: the API only reports whether `META_CAPI_ACCESS_TOKEN` / `META_TEST_EVENT_CODE` exist as Cloudflare Secrets, and CAPI cannot be enabled without the token (`CAPI_TOKEN_MISSING`). Sending events + consent: A.18. |
| SEO (§42) | Per page (home / gallery / booking / history) × language: title, description, https canonical, OG title / description / OG_IMAGE image, robots, JSON-LD (must be a JSON object, ≤ 8 KB, no `</script` / `<!--`). Redirects managed (reserved `/api`, `/media`, `/admin`, `/assets`, `/{lang}/admin` refused); serving metadata, sitemap and redirects: see A.17. |
| Admin UI | New pages: Dashboard, Calendar, Payments, Food menu (+ daily capacity grid), Food orders, Home, Gallery (multi-upload), History, SEO (+ redirects), GA4 / Meta Pixel / CAPI, Website (+ booking rules), Branding, Theme, Booking CTA; check-in / check-out / no-show on the booking page. All TH / EN / ZH-CN (`admin-cms-messages.ts`, parity tested). Privacy / cookies added in Phase 14 (A.18). |
| Migration | `0015_admin_dashboard.sql` — triggers (booking lifecycle, kitchen order forward-only, frozen theme versions) + 5 indexes. Non-destructive (no table rebuild, no data change). |

### A.14 Reports (Phase 10)

| Topic | Decision |
|---|---|
| Source of truth | Every figure is computed from D1 at request time (bookings, booking snapshots, night-locks, food orders, payments, refunds). No cached totals, no analytics data. Money is integer satang end-to-end; baht only at display / Excel time. |
| Endpoints | `GET /api/admin/reports/:type?from&to&group&lang` → `ReportDto` (tables of typed columns + rows + totals + notes). `GET /api/admin/reports/:type/export?…&format=xlsx` → Excel file. The PDF view calls the first endpoint with `export=pdf`. Types: `revenue`, `booking`, `accommodation`, `camping`, `food`, `kitchen`, `payment`. `from`/`to` are inclusive property-local dates; `group` = day / month / year. |
| Periods (§50) | Daily, Monthly (grouped by day), Yearly (grouped by month), Custom (any group). Limits: day grouping ≤ 366 days, month/year ≤ 3,660 days; kitchen ≤ 31 days (`RANGE_TOO_LONG`, `BEFORE_START`, `INVALID_DATE`). Days are property days (`Asia/Bangkok`, offset applied in SQL), not UTC. |
| Permissions | View `reports.view` (kitchen report: `kitchen.view`); Excel / PDF `reports.export` (kitchen: `kitchen.view`, so kitchen staff can print their sheet). Checked on the Worker; the UI only hides what the API would refuse. Customer names appear only with `bookings.view` (otherwise column omitted + note). Every export is audited (`EXPORT_REPORT` with type, range, group, format). |
| Revenue basis | **By night of stay**: paid (`PAID`/`VERIFIED`) bookings in a sold status (`CONFIRMED`/`CHECKED_IN`/`CHECKED_OUT`/`NO_SHOW`); accommodation split per night by the snapshot nightly prices (exact satang split, discount spread proportionally, check-out day is not a night) so a stay across months lands in both months; food by service date at booking-time prices. **Cash basis**: payments by confirmation date, refunds by refund date, net = received − refunded. Both shown side by side with notes. |
| Other reports | Booking: by creation date — per period, by current status, by accommodation, details (≤ 2,000 rows, flagged when truncated). Accommodation: per unit — nights available (active units minus admin blocks), blocked, sold, occupancy, revenue, ADR, RevPAR; per period. Camping: capacity per night (override or default), tents sold, occupancy, adults/children, revenue. Food: per period, per category, per dish (paid + sold only). Kitchen: portions to prepare per day × category × dish, **confirmed vs awaiting payment** (held quota that may still expire), included meals, order list with notes; cancelled orders excluded. Payment: received / refunded / slips by period, by method, by verification (auto / staff / recorded). |
| Excel | Built in the Worker with a small dependency-free XLSX writer (`src/worker/reports/xlsx.ts`, ZIP stored + CRC-32): one sheet per table, title / period / generated lines, bold header, frozen header row, auto-filter, number formats (baht `#,##0.00`, integers, percent), totals row, notes. Every value is written as a typed number or an inline string — **never a formula**, so customer-entered text cannot become a spreadsheet formula. Labels and codes in the admin's language (TH / EN / ZH-CN). `Cache-Control: no-store`, `Content-Disposition: attachment`. Validated with openpyxl. |
| PDF | Printable A4-landscape view (`/{lang}/admin/reports/print?…`) with site name / logo, period, time zone, generated at / by; opens the print dialog → "Save as PDF". Chosen because browsers shape Thai and Chinese text correctly with no font embedding and no third-party service. If one-click server-side PDFs are wanted later, Cloudflare Browser Rendering can render the same view without changing the report code. |
| Screen | Reports page with type tabs (only permitted types), period presets, bar chart for the main period figure, tables with totals, notes explaining each basis. "Kitchen report" menu opens the same page fixed to the kitchen type. All TH / EN / ZH-CN (`report-messages.ts`, parity tested). |
| Migration | None. Phase 10 only reads existing tables and uses the Phase 9 indexes (payments, bookings, food orders). |

### A.15 LINE notifications (Phase 11)

| Topic | Decision |
|---|---|
| Channel & secrets (§47, §61) | LINE Official Account + Messaging API. `LINE_CHANNEL_ACCESS_TOKEN` (long-lived) and `LINE_CHANNEL_SECRET` are **Cloudflare Secrets only**: never in Git, D1, logs or API responses (the admin API reports only "set / not set"). The token is used only in the `Authorization` header of calls to `api.line.me`. Settings → LINE shows the webhook URL to paste into LINE Developers and "Check connection" (bot name, Basic ID, monthly quota — the public Basic ID / name are stored). |
| Who gets what | **Staff chats** (a person, group or room), each with a language (TH / EN / ZH-CN) and three switches: *upcoming check-ins* (daily digest), *food / kitchen* (daily "food to prepare" digest + new confirmed food orders + cancellations of orders the kitchen already got), *payments* (slip waiting for review — sent 2 minutes later and skipped if auto-verification settled it — and booking paid / confirmed). **Guests** who opt in from their booking page get "payment received, booking confirmed" and a check-in reminder in their booking language. |
| Check-in notice | Default 1 day before at 18:00 property time (`reminder_days_before` 0–7, `reminder_time` HH:MM). Staff digest lists, per arrival, Booking ID, customer, check-in, check-out (nights), house/VIP or camping (tents), guests, food lines and payment status (§47); held-but-unpaid arrivals are included and marked. "Send when empty" is optional. Planned once per date (idempotency key per date), so changing the time never sends twice. |
| Pairing staff chats | Admin creates a one-time code (8 characters without look-alikes, 30 minutes, single use, only its SHA-256 stored); someone sends `LINK ABCD-EFGH` to the Official Account in that chat; the webhook registers the chat (user / group / room id) and replies. Manual id entry is a fallback. `leave` / `unfollow` events turn the chat off. Ids are masked in the admin API. |
| Guest opt-in | Only when "guest updates" is on. The booking page (confirmation + lookup; Booking ID + phone required) creates a code and a `line.me/R/oaMessage/@basicId/?…` link with the message pre-filled; the webhook links the LINE user (1:1 chat only) to that booking. The guest can stop it any time; blocking the account unlinks every booking; links are deleted 30 days after check-out (cron), codes 7 days after expiry. The log never stores the guest's LINE id (`recipient = 'guest:<booking id>'`, resolved at send time). |
| Outbox + idempotency | Notification rows are inserted **in the same D1 batch** as the change that causes them (record payment, slip stored, auto / staff slip verification, cancellation), guarded by the change's marker (`confirmed_at = now`, …), so a notice exists if and only if the change committed. `INSERT OR IGNORE` on a unique `idempotency_key` (type + booking / payment / date + recipient) makes replays harmless. Nothing is queued while LINE is off. |
| Delivery + retry | Cron every minute (was 5): plan digests, then deliver due rows. Each attempt is *claimed* (attempts + 1 and a 2-minute lease, compare-and-set), so parallel runs never send a row twice. Push uses `X-Line-Retry-Key` = a UUID derived from the row id, so a retry after a timeout is de-duplicated by LINE (409 → treated as sent). Temporary errors (network, timeout, 401, 408, 429 + Retry-After, 5xx) retry after 1, 5, 15, 60 minutes, 5 attempts max; other 4xx fail at once. Stale (> 24 h), opted-out, removed recipients, LINE switched off, or no-longer-relevant notices are skipped with a reason. A SENT row is final (DB trigger `NOTIFICATION_SENT_FINAL`). Message texts are rendered at send time from D1 snapshots; ≤ 5 messages × 5,000 characters per push. |
| Delivery log (§47) | Settings → LINE → Delivery log (`notifications.view`): type, recipient, booking, status + reason, attempts, times; filters; "send again" (FAILED / skipped → 3 more attempts) and "cancel" (`settings.line`, audited); "send due notifications now". Test message per chat (rate-limited, 10 / hour). |
| Webhook security | `POST /api/line/webhook` is the only API path outside the CSRF guard; it is authenticated by `x-line-signature` (HMAC-SHA256 of the raw body with the channel secret, constant-time compare), body ≤ 256 KB, ≤ 100 events. Bad signatures → 401 + security event (rate-capped). Only `LINK …` messages, `unfollow` and `leave` are acted on; nothing else is stored. |
| Website button | Optional floating "LINE" button (add-friend link from Website settings or the bot's Basic ID; https only), stacked above the floating booking button, hidden on the booking pages, AA-contrast green. |
| Permissions | `settings.line` (settings, chats, codes, retry / cancel / test), `notifications.view` (log). Audited: settings, chat create / update / delete / link, codes, tests, retry, cancel. |
| Migration | `0016_line_notifications.sql` — new tables `line_settings` (seeded row), `line_recipients`, `line_link_codes`, `booking_line_links`; trigger "SENT is final"; log index. Non-destructive. |

### A.16 Images, fonts and public content pages (Phase 12)

| Topic | Decision |
|---|---|
| Compression (§54) | Workers cannot run image codecs without a paid image service, so the **admin's browser** prepares photos before upload (`src/client/media/prepareImage.ts`): decode with orientation applied, scale to the purpose's maximum width (HOME_SLIDE / GALLERY 2400 px, ACCOMMODATION / HISTORY / HOME_SECTION 2000 px, FOOD 1600 px, OG_IMAGE 1200 px JPEG), re-encode WebP q 0.82 (JPEG when the browser cannot encode WebP), which also drops EXIF / GPS. LOGO, FAVICON and PAYMENT_QR are uploaded unchanged. If anything fails the original is uploaded (the server limits still apply). Cloudflare Image Transformations can replace this later without schema changes. |
| Responsive renditions | Smaller copies (e.g. 480 / 960 / 1600 px) are sent as `variant` fields of the same multipart upload. The server sniffs each from its bytes like the original and accepts it only if it is the same picture (narrower, same aspect ±1 % / 2 px, distinct widths, ≤ 5, only for purposes with renditions). Stored as `media_assets` rows with `parent_asset_id` (key `<original>-w<width>.<ext>`), in one D1 batch with the original (R2 objects compensated on failure). DB trigger `MEDIA_VARIANT_INVALID`: same bucket + purpose as an ACTIVE original image, never a rendition of a rendition. Content, settings and attach endpoints accept originals only. Deleting / retiring an original retires its renditions and deletes all their objects. |
| srcset | `ImageResolver` loads every rendition of a page's images in one query and builds `srcset` (renditions + original, ascending); every public image DTO carries `srcset` (null = plain `src`). Client `ResponsiveImage` sets `srcset` / `sizes` (`IMAGE_SIZES` per layout), `width` / `height` (no layout shift), lazy loading, and eager + `fetchpriority=high` for the first visible image. |
| Access control (§54–55) | `/media/*` serves a public-bucket asset only while the content using it is visible: LOGO / FAVICON / OG_IMAGE / PAYMENT_QR / FONT always; GALLERY when the photo and its category are published; HOME_SLIDE when published and inside its schedule; HOME_SECTION / HISTORY when the section / timeline item is published; ACCOMMODATION for an ACTIVE unit's photos or cover, or the camping cover while camping is on; FOOD for an ACTIVE dish. Renditions follow their original. Anything else → 404 for visitors; signed-in staff get it with `Cache-Control: private, no-store` (admin previews). Published → `public, max-age=31536000, immutable`. Slips stay in the private bucket (never `/media/*`). Unchanged: bytes sniffing (JPEG / PNG / WebP / AVIF only, SVG / HTML / executables rejected), size / dimension limits, server-generated keys (no traversal), `nosniff`, `default-src 'none'; sandbox` on media responses. |
| Food images | `food_options.image_asset_id` (FOOD purpose) edited in Food → Menu; dish photos appear in the booking food step and on the home food preview (`GET /api/public/food-menu`). Alt text = the photo's Media text in the visitor's language (Thai fallback), else the dish name. |
| Uploaded fonts (§37) | Settings → Theme → Uploaded fonts (`settings.theme`): WOFF2 / WOFF only (signature, flavour and header length checked from the bytes), ≤ 2 MB, one file per family + weight (100–900) + style, family name `[A-Za-z0-9][A-Za-z0-9 _-]{0,39}`, fallback stack SANS / ROUNDED / SERIF / MONO. Stored as FONT assets (`custom_fonts` table, DB checks + triggers). A theme font token is either a system stack or exactly `"Family", <fallback stack>` with an uploaded family — still a closed format, no CSS injection. Faces are registered with the FontFace API (no inline `<style>`, CSP-safe, `font-display: swap`); visitors download only faces of families the **published** theme uses; the draft preview gets the draft's faces. A family used by the draft or published theme cannot be deleted (`FONT_IN_USE`). Licence for web embedding is the admin's responsibility. |
| Home (§8–9) | Hero slideshow: autoplay 5 s (paused on hover / focus / hidden tab, pause button, no autoplay with reduced motion), previous / next, dots, arrow keys, swipe, mobile image via `<picture>`, admin overlay colour / opacity, text position, buttons (in-app `/path` or external `https://` in a new tab), only the current + next image loaded. Page `<h1>` = website name (visually hidden over the slideshow). Sections in the admin's order: introduction / custom (text + photo), accommodation rail (swipe on phones), gallery mosaic (fills for 1–5 photos), food menu with prices (dotted leaders), history preview (latest timeline years), booking band, location (address + map link), contact (phone / email / LINE). |
| Gallery (§10) | Category chips (only categories with photos), bento grid using the admin's NORMAL / WIDE / TALL / LARGE spans, skeleton while loading, empty states, lightbox: native modal `<dialog>`, previous / next, arrow / Home / End keys, swipe, caption, position, Esc / backdrop closes, focus returns, page scroll locked. |
| History (§11) | Sections render by type (HERO with photo → page `<h1>`, STORY / INTRODUCTION / IMAGE_TEXT with layouts image left / right / full width, QUOTE, TIMELINE, GALLERY link, CTA); timeline shows Buddhist-era years in Thai (พ.ศ. = CE + 543) and CE elsewhere; appended at the end when no Timeline section exists. |
| Thai typography | Headings get line-height 1.4 under `:lang(th)` (stacked vowels / tone marks); large display titles 1.3. |
| Migration | `0017_images_fonts.sql` — ADD COLUMN `media_assets.parent_asset_id`, `food_options.image_asset_id`; new table `custom_fonts`; triggers (variant validity, FONT ⇔ font file, font row → active FONT asset); lookup indexes for access checks. Non-destructive, no data change. |
| Deployment note | With a separate media domain (`PUBLIC_MEDIA_BASE_URL`), add it to `font-src` in `public/_headers` and allow the site origin in the bucket's CORS rules (README). |

### A.17 i18n, SEO and site search (Phase 13)

| Topic | Decision |
|---|---|
| Rendering (ADR-10) | `run_worker_first: ["/*", "!/assets/*"]`, `not_found_handling: "none"`. For a page the Worker loads the built `index.html` from the ASSETS binding and injects `<html lang data-seo-path>`, the title and the tags (escaped; JSON-LD with `<`, `>`, `&`, U+2028/9 escaped; function replacements so `$&` in content is literal). Unknown pages, unknown / inactive accommodation slugs → **404** with the app shell and `noindex`; file-like paths (`/wp-login.php`) → plain 404; `/EN/x`, trailing slashes → **301** to the canonical path (query kept); `/` → **302** to the best `Accept-Language` match (`Vary`); `/admin*` → 302. Admin shell: `noindex`, `no-store`, `no-referrer`, no public metadata. If metadata cannot be built, the plain shell is served (the site never fails because of SEO). Page headers = `public/_headers` (parity test). HTML: `Cache-Control: public, no-cache` (indexable) or `no-store`. |
| Metadata per page × language (§42) | Title, description, canonical, robots, OG (type, site name, title, description, url, locale + alternates, image with size / alt), Twitter card, Search Console verification meta, favicon. Admin texts (Website → SEO, per language) win; defaults: home `site | tagline`, pages `page | site`, accommodation `unit SEO title or name | site`, descriptions from `seo-messages.ts` (3 languages) or the unit's own text / a generated sentence with live price and capacity, ≤ 160 chars. OG image: admin image (language → Thai) → page image (first slide, first gallery photo, history image, unit cover) → logo. `noindex` pages get no canonical / hreflang. **Non-production (`APP_ENV` ≠ production) is always `noindex,nofollow`.** |
| hreflang | `th`, `en`, `zh-Hans` (Simplified Chinese script, readers in CN / SG / MY alike; `<html lang>` stays `zh-CN`), `x-default` → Thai. Only between indexable language versions. Same in the sitemap. |
| Structured data | Home: `WebSite` + `LodgingBusiness` (`@id` /#lodging; name, logo, phone, email, address, geo, map, LINE as `sameAs`, price range from live active prices, languages). Pages: `BreadcrumbList` + `CollectionPage` (gallery) / `AboutPage` (history) / `WebPage` (booking). Accommodation: `BreadcrumbList` + `Accommodation` (images, occupancy, amenities, contained in the lodging). Admin's own JSON-LD per page × language is added as an extra block. |
| Client navigation | `useHeadMeta` (Layout): the first page already has its head (`data-seo-path`); later pages fetch `GET /api/public/meta?path=` (same resolver, cacheable 60 s) and replace every `data-seo` tag (JSON-LD via `textContent`); a provisional `page | site` title meanwhile; stale answers ignored. Admin clears public tags. |
| Sitemap / robots | `/sitemap.xml`: home, gallery, booking, history × 3 languages (minus admin-noindexed versions and pages canonical elsewhere) + every active accommodation × 3; `xhtml:link` alternates, `lastmod` (latest content / SEO change), `image:image` (public originals, ≤ 50 per URL). `/robots.txt`: production disallows `/api/`, `/admin`, `/{lang}/admin`, `/{lang}/booking/lookup`, `/customer`, `/payment` and points to the sitemap; elsewhere `Disallow: /`. `/favicon.ico` → branding favicon or 404. |
| Redirects | Website → SEO → Redirects apply before routing (exact path, not for `/api`, `/media`, `/assets`, admin), keep the query string, count hits; targets are paths only (DB CHECK + runtime guard: no `//`, no `/\`). |
| Search Console | Verification HTML-tag code from Marketing settings on every public page; README: Domain property via DNS recommended, then submit the sitemap. Admin SEO page shows the sitemap / robots URLs and the live robots.txt. |
| i18n | `<html lang>` and `Content-Language` from the server; Accept-Language only for the bare `/`; language switcher keeps the path; **translation coverage** (`GET /api/admin/i18n/coverage`, `content.view`): visible records with Thai text but no EN / ZH-CN (accommodation, amenities, food categories / dishes, slides, home sections, gallery categories / photos, history sections / timeline, website / camping / booking-button texts, SEO texts), first 20 per group, shown on Website → SEO. Dictionaries for SEO / search texts in 3 languages (parity tests). |
| Global search (§40–41, added to this phase by agreement) | Header button (and `/` key) opens a modal search: words in any language (index rows for all 3 languages are searched; the answer is in the visitor's language), optional stay dates. `search_index` = projection built from the same public services as the pages (houses / VIP tents with amenities, camping, dishes with category, history sections / timeline with CE + BE years, gallery photos with texts; type words per language so "tent / เต็นท์ / 帐篷" work). Matching: Unicode-normalised substring tokens (Thai has no spaces), ≤ 6 tokens, ≤ 100 chars; ranking by kind, title match, language. **Every candidate is re-read from the source services** (unpublished / inactive drop out at once) and with dates the availability comes from `publicAvailability` (houses / VIP: free + fits guests; camping: tents left) — free stays first, link to the booking page with the dates. Cron (every 5 min) rebuilds the index only when a source fingerprint (counts, last updates, text lengths) changed, else once a day; first search on an empty install builds it; admin "Rebuild index now" (`seo.edit`, audited). `ACTIVITY` / `PROMOTION` / `FAQ` / `ARTICLE` types are reserved (no such content yet). |
| Search analytics | `search_history` (query, language, dates, result count — no IP, no user, no session; purged after 90 days) + daily `search_analytics` (searches, zero-result searches, clicks ≤ searches via `POST /api/search/click`, CSRF-guarded). Website → SEO → Site search: top searches and searches with no results (30 days), index size and last rebuild. |
| Migration | `0018_search_state.sql` — new singleton `search_index_state` + analytics index. Non-destructive. |

### A.18 Security & marketing (Phase 14)

| Topic | Decision |
|---|---|
| Cookie consent (§46) | One first-party cookie `pk_consent=<version>.<analytics>.<marketing>.<unix>` (`Path=/`, `SameSite=Lax`, `Secure` on https, `Max-Age` = Settings → Privacy days 30–395, default 180). Categories Necessary (always) / Analytics / Marketing. Banner (not modal, right after the skip link, labelled region) with the spec's three buttons **styled identically** (refusing as easy as accepting); settings `<dialog>` with switches (Necessary locked, others off until chosen), Esc closes without saving, focus returns to the opener. Shown only when GA4 or Pixel is on and the banner is enabled; with the banner off, visitors who have not chosen are simply not tracked. "Ask everyone again" raises the consent version (old cookies stop counting on client and server). Footer: privacy policy link + "Cookie settings". Floating booking / LINE buttons hide while the banner is up, and the footer's last row is kept clear of them. |
| Privacy policy | Settings → Privacy (`settings.privacy`): banner text, policy title and body (plain text ≤ 30,000 chars, blank line = paragraph, `1.` = heading, `- ` = list) per language; `/{lang}/privacy` (Thai fallback) is a real page (server metadata, sitemap) only once a policy exists, else 404. Audit: `UPDATE_PRIVACY` / `RENEW_CONSENT` with the policy length, not its text. Booking form links to the policy in a new tab. |
| GA4 (§43) | Loaded by the app only with Analytics consent; Consent Mode default (`analytics_storage` granted, ad_* = Marketing choice), `send_page_view: false`, Google signals only with Marketing consent. Page views sent by the app with a cleaned URL (`utm_*`, `gclid`, `fbclid` only). Events: page_view, view_item + view_accommodation, search, select_item + select_accommodation, begin_booking (stay chosen), begin_checkout (to guest details), view_food, select_food, add_food, generate_lead, add_payment_info + payment_submitted, purchase + booking_confirmed (`transaction_id` = Booking ID, value = total, THB; once per booking per browser, when the guest sees CONFIRMED). Never sent: name, phone, e-mail, bank account, slip, notes (free text is masked for e-mails / numbers). |
| Meta Pixel (§44) | Only with Marketing consent; `autoConfig` off (no automatic events / scraping), `disablePushState` (no automatic history page views), `trackSingle` to the configured Pixel. PageView, ViewContent, Search, AddToCart (stay chosen, dish added), InitiateCheckout, Lead (`eventID` = `lead-<Booking ID>`), AddPaymentInfo (`payment-<id>`), Purchase (`purchase-<id>`), Contact (tel / mailto / LINE / map links). README: switch off Automatic advanced matching in Events Manager. |
| Conversions API (§45) | `booking_marketing` stores the consent with each booking; `_fbp` / `_fbc` (format-checked), IP and user agent **only with Marketing consent** (DB CHECK), erased after 8 days. Outbox `marketing_events`: Lead inserted in the booking's batch, Purchase in the batch that confirms payment (staff record or verified slip; marker `confirmed_at = now`), both only with consent and CAPI on; `INSERT OR IGNORE` on unique `event_id`. Cron delivers (2-minute lease, backoff 1/5/15/60 min, max 5, 4xx = failed, skip when CAPI off / token missing / no Pixel / older than 7 days); user_data = hashed booking id + browser ids, custom_data = THB value, content ids, order id. Token only in the request body to graph.facebook.com, scrubbed from errors, never in D1 / logs / API. `META_TEST_EVENT_CODE` routes everything to Test events. Admin: delivery log (`marketing.view`) and "Send test event" (`marketing.edit`, audited `SEND_CAPI_TEST`); Pixel source (secret vs settings) + mismatch warning. Log kept 90 days; a SENT row is final (trigger). |
| GA4 Data API (§48) | Dashboard visitors (activeUsers), page views, accommodation views, booking started (`begin_booking`), checkout started (`begin_checkout`) for the last 30 days: service-account JWT (RS256, `analytics.readonly`) → OAuth token (per isolate) → `batchRunReports`; cached 3 h in `analytics_report_cache` (numbers only), 15-minute back-off after an error (shown on Marketing → GA4), 8 s timeout, dashboard still loads. Key = secret `GA4_SERVICE_ACCOUNT_KEY`; property id in Marketing settings. |
| CSP | Page CSP adds `https://www.googletagmanager.com` (+ GA collection hosts) and/or `https://connect.facebook.net` (+ facebook.com) only while that tracker is on; otherwise identical to `public/_headers`. Admin pages keep the strict CSP and never load trackers (tracking suspended in the back office). |
| Rate limits (§58) | Workers Rate Limiting bindings per client IP: `RL_PUBLIC` 300/min (pages, public reads), `RL_WRITE` 30/min (public POST/PUT/DELETE), `RL_AUTH` 10/min, `RL_ADMIN` 600/min; exempt: health, LINE webhook (signed), `/media`, `/assets`. 429 + `Retry-After: 60` (pages: plain text), one `RATE_LIMITED` security event per IP / group / minute; fails open if the limiter errors. Business limits from earlier phases stay (login lockout, bookings per hour, lookup failures, slip uploads). |
| Security review | No new raw SQL inputs (static statements, bound params); new endpoints behind session + permission + CSRF guard; allow-listed bodies (mass assignment); tracker IDs re-validated before reaching a script URL; policy text rendered as React text (no HTML); secrets only as Cloudflare Secrets (`META_CAPI_ACCESS_TOKEN`, `META_TEST_EVENT_CODE`, `META_PIXEL_ID`, `GA4_SERVICE_ACCOUNT_KEY`) and only "configured: yes/no" reaches the admin UI; security-event filter lists every event type the app writes. |
| Accessibility (§57) | In-browser audit on 9 public and 4 admin pages + banner + dialog: alt text, accessible names, labels, one h1 / heading order, landmarks, unique ids, `lang`, WCAG AA contrast of all visible text; focus ring on every tab stop; reduced motion. |
| Migration | `0019_privacy_marketing.sql` — new tables `privacy_settings` (+ row), `privacy_setting_translations`, `booking_marketing`, `marketing_events` (+ trigger), `analytics_report_cache`; new nullable column `marketing_settings.ga4_property_id`. Additive only. |

### A.19 Testing (Phase 15)

**Strategy.** Business rules are tested where they live — services and SQL — against the real migrations in SQLite (D1-compatible: one transaction per batch, CHECKs and triggers enforced). On top of the per-feature tests of Phases 1–14, Phase 15 adds tests that cover *everything at once*, so new code is checked without writing new tests: the route list comes from the router, the dictionaries are discovered from `src/shared/i18n`, the migration prefixes from `migrations/`. Browser suites run against a local HTTPS copy of the Worker with fake LINE / Meta / Google APIs.

| Area (B.60 Phase 15) | Where it is tested |
|---|---|
| Authentication | `worker/auth.test.ts` (login, lockout, IP throttle, sessions, rotation, reset links, bootstrap), `security-primitives.test.ts`, `route-security.test.ts` (401 on every admin route, forged cookies cleared); browser: Phase 9 |
| Authorization | `user-management.test.ts` (RBAC, overrides), **`route-security.test.ts`: every admin route → 403 for an account without permissions, before any body / query validation, denial logged**; permission checks per module in every feature test |
| User management | `user-management.test.ts` (create / invite / update / roles / permissions / suspend / force logout / admin reset / audit) |
| Soft delete | `user-management.test.ts` (delete + restore), `accommodation.test.ts` (units), `cms.test.ts` (content), `payment.test.ts` (accounts), `db/integrity.test.ts` |
| SUPER_ADMIN rules | `user-management.test.ts` (≥ 1 active SUPER_ADMIN, no self-delete / suspend, only SUPER_ADMIN grants SUPER_ADMIN, role not editable, escalation events), `auth.test.ts` (bootstrap CLI) |
| Booking | `booking.test.ts`, **`invariants.test.ts`** (simulation), browser: Phase 14 full booking, Phase 9 |
| Double booking | `booking.test.ts` (simultaneous requests), **`invariants.test.ts`: 3 seeds × 120 steps of concurrent bursts from many IPs — 337 bookings made, 295 refused at full capacity (unit / camping / food), 38 payments raced by two staff, 45 cancellations, 219 expiries, 50 capacity changes; invariants checked from first principles after every step** |
| Camping capacity · Multi-night | `camping-capacity.test.ts` (spec examples, races, owner vs booking race, integrity check), `invariants.test.ts` (1–3 night stays, counters = truth, never above the night's limit) |
| Food capacity | `booking.test.ts` (races), `food-admin.test.ts`, `invariants.test.ts` (daily counters = reserved portions of live orders) |
| Price snapshot · Payment snapshot | `booking.test.ts`, `payment.test.ts`, **`invariants.test.ts`: after changing base price, pricing rule, dish price, included meal, receiving account and unit name, the stored snapshots, the admin view and the guest view are unchanged; new quotes use the new prices; DB triggers refuse updates** |
| Slip | `slip.test.ts` (private storage, manual queue, real provider adapter, fail-safe), `marketing.test.ts` (Purchase only on verified slip), `coverage-gaps.test.ts` (provider factory: never OCR-only); browser: Phases 9, 11 |
| Search | `search.test.ts`, `client/seo-search.test.tsx`; browser: Phase 13 |
| i18n | `shared/i18n.test.ts`, `routes.test.ts`, **`shared/i18n-completeness.test.ts`: all 13 dictionaries (site, booking, content, consent, search, SEO, admin ×4, reports, LINE) — same keys, nothing empty, same `{placeholders}`, no Thai text in EN / ZH-CN**; browser: Phase 13 |
| LINE | `line.test.ts` (fake LINE API); browser: Phase 11 |
| Branding · Theme | `settings.test.ts`, `db/site-repository.test.ts`, `images.test.ts` (fonts); browser: Phases 9, 12 |
| Home · Gallery · History | `cms.test.ts`, `images.test.ts`, `client/content.test.tsx`; browser: Phase 12 |
| Floating booking CTA | `settings.test.ts`, `client/layout.test.tsx`; browser: Phase 9, responsive (never covers the footer) |
| GA4 · Meta | `marketing.test.ts` (event mapping, CAPI outbox / delivery / retry, GA4 Data API, CSP), `client/consent.test.tsx` (consent-gated runtime), `coverage-gaps.test.ts` (failure paths); browser: Phase 14 |
| SEO | `seo.test.ts`; browser: Phase 13 |
| Security | **`route-security.test.ts`**: CSRF (4 variants) on every state-changing route; hostile path / query / body input (SQL, traversal, script, huge, unicode, prototype pollution, deep JSON) on every route as SUPER_ADMIN and anonymous → never 500, no stack / SQL text, database intact; content-type / size limits; security headers + no-store on every API response; public endpoints leak no PII / hashes / tokens; booking lookup gives one answer for "wrong phone" and "unknown code". Plus `auth`, `security-primitives`, `marketing` (rate limits, secrets), static checks |
| Responsive | **browser `responsive.mjs`: 7 public pages × 5 widths (320 → 1440), landscape phone, 6 admin pages × 3 widths; no horizontal scroll, images within the screen, ≥ 24 px targets (WCAG 2.2), readable text, inputs ≥ 16 px on phones, mobile menu with keyboard** |
| Regression | Full unit suite + all browser suites rerun; **deploy-order tests: the site, pages and cron keep working with every migration prefix from 0010 to 0019** (code deployed before migrations) |

| Tool | Decision |
|---|---|
| Static checks (`scripts/static-checks.ts`) | TypeScript compiler API, works offline next to ESLint: SQL text may only interpolate constants or fragments reviewed in `scripts/sql-fragments.json` (ratchet; request-derived names always fail), no raw HTML / eval / string timers, no `console.log` in the browser, structured logs in the Worker, credential-looking literals and secret-named `vars` in `wrangler.jsonc`, `target=_blank` without `rel`, `<img>` without `alt`, `<button>` without `type`, rules of hooks (early return / conditional), extra strict compile of the Worker. |
| Coverage | `npm run test:coverage` (Node's built-in V8 coverage through source maps). |
| Browser suites | `tests/e2e/`: `run.mjs` builds the client, creates a throw-away certificate (`__Host-` cookies need HTTPS), draws test images in Chromium, starts a fresh server per suite (`server.mts`: real Worker, SQLite with all migrations + dev seed, fake LINE / Meta / Google), runs `phase09…phase14.mjs`, `responsive.mjs` and the accessibility audit (`a11y.mjs`). Default port 8443 (4190 is on the Fetch "bad ports" list). |
| CI | `.github/workflows/ci.yml`: typecheck → lint → static checks → tests with coverage → build; then the browser suites with screenshots as an artifact. |

### A.20 Production readiness (Phase 16)

Runbook for the owner: **`docs/PRODUCTION.md`** (Thai). Readiness by spec item — "in the repo" is built and tested here;
"owner" needs the Cloudflare / LINE / Google / Meta accounts, which this workspace cannot reach.

| Spec item | In the repo (tested) | Owner action before go-live |
|---|---|---|
| Cloudflare Workers | One Worker, Worker-first except `/assets/*`, cron `* * * * *` with per-task isolation + heartbeat, Workers Logs 100 %, `preview_urls: false`; `npm run preflight` checks the config | **Workers Paid plan** (free CPU 10 ms is too little for PBKDF2 sign-in, Excel reports and the cron); `wrangler login`; `npm run deploy` |
| D1 | Migrations 0001–0020 (0020 additive: 2 tables + 1 permission); `/api/health` compares the newest applied migration with `LATEST_MIGRATION` (test keeps it equal to the last file); deploy-order tests 0010–0020; no virtual tables, so `wrangler d1 export` works | `wrangler d1 create phasakura-db --location=apac`, paste `database_id`, `npm run db:migrate:remote` |
| R2 | `MEDIA_PUBLIC` / `MEDIA_PRIVATE` bindings, slips private, `/media/*` access control (Phase 12) | Create both buckets; never enable public access on the private bucket |
| Custom Domain | `routes` template (custom domains, apex + www); every page / file request on another host → 301 to `APP_BASE_URL` (API excluded); preflight warns when `APP_BASE_URL` is not routed or `workers_dev` is on | Zone on Cloudflare, uncomment `routes`, set `APP_BASE_URL`, `"workers_dev": false` |
| SSL | HSTS 1 year + includeSubDomains, CSP `upgrade-insecure-requests`, `__Host-` session cookie; smoke test checks http → https | SSL/TLS → Always Use HTTPS **on**, Minimum TLS 1.2 |
| Secrets | Read only from `env`; static check for credential literals / secret-named `vars`; preflight: secret files in Git, secret names vs features (`--secrets`); System status shows booleans only | `wrangler secret put` per feature (table in the runbook); keep originals in a password manager |
| LINE | Phase 11; System status: LINE on without secrets = error | Channel, webhook URL, Check connection, staff chats |
| GA4 · Meta | Phase 14 (consent-gated, CAPI `event_id` dedup, Purchase only after confirmed payment); System status: CAPI on without token = error, test event code in production = warning | IDs in Admin, CAPI token, delete `META_TEST_EVENT_CODE` after testing, Enhanced-measurement history events off, automatic advanced matching off |
| Search Console | HTML-tag verification field (Phase 13); System status reminder | Domain property (DNS TXT), submit `/sitemap.xml` |
| Sitemap · Robots | Indexable only with `APP_ENV=production`; smoke test: no `Disallow: /`, `Sitemap:` and every `<loc>` on the domain, pages indexable, admin / 404 noindex | `APP_BASE_URL` |
| Backup | D1 Time Travel (30 days on Paid) + `npm run db:backup` (bookmark + export + SHA-256, `backups/` gitignored) + `npm run release` backs up before migrating; restore procedures (in place / new database) | Weekly export, monthly restore drill, R2 copies with rclone (read-only token) |
| Monitoring | `/api/health`: database, schema, cron (503 when degraded, `no-store`, no configuration); `system_heartbeats`; Admin → System status: 19 checks with fixes (TH / EN / ZH-CN), job heartbeat, LINE / CAPI / slip backlog | An uptime monitor on `/api/health`; look at System status daily |
| Error Logging | `error_events`: unexpected API 500s, degraded pages, failed cron tasks — method + path (never the query), error name, message scrubbed of e-mails / phones / tokens; ≤ 20 rows / min / isolate; 30-day retention by the cron; never breaks the request it reports on; full JSON logs in Workers Logs (request id = `X-Request-Id`) | — |
| Security | Phases 3, 14, 15 controls unchanged; new endpoint `/api/admin/system` gated by `system.view` (SUPER_ADMIN, MANAGER) in the route matrix; smoke test checks CSP / HSTS / nosniff / referrer / CSRF rejection / admin noindex + no-store | ≥ 2 SUPER_ADMIN, change the bootstrap password, 2FA on provider accounts |
| Final Smoke Test | `npm run smoke -- <url>` (health, 3 languages, canonical host, headers, assets, robots, sitemap, 404, admin, public API, CSRF, http → https, optional signed-in System status); run in the Phase 16 browser suite against a production-mode server | Run against the real domain after deploy, then one real booking → slip → confirm → LINE / GA4 / Meta check → cancel |

**Go-live blockers** (preflight / System status errors until done): Workers Paid plan, `database_id`, `APP_BASE_URL`,
`routes`, migrations applied, first SUPER_ADMIN, website name, primary receiving account.

### A.6 Verification notes (Phase 1–16)

- Workspace had no npm registry access; `package-lock.json` must be generated on first `npm install`.
- Run on first install: `npm run lint`, `npm run build`, `npm run typecheck` (client part needs `@types/react`).
- Phase 5: 263 tests pass; worker typecheck clean (incl. `--noUnusedLocals`); client checked against a local React type shim; 22/22 browser end-to-end checks (mobile 390 px TH, desktop EN, admin) with zero console/CSP errors. ESLint could not run (plugins not installable offline).
- Phase 6: 275 tests pass (12 new camping-capacity tests; race losers verified to be stopped by the DB CHECK); worker + client typecheck clean; 7/7 browser checks (mobile tent hint, admin drift + recalculate), zero console/CSP errors.
- Phase 7: 285 tests pass (10 new payment tests); worker + client typecheck clean; 11/11 browser checks (admin account + QR + primary, guest payment instructions on mobile, record payment, cancel + refund), zero console/CSP errors.
- Phase 8: 305 tests pass (20 new slip tests incl. provider adapter with fake fetch); worker + client typecheck clean; 14/14 browser checks (manual review path, auto-verified path, private slip 401 without session), zero console/CSP errors. No migration needed (Phase 2 schema already covers slips).
- Phase 9: 330 tests pass (dashboard, calendar, stay lifecycle + DB trigger, payments list, booking rules, CMS engine for every entity, public content API, food capacity / kitchen orders, website, branding, theme draft/publish/rollback, CTA, marketing secret handling, SEO, dictionaries, public CTA/footer render); worker, client (React type shim) and test typecheck clean; 20/20 browser checks over HTTPS (dashboard, calendar, check-in, payments, kitchen, food menu, slide + gallery upload/publish, branding, theme publish + live preview, CTA, CAPI guard, SEO, permissions, mobile 390 px), zero console/CSP errors.
- Phase 10: 339 tests pass (9 new report tests: per-night allocation, XLSX structure / no formulas, revenue across months + cash/refunds, booking PII rule, occupancy with blocks, camping, food, payment, kitchen confirmed vs pending, permissions / validation / export audit, label coverage); worker, client and test typecheck clean; 9/9 Phase 10 browser checks (revenue monthly, Excel download opened as a workbook, yearly bookings, custom range validation, PDF view as EN and TH, kitchen staff, viewer without export) and the 20 Phase 9 checks again, zero console/CSP errors. Excel files checked with openpyxl; PDFs rendered via Chromium print and checked with pdftotext (Thai text correct).
- Phase 11: 366 tests pass (23 new LINE tests against a fake LINE API: retry key, signature, codes, templates in 3 languages, settings / secrets, pairing + expiry + leave, outbox in the same transaction, slip review skip, retry / backoff / 409 / permanent failure / max attempts, parallel runs, opt-out, kitchen cancel rules, digests at 18:00 + empty + days before, guest link / unlink / unfollow / 30-day purge, log / test / public button; plus client and dictionary tests); worker, client and test typecheck clean; 12/12 Phase 11 browser checks (check connection, enable, pairing through a signed webhook, test message, guest opt-in on mobile TH, payment → staff + kitchen + guest messages via the cron, failed → send again, booking page badge, website LINE button vs booking button on mobile + desktop, Thai admin at 390 px, viewer refused) and the Phase 9 (20) and Phase 10 (9) checks again; zero console / CSP errors. Real LINE delivery was not tested (needs a real channel and token).
- Phase 12: 390 tests pass (24 new: renditions stored + linked + audited, rejected renditions (wider, other aspect, not smaller, duplicate width, too many, SVG, purposes without renditions) store nothing, DB trigger cases, originals only for content / settings, srcset order, house photo delete removes renditions, access control for gallery (draft / published / unpublished / hidden category / staff preview / forged session), house status, slide schedule, dish photo in menu + booking catalogue + alt text, font sniffing, upload validation / duplicates / permissions, theme font validation + injection attempt, faces shipped only when published + draft preview, FONT_IN_USE, font DB checks; client render tests for ResponsiveImage, SmartLink, HeroSlideshow, Lightbox, FontFace loading; dictionary parity); worker, client (React type shim, `--noUnusedLocals`) and test typecheck clean; 16/16 Phase 12 browser checks over HTTPS (three 2–6 MB PNGs compressed to WebP in the browser with renditions, drafts 404 for visitors / private for staff, slide through the CMS editor, home sections + slideshow autoplay / pause / keys / dots / reduced motion, gallery chips + lightbox keys / swipe / Esc / focus, history BE / CE years, uploaded WOFF2 heading font published and loaded via FontFace, FONT_IN_USE, 390 px without horizontal scroll, zero console / CSP errors) and the Phase 9 (20), 10 (9) and 11 (12) checks again. The first browser run found that WebP detection always failed on OffscreenCanvas (no rendering context → JPEG fallback); fixed and re-verified. Not run: ESLint, `vite build` (registry offline; bundle built with esbuild for the browser tests), typecheck against the real `@types/react`, real R2 / Cloudflare deployment.
- Phase 13: 420 tests pass (30 new: server-rendered head for home / pages / accommodation in 3 languages, production vs non-production robots, admin SEO overrides incl. escaping of a hostile title and `$&`, OG fallback, noindex without hreflang, custom JSON-LD, Search Console code, 404s / file paths / 301 / 302 with query, Accept-Language entry, booking lookup + admin never indexed, plain shell when metadata fails, redirects (hits, inactive, path-only), robots.txt both modes, sitemap (pages × languages, units, noindex left out, lastmod, images, escaping), favicon, meta API validation, header parity with `public/_headers`, translation coverage + permission, search: index in 3 languages, cross-language words, source re-read, live availability with guests, dates-only, validation, anonymous logging, clicks ≤ searches, CSRF, admin analytics / reindex permissions + audit, cron rebuild only on change, gallery / history with BE years; client head manager and search dialog; dictionary parity); worker (`--noUnusedLocals`), client (React type shim) and test typecheck clean; 10/10 Phase 13 browser checks (crawler HTML, 404 / redirects, robots + sitemap, head updates on in-app navigation and language switch, search dialog + Esc + focus, `/` key, dates → availability badges → booking with dates, Chinese search + opened result counted, admin SEO cards + rebuild + live redirect, 390 px) and the Phase 9 (20), 10 (9), 11 (12) and 12 (16) checks again; zero console / CSP errors. The browser run caught that Esc in the search field only cleared the text; fixed (one Esc closes). Not run: ESLint, `vite build`, real `@types/react`, Google Search Console / Rich Results tests against a public URL (needs the production domain).
- Phase 14: 469 tests pass (49 new: consent cookie format / versions / Meta browser-id format; GA4 + Pixel event mapping covers every event of §43–44, Purchase = Booking ID / total / THB, shared Lead / Purchase event ids, no phone / e-mail / query strings; CSP per tracker on pages, never on admin; public site tracking IDs + banner (own-language text, Thai policy fallback, banner off); marketing validation, CAPI token guard, Pixel secret vs settings mismatch, no token in audits / API; Settings → Privacy permissions, validation (days, languages, sizes, unknown fields, version not settable), ask-again version bump, audit keeps policy length only, policy page 404 → 200 with metadata, sitemap, canonical; attribution with no / analytics-only / marketing / old-version consent, same-origin source URL only; Lead in the booking batch; Purchase on staff payment and on auto-verified slip, never without consent or for unpaid bookings; CAPI delivery payload (hashed id, browser ids, THB, order id, token only in the body, no name / phone / e-mail), test event code, retry 503 / network with backoff, 4xx failure with token scrubbed, skips (CAPI off, token missing, expired), retention 8 / 90 days, SENT final trigger; admin log / test-event permissions + audit; GA4 Data API: not connected, signed RS256 JWT verified with the public key, batchRunReports date range, cache, error back-off, broken key; rate limits: groups, 429 + Retry-After + one security event, per-IP keys, other IPs unaffected, per-group bindings, fail-open; client: banner / dialog markup, footer links, stored-choice expiry, cookie attributes, tracker runtime (nothing before consent, GA4 consent mode + clean page view, Pixel without auto events, shared event ids, purchase once, withdrawal deletes cookies and stops sending, admin suspension), contact links; dictionary parity); worker (`--noUnusedLocals`), client (React type shim) and test typecheck clean; 31/31 Phase 14 browser checks over HTTPS with the tracker scripts stubbed at the network layer (admin marketing + privacy pages, first visit sends nothing, keyboard: skip link → banner, dialog focus containment, Esc, focus return; refuse; analytics only from the footer; accept all → full booking with GA4 / Pixel funnel and no personal data; cron → fake Graph API Lead with `_fbp` and hashed id; staff payment → Purchase; guest lookup → browser Purchase once; admin CAPI log + dashboard GA4 numbers; ask everyone again; privacy page TH + EN fallback; accessibility audit of 9 public + 4 admin pages + banner + dialog; focus rings; reduced motion; 390 px; admin never loads trackers; zero console / CSP errors) and the Phase 9 (20), 10 (9), 11 (12), 12 (16) and 13 (10) checks again. The browser run found three real issues, all fixed: the desktop floating booking button covered the new footer "Cookie settings" link (footer now keeps clear of floating buttons), focus was lost after closing the cookie dialog from the banner (banner stays mounted; focus returns), and a tracked admin page view could be replayed on return to the site (tracking suspended before pages run). Not run: ESLint, `vite build`, real `@types/react`, real GA4 / Meta endpoints (needs real IDs and tokens; Graph API v23.0 and GA4 Data API v1beta request formats checked against the documentation, responses faked), Workers Rate Limiting on Cloudflare (bindings faked; local dev has none).
- Phase 15: 523 tests pass (54 new: route security matrix 18 — all 150 routes from the router (119 admin), ~6,000 requests; business invariants 4 — simulation + snapshots; i18n completeness 13; coverage gaps 19 incl. 10 deploy-order prefixes); coverage of `src/` by these tests: 88.4 % lines, 87.3 % branches, 92.8 % functions (Worker 92.5 % lines / 97.5 % functions; most uncovered "lines" are type declarations; the client is covered mainly by the browser suites); worker (`--noUnusedLocals --noUnusedParameters --noImplicitReturns`), client (React type shim) and test typecheck clean; static checks clean (35 reviewed SQL fragments, 64 uses); browser suites moved into the repo and run through `npm run test:e2e`: Phase 9 (20), 10 (9), 11 (12), 12 (16), 13 (10), 14 (31) and the new responsive sweep (12) — 110/110, zero console / CSP errors. Found and fixed: **44 admin endpoints read and validated the request before checking the permission** (an account without access got 422 / 415 with field details instead of 403; nothing was ever changed) — now a route-level permission gate runs first and the services still check the exact permission; admin text-style buttons ("Sign out") were 23 px high (WCAG 2.2 target size) → 24 px minimum; the report chart's 31 daily axis labels overlapped on phones → short labels, at most ~8; the dev-only reset-link log is structured JSON. Not run: ESLint, `vite build` and real `@types/react` (registry offline; client bundled with esbuild for the browser suites), the CI workflow itself, real Cloudflare D1 (concurrency is simulated in SQLite with D1's batch semantics; D1 serialises writes per database).
- Phase 16: 554 tests pass (31 new: monitoring 15 — heartbeat per cron run, stale cron → 503 and recovery, a failing task does not stop the others and is logged, retention, API 500 logged without query / PII, 4xx not logged, error-storm cap, degraded page logged, safe before migration 0020, `system.view` for SUPER_ADMIN / MANAGER / overrides only, readiness checks with secrets never in the response, configured site all green; preflight / backup / smoke scripts 12 — the repository config fails exactly on the three owner values, 15 risky-config cases, migrations, secret files in Git, `wrangler secret list` parsing, smoke test against the real app in production mode incl. sign-in + sign-out and five classic deploy mistakes; canonical host 2; deploy-order prefix 0020; new dictionary in the i18n completeness test). Coverage (`npm run test:coverage`): 97.6 % lines, 88.0 % branches, 93.6 % functions (Worker 99.0 % lines) — this Node run no longer reports type-only lines as uncovered, so compare branches / functions with Phase 15 (87.3 % / 92.8 %). Worker, client (React type shim) and test + scripts typecheck clean; static checks clean. Browser suites 120/120: Phases 9 (20), 10 (9), 11 (12), 12 (16), 13 (10), 14 (31), the new Phase 16 suite (10: health before / after the first cron, `npm run smoke` against a production-mode server with 0 errors, System status in three languages, accessibility + focus, mobile, viewer refused, production robots / indexing) and responsive (12); zero console / CSP errors. Found and fixed: an error in the hold-expiry or camping-drift step of the cron stopped the search / CAPI / LINE steps after it (every step is now isolated, logged and reported in the heartbeat); `/api/health` only pinged the database (now also schema version and cron freshness); the apex / `workers.dev` host served a duplicate site (now 301 to `APP_BASE_URL`); stale CSP comment in `public/_headers`; System status check names used the column-header style and the value column was cut off on phones (seen on screenshots). Not run here: a real deploy and the `wrangler` commands (`d1 create`, `migrations apply --remote`, `d1 export`, `secret list`) — no Cloudflare account or network access; ESLint, `vite build`, real `@types/react` (registry offline); real LINE / Meta / Google APIs (fakes only).

---

## B. Original Specification (verbatim)

คุณคือ Senior Full-Stack Engineer, Cloudflare Architect, Database Engineer, Security Engineer, UI/UX Designer และ QA Engineer

หน้าที่ของคุณคือสร้างระบบเว็บไซต์จองที่พักและระบบบริหารหลังบ้านแบบ Production-ready ตาม Specification นี้

---

### 1. กฎสำคัญในการทำงาน

ก่อนเริ่มเขียน Code ให้:

1. อ่าน `MASTER_SPEC.md` ทั้งหมด
2. ตรวจสอบ Repository ปัจจุบันทั้งหมด
3. ตรวจสอบโครงสร้างไฟล์ที่มีอยู่
4. ตรวจสอบ package.json
5. ตรวจสอบ configuration
6. ตรวจสอบ Cloudflare configuration
7. ตรวจสอบ Git status
8. ตรวจสอบ Database migrations ที่มีอยู่
9. ตรวจสอบว่า Feature ใดมีอยู่แล้ว
10. ห้ามสร้างระบบซ้ำโดยไม่จำเป็น

ถ้ายังไม่มี `MASTER_SPEC.md` ให้สร้างจาก Specification นี้

---

### 2. ห้ามทำทั้งหมดในครั้งเดียว

ให้พัฒนาเป็น Phase

```text
PHASE 1
PHASE 2
PHASE 3
...
PHASE 16
```

เมื่อทำ Phase ปัจจุบันเสร็จ:

1. Run tests
2. Fix errors
3. Run typecheck
4. Run lint
5. Security review
6. ตรวจ Migration
7. ตรวจ Regression
8. สรุปสิ่งที่ทำ
9. แสดงไฟล์ที่เปลี่ยน
10. STOP

ห้ามเริ่ม Phase ถัดไปจนกว่าผู้ใช้จะพิมพ์:

```text
NEXT PHASE
```

---

### 3. Technology Stack

Frontend:

```text
React
TypeScript
Responsive UI
Mobile-first
```

Backend:

```text
Cloudflare Workers
```

Database:

```text
Cloudflare D1
SQLite compatible
```

Storage:

```text
Cloudflare R2
```

Version Control:

```text
GitHub
```

Development:

```text
Claude Code
```

Domain:

```text
Custom Domain
```

Integrations:

```text
LINE Official Account
LINE Messaging API
GA4
Meta Pixel
Meta Conversions API
Google Search Console
```

---

### 4. Architecture

ใช้ Architecture:

```text
Frontend
   ↓
API
   ↓
Authentication / Authorization
   ↓
Controller
   ↓
Service Layer
   ↓
Repository Layer
   ↓
Cloudflare D1
```

ไฟล์:

```text
Frontend
   ↓
Upload API
   ↓
Cloudflare R2
```

Backend เป็น Source of Truth สำหรับ Business Logic

D1 เป็น Source of Truth สำหรับ:

* Booking
* Payment
* Revenue
* Inventory
* Food Capacity

Search Index เป็น Optimization เท่านั้น

ห้ามใช้ Search Index เป็น Source of Truth

---

### 5. Languages

รองรับ 3 ภาษา:

```text
th
en
zh-CN
```

Default:

```text
th
```

Routes:

```text
/th/
/en/
/zh-cn/
```

Main menu:

```text
Home
Gallery
จองที่พัก
ประวัติความเป็นมา
```

Admin UI รองรับ 3 ภาษาเช่นกัน

---

### 6. Public Website

สร้าง:

```text
Home
Gallery
Booking
History
Accommodation Detail
Food
Search
```

Routes:

```text
/th/
/th/gallery
/th/booking
/th/history

/en/
/en/gallery
/en/booking
/en/history

/zh-cn/
/zh-cn/gallery
/zh-cn/booking
/zh-cn/history
```

---

### 7. Header

Desktop:

```text
Logo
Home
Gallery
จองที่พัก
ประวัติความเป็นมา
Language
```

Mobile:

```text
Logo
Hamburger
```

Logo ต้องโหลดจาก:

```text
D1 + R2
```

ห้าม Hard-code Logo

---

### 8. HOME

Home ประกอบด้วย:

```text
Header
Hero Slideshow
Introduction
Accommodation Highlights
Gallery Preview
History Preview
Food Preview
Booking CTA
Location
Contact
Footer
```

ทุก Content ต้อง Dynamic จาก D1/R2

ห้าม Hard-code รูปภาพและ Content สำคัญ

---

### 9. HOME HERO SLIDESHOW

Admin สามารถ:

```text
Add
Edit
Delete
Reorder
Publish
Unpublish
Schedule
```

แต่ละ Slide:

```text
Desktop Image
Mobile Image
Title
Subtitle
Description
Button 1
Button 2
Overlay
Overlay Opacity
Position
Start Date
End Date
Status
```

รองรับ:

```text
TH
EN
ZH-CN
```

สถานะ:

```text
DRAFT
PUBLISHED
SCHEDULED
EXPIRED
INACTIVE
```

Public:

* Auto Play
* 5 seconds
* Prev/Next
* Swipe
* Keyboard
* Pause
* Reduced Motion
* Lazy Load
* Preload First Image

---

### 10. GALLERY

Gallery ต้องเป็นระบบ Dynamic CMS

Admin Upload:

```text
Admin
 ↓
R2
 ↓
D1 Metadata
 ↓
Preview
 ↓
Publish
 ↓
Public Gallery
```

Public Gallery:

```text
Gallery Title
Category Filter
Modern Image Grid
Masonry / Justified / Bento
Lightbox
```

Responsive:

```text
Mobile: 1–2 columns
Tablet: 2–3 columns
Desktop: 3–5 columns
```

ต้องมี:

* Lazy Loading
* Responsive Images
* WebP/AVIF หากรองรับ
* Thumbnail
* Lightbox
* Caption
* Alt Text
* Prev/Next
* Mobile Swipe
* Keyboard
* Skeleton
* Empty State

Admin สามารถ:

```text
Upload
Edit
Delete
Reorder
Publish
Unpublish
Create Category
Edit Category
Delete Category
```

Database:

```text
gallery_categories
gallery_category_translations
gallery_images
gallery_image_translations
```

เฉพาะ `PUBLISHED` เท่านั้นที่แสดง Public

---

### 11. HISTORY — ประวัติความเป็นมา

Public:

```text
/th/history
/en/history
/zh-cn/history
```

Admin:

```text
Content
 └ History
```

สามารถเพิ่ม:

```text
Hero
Introduction
Story
Image + Text
Timeline
Gallery
Quote
CTA
```

Admin สามารถ:

```text
เพิ่ม
แก้ไข
ลบ
เรียงลำดับ
Publish
Unpublish
Upload Image
```

รองรับ:

```text
TH
EN
ZH-CN
```

Timeline:

```text
Year
Title
Description
Image
Sort Order
Status
```

Database:

```text
history_sections
history_translations
history_timeline
history_timeline_translations
```

ห้าม Hard-code History Content

---

### 12. BOOKING

เมนู:

```text
จองที่พัก
Booking
立即预订
```

ระบบต้องรองรับ:

### 1. บ้านพัก

แต่ละบ้านเป็น Inventory แยกกัน

ตัวอย่าง:

```text
House 01 — บ้านซากุระ
House 02 — บ้านชมดาว
```

ลูกค้าต้องเลือกบ้านที่ต้องการโดยตรง

ข้อมูล:

```text
Unit ID
Name
Description
Price
Capacity
Status
Amenities
Images
Cover
SEO
Translations
```

---

### 2. VIP Tent

แต่ละ VIP เป็น Inventory แยกกัน

ตัวอย่าง:

```text
VIP-01
VIP-02
VIP-03
```

แต่ละ VIP มี:

```text
ราคา
ความจุ
รายละเอียด
สิ่งอำนวยความสะดวก
รูปภาพ
สถานะ
SEO
Translation
```

---

### 3. นำเต็นท์มาเอง

ใช้ Shared Capacity

ตัวอย่าง:

```text
Maximum = 30 tents/night
```

ถ้ามี:

```text
A = 3
B = 5
```

เหลือ:

```text
22
```

ต้องตรวจ Capacity ทุกคืน

---

### 13. BOOKING FLOW

Flow:

```text
1. Language
2. Check-in
3. Check-out
4. Accommodation Type
5. Select House/VIP หรือ Own Tent
6. Guests
7. Tent Quantity
8. Food
9. Customer Information
10. Review
11. Confirm
12. Booking ID
13. Payment Account
14. QR
15. Upload Slip
16. Verification
17. LINE Notification
```

---

### 14. BOOKING ID

รูปแบบ:

```text
BK-YYYYMMDD-XXXX
```

ต้อง Unique

Public Lookup ต้องใช้:

```text
Booking ID
+
Phone
```

ห้ามเปิดข้อมูล Booking ด้วย Booking ID อย่างเดียว

---

### 15. MULTI-NIGHT

```text
nights = checkout - checkin
```

ตัวอย่าง:

```text
10–13 Jan = 3 nights
```

ตรวจ Availability ทุกคืน:

```text
10
11
12
```

Check-out ไม่ถือเป็น Stay Night

---

### 16. DOUBLE BOOKING

ห้ามเกิด Double Booking

ต้องป้องกันทั้ง:

```text
Application
+
Database
```

ใช้ Transaction / Constraint / Atomic Operation ตามความเหมาะสม

ห้ามพึ่ง Frontend อย่างเดียว

---

### 17. PRICE SNAPSHOT

เมื่อ Booking ถูกสร้าง ต้องเก็บ Snapshot:

```text
unit_id
unit_name_snapshot
unit_type
price_snapshot
pricing_type
quantity
number_of_nights
adult_count
child_count
subtotal
discount
total
```

หาก Admin เปลี่ยนราคาในอนาคต:

Booking เก่าต้องไม่เปลี่ยนราคา

---

### 18. CAMPING PRICE

Own Tent:

```text
Price per adult/person/night
```

Children:

```text
Under 12 = Free
```

ตัวอย่าง:

```text
2 tents
5 adults
2 children
2 nights
250 THB
```

Total:

```text
5 × 2 × 250
= 2,500 THB
```

จำนวนเต็นท์ใช้สำหรับ Capacity

---

### 19. FOOD

Food Module เชื่อมกับ Booking

Categories:

```text
Breakfast
Dinner
BBQ
Other
```

อนาคต:

```text
Lunch
Drinks
Snack
```

รองรับ:

```text
Included Meal
Extra Food
```

---

### 20. INCLUDED MEALS

ตัวอย่าง:

```text
House Sakura
Breakfast included
2 persons/night
```

ถ้ามี 4 คน:

```text
2 Free
2 Extra Charge
```

ห้ามคิดเงินซ้ำ

ต้อง Snapshot Included Meal ตอน Booking

---

### 21. EXTRA FOOD

ตัวอย่าง:

```text
Breakfast A = 150/person
Breakfast B = 180/person
Dinner A = 250/person
BBQ = 399/set
```

Pricing:

```text
PER_PERSON
PER_SET
PER_ITEM
PER_NIGHT
```

Child Pricing:

```text
FREE
FULL
HALF
SPECIAL_PRICE
```

---

### 22. FOOD CAPACITY

รองรับ Daily Capacity

ตัวอย่าง:

```text
Dinner
Maximum = 50
Used = 48
New Request = 5
```

ต้อง Reject หรือแจ้งจำนวนที่เหลือ

ห้ามเกิน Capacity

---

### 23. FOOD DEADLINE

Admin ตั้ง Deadline ได้

เช่น:

```text
Dinner = 1 day ahead
Breakfast = before 18:00 previous day
```

หลัง Cutoff:

```text
Unavailable
```

---

### 24. FOOD ORDER STATUS

```text
PENDING
CONFIRMED
PREPARING
READY
SERVED
CANCELLED
```

---

### 25. PAYMENT

Admin สามารถตั้งบัญชีรับเงินหลายบัญชี:

```text
payment_account_id
bank_name
account_name
account_number
promptpay_number
qr_image
status
is_primary
```

Booking ต้อง Snapshot:

```text
bank_name_snapshot
account_name_snapshot
account_number_snapshot
promptpay_number_snapshot
payment_qr_snapshot
```

---

### 26. PAYMENT STATUS

```text
UNPAID
PENDING_VERIFICATION
VERIFIED
PAID
REJECTED
REFUNDED
```

---

### 27. SLIP VERIFICATION

รองรับ:

```text
Manual Verification
Auto Verification
```

Auto Verification ต้องใช้ Transaction/Slip Verification Service จริง

ห้ามใช้ OCR อย่างเดียวในการยืนยันเงิน

ตรวจ:

```text
Amount
Date
Time
Sender Bank
Receiver Bank
Reference
Destination Account
Duplicate Slip
Duplicate Transaction
```

Slip อยู่ใน Private R2

---

### 28. ADMIN LOGIN

สร้าง:

```text
/admin/login
```

หรือ:

```text
/th/admin/login
/en/admin/login
/zh-cn/admin/login
```

Login:

```text
Email/Username
Password
Remember Me
Show Password
Forgot Password
```

ใช้:

```text
Secure Session
HttpOnly Cookie
Secure
SameSite
Expiration
Session Rotation
Session Revocation
```

Password ต้อง Hash

ห้ามเก็บ Password Plain Text

---

### 29. ADMIN ROLES

```text
SUPER_ADMIN
MANAGER
BOOKING_ADMIN
FINANCE_ADMIN
CONTENT_ADMIN
VIEWER
```

---

### 30. SUPER_ADMIN USER MANAGEMENT

SUPER_ADMIN สามารถ:

```text
View User
Create User
Edit User
Change Role
Change Permission
Reset Password
Suspend User
Activate User
Force Logout
Delete User
Restore User
```

Admin Page:

```text
/admin/users
```

---

### 31. USER MANAGEMENT PERMISSIONS

```text
users.view
users.create
users.edit
users.delete
users.manage_roles
users.manage_permissions
users.reset_password
users.suspend
users.force_logout
users.restore
```

---

### 32. SOFT DELETE USER

ห้าม Hard Delete User โดย Default

ใช้:

```text
deleted_at
deleted_by
status = DELETED
```

เมื่อ Delete:

```text
Login ไม่ได้
Session ถูก Revoke
ไม่แสดงใน Active User
Booking ไม่ถูกลบ
Payment ไม่ถูกลบ
Food Order ไม่ถูกลบ
Audit Log ไม่ถูกลบ
```

สามารถ Restore ได้

---

### 33. SUPER_ADMIN SECURITY RULES

ห้าม:

```text
SUPER_ADMIN ลบตัวเอง
```

ห้าม:

```text
ลบ SUPER_ADMIN คนสุดท้าย
```

ห้าม:

```text
ลด Role ของ SUPER_ADMIN คนสุดท้าย
```

ต้องมี SUPER_ADMIN อย่างน้อย 1 คนเสมอ

---

### 34. AUTHORIZATION

สร้าง:

```text
AuthorizationService
UserManagementService
```

ห้ามกระจาย:

```text
if role === SUPER_ADMIN
```

ไปทั่ว Code

ใช้:

```text
authorization.requirePermission(
    currentUser,
    "users.delete"
)
```

Backend เป็น Authority

Frontend ซ่อน Menu ได้ แต่ไม่ใช่ Security

---

### 35. ADMIN SIDEBAR

```text
Dashboard

การจอง
ปฏิทิน

ที่พัก
 ├ บ้านพัก
 ├ VIP Tent
 └ Camping

อาหาร
 ├ รายการอาหาร
 ├ คำสั่งอาหาร
 └ รายงานครัว

การเงิน
 ├ Payment
 ├ Slip
 └ Receiving Accounts

รายงาน

เว็บไซต์
 ├ Home
 ├ Gallery
 ├ ประวัติความเป็นมา
 └ SEO

การตลาด
 ├ GA4
 ├ Meta Pixel
 └ CAPI

ตั้งค่า
 ├ Website
 ├ Branding
 ├ Theme
 ├ Booking CTA
 ├ LINE
 └ Privacy

ผู้ดูแลระบบ
 ├ Users
 ├ Roles
 ├ Permissions
 └ Security Events

Audit Logs
```

แสดง Menu ตาม Permission

---

### 36. BRANDING

Admin สามารถเปลี่ยน:

```text
Main Logo
Mobile Logo
Favicon
Login Logo
```

โดยไม่ต้อง Deploy ใหม่

เก็บไฟล์ใน:

```text
R2
```

Metadata ใน:

```text
D1
```

---

### 37. WEBSITE CUSTOMIZATION

Admin สามารถเปลี่ยน:

```text
Website Name
Tagline
Colors
Fonts
Typography
Buttons
Cards
Inputs
Radius
Shadows
Header
Footer
Layout
```

ใช้ CSS Variables:

```text
--color-primary
--color-secondary
--color-accent
--color-background
--color-surface
--color-text
--color-heading
--color-muted
--color-border
--color-success
--color-warning
--color-error
--color-info
--font-body
--font-heading
--font-button
--radius-sm
--radius-md
--radius-lg
--radius-xl
--shadow-sm
--shadow-md
--shadow-lg
```

---

### 38. THEME PRESETS

รองรับ:

```text
Default
Nature
Forest
Mountain
Sakura
Luxury
Minimal
Warm
Modern
Dark
```

ต้อง Preview ก่อน Publish

รองรับ:

```text
Draft
Preview
Publish
Rollback
Version History
```

---

### 39. FLOATING BOOKING CTA

ทุก Public Page ให้มี Floating:

```text
จองที่พัก
Book Now
立即预订
```

ลอยตามการ Scroll

Desktop:

```text
Bottom Right
```

Mobile:

```text
Bottom
```

ต้องไม่บัง:

```text
Cookie Banner
LINE Button
Form
Important Content
```

รองรับ Safe Area สำหรับ iPhone

Admin สามารถตั้ง:

```text
Enabled
Label
Icon
Position
Size
Color
Animation
Mobile
Desktop
Closeable
Pages
```

Default:

```text
คลิก → /{lang}/booking
```

---

### 40. SEARCH

Global Search:

```text
ค้นหาที่พัก อาหาร หรือกิจกรรม...
```

ค้นหา:

```text
House
VIP
Camping
Food
Activity
Promotion
FAQ
History
Gallery
Article
```

รองรับ TH/EN/ZH-CN

ถ้ามีวันที่:

```text
Search
 ↓
Availability Service
```

ต้องตรวจ Availability จริง

---

### 41. SEARCH INDEX

```text
search_index
```

เป็น Optimization เท่านั้น

ห้ามใช้แทน D1 Source of Truth

สามารถเปลี่ยนภายหลังเป็น:

```text
Meilisearch
Typesense
Algolia
```

โดยไม่ต้องแก้ Business Logic

---

### 42. SEO

ทุก Public Page รองรับ:

```text
SEO Title
Meta Description
Canonical
OG Title
OG Description
OG Image
Robots
Schema
```

รองรับ 3 ภาษา

สร้าง:

```text
/sitemap.xml
/robots.txt
```

Exclude:

```text
/admin
/api
/customer
/payment
private booking
```

รองรับ:

```text
hreflang
canonical
structured data
```

---

### 43. GA4

Admin ตั้ง:

```text
GA4 Measurement ID
Enable/Disable
```

Events:

```text
page_view
view_item
search
select_item
begin_checkout
add_payment_info
purchase
generate_lead
view_accommodation
select_accommodation
begin_booking
select_food
payment_submitted
booking_confirmed
view_food
add_food
```

Purchase:

```text
transaction_id = Booking ID
value = total
currency = THB
```

ห้ามส่ง:

```text
Name
Phone
Bank Account
Slip
Sensitive PII
```

---

### 44. META PIXEL

Admin ตั้ง:

```text
Pixel ID
Enabled
```

Events:

```text
PageView
ViewContent
Search
InitiateCheckout
AddToCart
AddPaymentInfo
Purchase
Lead
Contact
```

---

### 45. META CAPI

ใช้ Server-side

```text
Customer
 ↓
Website
 ↓
Cloudflare Worker
 ↓
Meta CAPI
```

Secrets:

```text
META_PIXEL_ID
META_CAPI_ACCESS_TOKEN
META_TEST_EVENT_CODE
```

เก็บใน Cloudflare Secrets

ห้าม:

```text
Git
Frontend
D1
Logs
```

CAPI + Pixel ต้องใช้ `event_id` เดียวกันเพื่อ Deduplication

Purchase ต้องเกิดเฉพาะ Payment State ที่ระบบกำหนดว่า Confirmed แล้ว

---

### 46. COOKIE CONSENT

Categories:

```text
Necessary
Analytics
Marketing
```

Buttons:

```text
ยอมรับทั้งหมด
ตั้งค่าคุกกี้
ปฏิเสธที่ไม่จำเป็น
```

Analytics / Marketing ต้องเคารพ Consent Policy

---

### 47. LINE

รองรับ:

```text
LINE Official Account
LINE Messaging API
```

Tomorrow Check-in:

Default:

```text
1 day before
18:00
```

Admin ปรับได้

Message:

```text
Booking ID
Customer
Check-in
Check-out
House/VIP
Camping
Guests
Food
Payment Status
```

รองรับ TH/EN/ZH-CN

ต้องมี:

```text
Idempotency
Retry
Notification Log
```

---

### 48. ADMIN DASHBOARD

Dashboard:

```text
Today Check-in
Today Check-out
Bookings
Revenue
Pending Payment
Available Houses
Available VIP
Camping Used
Camping Remaining
Food Revenue
Total Revenue
```

Analytics:

```text
Visitors
Page Views
Searches
Accommodation Views
Booking Started
Checkout Started
Payment Submitted
Confirmed Booking
Revenue
Food Orders
```

Analytics ไม่ใช่ Financial Source of Truth

---

### 49. BOOKING CALENDAR

รองรับ:

```text
Day
Week
Month
Custom
```

แสดง:

```text
Booking ID
Customer
House/VIP
Camping
Guests
Check-in
Check-out
Payment Status
Revenue
```

Multi-night ต้องแสดงทุก Stay Date

---

### 50. REPORTS

รายงาน:

```text
Booking
Revenue
Accommodation
Camping
Food
Kitchen
Payment
```

ช่วงเวลา:

```text
Daily
Monthly
Yearly
Custom
```

Export:

```text
Excel
PDF
```

---

### 51. AUDIT LOG

ทุก Important Admin Action ต้อง Audit

ตัวอย่าง:

```text
Price Change
Food Change
Booking Change
Payment Verification
User Change
Role Change
Permission Change
Logo Change
Theme Change
SEO Change
Gallery Change
History Change
Home Change
Marketing Change
```

ข้อมูล:

```text
user_id
action
module
record_id
old_value
new_value
IP
User Agent
timestamp
```

ห้าม Log:

```text
Password
Token
Secret
CAPI Token
```

---

### 52. DATABASE TABLES

Core:

```text
users
roles
permissions
role_permissions
user_roles
user_permissions
sessions
password_reset_tokens
security_events

accommodation_units
accommodation_translations
accommodation_images
accommodation_amenities

camping_settings

bookings
booking_items
booking_guests
booking_price_snapshots

pricing_settings
price_history

payments
slip_verifications

receiving_accounts
payment_account_snapshots

notification_logs
audit_logs
```

Food:

```text
food_categories
food_options
food_option_translations
food_images
included_meals
booking_food_items
booking_included_meals
food_daily_capacity
food_orders
```

Search:

```text
search_index
search_history
search_analytics
```

Branding:

```text
branding_settings
```

Theme:

```text
site_settings
theme_settings
theme_versions
font_settings
```

Marketing:

```text
marketing_settings
```

SEO:

```text
seo_settings
seo_redirects
```

Content:

```text
home_sections
home_section_translations
home_slides
home_slide_translations
home_versions

gallery_categories
gallery_category_translations
gallery_images
gallery_image_translations

history_sections
history_translations
history_timeline
history_timeline_translations
```

Booking CTA:

```text
booking_cta_settings
```

---

### 53. DATABASE RULES

สร้าง Index สำหรับ:

```text
booking_id
check_in
check_out
unit_id
booking_status
payment_status
customer_phone

search_index
entity_type
entity_id
language_code
is_active

gallery
category
status
sort_order

home_slides
status
start_at
end_at
sort_order
```

สร้าง Migration ทุกครั้งที่ Schema เปลี่ยน

ห้ามแก้ Production Database โดยตรงโดยไม่มี Migration

---

### 54. R2

R2 ใช้เก็บ:

```text
Accommodation Images
Food Images
Logo
Favicon
Fonts
Home Slides
Gallery
History
Payment Slips
```

Public Image และ Private File ต้องแยก Access Policy

Payment Slip ต้อง Private

---

### 55. IMAGE SECURITY

ตรวจ:

```text
MIME Type
File Extension
File Size
Image Dimensions
```

ป้องกัน:

```text
Malicious Upload
Path Traversal
Unsafe SVG
Executable File
XSS
```

แนะนำ:

```text
JPG
JPEG
PNG
WEBP
AVIF
```

ตาม Browser Support

---

### 56. IMAGE SEO

ทุก Public Image รองรับ:

```text
Alt
Title
Caption
```

รองรับ TH/EN/ZH-CN

---

### 57. ACCESSIBILITY

ต้องรองรับ:

```text
Keyboard
Screen Reader
Focus State
ARIA
Contrast
Reduced Motion
Alt Text
Semantic HTML
```

---

### 58. SECURITY

ต้องป้องกัน:

```text
SQL Injection
XSS
CSRF
IDOR
Authentication Bypass
Authorization Bypass
Privilege Escalation
Session Hijacking
Brute Force
Rate Limit Abuse
Mass Assignment
File Upload Attack
Booking Enumeration
PII Exposure
```

Backend เป็น Security Authority

---

### 59. API DESIGN

Public:

```text
GET /api/public/site
GET /api/public/home
GET /api/public/home/slides
GET /api/public/gallery
GET /api/public/gallery/categories
GET /api/public/history
GET /api/public/history/timeline
GET /api/search
```

Auth:

```text
POST /api/auth/login
POST /api/auth/logout
GET /api/auth/me
POST /api/auth/refresh
```

Admin:

```text
/api/admin/*
```

ทุก Protected API:

```text
Authentication
→ Authorization
→ Validation
→ Service
→ Repository
→ Database
```

---

### 60. PHASE DEVELOPMENT

#### PHASE 1 — Project Setup

สร้าง:

```text
React
TypeScript
Cloudflare Workers
D1
R2
GitHub
i18n
Responsive Layout
Header
Footer
```

STOP

---

#### PHASE 2 — Database

สร้าง Migration:

```text
Core
Booking
Food
Payment
Users
Auth
Branding
Theme
SEO
Marketing
Home
Gallery
History
Search
```

Seed Data สำหรับ Development เท่านั้น

STOP

---

#### PHASE 3 — Authentication

สร้าง:

```text
Login
Logout
Session
Forgot Password
RBAC
Authorization
User Management
SUPER_ADMIN
Soft Delete
Security Events
```

STOP

---

#### PHASE 4 — Accommodation

สร้าง:

```text
House
VIP
Camping
Images
Amenities
Translations
Availability
```

STOP

---

#### PHASE 5 — Booking

สร้าง:

```text
Booking Flow
Date
Guests
Inventory
Pricing
Food
Snapshots
Booking ID
Confirmation
```

STOP

---

#### PHASE 6 — Camping Capacity

สร้าง:

```text
Daily Capacity
Multi-night Capacity
Tent Quantity
Race Protection
```

STOP

---

#### PHASE 7 — Payment

สร้าง:

```text
Receiving Account
QR
Payment
Snapshot
Status
```

STOP

---

#### PHASE 8 — Slip Verification

สร้าง:

```text
Upload
Private R2
Manual Verification
Auto Verification Integration
Duplicate Protection
```

STOP

---

#### PHASE 9 — Admin Dashboard

สร้าง:

```text
Dashboard
Calendar
Bookings
Accommodation
Food
Payments
Users
Branding
Theme
Marketing
SEO
Home
Gallery
History
```

STOP

---

#### PHASE 10 — Reports

สร้าง:

```text
Revenue
Booking
Accommodation
Camping
Food
Kitchen
Excel
PDF
```

STOP

---

#### PHASE 11 — LINE

สร้าง:

```text
LINE OA
Messaging API
Check-in Notification
Food Notification
Payment Notification
Retry
Idempotency
Logs
```

STOP

---

#### PHASE 12 — R2 & Images

สร้าง:

```text
Accommodation Images
Food Images
Logo
Fonts
Home
Gallery
History
Compression
Responsive Images
Access Control
```

STOP

---

#### PHASE 13 — i18n & SEO

สร้าง:

```text
TH
EN
ZH-CN
hreflang
Canonical
Metadata
OG
Sitemap
Robots
Schema
Search Console
```

STOP

---

#### PHASE 14 — Security & Marketing

สร้าง:

```text
GA4
Meta Pixel
CAPI
Cookie Consent
Rate Limit
Security
Audit
Accessibility
```

STOP

---

#### PHASE 15 — Testing

ต้อง Test:

```text
Authentication
Authorization
User Management
Soft Delete
SUPER_ADMIN Rules
Booking
Double Booking
Camping Capacity
Multi-night
Food Capacity
Price Snapshot
Payment Snapshot
Slip
Search
i18n
LINE
Branding
Theme
Home
Gallery
History
Floating Booking CTA
GA4
Meta
SEO
Security
Responsive
Regression
```

STOP

---

#### PHASE 16 — Production

ตรวจ:

```text
Cloudflare Workers
D1
R2
Custom Domain
SSL
Secrets
LINE
GA4
Meta
Search Console
Sitemap
Robots
Backup
Monitoring
Error Logging
Security
Final Smoke Test
```

เมื่อเสร็จสมบูรณ์ให้รายงาน Production Readiness

---

### 61. CLAUDE CODE QUALITY RULES

ห้าม:

```text
Hard-coded Price
Hard-coded Permission
Hard-coded Logo
Hard-coded Website Name
Hard-coded Font
Hard-coded Theme
Hard-coded Tracking ID
Hard-coded Language
Hard-coded Booking Inventory
```

ห้ามใส่:

```text
Secrets
API Keys
Passwords
CAPI Token
LINE Secret
```

ใน Git

---

### 62. BUSINESS RULES

ต้องรักษา:

```text
Booking = Source of Truth
Payment = Source of Truth
Revenue = Source of Truth
Inventory = Source of Truth
Food Capacity = Source of Truth
```

ห้าม:

```text
Booking เกิน Capacity
Double Booking
Food เกิน Capacity
Camping เกิน Capacity
Price Booking เก่าเปลี่ยน
Payment Account Booking เก่าเปลี่ยน
Included Meal Booking เก่าเปลี่ยน
```

---

### 63. TESTING RULE

หลังแต่ละ Feature:

```text
Typecheck
Lint
Unit Test
Integration Test
API Test
Security Test
```

ก่อนจบ Phase:

```text
npm test
npm run typecheck
npm run lint
```

หาก Command แตกต่างจาก Repository ให้ใช้ Command ที่ถูกต้องตาม Project

ห้ามบอกว่า Test ผ่าน ถ้ายังไม่ได้ Run จริง

---

### 64. GIT RULES

ก่อนแก้ไข:

```text
git status
```

หลังแก้ไข:

```text
git diff
```

ตรวจ:

```text
git status
```

ห้ามลบข้อมูลหรือไฟล์สำคัญโดยไม่มีคำสั่ง

ห้ามทำ Destructive Migration โดยไม่แจ้ง

---

### 65. PRODUCTION SAFETY

ก่อน Migration ที่อาจทำลายข้อมูล:

ต้องแจ้ง:

```text
Migration นี้มีความเสี่ยง...
```

และเสนอ:

```text
Backup
Migration Plan
Rollback Plan
```

ห้าม Drop Table Production โดยพลการ

---

### 66. FINAL REQUIREMENT

ระบบสุดท้ายต้องมี:

```text
PUBLIC WEBSITE
+
BOOKING SYSTEM
+
FOOD SYSTEM
+
PAYMENT SYSTEM
+
ADMIN LOGIN
+
RBAC
+
SUPER_ADMIN USER MANAGEMENT
+
SOFT DELETE
+
DASHBOARD
+
REPORTS
+
LINE
+
GALLERY CMS
+
HISTORY CMS
+
HOME CMS
+
BRANDING
+
THEME CUSTOMIZATION
+
SEO
+
GA4
+
META PIXEL
+
META CAPI
+
SEARCH
+
MULTI-LANGUAGE
+
SECURITY
+
AUDIT LOG
+
RESPONSIVE UI
```

---

### 67. FIRST COMMAND

เมื่อได้รับ Prompt นี้ครั้งแรก:

อย่าเพิ่งสร้างทุกอย่าง

ให้ทำตามลำดับ:

```text
1. ตรวจ Repository
2. ตรวจ Project Structure
3. ตรวจ Existing Code
4. ตรวจ package.json
5. ตรวจ Cloudflare Config
6. ตรวจ D1 Migration
7. ตรวจ R2 Config
8. ตรวจ Git
9. สร้าง/ปรับ MASTER_SPEC.md
10. สรุป Architecture
11. สรุปสิ่งที่จะทำใน PHASE 1
12. Implement PHASE 1 เท่านั้น
13. Test
14. Fix
15. Security Review
16. สรุป
17. STOP
```

ห้ามข้าม Phase

ห้ามทำ Phase 2 จนกว่าผู้ใช้จะพิมพ์:

```text
NEXT PHASE
```

---

### 68. DEFINITION OF DONE

แต่ละ Feature จะถือว่าเสร็จเมื่อ:

```text
Code เสร็จ
Database Migration เสร็จ
API เสร็จ
UI เสร็จ
Validation เสร็จ
Permission เสร็จ
Security เสร็จ
Test เสร็จ
Responsive เสร็จ
Accessibility เสร็จ
Documentation เสร็จ
```

และต้องไม่มี:

```text
TypeScript Error
Lint Error
Failed Test
Known Security Issue
```

ที่เกี่ยวข้องกับ Phase นั้น

---

### START

เริ่มจากการตรวจสอบ Repository ปัจจุบัน

จากนั้นสร้างหรืออัปเดต:

```text
MASTER_SPEC.md
```

ห้าม Implement ทั้งระบบในครั้งเดียว

เริ่มเฉพาะ:

```text
PHASE 1
```

และเมื่อ PHASE 1 เสร็จแล้วให้หยุดรอคำสั่ง:

```text
NEXT PHASE
```
