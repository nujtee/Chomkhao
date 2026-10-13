import { useEffect, useId, useState, type ReactNode } from "react";
import type { PaymentChannel, PaymentInstructionsDto, SlipChannel } from "../../shared/payment-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { fill } from "../accommodation/UnitCard.tsx";
import { bookingErrorText, createPaypalOrder, rememberForPaypal } from "./api.ts";
import { QrCode, qrPngDataUrl } from "./QrCode.tsx";
import { useDateTimeText } from "./Summary.tsx";
import { useBookingT } from "./useBookingT.ts";

function CopyRow({ label, value, copyValue }: { label: string; value: string; copyValue?: string }) {
  const bt = useBookingT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="pay__row">
      <dt>{label}</dt>
      <dd>
        <span className="pay__value" translate="no">{value}</span>
        <button type="button" className="pay__copy" aria-label={`${bt.copyNumber}: ${label}`}
          onClick={() => navigator.clipboard.writeText(copyValue ?? value.replace(/[^\d]/g, "")).then(() => setCopied(true), () => setCopied(false))}>
          {copied ? bt.copied : bt.copy}
        </button>
      </dd>
    </div>
  );
}

/** "45 min" / "2 h 5 min" until the deadline; null once it has passed. */
function useTimeLeft(expiresAt: string | null): string | null | undefined {
  const bt = useBookingT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return undefined;
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes < 60 ? fill(bt.pay.leftMinutes, { n: minutes }) : fill(bt.pay.leftHours, { h: Math.floor(minutes / 60), m: minutes % 60 });
}

const SLIP: readonly PaymentChannel[] = ["PROMPTPAY", "BANK_TRANSFER", "QR_CODE"];

/**
 * The payment step: the guest picks a channel the property offers — PromptPay (QR with the amount
 * filled in), bank transfer, the property's own QR, or PayPal — and either attaches the slip or pays at
 * PayPal. Account details always come from the booking's own snapshot, never the current settings.
 * `slip(channel)` renders the slip form for the chosen slip channel.
 */
export function PaymentInstructions({
  payment, expiresAt, bookingCode, phone, slip, laterSatang = 0, labels,
}: {
  payment: PaymentInstructionsDto;
  /** Other wording for the same panel, e.g. the rest of a deposit paid before the stay. */
  labels?: { title: string; amount: string; intro: string; afterTransfer: string };
  /** Deposit plan: what is left for check-in (0 = the amount due is everything). */
  laterSatang?: number;
  expiresAt: string | null;
  bookingCode: string;
  phone: string;
  slip: (channel: SlipChannel) => ReactNode;
}) {
  const { locale } = useI18n();
  const bt = useBookingT();
  const timeText = useDateTimeText();
  const id = useId();
  const channels = payment.channels.length ? payment.channels : (["BANK_TRANSFER"] as PaymentChannel[]);
  const [channel, setChannel] = useState<PaymentChannel>(channels[0]!);
  const [paypalBusy, setPaypalBusy] = useState(false);
  const [paypalError, setPaypalError] = useState<string | null>(null);
  const left = useTimeLeft(expiresAt);
  const amount = formatBaht(payment.amountDueSatang, locale.code);
  const amountPlain = (payment.amountDueSatang / 100).toFixed(2);
  const current = channels.includes(channel) ? channel : channels[0]!;

  async function payWithPaypal() {
    setPaypalBusy(true);
    setPaypalError(null);
    try {
      const order = await createPaypalOrder(bookingCode, phone);
      rememberForPaypal(bookingCode, phone);
      window.location.assign(order.approveUrl);
    } catch (err) {
      setPaypalError(bookingErrorText(bt, err));
      setPaypalBusy(false);
    }
  }

  function saveQr() {
    if (!payment.promptpayPayload) return;
    const url = qrPngDataUrl(payment.promptpayPayload);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `promptpay-${bookingCode}.png`;
    a.click();
  }

  return (
    <section className="pay" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="pay__title">{labels?.title ?? bt.payTitle}</h2>
      {labels && <p className="pay__intro">{labels.intro}</p>}
      <p className="pay__amount">
        <span>{labels?.amount ?? (laterSatang > 0 ? bt.amountDueDeposit : bt.amountDue)}</span>
        <strong>{amount}</strong>
      </p>
      {laterSatang > 0 && <p className="pay__later">{fill(bt.payLaterNote, { amount: formatBaht(laterSatang, locale.code) })}</p>}
      {expiresAt && (
        <p className="pay__deadline">
          {fill(bt.pay.deadline, { time: timeText(expiresAt) })}
          {left && <span className="pay__left"> · {fill(bt.pay.left, { time: left })}</span>}
        </p>
      )}

      {channels.length > 1 && (
        <fieldset className="pay-channels">
          <legend className="pay-channels__legend">{bt.pay.choose}</legend>
          <div className="pay-channels__list">
            {channels.map((c) => (
              <label key={c} className={`pay-channel${current === c ? " is-selected" : ""}`}>
                <input type="radio" name={`${id}-channel`} value={c} checked={current === c} onChange={() => { setChannel(c); setPaypalError(null); }} />
                <span className="pay-channel__text">
                  <strong>{bt.pay.channels[c]}</strong>
                  <small>{bt.pay.hints[c]}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="pay-panel" role="group" aria-label={bt.pay.channels[current]}>
        {current === "PROMPTPAY" && payment.promptpayNumber && (
          <div className="pay__body">
            {payment.promptpayPayload && (
              <figure className="pay-qr">
                <QrCode value={payment.promptpayPayload} label={fill(bt.pay.promptpayQrAlt, { amount })} />
                <figcaption className="pay-qr__brand">PromptPay · {amount}</figcaption>
                <button type="button" className="pay__copy pay-qr__save" onClick={saveQr}>{bt.pay.saveQr}</button>
              </figure>
            )}
            <div className="pay-panel__text">
              <p className="pay-panel__how">{fill(bt.pay.promptpayHow, { amount })}</p>
              <dl className="pay__details">
                <CopyRow label={bt.promptpay} value={payment.promptpayNumber} />
                <div className="pay__row"><dt>{bt.accountName}</dt><dd>{payment.accountName}</dd></div>
                <CopyRow label={bt.pay.amount} value={amount} copyValue={amountPlain} />
              </dl>
            </div>
          </div>
        )}

        {current === "BANK_TRANSFER" && (
          <div className="pay-panel__text">
            <p className="pay-panel__how">{fill(bt.pay.bankHow, { amount })}</p>
            <dl className="pay__details">
              <div className="pay__row"><dt>{bt.bankName}</dt><dd>{payment.bankName}</dd></div>
              <div className="pay__row"><dt>{bt.accountName}</dt><dd>{payment.accountName}</dd></div>
              {payment.accountNumber && <CopyRow label={bt.accountNumber} value={payment.accountNumber} />}
              <CopyRow label={bt.pay.amount} value={amount} copyValue={amountPlain} />
            </dl>
          </div>
        )}

        {current === "QR_CODE" && payment.qrUrl && (
          <div className="pay__body">
            <img className="pay__qr" src={payment.qrUrl} alt={bt.qrAlt} width={220} height={220} decoding="async" />
            <div className="pay-panel__text">
              <p className="pay-panel__how">{fill(bt.pay.qrHow, { amount })}</p>
              <dl className="pay__details">
                <div className="pay__row"><dt>{bt.bankName}</dt><dd>{payment.bankName}</dd></div>
                <div className="pay__row"><dt>{bt.accountName}</dt><dd>{payment.accountName}</dd></div>
                <CopyRow label={bt.pay.amount} value={amount} copyValue={amountPlain} />
              </dl>
            </div>
          </div>
        )}

        {current === "PAYPAL" && (
          <div className="pay-paypal">
            <p className="pay-panel__how">{fill(bt.pay.paypalHow, { amount })}</p>
            {paypalError && <p className="field-error" role="alert">{paypalError}</p>}
            <button type="button" className="button button--primary pay-paypal__button" disabled={paypalBusy} aria-busy={paypalBusy || undefined}
              onClick={() => void payWithPaypal()}>
              {paypalBusy ? bt.pay.paypalOpening : `${bt.pay.paypalButton} · ${amount}`}
            </button>
            <p className="pay__note">{bt.pay.paypalNote}</p>
          </div>
        )}
      </div>

      {SLIP.includes(current) && (
        <>
          <p className="pay__note">{labels?.afterTransfer ?? bt.pay.afterTransfer}</p>
          {slip(current as SlipChannel)}
        </>
      )}
    </section>
  );
}
