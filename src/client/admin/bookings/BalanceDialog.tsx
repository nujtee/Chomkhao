import { useEffect, useId, useRef, useState } from "react";
import type { AdminBookingDto } from "../../../shared/booking-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import type { BalanceDueDto, BalanceMethod } from "../../../shared/payment-types.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { QrCode } from "../../booking/QrCode.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, detailMessage, errorMessage } from "../ui.tsx";

/** Ways to take the rest at reception, in the order offered: those the account allows, cash always. */
export function balanceMethods(due: BalanceDueDto): BalanceMethod[] {
  return [
    ...(due.promptpayPayload || due.account?.qrUrl ? ["PROMPTPAY" as const] : []),
    ...(due.account?.accountNumber ? ["BANK_TRANSFER" as const] : []),
    "CASH",
  ];
}

/**
 * Check in a deposit booking that still owes money: shows what is due, the guest picks PromptPay QR (amount filled
 * in), a bank transfer (account number) or cash; staff confirm once the money is in, and the Worker records the
 * payment and checks the guest in in one batch (POST …/balance). Without payments.verify the dialog only shows
 * how to pay.
 */
export function BalanceDialog({ code, open, onClose, onDone }: {
  code: string;
  open: boolean;
  onClose: () => void;
  onDone: (booking: AdminBookingDto, message: string) => void;
}) {
  const { t, can, locale } = useAdmin();
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [due, setDue] = useState<BalanceDueDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<BalanceMethod>("CASH");
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const baht = (s: number) => formatBaht(s, locale.code);
  const canTake = can("payments.verify");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setDue(null);
    setError(null);
    setStep("choose");
    setReference("");
    apiGet<BalanceDueDto>(`/api/admin/bookings/${encodeURIComponent(code)}/balance`, controller.signal)
      .then((d) => {
        setDue(d);
        setMethod(balanceMethods(d)[0]!);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(t, err));
      });
    return () => controller.abort();
  }, [open, code, t]);

  async function take() {
    if (!due) return;
    setBusy(true);
    setError(null);
    try {
      const booking = await apiRequest<AdminBookingDto>("POST", `/api/admin/bookings/${encodeURIComponent(code)}/balance`, {
        method, checkIn: true, ...(method !== "CASH" && reference.trim() ? { reference: reference.trim() } : {}),
      });
      onDone(booking, format(t.pay.balDone, { code, amount: baht(due.balanceSatang) }));
    } catch (err) {
      setError(detailMessage(t, err));
      setStep("choose");
    } finally {
      setBusy(false);
    }
  }

  const label: Record<BalanceMethod, string> = { PROMPTPAY: t.pay.balQr, BANK_TRANSFER: t.pay.balAccount, CASH: t.pay.balCash };
  const got: Record<BalanceMethod, string> = { PROMPTPAY: t.pay.balGotPromptpay, BANK_TRANSFER: t.pay.balGotTransfer, CASH: t.pay.balGotCash };
  const acc = due?.account ?? null;

  return (
    <dialog ref={ref} className="adm-dialog adm-balance" aria-labelledby={`${id}-h`} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <h2 className="adm-h2" id={`${id}-h`}>{t.pay.balTitle}</h2>
      {error && <Alert kind="error">{error}</Alert>}
      {!due && !error && <p role="status">{t.common.loading}</p>}
      {due && (
        <>
          <p className="adm-small adm-muted">{format(t.pay.balIntro, { code, paid: baht(due.paidSatang), total: baht(due.totalSatang) })}</p>
          <p className="adm-balance__due">
            <span>{t.pay.balDue}</span>
            <strong>{baht(due.balanceSatang)}</strong>
          </p>

          {step === "choose" ? (
            <>
              <fieldset className="adm-balance__ways">
                <legend className="adm-field__hint">{t.pay.balChoose}</legend>
                <div className="adm-balance__tabs">
                  {balanceMethods(due).map((m) => (
                    <label key={m} className="adm-balance__tab">
                      <input type="radio" name={`${id}-method`} value={m} checked={method === m} onChange={() => setMethod(m)} />
                      <span>{label[m]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="adm-balance__panel" aria-live="polite">
                {method === "PROMPTPAY" && (
                  <div className="adm-balance__qr">
                    {due.promptpayPayload
                      ? <QrCode value={due.promptpayPayload} label={`${t.pay.balQr} ${baht(due.balanceSatang)}`} size={200} />
                      : acc?.qrUrl && <img src={acc.qrUrl} alt={t.pay.balQr} width={200} height={200} />}
                    <p className="adm-field__hint">{due.promptpayPayload ? t.pay.balQrHint : null}</p>
                    {acc?.promptpayNumber && <p className="adm-small">PromptPay <span className="adm-mono">{acc.promptpayNumber}</span> · {acc.accountName}</p>}
                  </div>
                )}
                {method === "BANK_TRANSFER" && acc && (
                  <dl className="adm-dl adm-balance__account">
                    <dt>{t.pay.bankName}</dt><dd>{acc.bankName}</dd>
                    <dt>{t.pay.accountName}</dt><dd>{acc.accountName}</dd>
                    <dt>{t.pay.accountNumber}</dt><dd className="adm-mono adm-balance__number">{acc.accountNumber}</dd>
                  </dl>
                )}
                {method === "CASH" && <p className="adm-field__hint">{t.pay.balCashHint}</p>}
                {!acc && <p className="adm-field__hint">{t.pay.balNoAccount}</p>}
              </div>

              {method !== "CASH" && canTake && (
                <div className="adm-field">
                  <label htmlFor={`${id}-ref`}>{t.pay.balRef}</label>
                  <input id={`${id}-ref`} maxLength={100} value={reference} onChange={(e) => setReference(e.currentTarget.value)} />
                </div>
              )}
              {!canTake && <Alert kind="info">{t.pay.balNoPermission}</Alert>}
              <div className="adm-dialog__actions">
                <Button variant="secondary" onClick={onClose}>{t.common.cancel}</Button>
                {canTake && <Button onClick={() => setStep("confirm")}>{got[method]}</Button>}
              </div>
            </>
          ) : (
            <>
              <p>{format(t.pay.balConfirm, { amount: baht(due.balanceSatang), method: t.pay[`m${method}`], code })}</p>
              <div className="adm-dialog__actions">
                <Button variant="secondary" disabled={busy} onClick={() => setStep("choose")}>{t.pay.balBack}</Button>
                <Button busy={busy} onClick={() => void take()}>{t.pay.balConfirmButton}</Button>
              </div>
            </>
          )}
        </>
      )}
      {!due && (
        <div className="adm-dialog__actions">
          <Button variant="secondary" onClick={onClose}>{t.common.cancel}</Button>
        </div>
      )}
    </dialog>
  );
}
