# D1 migrations

| File | Contents |
|---|---|
| `0001_languages_auth_rbac.sql` | languages, users, roles, permissions, sessions, reset tokens, security events, audit log, SUPER_ADMIN guard triggers |
| `0002_media_assets.sql` | R2 object metadata (public/private bucket), image alt/title/caption per language |
| `0003_site_branding_theme_seo_marketing.sql` | site settings, branding, theme versions, fonts, marketing IDs, SEO, redirects, floating CTA |
| `0004_accommodation_camping_pricing.sql` | houses / VIP tents, translations, images, amenities, camping settings + nightly tent inventory, pricing rules, price history |
| `0005_bookings.sql` | bookings, items, night-locks (double-booking guard), guests, price snapshots |
| `0006_payments_notifications.sql` | receiving accounts, payment account snapshots, payments, slip verifications, LINE notification log |
| `0007_food.sql` | food categories/options, included meals, daily capacity, kitchen orders, booking food items |
| `0008_content_home_gallery_history.sql` | home sections, hero slides, home versions, gallery, history, timeline |
| `0009_search.sql` | search index (optimization only), search history, daily search analytics |
| `0010_rbac_reference_data.sql` | 6 system roles, permission catalogue, default grants |
| `0011_camping_capacity_override.sql` | `camping_night_inventory.is_override` (ADD COLUMN, non-destructive) |
| `0012_booking_flow.sql` | breakfast service-day offset, booking idempotency key + privacy timestamp, kitchen-order capacity ledger, `booking_settings` (hold time, limits) — ADD COLUMN / new table only |
| `0013_capacity_guards.sql` | triggers: own-tent booking requires camping enabled, unit booking requires ACTIVE unit; index for active own-tent items — no data change |
| `0014_payments.sql` | payments: reference, note, refund_reason (ADD COLUMN); triggers: frozen money fields, refund is final, no payment on cancelled/expired bookings — no data change |
| `0015_admin_dashboard.sql` | triggers: booking lifecycle (`BOOKING_STATUS_TRANSITION`), kitchen orders forward-only, published/archived theme versions frozen; indexes for dashboard, calendar and admin lists — no data change |
| `0016_line_notifications.sql` | LINE settings (singleton), staff recipients, one-time link codes (hashed), guest booking ↔ LINE links; trigger: a SENT notification is final; log index — new tables only, no data change |
| `0017_images_fonts.sql` | `media_assets.parent_asset_id` (responsive variants) and `food_options.image_asset_id` (ADD COLUMN), `custom_fonts`; triggers: variants must match their original, FONT ⇔ font file, font rows point at an active FONT file; indexes for media access checks — no data change |
| `0018_search_state.sql` | `search_index_state` (fingerprint of the content the search index was built from, row count, time) and an analytics index — new table only, no data change |
| `0019_privacy_marketing.sql` | `privacy_settings` (+ seeded row) and texts per language, `booking_marketing` (consent + browser ids, only with Marketing consent, erased after 8 days), `marketing_events` (Meta CAPI outbox, no personal data); trigger: a SENT event is final; `marketing_settings.ga4_property_id` (new nullable column) and `analytics_report_cache` (GA4 Data API numbers for the dashboard) — additive only, no data change |
| `0020_system_monitoring.sql` | `system_heartbeats` (last run of the cron and its tasks — `/api/health` reports a stopped cron), `error_events` (server errors without personal data, 30 days), permission `system.view` for SUPER_ADMIN and MANAGER — additive only |
| `0021_camping_tarp.sql` | camping add-on "tarp area": `camping_settings.tarp_enabled / tarp_price_per_night_satang / max_tarps_per_night` (ADD COLUMN with defaults: off, 0, 0), `camping_tarp_night_inventory` (nightly counter, CHECK no overselling), `booking_tarps` (per-booking price snapshot, money fields frozen); triggers: tarp only with own-tent camping and only while offered — additive only, no data change |
| `0022_d1_glob_limits.sql` | **table rebuild (announced)**: `bookings`, `home_slides`, `booking_cta_settings` re-created with the same columns, indexes and triggers; only three CHECKs rewritten (booking code, `#RRGGBB` colours) because D1 refuses LIKE/GLOB patterns over 50 bytes ("pattern too complex" — every booking insert failed). Production: all three tables were empty; rollback = D1 Time Travel |
| `0023_payment_channels_email.sql` | payment step: `payment_settings` (Auto / Manual slip approval, channels PromptPay / bank / QR / PayPal — seeded row), `payments.channel` (ADD COLUMN, nullable, frozen by trigger), `paypal_orders` (PayPal Checkout: claim → capture → settle; money fields frozen, CAPTURED final), `line_recipients.notify_booking` (ADD COLUMN, default on), e-mail: `email_settings` (seeded, off), `email_recipients`, `email_logs` (outbox, SENT final) — additive only, no data change |
| `0024_admin_menu.sql` | Administration → Menu: `admin_menu_hidden` (sidebar items hidden for everyone; empty = all shown) and the permission `settings.admin_menu` for SUPER_ADMIN — additive only |
| `0025_deposit.sql` | deposit plan: `accommodation_units.payment_mode` and `camping_settings.payment_mode` (`FULL` / `DEPOSIT_50`, ADD COLUMN default `FULL`), `bookings.deposit_satang` (amount asked online; NULL = full payment; frozen by trigger), trigger `trg_bookings_checkin_paid` (a deposit booking cannot be checked in while money is due) — additive only, no data change |
| `0026_multi_stay.sql` | several stays per booking: `booking_items.pay_later_satang` (part of a deposit stay left for check-in; backfilled for existing deposit bookings), `booking_items.cancelled_at` / `cancel_reason` (one stay cancelled by staff), `booking_food_items.booking_item_id` (included meals belong to their stay); triggers `trg_bookings_deposit_frozen` (deposit may change only together with the total) and `trg_bookings_checkin_paid` (money received counts what is left of a partly refunded payment) replaced — additive, one backfill of the new column |

## Commands

```bash
npm run db:migrate:local     # apply to local D1 (.wrangler/)
npm run db:seed:local        # DEV sample data — local only
npm run db:reset:local       # wipe local D1, migrate, seed
npm run db:migrate:remote    # production — take a backup first (below)
```

## Production rules (spec §53, §65)

- Never edit an applied migration. Every schema change is a **new** numbered file.
- Never change the production database without a migration file here.
- D1 refuses LIKE / GLOB patterns longer than **50 bytes** at run time (local SQLite does not): keep
  CHECK patterns short — `tests/db/schema.test.ts` fails on any longer pattern in the schema.
- Before any destructive migration (DROP, table rebuild, data rewrite): announce the risk,
  then back up and prepare a rollback:

  ```bash
  npx wrangler d1 export chomkhao-db --remote --output backup-$(date +%Y%m%d-%H%M).sql
  # D1 Time Travel can also restore to a point in time:
  npx wrangler d1 time-travel info chomkhao-db
  ```
- `seeds/dev.sql` is never applied remotely.
