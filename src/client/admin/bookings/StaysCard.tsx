import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AdminBookingDto, QuoteItemDto } from "../../../shared/booking-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, detailMessage } from "../ui.tsx";
import { useStayDate } from "./shared.tsx";

/**
 * The stays of a booking (one or several houses / VIP tents / camping), each with its guests and nightly prices
 * from the snapshot. With several stays, staff holding bookings.cancel may cancel one of them: its nights are given
 * back and the booking's total (and deposit) are worked out again by the Worker.
 */
export function StaysCard({ booking: b, onChanged }: { booking: AdminBookingDto; onChanged: (next: AdminBookingDto, message: string) => void }) {
  const { t, can, locale } = useAdmin();
  const stayDate = useStayDate();
  const baht = (s: number) => formatBaht(s, locale.code);
  const [cancelling, setCancelling] = useState<QuoteItemDto | null>(null);
  const live = b.items.filter((i) => i.status !== "CANCELLED");
  const canCancelStay = (b.status === "PENDING" || b.status === "CONFIRMED") && can("bookings.cancel") && live.length > 1;
  /** Snapshots keep the nights as booked: after a date change their dates are the original ones. */
  const first = b.items[0];
  const moved = !!first && first.nightly.length > 0 && first.nightly[0]!.date !== b.checkIn;
  const several = b.items.length > 1;

  return (
    <div className="adm-card">
      <h2 className="adm-h2">{several ? format(t.bk.staysTitle, { n: live.length }) : t.bk.nightly}</h2>
      {moved && <p className="adm-field__hint">{t.bk.nightlyMoved}</p>}
      {b.items.map((item, index) => {
        const cancelled = item.status === "CANCELLED";
        const perAdult = item.pricingType === "PER_ADULT_NIGHT";
        const tarp = item.type === "OWN_TENT" && b.tarp ? b.tarp : null;
        return (
          <section key={item.id ?? index} className={`adm-stay${cancelled ? " is-cancelled" : ""}`} aria-labelledby={`stay-${index}-h`}>
            <div className="adm-stay__head">
              <h3 className="adm-h3 adm-stay__name" id={`stay-${index}-h`}>
                {item.name}
                {item.type === "OWN_TENT" && ` · ${format(t.bk.tents, { n: item.quantity })}`}
                {tarp && ` + ${t.bk.tarp}`}
              </h3>
              {several && <span className="adm-muted adm-small">{format(t.bk.guests, { adults: item.adults, children: item.children })}</span>}
              {cancelled && <span className="adm-badge adm-badge--muted">{t.bk.stayCancelled}</span>}
              {canCancelStay && !cancelled && item.id && (
                <Button variant="secondary" className="adm-stay__cancel" onClick={() => setCancelling(item)}>{t.bk.cancelStay}</Button>
              )}
            </div>
            {cancelled && item.cancelReason && <p className="adm-small adm-muted">{t.bk.cancelReason}: {item.cancelReason}</p>}
            <div className="adm-tablewrap">
              <table className="adm-table">
                <tbody>
                  {item.nightly.map((n) => (
                    <tr key={n.date}>
                      <td>{stayDate(n.date)}</td>
                      <td className="adm-num">
                        {baht(n.priceSatang)} {perAdult ? t.bk.perAdultNight : t.bk.perNight}
                        {perAdult && <span className="adm-muted adm-small"> × {item.adults}</span>}
                      </td>
                    </tr>
                  ))}
                  {tarp && (
                    <tr>
                      <td>{format(t.bk.tarpNights, { n: tarp.nights })}</td>
                      <td className="adm-num">{baht(tarp.subtotalSatang)} ({baht(tarp.pricePerNightSatang)} {t.bk.perNight})</td>
                    </tr>
                  )}
                  {several && (
                    <tr className="adm-table__total">
                      <th scope="row">{t.bk.staySubtotal}</th>
                      <td className="adm-num">{cancelled ? <s>{baht(item.subtotalSatang)}</s> : baht(item.subtotalSatang + (tarp?.subtotalSatang ?? 0))}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <p className="adm-stay__total">{t.bk.accommodationSubtotal}: <strong>{baht(b.accommodationSubtotalSatang)}</strong></p>
      <CancelStayDialog booking={b} item={cancelling} onClose={() => setCancelling(null)}
        onDone={(next) => {
          setCancelling(null);
          const message = format(t.bk.stayCancelledDone, { name: cancelling?.name ?? "", total: baht(next.totalSatang) });
          onChanged(next, next.overpaidSatang > 0 ? `${message} ${format(t.pay.overpaid, { amount: baht(next.overpaidSatang) })}` : message);
        }} />
    </div>
  );
}

function CancelStayDialog({ booking, item, onClose, onDone }: {
  booking: AdminBookingDto; item: QuoteItemDto | null; onClose: () => void; onDone: (next: AdminBookingDto) => void;
}) {
  const { t } = useAdmin();
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (item && !d.open) {
      setReason("");
      setError(null);
      d.showModal?.();
    }
    if (!item && d.open) d.close?.();
  }, [item]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!item?.id || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await apiRequest<AdminBookingDto>("POST",
        `/api/admin/bookings/${encodeURIComponent(booking.bookingCode)}/stays/${encodeURIComponent(item.id)}/cancel`, { reason: reason.trim() }));
    } catch (err) {
      setError(detailMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="adm-dialog" aria-labelledby={`${id}-h`} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <form method="dialog" onSubmit={(e) => void submit(e)}>
        <h2 className="adm-h2" id={`${id}-h`}>{format(t.bk.cancelStayTitle, { name: item?.name ?? "" })}</h2>
        <p className="adm-small">{t.bk.cancelStayHint}</p>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="adm-field">
          <label htmlFor={`${id}-reason`}>{t.bk.cancelReason}<span aria-hidden="true"> *</span></label>
          <textarea id={`${id}-reason`} rows={2} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        </div>
        <div className="adm-dialog__actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t.common.close}</Button>
          <Button type="submit" variant="danger" busy={busy} disabled={reason.trim().length < 3}>{t.bk.cancelStay}</Button>
        </div>
      </form>
    </dialog>
  );
}
