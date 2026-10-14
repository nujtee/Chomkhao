-- Migration 0026: several stays in one booking, and cancelling one of them
--
-- DESTRUCTIVE (announced): two triggers are dropped and re-created in the same file (trg_bookings_deposit_frozen,
-- trg_bookings_checkin_paid) — each new version refuses everything the old one refused except one new, valid case
-- (see 4. and 5.). No table is dropped or rebuilt, no row is deleted; the rest is ADD COLUMN with safe defaults and
-- one backfill of a new column.
--
-- Backup / rollback:
--   * Before applying: note the D1 Time Travel bookmark (wrangler d1 time-travel info phasakura-db) and export
--     (wrangler d1 export phasakura-db --remote --output backup-0026.sql).
--   * Rollback: restore that bookmark (wrangler d1 time-travel restore phasakura-db --bookmark=<bookmark>), or
--     re-create the two triggers exactly as in 0025_deposit.sql (the new columns are harmless to old code).
--
-- One booking may now hold several houses / VIP tents plus own-tent camping, on the same dates
-- (booking_items already allowed several rows; the code only ever wrote one). Each stay keeps its own guests
-- (booking_items.adults / children) and price snapshot (booking_price_snapshots per item).
--
-- 1. Deposit per stay: the part of each stay left for check-in (half of a DEPOSIT_50 stay, 0 for full payment).
--    bookings.deposit_satang stays the amount asked online = total − Σ pay_later_satang of the active stays.
ALTER TABLE booking_items ADD COLUMN pay_later_satang INTEGER NOT NULL DEFAULT 0 CHECK (pay_later_satang >= 0);

-- Bookings made so far have one stay: it carries the whole "later" part of a deposit booking.
UPDATE booking_items
   SET pay_later_satang = (SELECT b.total_satang - b.deposit_satang FROM bookings b WHERE b.id = booking_items.booking_id)
 WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_items.booking_id AND b.deposit_satang IS NOT NULL);

-- 2. Staff may cancel one stay of a booking that holds several (the booking itself stays): when and why.
ALTER TABLE booking_items ADD COLUMN cancelled_at TEXT;
ALTER TABLE booking_items ADD COLUMN cancel_reason TEXT;

-- 3. Meals included with a stay belong to that stay, so they go with it when it is cancelled.
ALTER TABLE booking_food_items ADD COLUMN booking_item_id TEXT REFERENCES booking_items (id);

-- 4. The deposit is still frozen — except when the booking total changes in the same update (a stay was
--    cancelled, so the deposit is worked out again from the stays that are left).
DROP TRIGGER trg_bookings_deposit_frozen;
CREATE TRIGGER trg_bookings_deposit_frozen BEFORE UPDATE OF deposit_satang ON bookings
WHEN NEW.deposit_satang IS NOT OLD.deposit_satang AND NEW.total_satang = OLD.total_satang
BEGIN
  SELECT RAISE(ABORT, 'DEPOSIT_IMMUTABLE');
END;

-- 5. Money received = verified / paid payments, plus what is left of a partly refunded payment (staff refund
--    what was paid for a cancelled stay). A deposit booking cannot be checked in while money is still due.
DROP TRIGGER trg_bookings_checkin_paid;
CREATE TRIGGER trg_bookings_checkin_paid BEFORE UPDATE OF booking_status ON bookings
WHEN NEW.booking_status = 'CHECKED_IN' AND OLD.booking_status <> 'CHECKED_IN' AND NEW.deposit_satang IS NOT NULL
 AND NEW.total_satang > (SELECT COALESCE(SUM(CASE WHEN p.status IN ('VERIFIED', 'PAID') THEN p.amount_satang
                                                  WHEN p.status = 'REFUNDED' THEN p.amount_satang - COALESCE(p.refund_amount_satang, p.amount_satang)
                                                  ELSE 0 END), 0)
                           FROM payments p WHERE p.booking_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_DUE');
END;
