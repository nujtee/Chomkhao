import { PAYMENT_MODES, type PaymentMode } from "../../../shared/booking-rules.ts";
import { useAdmin } from "../AdminContext.tsx";

/**
 * How guests pay a house / VIP tent / camping: everything when booking, or a 50% deposit with the rest taken at
 * reception before check-in. A money setting: changing it needs pricing.edit (the Worker checks it too).
 */
export function PaymentModeField({ id, value, onChange, error }: {
  id: string;
  value: PaymentMode;
  onChange: (mode: PaymentMode) => void;
  error?: string;
}) {
  const { t, can } = useAdmin();
  const canPrice = can("pricing.edit");
  return (
    <div className="adm-field">
      <label htmlFor={id}>{t.acc.paymentMode}</label>
      <select id={id} value={value} disabled={!canPrice} aria-describedby={`${id}-hint`} aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.currentTarget.value as PaymentMode)}>
        {PAYMENT_MODES.map((m) => <option key={m} value={m}>{t.acc[`pay${m}`]}</option>)}
      </select>
      <p id={`${id}-hint`} className="adm-field__hint">{canPrice ? t.acc.paymentModeHint : t.acc.needsPricing}</p>
      {error && <p className="adm-field__error">{error}</p>}
    </div>
  );
}
