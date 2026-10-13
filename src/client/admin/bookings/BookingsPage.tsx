import { useCallback, useState, type FormEvent } from "react";
import type { AdminBookingSummaryDto, BookingStatus, PaymentStatus } from "../../../shared/booking-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button } from "../ui.tsx";
import { useCursorList } from "../useCursorList.ts";
import { BookingStatusBadge, useStayDate } from "./shared.tsx";
import { StayButtons } from "./StayButtons.tsx";

const PAYMENTS: PaymentStatus[] = ["UNPAID", "PENDING_VERIFICATION", "VERIFIED", "PAID", "REJECTED", "REFUNDED"];
const STATUSES: BookingStatus[] = ["PENDING", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "EXPIRED", "NO_SHOW"];

export function BookingsPage() {
  const { t, href, locale } = useAdmin();
  const stayDate = useStayDate();
  const [status, setStatus] = useState<string>("");
  // Deep links from the dashboard, e.g. ?payment=UNPAID (allow-listed values only).
  const initialPayment = (() => {
    const p = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("payment");
    return p && ["UNPAID", "PENDING_VERIFICATION", "VERIFIED", "PAID", "REJECTED", "REFUNDED"].includes(p) ? p : "";
  })();
  // …or ?due=1: confirmed deposit bookings that still owe the rest (dashboard "still due at check-in").
  const initialDue = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("due") === "1";
  const [payment, setPayment] = useState<string>(initialPayment);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [due, setDue] = useState(initialDue);
  const [filters, setFilters] = useState({ status: "", payment: initialPayment, from: "", to: "", q: "", due: initialDue ? "1" : "" });

  const buildUrl = useCallback((before: string | null) => {
    const params = new URLSearchParams({ limit: "30" });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    if (before) params.set("before", before);
    return `/api/admin/bookings?${params}`;
  }, [filters]);
  const { items, cursor, loading, error, more, update } = useCursorList<AdminBookingSummaryDto>(buildUrl);
  const [stayMsg, setStayMsg] = useState<string | null>(null);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setFilters({ status, payment, from, to, q: q.trim(), due: due ? "1" : "" });
  };

  return (
    <section>
      <div className="adm-pagehead">
        <h1 className="adm-h1">{t.bk.title}</h1>
      </div>

      <form role="search" className="adm-filters" onSubmit={apply}>
        <label className="adm-filter">
          <span>{t.bk.status}</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t.bk.allStatuses}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t.bk[`s${s}`]}</option>)}
          </select>
        </label>
        <label className="adm-filter">
          <span>{t.bk.payment}</span>
          <select value={payment} onChange={(e) => setPayment(e.target.value)}>
            <option value="">{t.pay.allPayments}</option>
            {PAYMENTS.map((p) => <option key={p} value={p}>{t.bk[`p${p}`]}</option>)}
          </select>
        </label>
        <label className="adm-filter">
          <span>{t.bk.stayFrom}</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="adm-filter">
          <span>{t.bk.stayTo}</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="adm-filter adm-filter--grow">
          <span>{t.common.search}</span>
          <input type="search" placeholder={t.bk.searchPlaceholder} maxLength={60} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="adm-filter adm-filter--toggle">
          <input type="checkbox" checked={due} onChange={(e) => setDue(e.currentTarget.checked)} />
          <span>{t.bk.dueOnly}</span>
        </label>
        <Button type="submit" variant="secondary">{t.common.search}</Button>
      </form>

      {error && <Alert kind="error">{error}</Alert>}
      {stayMsg && <Alert kind="success">{stayMsg}</Alert>}
      <div className="adm-tablewrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">{t.bk.code}</th>
              <th scope="col">{t.bk.guest}</th>
              <th scope="col">{t.bk.stay}</th>
              <th scope="col">{t.bk.item}</th>
              <th scope="col" className="adm-num">{t.bk.total}</th>
              <th scope="col">{t.bk.status}</th>
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && <tr><td colSpan={6} className="adm-table__empty">{t.bk.empty}</td></tr>}
            {items.map((b) => (
              <tr key={b.id}>
                <td><Link to={href("bookings", b.bookingCode)} className="adm-table__primary adm-mono">{b.bookingCode}</Link></td>
                <td>
                  {b.customerName}
                  <div className="adm-muted adm-small">{b.customerPhone}</div>
                </td>
                <td className="adm-small">
                  {stayDate(b.checkIn)} → {stayDate(b.checkOut)}
                  <div className="adm-muted">{format(t.bk.nights, { n: b.nights })} · {format(t.bk.guests, { adults: b.adults, children: b.children })}</div>
                </td>
                <td className="adm-small">
                  {b.itemName}
                  {b.itemType === "OWN_TENT" && <div className="adm-muted">{format(t.bk.tents, { n: b.quantity })}{b.tarps > 0 && ` + ${t.bk.tarp}`}</div>}
                </td>
                <td className="adm-num">
                  {formatBaht(b.totalSatang, locale.code)}
                  {/* Deposit plan: what is still to be taken at check-in. */}
                  {b.depositSatang !== null && b.status === "CONFIRMED" && b.balanceSatang > 0 && (
                    <div className="adm-small adm-due">{format(t.pay.balanceBadge, { amount: formatBaht(b.balanceSatang, locale.code) })}</div>
                  )}
                </td>
                <td>
                  <BookingStatusBadge status={b.status} />
                  <div className="adm-muted adm-small">{t.bk[`p${b.paymentStatus}`]}</div>
                  <StayButtons compact code={b.bookingCode} checkIn={b.checkIn} actions={b.stayActions}
                    balanceSatang={b.status === "CONFIRMED" ? b.balanceSatang : 0}
                    onDone={(next, message) => {
                      update((rows) => rows.map((r) => (r.bookingCode === next.bookingCode
                        ? { ...r, status: next.status, paymentStatus: next.paymentStatus, stayActions: next.stayActions, balanceSatang: next.balanceSatang } : r)));
                      setStayMsg(message);
                    }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <p role="status">{t.common.loading}</p>}
      {cursor && !loading && <Button variant="secondary" onClick={more}>{t.common.loadMore}</Button>}
    </section>
  );
}
