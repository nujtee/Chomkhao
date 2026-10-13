import type { PublicBookingDto } from "../../shared/booking-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { PaymentInstructions } from "./PaymentInstructions.tsx";
import { SlipUpload } from "./SlipUpload.tsx";
import { useBookingT } from "./useBookingT.ts";

/**
 * Deposit plan, confirmed booking: the guest may transfer the rest before the stay (PromptPay / bank transfer / the
 * property's QR, then the slip) instead of paying at reception. The account is the one copied onto the booking, the
 * slip is checked like the deposit (verification service or staff), and the booking stays confirmed either way.
 */
export function BalancePay({ booking, phone, onChange }: { booking: PublicBookingDto; phone: string; onChange: (b: PublicBookingDto) => void }) {
  const bt = useBookingT();
  const { locale } = useI18n();
  const balance = booking.balancePayment;
  if (!balance) {
    // Deposit taken and the rest received: nothing left for check-in.
    return booking.depositSatang !== null && booking.status === "CONFIRMED" && booking.balanceSatang === 0
      ? <p className="notice notice--ok" role="status">{bt.balanceDone}</p> : null;
  }
  return (
    <>
      {balance.reviewing && <p className="notice" role="status">{bt.balanceReviewing}</p>}
      {balance.rejectedReason !== null && (
        <p className="notice notice--error" role="alert">
          {balance.rejectedReason ? fill(bt.balanceRejected, { reason: balance.rejectedReason }) : bt.balanceRejectedNoReason}
        </p>
      )}
      {balance.instructions && (
        <PaymentInstructions payment={balance.instructions} expiresAt={null} bookingCode={booking.bookingCode} phone={phone}
          labels={{
            title: bt.balanceTitle,
            amount: bt.balanceAmount,
            intro: fill(bt.balanceIntro, { paid: formatBaht(booking.paidSatang, locale.code) }),
            afterTransfer: bt.balanceAfterTransfer,
          }}
          slip={(channel) => (
            <SlipUpload bookingCode={booking.bookingCode} phone={phone} channel={channel} onDone={(r) => onChange(r.booking)} />
          )} />
      )}
    </>
  );
}
