import { useEffect, useState } from "react";
import type { AdminBookingDto } from "../../../shared/booking-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { getLineMessages } from "../../../shared/i18n/admin-line-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, errorMessage, useDateFormatter } from "../ui.tsx";
import { PaymentPanel } from "../payments/PaymentPanel.tsx";
import { BookingStatusBadge, useStayDate } from "./shared.tsx";
import { MoveDates } from "./MoveDates.tsx";
import { StayButtons } from "./StayButtons.tsx";
import { StaysCard } from "./StaysCard.tsx";
import { AdminBillButton } from "./AdminBillButton.tsx";
import { staysText } from "./shared.tsx";

export function BookingDetailPage({ code }: { code: string }) {
  const { t, c, can, href, locale } = useAdmin();
  const [stayDone, setStayDone] = useState<string | null>(null);
  const dateTime = useDateFormatter();
  const stayDate = useStayDate();
  const [b, setB] = useState<AdminBookingDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const [version, setVersion] = useState(0);
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiGet<AdminBookingDto>(`/api/admin/bookings/${encodeURIComponent(code)}`, controller.signal)
      .then(setB)
      .catch((err: unknown) => !controller.signal.aborted && setError(errorMessage(t, err)));
    return () => controller.abort();
  }, [code, t, version]);

  async function cancel() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    setPaymentNotice(null);
    setStayDone(null);
    try {
      setB(await apiRequest<AdminBookingDto>("POST", `/api/admin/bookings/${encodeURIComponent(code)}/cancel`, { reason: reason.trim() }));
      setDone(true);
    } catch (err) {
      setError(detailMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  const stayChanged = (next: AdminBookingDto, message: string) => {
    setB(next);
    setError(null);
    setPaymentNotice(null);
    setStayDone(message);
  };

  const baht = (s: number) => formatBaht(s, locale.code);
  const back = <p><Link to={href("bookings")}>← {t.bk.back}</Link></p>;
  if (!b) return <section>{back}{error ? <Alert kind="error">{error}</Alert> : <p role="status">{t.common.loading}</p>}</section>;

  const cancellable = (b.status === "PENDING" || b.status === "CONFIRMED") && can("bookings.cancel");
  const movable = (b.status === "PENDING" || b.status === "CONFIRMED") && can("bookings.edit");
  const extraFood = b.food.filter((f) => f.includedQuantity === 0);
  const includedFood = b.food.filter((f) => f.includedQuantity > 0);

  return (
    <section>
      {back}
      <div className="adm-pagehead">
        <h1 className="adm-h1 adm-mono">{b.bookingCode}</h1>
        <BookingStatusBadge status={b.status} />
        <AdminBillButton booking={b} />
      </div>
      {done && <Alert kind="success">{t.bk.cancelled}</Alert>}
      {stayDone && <Alert kind="success">{stayDone}</Alert>}
      {can("bookings.edit") && (b.status === "PENDING" || b.status === "CONFIRMED" || b.status === "CHECKED_IN") && (
        <div className="adm-card" role="group" aria-labelledby="stay-h">
          <h2 className="adm-h2" id="stay-h">{c.stay.title}</h2>
          {b.status === "PENDING"
            ? <p className="adm-muted">{c.stay.needConfirmed}</p>
            : <StayButtons code={b.bookingCode} checkIn={b.checkIn} actions={b.stayActions} balanceSatang={b.status === "CONFIRMED" ? b.balanceSatang : 0} onDone={stayChanged} />}
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}

      <div className="adm-grid2">
        <div className="adm-card">
          <h2 className="adm-h2">{t.bk.stay}</h2>
          <dl className="adm-dl">
            <dt>{t.bk.item}</dt>
            <dd>{staysText(b.items.filter((i) => i.status !== "CANCELLED"), (n) => format(t.bk.tents, { n }))}{b.tarp && ` + ${t.bk.tarp}`}</dd>
            <dt>{t.bk.stay}</dt><dd>{stayDate(b.checkIn)} → {stayDate(b.checkOut)} ({format(t.bk.nights, { n: b.nights })})</dd>
            <dt>{t.bk.guest}</dt><dd>{format(t.bk.guests, { adults: b.adults, children: b.children })}</dd>
            <dt>{t.bk.payment}</dt><dd>{t.bk[`p${b.paymentStatus}`]}</dd>
            {b.status === "PENDING" && b.expiresAt && <><dt>{t.bk.expires}</dt><dd>{dateTime(b.expiresAt)}</dd></>}
            <dt>{t.bk.created}</dt><dd>{dateTime(b.createdAt)} · {b.source} · {b.languageCode}</dd>
            {b.cancelledAt && <><dt>{t.bk.cancelledAt}</dt><dd>{dateTime(b.cancelledAt)}</dd><dt>{t.bk.cancelReason}</dt><dd>{b.cancelReason}</dd></>}
          </dl>
          {movable && <MoveDates key={`${b.checkIn}|${b.status}`} booking={b} onMoved={stayChanged} />}
        </div>
        <div className="adm-card">
          <h2 className="adm-h2">{t.bk.customer}</h2>
          <dl className="adm-dl">
            <dt>{t.users.name}</dt><dd>{b.customerName}</dd>
            <dt>{t.bk.phone}</dt><dd><a href={`tel:${b.customerPhone.replace(/[^\d+]/g, "")}`}>{b.customerPhone}</a></dd>
            {b.customerEmail && <><dt>{t.bk.email}</dt><dd>{b.customerEmail}</dd></>}
            {b.customerLineId && <><dt>{t.bk.lineId}</dt><dd>{b.customerLineId}</dd></>}
            {b.lineUpdates.linked && <><dt>LINE</dt><dd><span className="adm-badge adm-badge--active">✓ {getLineMessages(locale.code).bookingLinked}</span></dd></>}
            {b.customerNote && <><dt>{t.bk.note}</dt><dd className="adm-prewrap">{b.customerNote}</dd></>}
            <dt>{t.bk.privacyAccepted}</dt><dd>{dateTime(b.privacyAcceptedAt)}</dd>
          </dl>
        </div>
      </div>

      <StaysCard booking={b} onChanged={stayChanged} />

      <div className="adm-card">
        {(b.includedMeals.length > 0 || b.food.length > 0) && <h2 className="adm-h2">{t.bk.food}</h2>}
        {b.includedMeals.map((m, i) => (
          <p key={`${m.categoryCode}|${i}`} className="adm-small">
            {t.bk.includedMeals}: {m.name} · {format(t.bk.persons, { n: m.personsPerNight })} × {format(t.bk.nights, { n: m.nights })}
            {m.stayName && <span className="adm-muted"> ({m.stayName})</span>}
          </p>
        ))}
        {b.food.length > 0 && (
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead>
                <tr><th scope="col">{t.bk.serviceDate}</th><th scope="col">{t.bk.food}</th><th scope="col" className="adm-num">{t.bk.qty}</th><th scope="col" className="adm-num">{t.bk.total}</th></tr>
              </thead>
              <tbody>
                {[...includedFood, ...extraFood].map((f) => (
                  <tr key={`${f.optionId}|${f.serviceDate}|${f.includedQuantity}`}>
                    <td>{stayDate(f.serviceDate)}</td>
                    <td>{f.name} <span className="adm-muted adm-small">{f.categoryCode}</span></td>
                    <td className="adm-num">{f.quantity}{f.pricingType === "PER_PERSON" && <span className="adm-muted adm-small"> ({f.adults}+{f.children})</span>}</td>
                    <td className="adm-num">{f.includedQuantity > 0 ? t.bk.included : baht(f.subtotalSatang)}</td>
                  </tr>
                ))}
                <tr className="adm-table__total"><th scope="row" colSpan={3}>{t.bk.foodSubtotal}</th><td className="adm-num">{baht(b.foodSubtotalSatang)}</td></tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="adm-total">{t.bk.total}: <strong>{baht(b.totalSatang)}</strong></p>
      </div>

      {can("payments.view") && <PaymentPanel key={`${b.status}-${b.paymentStatus}-${b.payments.length}-${b.totalSatang}-${b.depositSatang ?? ""}`} booking={b} notice={paymentNotice}
        onChanged={(text) => { setPaymentNotice(text ?? null); setVersion((v) => v + 1); }} />}

      {cancellable && (
        <div className="adm-card adm-card--danger">
          <h2 className="adm-h2">{t.bk.cancel}</h2>
          <div className="adm-field">
            <label htmlFor="cancel-reason">{t.bk.cancelReason}<span aria-hidden="true"> *</span></label>
            <textarea id="cancel-reason" rows={2} maxLength={500} value={reason} aria-describedby="cancel-reason-hint" onChange={(e) => setReason(e.target.value)} />
            <p id="cancel-reason-hint" className="adm-field__hint">{t.bk.cancelReasonHint}</p>
          </div>
          <Button variant="danger" disabled={reason.trim().length < 3} busy={busy} onClick={() => setConfirming(true)}>{t.bk.cancel}</Button>
          <ConfirmDialog open={confirming} danger message={t.bk.cancelConfirm} confirmLabel={t.bk.cancel}
            onConfirm={() => void cancel()} onCancel={() => setConfirming(false)} />
        </div>
      )}
    </section>
  );
}
