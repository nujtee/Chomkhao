-- Migration 0025: deposit — pay half of the stay now, the rest before check-in
-- Non-destructive: three ADD COLUMNs with safe defaults and one trigger. No table is rebuilt, no existing row
-- changes meaning (every unit / camping keeps "full payment", every existing booking has no deposit).
--
-- How a deposit booking works:
--   * The owner chooses per house / VIP tent (accommodation_units.payment_mode) and for camping
--     (camping_settings.payment_mode): FULL (as before) or DEPOSIT_50.
--   * DEPOSIT_50: the guest pays bookings.deposit_satang to confirm = the whole total minus half of the stay
--     (accommodation + tarp area, the half left for later rounded down to whole baht). Food is paid in full now.
--   * The rest (total_satang − payments received) is paid at reception before check-in: one more `payments`
--     row (cash, PromptPay or bank transfer, confirmed by staff). Check-in is refused while anything is due.
--   * bookings.payment_status keeps its meaning for the amount asked online (PAID / VERIFIED once the
--     deposit is in); what is still due is total_satang minus the VERIFIED / PAID payments.

ALTER TABLE accommodation_units ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'FULL'
  CHECK (payment_mode IN ('FULL', 'DEPOSIT_50'));

ALTER TABLE camping_settings ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'FULL'
  CHECK (payment_mode IN ('FULL', 'DEPOSIT_50'));

-- Amount asked online to confirm the booking; NULL = the full total (no deposit).
ALTER TABLE bookings ADD COLUMN deposit_satang INTEGER
  CHECK (deposit_satang IS NULL OR (deposit_satang > 0 AND deposit_satang < total_satang));

-- Like the price snapshot, the deposit agreed at booking time never changes afterwards.
CREATE TRIGGER trg_bookings_deposit_frozen BEFORE UPDATE OF deposit_satang ON bookings
WHEN NEW.deposit_satang IS NOT OLD.deposit_satang
BEGIN
  SELECT RAISE(ABORT, 'DEPOSIT_IMMUTABLE');
END;

-- A deposit booking cannot be checked in while money is still due: the balance is taken first (same batch).
CREATE TRIGGER trg_bookings_checkin_paid BEFORE UPDATE OF booking_status ON bookings
WHEN NEW.booking_status = 'CHECKED_IN' AND OLD.booking_status <> 'CHECKED_IN' AND NEW.deposit_satang IS NOT NULL
 AND NEW.total_satang > (SELECT COALESCE(SUM(p.amount_satang), 0) FROM payments p
                          WHERE p.booking_id = NEW.id AND p.status IN ('VERIFIED', 'PAID'))
BEGIN
  SELECT RAISE(ABORT, 'BALANCE_DUE');
END;
