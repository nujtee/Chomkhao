import { useEffect, useState, type FormEvent } from "react";
import { BOOKING_CODE_PATTERN, type PublicBookingDto } from "../../shared/booking-types.ts";
import type { PaypalCaptureDto } from "../../shared/payment-types.ts";
import { pagePath } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { fill } from "../accommodation/UnitCard.tsx";
import { bookingErrorText, cancelPaypalOrder, capturePaypalOrder, lookupBooking, recallAfterPaypal } from "../booking/api.ts";
import { StatusPill } from "../booking/Confirmation.tsx";
import { BalancePay } from "../booking/BalancePay.tsx";
import { PaymentInstructions } from "../booking/PaymentInstructions.tsx";
import { SlipStatus, SlipUpload } from "../booking/SlipUpload.tsx";
import { BookingSummary, useDateTimeText } from "../booking/Summary.tsx";
import { useBookingT } from "../booking/useBookingT.ts";
import { LineUpdates } from "../booking/LineUpdates.tsx";
import { paymentSubmittedEvent, useConfirmedBookingEvent } from "../analytics/booking-events.ts";

/** Guest self-service: Booking ID + phone (both required — no enumeration). */
export function BookingLookupPage() {
  const { locale, t } = useI18n();
  const bt = useBookingT();
  const timeText = useDateTimeText();
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<PublicBookingDto | null>(null);
  const [paypal, setPaypal] = useState<{ state: "checking" | "cancelled" } | { state: "done"; outcome: PaypalCaptureDto["outcome"]; orderId: string } | null>(null);
  useConfirmedBookingEvent(booking);

  async function open(bookingCode: string, guestPhone: string) {
    setBusy(true);
    setError(null);
    setBooking(null);
    try {
      setBooking(await lookupBooking(bookingCode, guestPhone));
    } catch (err) {
      setError(bookingErrorText(bt, err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void open(code.trim(), phone.trim());
  }

  async function finishPaypal(orderId: string, memory: { code: string; phone: string } | null) {
    setPaypal({ state: "checking" });
    try {
      const r = await capturePaypalOrder(orderId);
      setPaypal({ state: "done", outcome: r.outcome, orderId });
      setCode(r.bookingCode);
      if (memory && memory.code === r.bookingCode) await open(r.bookingCode, memory.phone);
    } catch (err) {
      setPaypal(null);
      setError(bookingErrorText(bt, err));
    }
  }

  // Back from PayPal (?paypal=return|cancel&token=<order>&code=<Booking ID>), or a link with ?code=.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const linked = p.get("code")?.toUpperCase() ?? null;
    if (linked && BOOKING_CODE_PATTERN.test(linked)) setCode(linked);
    const mode = p.get("paypal");
    const token = p.get("token");
    if (!mode || !token || !/^[A-Za-z0-9-]{8,64}$/.test(token)) return;
    // A reload must not repeat this (the server would answer the same, but quietly is better).
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${linked ? `?code=${encodeURIComponent(linked)}` : ""}`);
    const memory = recallAfterPaypal(linked);
    if (memory) setPhone(memory.phone);
    if (mode === "cancel") {
      setPaypal({ state: "cancelled" });
      void cancelPaypalOrder(token).catch(() => undefined);
      if (memory) void open(memory.code, memory.phone);
      return;
    }
    void finishPaypal(token, memory);
    // Runs once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paypalText = paypal?.state === "checking" ? bt.pay.paypalChecking
    : paypal?.state === "cancelled" ? bt.pay.paypalCancelled
    : paypal?.state === "done" ? {
      PAID: bt.pay.paypalPaid, PENDING_REVIEW: bt.pay.paypalPending, DECLINED: bt.pay.paypalDeclined,
      NOT_PAYABLE: bt.pay.paypalNotPayable, PROCESSING: bt.pay.paypalProcessing,
    }[paypal.outcome] : null;
  const paypalKind = paypal?.state === "done" ? (paypal.outcome === "PAID" ? "notice--ok" : paypal.outcome === "DECLINED" || paypal.outcome === "NOT_PAYABLE" ? "notice--error" : "") : "";

  return (
    <div className="page container lookup">
      <p className="detail__back"><Link to={pagePath(locale, "booking")}>← {t.accommodation.backToBooking}</Link></p>
      <h1 className="page__title">{bt.lookupTitle}</h1>
      <p className="page__lead">{bt.lookupIntro}</p>

      <form className="flow-form lookup__form" onSubmit={(e) => void submit(e)}>
        <div className="form-field">
          <label htmlFor="lk-code">{bt.bookingCode}<span aria-hidden="true"> *</span></label>
          <input id="lk-code" required maxLength={20} autoComplete="off" autoCapitalize="characters" spellCheck={false}
            placeholder={bt.bookingCodeHint} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </div>
        <div className="form-field">
          <label htmlFor="lk-phone">{bt.phone}<span aria-hidden="true"> *</span></label>
          <input id="lk-phone" required type="tel" inputMode="tel" autoComplete="tel" maxLength={24} value={phone}
            onChange={(e) => setPhone(e.target.value)} />
        </div>
        <button type="submit" className="button button--primary" disabled={busy} aria-busy={busy || undefined}>{bt.find}</button>
      </form>

      {paypalText && (
        <div className={`notice ${paypalKind}`} role="status" aria-live="polite">
          <p>{paypalText}</p>
          {paypal?.state === "done" && paypal.outcome === "PROCESSING" && (
            <button type="button" className="button button--secondary" onClick={() => void finishPaypal(paypal.orderId, phone.trim() && code ? { code, phone: phone.trim() } : null)}>
              {bt.pay.checkAgain}
            </button>
          )}
        </div>
      )}
      {error && <p role="alert" className="notice notice--error">{error}</p>}

      {booking && (
        <section className="lookup__result" aria-live="polite">
          <p className="confirmation__value" translate="no">{booking.bookingCode}</p>
          <p className="confirmation__status">{bt.status}: <StatusPill status={booking.status} /></p>
          <p className="summary__meta">{booking.customerName} · {booking.customerPhoneMasked}</p>
          <SlipStatus booking={booking} />
          {booking.paymentInstructions ? (
            <PaymentInstructions payment={booking.paymentInstructions} expiresAt={booking.expiresAt} bookingCode={booking.bookingCode}
              laterSatang={booking.totalSatang - booking.paymentInstructions.amountDueSatang} phone={phone.trim()}
              slip={(channel) => (
                <SlipUpload bookingCode={booking.bookingCode} phone={phone.trim()} channel={channel}
                  onDone={(r) => { paymentSubmittedEvent(r.booking); setBooking(r.booking); }} />
              )} />
          ) : booking.expiresAt && <p className="notice" role="note">{fill(bt.holdUntil, { time: timeText(booking.expiresAt) })}</p>}
          <BalancePay booking={booking} phone={phone.trim()} onChange={setBooking} />
          <LineUpdates booking={booking} phone={phone.trim()} onChange={setBooking} />
          <BookingSummary quote={booking} />
        </section>
      )}
    </div>
  );
}
