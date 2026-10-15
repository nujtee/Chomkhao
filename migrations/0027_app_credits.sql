-- Migration 0027: app-usage credits (ค่าธรรมเนียมการใช้ App)
--
-- Every booking adds an app fee to the guest's bill: fee per unit (house / VIP tent / own tent) × units, the rate
-- set by Super Admin (credit_settings.fee_per_unit, default 20; 1 credit = 1 baht). The property pre-pays the fee
-- as credits; a booking HOLDS its fee in credits when it is made, the hold is CAPTURED (deducted) when the booking
-- is confirmed as paid, and RELEASED when it expires or is cancelled before payment. Not enough credit → the
-- booking is refused (CREDIT_INSUFFICIENT). Credits never expire.
--
-- The hold / capture / release run as triggers on `bookings`, so every way a booking is created, confirmed
-- (manual payment, slip auto / staff verify, PayPal, deposit), expires or is cancelled moves the credits in the
-- same transaction — no path can confirm a booking without deducting, or deduct twice.
--
-- Top-ups: back-office users send an amount + slip under a plan (STANDARD / PREMIUM, each with its own minimum);
-- Super Admin approves (or EasySlip does). The plan of the latest approved top-up is the property's plan: STANDARD
-- hides Reports, Marketing and Theme (permissions removed for everyone but SUPER_ADMIN, see rbac.repository.ts).
--
-- The whole system starts SWITCHED OFF (credit_settings.enabled = 0): no fee, no hold, no plan lock — bookings
-- work exactly as before until Super Admin has set the receiving account, topped up and switched it on.
--
-- DESTRUCTIVE (announced): `bookings` is rebuilt to add app_fee_units / app_fee_satang and to include the fee in
-- the subtotal CHECK (subtotal = accommodation + food + app fee). Same columns, indexes and triggers otherwise;
-- every existing row keeps its money (fee 0). Production chomkhao-db had 0 bookings when this was written.
-- Backup / rollback: D1 Time Travel to a point before this migration.
PRAGMA defer_foreign_keys = true;

-- ================================================================ bookings: + app fee (table rebuild)

DROP TRIGGER trg_booking_unit_nights_in_range;
DROP TRIGGER trg_payments_booking_live;

CREATE TABLE bookings__new (
  id                            TEXT PRIMARY KEY,
  booking_code                  TEXT NOT NULL UNIQUE
                                CHECK (length(booking_code) = 16 AND substr(booking_code, 1, 3) = 'BK-' AND substr(booking_code, 12, 1) = '-'
                                       AND substr(booking_code, 4, 8) NOT GLOB '*[^0-9]*' AND substr(booking_code, 13, 4) NOT GLOB '*[^A-Z0-9]*'),
  language_code                 TEXT NOT NULL REFERENCES languages (code),
  source                        TEXT NOT NULL DEFAULT 'WEB' CHECK (source IN ('WEB', 'ADMIN', 'PHONE', 'LINE', 'WALK_IN')),
  check_in                      TEXT NOT NULL CHECK (date(check_in) = check_in),
  check_out                     TEXT NOT NULL CHECK (date(check_out) = check_out),
  nights                        INTEGER NOT NULL CHECK (nights >= 1),
  adults                        INTEGER NOT NULL CHECK (adults >= 1),
  children                      INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
  customer_name                 TEXT NOT NULL CHECK (length(trim(customer_name)) >= 1),
  customer_phone                TEXT NOT NULL,
  customer_phone_normalized     TEXT NOT NULL CHECK (customer_phone_normalized NOT GLOB '*[^0-9+]*'
                                                    AND length(customer_phone_normalized) BETWEEN 6 AND 16),
  customer_email                TEXT,
  customer_line_id              TEXT,
  customer_note                 TEXT,
  admin_note                    TEXT,
  booking_status                TEXT NOT NULL DEFAULT 'PENDING'
                                CHECK (booking_status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT',
                                                          'CANCELLED', 'EXPIRED', 'NO_SHOW')),
  payment_status                TEXT NOT NULL DEFAULT 'UNPAID'
                                CHECK (payment_status IN ('UNPAID', 'PENDING_VERIFICATION', 'VERIFIED', 'PAID',
                                                          'REJECTED', 'REFUNDED')),
  accommodation_subtotal_satang INTEGER NOT NULL CHECK (accommodation_subtotal_satang >= 0),
  food_subtotal_satang          INTEGER NOT NULL DEFAULT 0 CHECK (food_subtotal_satang >= 0),
  subtotal_satang               INTEGER NOT NULL CHECK (subtotal_satang >= 0),
  discount_satang               INTEGER NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),
  total_satang                  INTEGER NOT NULL CHECK (total_satang >= 0),
  currency                      TEXT NOT NULL DEFAULT 'THB' CHECK (length(currency) = 3),
  expires_at                    TEXT,
  confirmed_at                  TEXT,
  cancelled_at                  TEXT,
  cancelled_by                  TEXT REFERENCES users (id),
  cancel_reason                 TEXT,
  created_by                    TEXT REFERENCES users (id),
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  idempotency_key               TEXT
                                CHECK (idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 16 AND 64 AND idempotency_key NOT GLOB '*[^A-Za-z0-9-]*')),
  privacy_accepted_at           TEXT,
  deposit_satang                INTEGER
                                CHECK (deposit_satang IS NULL OR (deposit_satang > 0 AND deposit_satang < total_satang)),
  -- App fee (this migration): units charged (houses + VIP tents + own tents) and the fee in satang, frozen at
  -- booking time (only an unpaid stay cancelled by staff lowers it — see trg_bookings_app_fee_change).
  app_fee_units                 INTEGER NOT NULL DEFAULT 0 CHECK (app_fee_units >= 0),
  app_fee_satang                INTEGER NOT NULL DEFAULT 0 CHECK (app_fee_satang >= 0 AND app_fee_satang % 100 = 0),
  CHECK (check_out > check_in),
  CHECK (nights = CAST(julianday(check_out) - julianday(check_in) AS INTEGER)),
  CHECK (subtotal_satang = accommodation_subtotal_satang + food_subtotal_satang + app_fee_satang),
  CHECK (discount_satang <= subtotal_satang),
  CHECK (total_satang = subtotal_satang - discount_satang),
  CHECK ((app_fee_satang = 0) = (app_fee_units = 0)),
  CHECK ((booking_status = 'CANCELLED') = (cancelled_at IS NOT NULL))
) STRICT;
INSERT INTO bookings__new (id, booking_code, language_code, source, check_in, check_out, nights, adults, children, customer_name, customer_phone, customer_phone_normalized, customer_email, customer_line_id, customer_note, admin_note, booking_status, payment_status, accommodation_subtotal_satang, food_subtotal_satang, subtotal_satang, discount_satang, total_satang, currency, expires_at, confirmed_at, cancelled_at, cancelled_by, cancel_reason, created_by, created_at, updated_at, idempotency_key, privacy_accepted_at, deposit_satang) SELECT id, booking_code, language_code, source, check_in, check_out, nights, adults, children, customer_name, customer_phone, customer_phone_normalized, customer_email, customer_line_id, customer_note, admin_note, booking_status, payment_status, accommodation_subtotal_satang, food_subtotal_satang, subtotal_satang, discount_satang, total_satang, currency, expires_at, confirmed_at, cancelled_at, cancelled_by, cancel_reason, created_by, created_at, updated_at, idempotency_key, privacy_accepted_at, deposit_satang FROM bookings;
DROP TABLE bookings;
ALTER TABLE bookings__new RENAME TO bookings;
CREATE INDEX ix_bookings_check_in ON bookings (check_in);
CREATE INDEX ix_bookings_check_out ON bookings (check_out);
CREATE INDEX ix_bookings_confirmed ON bookings (confirmed_at) WHERE confirmed_at IS NOT NULL;
CREATE INDEX ix_bookings_created ON bookings (created_at);
CREATE INDEX ix_bookings_customer_phone ON bookings (customer_phone_normalized);
CREATE INDEX ix_bookings_expires ON bookings (expires_at) WHERE booking_status = 'PENDING';
CREATE INDEX ix_bookings_payment_status ON bookings (payment_status, created_at);
CREATE INDEX ix_bookings_status ON bookings (booking_status, check_in);
CREATE UNIQUE INDEX ux_bookings_idempotency_key ON bookings (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER trg_bookings_no_delete BEFORE DELETE ON bookings
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_DELETE_FORBIDDEN');
END;
CREATE TRIGGER trg_bookings_status_transition BEFORE UPDATE OF booking_status ON bookings
WHEN NEW.booking_status <> OLD.booking_status
 AND NOT (
      (OLD.booking_status = 'PENDING'    AND NEW.booking_status IN ('CONFIRMED', 'EXPIRED', 'CANCELLED'))
   OR (OLD.booking_status = 'CONFIRMED'  AND NEW.booking_status IN ('CHECKED_IN', 'CANCELLED', 'NO_SHOW'))
   OR (OLD.booking_status = 'CHECKED_IN' AND NEW.booking_status = 'CHECKED_OUT'))
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_STATUS_TRANSITION');
END;
CREATE TRIGGER trg_bookings_deposit_frozen BEFORE UPDATE OF deposit_satang ON bookings
WHEN NEW.deposit_satang IS NOT OLD.deposit_satang AND NEW.total_satang = OLD.total_satang
BEGIN
  SELECT RAISE(ABORT, 'DEPOSIT_IMMUTABLE');
END;
CREATE TRIGGER trg_bookings_checkin_paid BEFORE UPDATE OF booking_status ON bookings
WHEN NEW.booking_status = 'CHECKED_IN' AND OLD.booking_status <> 'CHECKED_IN' AND NEW.deposit_satang IS NOT NULL
 AND NEW.total_satang > (SELECT COALESCE(SUM(CASE WHEN p.status IN ('VERIFIED', 'PAID') THEN p.amount_satang
                                                  WHEN p.status = 'REFUNDED' THEN p.amount_satang - COALESCE(p.refund_amount_satang, p.amount_satang)
                                                  ELSE 0 END), 0)
                           FROM payments p WHERE p.booking_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_DUE');
END;
CREATE TRIGGER trg_booking_unit_nights_in_range BEFORE INSERT ON booking_unit_nights
WHEN NEW.booking_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM bookings b
                  WHERE b.id = NEW.booking_id AND NEW.stay_date >= b.check_in AND NEW.stay_date < b.check_out)
BEGIN
  SELECT RAISE(ABORT, 'STAY_NIGHT_OUT_OF_RANGE');
END;
CREATE TRIGGER trg_payments_booking_live BEFORE INSERT ON payments
WHEN (SELECT booking_status FROM bookings WHERE id = NEW.booking_id) IN ('CANCELLED', 'EXPIRED')
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_NOT_PAYABLE');
END;

-- ================================================================ settings, balance, ledger

CREATE TABLE credit_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  -- Off: no app fee, no credit hold, no plan lock (bookings as before migration 0027).
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- Credits (= baht) per house / VIP tent / own tent; changes apply to new bookings only.
  fee_per_unit     INTEGER NOT NULL DEFAULT 20 CHECK (fee_per_unit BETWEEN 1 AND 100000),
  -- Below this many usable credits: daily "low credit" notice.
  low_threshold    INTEGER NOT NULL DEFAULT 500 CHECK (low_threshold BETWEEN 0 AND 100000000),
  approval_mode    TEXT NOT NULL DEFAULT 'MANUAL' CHECK (approval_mode IN ('MANUAL', 'EASYSLIP')),
  -- Minimum top-up per plan (baht); NULL = that plan cannot be chosen yet.
  standard_min     INTEGER CHECK (standard_min IS NULL OR standard_min BETWEEN 1 AND 100000000),
  premium_min      INTEGER CHECK (premium_min IS NULL OR premium_min BETWEEN 1 AND 100000000),
  -- Where top-ups are paid (Super Admin's account).
  bank_name        TEXT CHECK (bank_name IS NULL OR length(trim(bank_name)) BETWEEN 1 AND 100),
  account_name     TEXT CHECK (account_name IS NULL OR length(trim(account_name)) BETWEEN 1 AND 150),
  account_number   TEXT CHECK (account_number IS NULL OR (length(account_number) BETWEEN 5 AND 30 AND account_number NOT GLOB '*[^0-9-]*')),
  promptpay_number TEXT CHECK (promptpay_number IS NULL OR (length(promptpay_number) IN (10, 13, 15) AND promptpay_number NOT GLOB '*[^0-9]*')),
  qr_asset_id      TEXT REFERENCES media_assets (id),
  -- Top-up requests are e-mailed here (LINE: every SUPER_ADMIN who linked LINE in "My account").
  notify_email     TEXT CHECK (notify_email IS NULL OR (length(notify_email) BETWEEN 3 AND 254 AND notify_email LIKE '%_@_%')),
  -- Local times (property time zone): low notice at alert_time_1, empty notice at both.
  alert_time_1     TEXT NOT NULL DEFAULT '09:00' CHECK (alert_time_1 GLOB '[0-2][0-9]:[0-5][0-9]' AND alert_time_1 <= '23:59'),
  alert_time_2     TEXT NOT NULL DEFAULT '17:00' CHECK (alert_time_2 GLOB '[0-2][0-9]:[0-5][0-9]' AND alert_time_2 <= '23:59'),
  updated_by       TEXT REFERENCES users (id),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
INSERT INTO credit_settings (id) VALUES (1);

-- One credit account for the property. `held` = credits reserved by unpaid bookings (never more than the balance).
CREATE TABLE credit_account (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  held       INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  plan       TEXT NOT NULL DEFAULT 'STANDARD' CHECK (plan IN ('STANDARD', 'PREMIUM')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (held <= balance)
) STRICT;
INSERT INTO credit_account (id) VALUES (1);

-- Top-up requests (slip in the PRIVATE bucket, purpose PAYMENT_SLIP).
CREATE TABLE credit_topups (
  id               TEXT PRIMARY KEY,
  requested_by     TEXT NOT NULL REFERENCES users (id),
  plan             TEXT NOT NULL CHECK (plan IN ('STANDARD', 'PREMIUM')),
  amount_requested INTEGER NOT NULL CHECK (amount_requested BETWEEN 1 AND 100000000),
  amount_credited  INTEGER CHECK (amount_credited IS NULL OR amount_credited BETWEEN 1 AND 100000000),
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  slip_asset_id    TEXT NOT NULL REFERENCES media_assets (id),
  slip_sha256      TEXT NOT NULL CHECK (length(slip_sha256) = 64),
  -- Bank transaction reference read by EasySlip (or NULL); one bank transfer tops up once.
  transaction_ref  TEXT CHECK (transaction_ref IS NULL OR length(transaction_ref) BETWEEN 1 AND 120),
  verify_result    TEXT CHECK (verify_result IS NULL OR verify_result IN ('PASSED', 'FAILED', 'NOT_A_SLIP', 'ERROR')),
  verify_reasons   TEXT CHECK (verify_reasons IS NULL OR json_valid(verify_reasons)),
  verified_amount  INTEGER,
  decided_by       TEXT REFERENCES users (id),
  decided_at       TEXT,
  decided_via      TEXT CHECK (decided_via IS NULL OR decided_via IN ('STAFF', 'EASYSLIP')),
  reject_reason    TEXT CHECK (reject_reason IS NULL OR length(reject_reason) <= 300),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK ((status = 'APPROVED') = (amount_credited IS NOT NULL)),
  CHECK ((status = 'PENDING') = (decided_at IS NULL)),
  CHECK (status <> 'REJECTED' OR reject_reason IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX ux_credit_topups_slip ON credit_topups (slip_sha256) WHERE status <> 'REJECTED';
CREATE UNIQUE INDEX ux_credit_topups_transaction ON credit_topups (transaction_ref) WHERE transaction_ref IS NOT NULL AND status <> 'REJECTED';
CREATE INDEX ix_credit_topups_status ON credit_topups (status, created_at);
CREATE INDEX ix_credit_topups_requested_by ON credit_topups (requested_by, created_at);

-- A decided top-up never changes again.
CREATE TRIGGER trg_credit_topups_final BEFORE UPDATE ON credit_topups
WHEN OLD.status <> 'PENDING'
BEGIN
  SELECT RAISE(ABORT, 'TOPUP_ALREADY_DECIDED');
END;

-- Every movement of credits, append-only. amount is signed (− for a deduction); 0 for a plan change.
CREATE TABLE credit_ledger (
  id            TEXT PRIMARY KEY,
  entry_type    TEXT NOT NULL CHECK (entry_type IN ('TOPUP', 'ADJUST_ADD', 'ADJUST_SUB', 'FEE_CAPTURE', 'PLAN_CHANGE')),
  amount        INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  plan          TEXT CHECK (plan IS NULL OR plan IN ('STANDARD', 'PREMIUM')),
  booking_id    TEXT REFERENCES bookings (id),
  topup_id      TEXT REFERENCES credit_topups (id),
  units         INTEGER CHECK (units IS NULL OR units >= 0),
  note          TEXT CHECK (note IS NULL OR length(note) <= 300),
  actor_id      TEXT REFERENCES users (id),
  created_at    TEXT NOT NULL,
  CHECK ((entry_type IN ('TOPUP', 'ADJUST_ADD')) = (amount > 0) OR entry_type = 'PLAN_CHANGE'),
  CHECK (entry_type <> 'PLAN_CHANGE' OR (amount = 0 AND plan IS NOT NULL)),
  CHECK (entry_type <> 'FEE_CAPTURE' OR booking_id IS NOT NULL),
  CHECK (entry_type <> 'TOPUP' OR topup_id IS NOT NULL),
  CHECK (entry_type NOT IN ('ADJUST_ADD', 'ADJUST_SUB', 'PLAN_CHANGE') OR note IS NOT NULL)
) STRICT;
CREATE INDEX ix_credit_ledger_created ON credit_ledger (created_at);
CREATE INDEX ix_credit_ledger_booking ON credit_ledger (booking_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX ux_credit_ledger_fee ON credit_ledger (booking_id) WHERE entry_type = 'FEE_CAPTURE';
CREATE UNIQUE INDEX ux_credit_ledger_topup ON credit_ledger (topup_id) WHERE entry_type = 'TOPUP';
CREATE TRIGGER trg_credit_ledger_no_update BEFORE UPDATE ON credit_ledger
BEGIN
  SELECT RAISE(ABORT, 'CREDIT_LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER trg_credit_ledger_no_delete BEFORE DELETE ON credit_ledger
BEGIN
  SELECT RAISE(ABORT, 'CREDIT_LEDGER_APPEND_ONLY');
END;

-- Credits reserved by a booking: HELD while unpaid, then CAPTURED (paid) or RELEASED (expired / cancelled).
CREATE TABLE credit_holds (
  booking_id TEXT PRIMARY KEY REFERENCES bookings (id),
  units      INTEGER NOT NULL CHECK (units >= 1),
  amount     INTEGER NOT NULL CHECK (amount >= 1),
  status     TEXT NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'CAPTURED', 'RELEASED')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((status = 'HELD') = (settled_at IS NULL))
) STRICT;
CREATE INDEX ix_credit_holds_held ON credit_holds (status) WHERE status = 'HELD';

-- ================================================================ hold → capture / release (triggers on bookings)

-- A booking with an app fee reserves its credits, or the whole insert (and its batch) fails.
CREATE TRIGGER trg_bookings_credit_hold AFTER INSERT ON bookings
WHEN NEW.app_fee_satang > 0
BEGIN
  SELECT RAISE(ABORT, 'CREDIT_INSUFFICIENT')
   WHERE COALESCE((SELECT balance - held FROM credit_account WHERE id = 1), 0) < NEW.app_fee_satang / 100;
  UPDATE credit_account SET held = held + NEW.app_fee_satang / 100, updated_at = NEW.created_at WHERE id = 1;
  INSERT INTO credit_holds (booking_id, units, amount, status, created_at)
  VALUES (NEW.id, NEW.app_fee_units, NEW.app_fee_satang / 100, 'HELD', NEW.created_at);
END;

-- Paid (PENDING → CONFIRMED, by any path): the held credits are deducted, once.
CREATE TRIGGER trg_bookings_credit_capture AFTER UPDATE OF booking_status ON bookings
WHEN OLD.booking_status = 'PENDING' AND NEW.booking_status = 'CONFIRMED'
 AND EXISTS (SELECT 1 FROM credit_holds WHERE booking_id = NEW.id AND status = 'HELD')
BEGIN
  UPDATE credit_account
     SET balance = balance - (SELECT amount FROM credit_holds WHERE booking_id = NEW.id),
         held = held - (SELECT amount FROM credit_holds WHERE booking_id = NEW.id),
         updated_at = NEW.updated_at
   WHERE id = 1;
  INSERT INTO credit_ledger (id, entry_type, amount, balance_after, booking_id, units, created_at)
  SELECT lower(hex(randomblob(16))), 'FEE_CAPTURE', -h.amount, (SELECT balance FROM credit_account WHERE id = 1), NEW.id, h.units, NEW.updated_at
    FROM credit_holds h WHERE h.booking_id = NEW.id;
  UPDATE credit_holds SET status = 'CAPTURED', settled_at = NEW.updated_at WHERE booking_id = NEW.id;
END;

-- Never paid (PENDING → EXPIRED / CANCELLED): the held credits are free again.
CREATE TRIGGER trg_bookings_credit_release AFTER UPDATE OF booking_status ON bookings
WHEN OLD.booking_status = 'PENDING' AND NEW.booking_status IN ('EXPIRED', 'CANCELLED')
 AND EXISTS (SELECT 1 FROM credit_holds WHERE booking_id = NEW.id AND status = 'HELD')
BEGIN
  UPDATE credit_account SET held = held - (SELECT amount FROM credit_holds WHERE booking_id = NEW.id), updated_at = NEW.updated_at WHERE id = 1;
  UPDATE credit_holds SET status = 'RELEASED', settled_at = NEW.updated_at WHERE booking_id = NEW.id;
END;

-- Staff cancel one stay of an UNPAID booking: its units come off the fee and the hold. Once captured (or for a
-- booking made without a hold) the fee is frozen.
CREATE TRIGGER trg_bookings_app_fee_change BEFORE UPDATE OF app_fee_satang, app_fee_units ON bookings
WHEN NEW.app_fee_satang <> OLD.app_fee_satang OR NEW.app_fee_units <> OLD.app_fee_units
BEGIN
  SELECT RAISE(ABORT, 'APP_FEE_FROZEN')
   WHERE NOT EXISTS (SELECT 1 FROM credit_holds WHERE booking_id = NEW.id AND status = 'HELD')
      OR NEW.app_fee_satang > OLD.app_fee_satang OR NEW.app_fee_units < 1;
END;
CREATE TRIGGER trg_bookings_app_fee_changed AFTER UPDATE OF app_fee_satang, app_fee_units ON bookings
WHEN NEW.app_fee_satang <> OLD.app_fee_satang OR NEW.app_fee_units <> OLD.app_fee_units
BEGIN
  UPDATE credit_account SET held = held - (OLD.app_fee_satang - NEW.app_fee_satang) / 100, updated_at = NEW.updated_at WHERE id = 1;
  UPDATE credit_holds SET amount = NEW.app_fee_satang / 100, units = NEW.app_fee_units WHERE booking_id = NEW.id;
END;

-- ================================================================ LINE for each back-office user ("My account")

-- A user links their own LINE (1:1 chat with the property's LINE OA) to get credit notices.
CREATE TABLE user_line_links (
  user_id      TEXT PRIMARY KEY REFERENCES users (id),
  line_user_id TEXT NOT NULL CHECK (length(line_user_id) = 33 AND substr(line_user_id, 1, 1) = 'U' AND substr(line_user_id, 2) NOT GLOB '*[^0-9a-f]*'),
  linked_at    TEXT NOT NULL
) STRICT;
CREATE INDEX ix_user_line_links_line ON user_line_links (line_user_id);

-- A STAFF pairing code with user_id links that user's LINE instead of creating a staff chat.
ALTER TABLE line_link_codes ADD COLUMN user_id TEXT REFERENCES users (id);

-- ================================================================ permissions

INSERT INTO permissions (id, code, module, description) VALUES
  ('perm_credits_view', 'credits.view', 'credits', 'See the app-usage credit balance'),
  ('perm_credits_topup', 'credits.topup', 'credits', 'Top up app-usage credits (send amount + slip)'),
  ('perm_credits_manage', 'credits.manage', 'credits', 'Manage credits: settings, approve top-ups, adjust balance (SUPER_ADMIN only)');

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('role_super_admin', 'perm_credits_view'), ('role_super_admin', 'perm_credits_topup'), ('role_super_admin', 'perm_credits_manage'),
  ('role_manager', 'perm_credits_view'), ('role_manager', 'perm_credits_topup'),
  ('role_booking_admin', 'perm_credits_view'), ('role_booking_admin', 'perm_credits_topup'),
  ('role_finance_admin', 'perm_credits_view'), ('role_finance_admin', 'perm_credits_topup'),
  ('role_content_admin', 'perm_credits_view'), ('role_content_admin', 'perm_credits_topup'),
  ('role_viewer', 'perm_credits_view');

-- credits.manage belongs to the SUPER_ADMIN role alone: never to another role, never granted to one user.
CREATE TRIGGER trg_role_permissions_credits_manage BEFORE INSERT ON role_permissions
WHEN NEW.permission_id = 'perm_credits_manage' AND NEW.role_id <> 'role_super_admin'
BEGIN
  SELECT RAISE(ABORT, 'CREDITS_MANAGE_SUPER_ADMIN_ONLY');
END;
CREATE TRIGGER trg_user_permissions_credits_manage BEFORE INSERT ON user_permissions
WHEN NEW.permission_id = 'perm_credits_manage' AND NEW.effect = 'GRANT'
BEGIN
  SELECT RAISE(ABORT, 'CREDITS_MANAGE_SUPER_ADMIN_ONLY');
END;

PRAGMA defer_foreign_keys = false;
