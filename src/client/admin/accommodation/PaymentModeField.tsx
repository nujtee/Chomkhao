import type { DepositBookingsDto } from "../../../shared/accommodation-types.ts";
import { PAYMENT_MODES, formatBaht, type PaymentMode } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";

/**
 * How guests pay a house / VIP tent / camping: everything when booking, or a 50% deposit with the rest taken at
 * reception before check-in. A money setting: changing it needs pricing.edit (the Worker checks it too).
 *
 * `deposits`: open bookings made with a deposit. Their deposit is fixed at booking time, so with "full payment"
 * chosen (or already saved) the owner is told they keep the deposit plan — the rest is still taken at check-in.
 */
export function PaymentModeField({ id, value, onChange, error, deposits }: {
  id: string;
  value: PaymentMode;
  onChange: (mode: PaymentMode) => void;
  error?: string;
  deposits?: DepositBookingsDto;
}) {
  const { t, can, href, locale } = useAdmin();
  const canPrice = can("pricing.edit");
  const kept = value === "FULL" && deposits && deposits.paid + deposits.awaiting > 0 ? deposits : null;
  return (
    <div className="adm-field">
      <label htmlFor={id}>{t.acc.paymentMode}</label>
      <select id={id} value={value} disabled={!canPrice} aria-describedby={`${id}-hint${kept ? ` ${id}-kept` : ""}`} aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.currentTarget.value as PaymentMode)}>
        {PAYMENT_MODES.map((m) => <option key={m} value={m}>{t.acc[`pay${m}`]}</option>)}
      </select>
      <p id={`${id}-hint`} className="adm-field__hint">{canPrice ? t.acc.paymentModeHint : t.acc.needsPricing}</p>
      {kept && (
        <div id={`${id}-kept`} className="adm-paymode-kept" role="note">
          <p className="adm-paymode-kept__title">{t.acc.keptTitle}</p>
          <ul>
            {kept.paid > 0 && <li>{format(t.acc.keptPaid, { n: kept.paid, amount: formatBaht(kept.dueSatang, locale.code) })}</li>}
            {kept.awaiting > 0 && <li>{format(t.acc.keptAwaiting, { n: kept.awaiting })}</li>}
          </ul>
          {kept.paid > 0 && can("bookings.view") && <Link to={`${href("bookings")}?due=1`}>{t.acc.keptList}</Link>}
        </div>
      )}
      {error && <p className="adm-field__error">{error}</p>}
    </div>
  );
}
