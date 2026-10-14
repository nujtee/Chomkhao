import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBaht } from "../../../shared/booking-rules.ts";
import type { CalendarBookingDto, CalendarDto } from "../../../shared/dashboard-types.ts";
import { addDays, diffDays, monthRange } from "../../../shared/dates.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { PageTabs } from "../cms/CmsKit.tsx";
import { Alert, Button, errorMessage } from "../ui.tsx";
import { BookingStatusBadge, PaymentBadge, staysText, useStayDate } from "./shared.tsx";

type View = "day" | "week" | "month" | "custom";

/** Monday of the week containing `date` (business dates, UTC arithmetic). */
function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

function rangeFor(view: View, anchor: string): { from: string; to: string } {
  if (view === "day") return { from: anchor, to: addDays(anchor, 1) };
  if (view === "week") { const from = weekStart(anchor); return { from, to: addDays(from, 7) }; }
  const m = monthRange(anchor);
  return { from: m.start, to: m.next };
}

/** Booking calendar (spec §49): every stay night of every unit, camping per night, bookings in range. */
export function CalendarPage() {
  const { t, c, locale, href } = useAdmin();
  const stayDate = useStayDate();
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [data, setData] = useState<CalendarDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (from: string | null, to: string | null) => {
    setError(null);
    try {
      const q = from && to ? `?from=${from}&to=${to}` : "";
      const res = await apiGet<CalendarDto>(`/api/admin/calendar${q}`);
      setData(res);
      return res;
    } catch (err) {
      setError(errorMessage(t, err));
      return null;
    }
  }, [t]);

  useEffect(() => {
    if (view === "custom") return;
    if (!anchor) {
      // First load: ask the server for "today" (property time zone), then align to the view.
      void load(null, null).then((res) => res && setAnchor(res.today));
      return;
    }
    const r = rangeFor(view, anchor);
    void load(r.from, r.to);
  }, [view, anchor, load]);

  const step = (dir: 1 | -1) => {
    if (!anchor) return;
    if (view === "day") setAnchor(addDays(anchor, dir));
    else if (view === "week") setAnchor(addDays(anchor, 7 * dir));
    else if (view === "month") {
      const m = monthRange(anchor);
      setAnchor(dir === 1 ? m.next : monthRange(addDays(m.start, -1)).start);
    }
  };

  const byUnitDate = useMemo(() => {
    const map = new Map<string, { bookingCode: string | null; blockReason: string | null }>();
    for (const n of data?.nights ?? []) map.set(`${n.unitId}|${n.date}`, n);
    return map;
  }, [data]);
  const bookingByCode = useMemo(() => new Map((data?.bookings ?? []).map((b) => [b.bookingCode, b])), [data]);

  const dayHead = new Intl.DateTimeFormat(locale.code, { weekday: "short", day: "numeric", timeZone: "UTC" });
  const title = data ? `${stayDate(data.from)} – ${stayDate(addDays(data.to, -1))}` : "";

  return (
    <section>
      <h1 className="adm-h1">{c.cal.title}</h1>
      <div className="adm-toolbar">
        <PageTabs label={c.cal.title} value={view} onChange={(v) => { setView(v); if (v === "custom" && data) setCustom({ from: data.from, to: data.to }); }}
          tabs={[{ value: "day", label: c.cal.day }, { value: "week", label: c.cal.week }, { value: "month", label: c.cal.month }, { value: "custom", label: c.cal.custom }]} />
        {view !== "custom" ? (
          <div className="adm-row">
            <Button variant="secondary" aria-label={c.ui.previous} onClick={() => step(-1)}>←</Button>
            <Button variant="secondary" onClick={() => data && setAnchor(data.today)}>{c.ui.today}</Button>
            <Button variant="secondary" aria-label={c.ui.next} onClick={() => step(1)}>→</Button>
          </div>
        ) : (
          <form className="adm-row adm-row--wrap" onSubmit={(e) => { e.preventDefault(); void load(custom.from, custom.to); }}>
            <label className="adm-field adm-field--inline"><span>{c.ui.from}</span>
              <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.currentTarget.value })} /></label>
            <label className="adm-field adm-field--inline"><span>{c.ui.to}</span>
              <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.currentTarget.value })} /></label>
            <Button type="submit" disabled={!custom.from || !custom.to || diffDays(custom.from, custom.to) < 1}>{c.ui.apply}</Button>
            <span className="adm-field__hint">{c.cal.rangeHint}</span>
          </form>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!data && !error && <p role="status">{t.common.loading}</p>}
      {data && (
        <>
          <h2 className="adm-h2">{title}</h2>
          <div className="adm-tablewrap adm-calwrap">
            <table className="adm-cal">
              <thead>
                <tr>
                  <th scope="col" className="adm-cal__unit">{c.cal.unit}</th>
                  {data.dates.map((d) => (
                    <th key={d} scope="col" className={d === data.today ? "adm-cal__today" : undefined}>{dayHead.format(new Date(`${d}T00:00:00Z`))}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.units.map((u) => (
                  <tr key={u.id}>
                    <th scope="row" className="adm-cal__unit">
                      {u.names[locale.code] ?? u.names.th ?? u.code}
                      {(u.names[locale.code] ?? u.names.th) && (u.names[locale.code] ?? u.names.th) !== u.code && <span className="adm-small adm-muted"> {u.code}</span>}
                    </th>
                    {data.dates.map((d, i) => {
                      const n = byUnitDate.get(`${u.id}|${d}`);
                      if (!n) return <td key={d} className={d === data.today ? "adm-cal__today" : undefined} />;
                      if (!n.bookingCode) return <td key={d} className="adm-cal__blocked" title={format(c.cal.blocked, { reason: n.blockReason ?? "" })}>✕</td>;
                      const b = bookingByCode.get(n.bookingCode);
                      const starts = i === 0 || byUnitDate.get(`${u.id}|${data.dates[i - 1]}`)?.bookingCode !== n.bookingCode;
                      return (
                        <td key={d} className={`adm-cal__night adm-cal__night--${(b?.status ?? "PENDING").toLowerCase()}`}>
                          <Link to={href("bookings", n.bookingCode)} className="adm-cal__link" title={b ? tooltip(b) : n.bookingCode}>
                            {starts ? (b?.customerName ?? n.bookingCode) : <span className="adm-sr">{n.bookingCode}</span>}
                          </Link>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {data.camping.enabled && (
                  <tr>
                    <th scope="row" className="adm-cal__unit">{c.cal.camping}</th>
                    {data.camping.nights.map((n) => (
                      <td key={n.date} className={`adm-cal__camp${n.used >= n.max ? " adm-cal__camp--full" : ""}`}>
                        {format(c.cal.tents, { used: n.used, max: n.max })}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="adm-card">
            <h2 className="adm-h2">{c.cal.bookingsInRange} ({data.bookings.length})</h2>
            {data.bookings.length === 0 ? <p className="adm-muted">{c.cal.noBookings}</p> : (
              <div className="adm-tablewrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th scope="col">{t.bk.code}</th><th scope="col">{t.bk.guest}</th><th scope="col">{t.bk.item}</th>
                      <th scope="col">{t.bk.stay}</th><th scope="col">{t.bk.status}</th><th scope="col" className="adm-num">{t.bk.total}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bookings.map((b) => (
                      <tr key={b.bookingCode}>
                        <td className="adm-nowrap"><Link to={href("bookings", b.bookingCode)} className="adm-mono">{b.bookingCode}</Link></td>
                        <td>{b.customerName ?? "—"}<div className="adm-small adm-muted">{format(c.cal.guests, { adults: b.adults, children: b.children })}</div></td>
                        <td>{(b.stays?.length ?? 0) > 1 ? staysText(b.stays, (n) => `× ${n}`).replace(/ · ×/g, " ×") : <>{b.itemName}{b.itemType === "OWN_TENT" && ` × ${b.quantity}`}</>}{b.tarps > 0 && ` + ${t.bk.tarp}`}</td>
                        <td className="adm-nowrap">{stayDate(b.checkIn)} → {stayDate(b.checkOut)}<div className="adm-small adm-muted">{format(c.cal.nights, { n: b.nights })}</div></td>
                        <td><BookingStatusBadge status={b.status} /> <PaymentBadge status={b.paymentStatus} /></td>
                        <td className="adm-num">{b.totalSatang === null ? "—" : formatBaht(b.totalSatang, locale.code)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );

  function tooltip(b: CalendarBookingDto): string {
    return [b.bookingCode, b.customerName, `${stayDate(b.checkIn)} → ${stayDate(b.checkOut)}`, format(c.cal.guests, { adults: b.adults, children: b.children }),
      t.bk[`p${b.paymentStatus}`], b.totalSatang !== null ? formatBaht(b.totalSatang, locale.code) : null].filter(Boolean).join(" · ");
  }
}
