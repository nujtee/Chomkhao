import { useState, type RefObject } from "react";
import { SlipStatus, SlipUpload } from "./SlipUpload.tsx";
import type { PublicBookingDto } from "../../shared/booking-types.ts";
import { bookingLookupPath } from "../../shared/routes.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { fill } from "../accommodation/UnitCard.tsx";
import { PaymentInstructions } from "./PaymentInstructions.tsx";
import { BookingSummary, useDateTimeText } from "./Summary.tsx";
import { useBookingT } from "./useBookingT.ts";
import { LineUpdates } from "./LineUpdates.tsx";
import { paymentSubmittedEvent, useConfirmedBookingEvent } from "../analytics/booking-events.ts";

export function StatusPill({ status }: { status: PublicBookingDto["status"] }) {
  const bt = useBookingT();
  return <span className={`status-pill status-pill--${status.toLowerCase()}`}>{bt.statuses[status]}</span>;
}

/** Shown right after booking: the Booking ID is the thing to keep. */
export function Confirmation({
  booking: initial,
  phone,
  headingRef,
  onNewBooking,
}: {
  booking: PublicBookingDto;
  /** The phone the guest just typed — proves ownership for the slip upload. */
  phone: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onNewBooking: () => void;
}) {
  const [booking, setBooking] = useState(initial);
  useConfirmedBookingEvent(booking);
  const { locale } = useI18n();
  const bt = useBookingT();
  const timeText = useDateTimeText();
  const [copied, setCopied] = useState(false);

  const paying = booking.status === "PENDING";
  const labels = [bt.stepFood, bt.stepDetails, bt.stepReview, bt.stepPay];
  return (
    <div className="confirmation">
      <ol className="flow-steps" aria-label={fill(bt.progress, { n: 4, total: 4 })}>
        {labels.map((label, i) => {
          const isPay = i === labels.length - 1;
          const state = !isPay || !paying ? "is-done" : "is-current";
          return (
            <li key={label} className={state} aria-current={isPay && paying ? "step" : undefined}>
              <span className="flow-steps__n" aria-hidden="true">{!isPay || !paying ? "✓" : i + 1}</span> {label}
            </li>
          );
        })}
      </ol>
      <div className="confirmation__head">
        <span className="confirmation__check" aria-hidden="true">✓</span>
        <h1 className="page__title" tabIndex={-1} ref={headingRef}>{bt.doneTitle}</h1>
      </div>

      <div className="confirmation__code">
        <p className="confirmation__label">{bt.yourCode}</p>
        <p className="confirmation__value" translate="no">{booking.bookingCode}</p>
        <button type="button" className="button button--secondary"
          onClick={() => navigator.clipboard.writeText(booking.bookingCode).then(() => setCopied(true), () => setCopied(false))}>
          {copied ? bt.copied : bt.copy}
        </button>
        <p className="confirmation__hint">{bt.keepCode}</p>
      </div>

      <p className="confirmation__status">
        {bt.status}: <StatusPill status={booking.status} />
      </p>
      <SlipStatus booking={booking} />
      {booking.paymentInstructions ? (
        <PaymentInstructions payment={booking.paymentInstructions} expiresAt={booking.expiresAt} bookingCode={booking.bookingCode}
          laterSatang={booking.totalSatang - booking.paymentInstructions.amountDueSatang} phone={phone}
          slip={(channel) => (
            <SlipUpload bookingCode={booking.bookingCode} phone={phone} channel={channel}
              onDone={(r) => { paymentSubmittedEvent(r.booking); setBooking(r.booking); }} />
          )} />
      ) : booking.expiresAt && <p className="notice" role="note">{fill(bt.holdUntil, { time: timeText(booking.expiresAt) })}</p>}

      <LineUpdates booking={booking} phone={phone} onChange={setBooking} />

      <BookingSummary quote={booking} />

      <div className="flow-nav">
        <Link to={bookingLookupPath(locale)} className="button button--secondary">{bt.checkBooking}</Link>
        <button type="button" className="button button--ghost" onClick={onNewBooking}>{bt.newBooking}</button>
      </div>
    </div>
  );
}
