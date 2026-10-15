-- Migration 0028: the PromptPay ID behind the top-up QR.
--
-- A bank's "receive money" QR (e.g. K PLUS) is often tied to a 15-digit e-Wallet ID rather than the phone or account
-- number, so a slip paid by scanning it names that ID as the receiver and EasySlip's destination check refused it.
-- Super Admin can now record that ID (read from the QR in the browser, or typed): it counts as a valid receiver.
-- Additive only (one nullable column); the code runs before and after it is applied.
ALTER TABLE credit_settings ADD COLUMN qr_receiver TEXT
  CHECK (qr_receiver IS NULL OR (length(qr_receiver) BETWEEN 10 AND 20 AND qr_receiver NOT GLOB '*[^0-9]*'));
