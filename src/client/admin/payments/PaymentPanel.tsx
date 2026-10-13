import { useState, type FormEvent } from "react";
import type { AdminBookingDto } from "../../../shared/booking-types.ts";
import { formatBaht, parseBahtToSatang, SATANG_PER_BAHT } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { localDateTimeIn, DEFAULT_TIMEZONE } from "../../../shared/dates.ts";
import { PAYMENT_METHODS, type PaymentMethod } from "../../../shared/payment-types.ts";
import { apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, Field, fieldErrors, useDateFormatter } from "../ui.tsx";
import { DeclineDialog } from "./SlipsPage.tsx";

/** "2027-01-10T14:30" entered in property time → ISO instant (Asia/Bangkok has no DST: +07:00). */
function bangkokToIso(local: string): string {
  return new Date(`${local}:00+07:00`).toISOString();
}

/** Payment section of the admin booking page: account snapshot, payments, record & refund. */
/**
 * The booking page remounts this panel when the booking's status / payments change, so a success note is
 * handed up with onChanged(text) and comes back as `notice` — otherwise "Approved" would vanish at once.
 */
export function PaymentPanel({ booking, notice = null, onChanged }: {
  booking: AdminBookingDto; notice?: string | null; onChanged: (notice?: string) => void;
}) {
  const { t, can, locale, href } = useAdmin();
  const dateTime = useDateFormatter();
  const baht = (s: number) => formatBaht(s, locale.code);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(notice ? { kind: "success", text: notice } : null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    // Deposit plan: the deposit is what the booking asks for now; the rest is taken at check-in.
    amount: String((booking.depositSatang ?? booking.totalSatang) / SATANG_PER_BAHT),
    method: "BANK_TRANSFER" as PaymentMethod,
    paidAt: localDateTimeIn(DEFAULT_TIMEZONE, new Date()),
    reference: "",
    note: "",
  });
  const [refund, setRefund] = useState<{ paymentId: string; amount: string; reason: string } | null>(null);
  const [confirm, setConfirm] = useState<"record" | "refund" | "approve" | null>(null);
  const [busy, setBusy] = useState(false);
  const [txRef, setTxRef] = useState("");
  const [declining, setDeclining] = useState(false);

  // A pending slip is approved / declined (here or on the Slips page), never answered by recording a second payment.
  const awaiting = booking.status === "PENDING" && ["UNPAID", "REJECTED"].includes(booking.paymentStatus);
  const pending = booking.status === "PENDING" && can("payments.verify") ? booking.payments.find((p) => p.status === "PENDING_VERIFICATION") ?? null : null;

  async function doApprove() {
    setConfirm(null);
    if (!pending) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiRequest("POST", `/api/admin/payments/${encodeURIComponent(pending.id)}/verify`, txRef.trim() ? { transactionRef: txRef.trim() } : {});
      setTxRef("");
      setMessage({ kind: "success", text: t.slip.verifiedDone });
      onChanged(t.slip.verifiedDone);
    } catch (err) {
      setMessage({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  async function doDecline(reason: string, cancelBooking: boolean) {
    if (!pending) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiRequest("POST", `/api/admin/payments/${encodeURIComponent(pending.id)}/reject`, { reason, cancelBooking });
      setDeclining(false);
      setMessage({ kind: "success", text: cancelBooking ? t.slip.cancelledDone : t.slip.rejectedDone });
      onChanged(cancelBooking ? t.slip.cancelledDone : t.slip.rejectedDone);
    } catch (err) {
      setDeclining(false);
      setMessage({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }
  const refundable = booking.status === "CANCELLED" || booking.status === "NO_SHOW";

  async function doRecord() {
    setConfirm(null);
    const amountSatang = parseBahtToSatang(form.amount);
    if (amountSatang === null) return setErrors({ amountSatang: t.errors.INVALID_PRICE });
    setBusy(true);
    setErrors({});
    try {
      await apiRequest("POST", `/api/admin/bookings/${encodeURIComponent(booking.bookingCode)}/payments`, {
        amountSatang, method: form.method, paidAt: bangkokToIso(form.paidAt),
        ...(form.reference.trim() ? { reference: form.reference.trim() } : {}), ...(form.note.trim() ? { note: form.note.trim() } : {}),
      });
      setMessage({ kind: "success", text: t.pay.recorded });
      onChanged(t.pay.recorded);
    } catch (err) {
      setErrors(fieldErrors(t, err));
      setMessage({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  async function doRefund() {
    setConfirm(null);
    if (!refund) return;
    const amountSatang = parseBahtToSatang(refund.amount);
    if (amountSatang === null) return setErrors({ refundAmount: t.errors.INVALID_PRICE });
    setBusy(true);
    try {
      await apiRequest("POST", `/api/admin/bookings/${encodeURIComponent(booking.bookingCode)}/payments/${encodeURIComponent(refund.paymentId)}/refund`,
        { amountSatang, reason: refund.reason.trim() });
      setRefund(null);
      setMessage({ kind: "success", text: t.pay.refunded });
      onChanged(t.pay.refunded);
    } catch (err) {
      setMessage({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  const acc = booking.paymentAccount;
  const deposit = booking.depositSatang;
  /** Deposit plan: the first money in is the deposit, later money is the balance taken at check-in. */
  const firstPaid = booking.payments.find((p) => p.status === "PAID" || p.status === "VERIFIED" || p.status === "REFUNDED")?.id ?? null;
  return (
    <div className="adm-card" id="payment">
      <h2 className="adm-h2">{t.pay.paymentTitle} · <span className="adm-muted">{t.bk[`p${booking.paymentStatus}`]}</span></h2>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}

      {acc && (
        <div className="adm-snapshot">
          <p className="adm-small adm-muted">{t.pay.snapshot} · {dateTime(acc.capturedAt)}</p>
          <p>
            <strong>{acc.bankName}</strong> · {acc.accountName}
            {acc.accountNumber && <> · <span className="adm-mono">{acc.accountNumber}</span></>}
            {acc.promptpayNumber && <> · PromptPay <span className="adm-mono">{acc.promptpayNumber}</span></>}
          </p>
        </div>
      )}

      {deposit !== null && (
        <dl className="adm-dl adm-deposit">
          <dt>{t.pay.plan}</dt>
          <dd>{format(t.pay.planDeposit, { deposit: baht(deposit), later: baht(booking.totalSatang - deposit) })}</dd>
          <dt>{t.pay.paidTotal}</dt>
          <dd>{baht(booking.paidSatang)}</dd>
          <dt>{t.pay.balance}</dt>
          <dd>{booking.balanceSatang > 0 ? <strong className="adm-due">{baht(booking.balanceSatang)}</strong> : t.pay.paidInFull}</dd>
        </dl>
      )}

      <h3 className="adm-h3">{t.pay.payments}</h3>
      {booking.payments.length === 0 ? <p className="adm-muted">{t.pay.noPayments}</p> : (
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">{t.pay.paidAt}</th><th scope="col">{t.pay.method}</th><th scope="col" className="adm-num">{t.pay.amount}</th>
                <th scope="col">{t.bk.status}</th>{refundable && can("payments.refund") && <th scope="col"><span className="visually-hidden">{t.pay.refund}</span></th>}
              </tr>
            </thead>
            <tbody>
              {booking.payments.map((p) => (
                <tr key={p.id}>
                  <td className="adm-small">
                    {dateTime(p.paidAt ?? p.submittedAt)}
                    {p.verifiedByName && <div className="adm-muted">{t.pay.by} {p.verifiedByName}</div>}
                  </td>
                  <td className="adm-small">
                    {deposit !== null && (p.status === "PAID" || p.status === "VERIFIED" || p.status === "REFUNDED") && (
                      <span className="adm-badge adm-badge--muted adm-deposit__kind">{p.id === firstPaid ? t.pay.kindDeposit : t.pay.kindBalance}</span>
                    )}
                    {p.channel ? t.pay[`c${p.channel}`] : t.pay[`m${p.method}`]}
                    {p.reference && <div className="adm-muted">{t.pay.ref}: {p.reference}</div>}
                    {p.note && <div className="adm-muted">{p.note}</div>}
                    {p.slipUrl && can("slips.view") && <div><a href={p.slipUrl} target="_blank" rel="noopener">{t.slip.viewSlip}</a></div>}
                  </td>
                  <td className="adm-num">
                    {baht(p.amountSatang)}
                    {p.refundAmountSatang !== null && <div className="adm-small adm-muted">− {baht(p.refundAmountSatang)}</div>}
                  </td>
                  <td className="adm-small">
                    {t.bk[`p${p.status}`]}
                    {p.refundReason && <div className="adm-muted">{p.refundReason}</div>}
                  </td>
                  {refundable && can("payments.refund") && (
                    <td>
                      {(p.status === "PAID" || p.status === "VERIFIED") && (
                        <Button variant="secondary" onClick={() => setRefund({ paymentId: p.id, amount: String(p.amountSatang / SATANG_PER_BAHT), reason: "" })}>
                          {t.pay.refund}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pending && (
        <div className="adm-subform adm-slip-review" role="group" aria-labelledby="slip-review-h">
          <h3 id="slip-review-h" className="adm-h3 adm-subform__title">{t.pay.reviewTitle}</h3>
          <div className="adm-slip-review__body">
            {pending.slipUrl && can("slips.view") && (
              <a href={pending.slipUrl} target="_blank" rel="noopener" className="adm-slip-review__img" aria-label={t.slip.openSlip}>
                <img src={pending.slipUrl} alt={format(t.slip.slipAlt, { code: booking.bookingCode })} loading="lazy" decoding="async" />
              </a>
            )}
            <div className="adm-slip-review__text">
              <p>
                {pending.channel ? t.pay[`c${pending.channel}`] : t.pay[`m${pending.method}`]} · <strong>{baht(pending.amountSatang)}</strong>
                {" · "}<span className="adm-small adm-muted">{t.slip.submitted} {dateTime(pending.submittedAt)}</span>
              </p>
              {pending.channel === "PAYPAL" && <Alert kind="info">{t.slip.paypalNote}</Alert>}
              <p className="adm-field__hint">{t.pay.reviewHint}</p>
              {can("slips.view") && <p className="adm-small"><Link to={href("slips")}>{t.pay.reviewChecks}</Link></p>}
              <form className="adm-inline" onSubmit={(e: FormEvent) => { e.preventDefault(); setConfirm("approve"); }}>
                {pending.slipUrl && (
                  <input aria-label={t.slip.txRefInput} placeholder={t.slip.txRefInput} maxLength={64} value={txRef} onChange={(e) => setTxRef(e.target.value)} />
                )}
                <Button type="submit" busy={busy}>{t.slip.approve}</Button>
                <Button variant="danger" busy={busy} onClick={() => setDeclining(true)}>{t.slip.reject}</Button>
              </form>
            </div>
          </div>
          <DeclineDialog open={declining} code={booking.bookingCode} canCancel={can("bookings.cancel")} busy={busy}
            onClose={() => setDeclining(false)} onSubmit={(r, c) => void doDecline(r, c)} />
        </div>
      )}

      {refund && (
        <form className="adm-subform" onSubmit={(e: FormEvent) => { e.preventDefault(); setConfirm("refund"); }}>
          <div className="adm-grid2">
            <Field label={t.pay.refundAmount} required inputMode="decimal" value={refund.amount} error={errors.refundAmount}
              onChange={(e) => setRefund({ ...refund, amount: e.target.value })} />
            <Field label={t.pay.refundReason} required minLength={3} maxLength={500} value={refund.reason}
              onChange={(e) => setRefund({ ...refund, reason: e.target.value })} />
          </div>
          <div className="adm-row">
            <Button type="submit" variant="danger" busy={busy}>{t.pay.refund}</Button>
            <Button variant="secondary" onClick={() => setRefund(null)}>{t.common.cancel}</Button>
          </div>
        </form>
      )}

      {awaiting && can("payments.verify") && (
        <form className="adm-subform" onSubmit={(e: FormEvent) => { e.preventDefault(); setConfirm("record"); }}>
          <h3 className="adm-h3">{t.pay.record}</h3>
          {deposit !== null && <p className="adm-field__hint">{format(t.pay.recordDepositHint, { amount: baht(deposit) })}</p>}
          <div className="adm-grid2">
            <Field label={t.pay.amount} required inputMode="decimal" value={form.amount} error={errors.amountSatang}
              onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            <div className="adm-field">
              <label htmlFor="pay-method">{t.pay.method}</label>
              <select id="pay-method" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as PaymentMethod })}>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t.pay[`m${m}`]}</option>)}
              </select>
            </div>
            <Field label={t.pay.paidAt} type="datetime-local" required value={form.paidAt} error={errors.paidAt}
              onChange={(e) => setForm({ ...form, paidAt: e.target.value })} />
            <Field label={t.pay.reference} maxLength={100} value={form.reference} error={errors.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </div>
          <Field label={t.pay.note} maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <Button type="submit" busy={busy}>{t.pay.record}</Button>
        </form>
      )}

      <ConfirmDialog open={confirm !== null} danger={confirm === "refund"}
        message={confirm === "refund" ? t.pay.refundConfirm : confirm === "approve" ? t.slip.verifyConfirm : t.pay.recordConfirm}
        confirmLabel={confirm === "refund" ? t.pay.refund : confirm === "approve" ? t.slip.approve : t.pay.record}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void (confirm === "refund" ? doRefund() : confirm === "approve" ? doApprove() : doRecord())} />
    </div>
  );
}
