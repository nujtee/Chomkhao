import { useEffect, useRef, useState } from "react";
import type { AdminBookingDto, BookingMoveOptionsDto, MoveDayState } from "../../../shared/booking-types.ts";
import { addDays, diffDays, monthRange } from "../../../shared/dates.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, errorMessage } from "../ui.tsx";
import { useStayDate } from "./shared.tsx";

type Tone = "ok" | "taken" | "off" | "current";

/** Green = the stay can start that day (every night free), red = it cannot, grey = outside what may be chosen. */
export const MOVE_TONE: Record<MoveDayState, Tone> = {
  OK: "ok",
  TAKEN: "taken",
  FOOD_FULL: "taken",
  TARP_FULL: "taken",
  PAST: "off",
  TOO_FAR: "off",
  CURRENT: "current",
};

/** Sunday-first weeks of one month: leading blanks, then the month's days. */
export function monthWeeks<T>(month: string, days: T[]): (T | null)[][] {
  const cells: (T | null)[] = [...Array<null>(new Date(`${month}T00:00:00Z`).getUTCDay()).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}

/**
 * Booking page → Stay → Change dates: a month calendar of new check-in days for the same number of nights.
 * Only green days can be clicked. The Worker re-checks the chosen day and moves nights, tents / tarp areas
 * and meals in one batch, so a day taken in the meantime is refused (409) and the calendar reloads.
 */
export function MoveDates({ booking, onMoved }: { booking: AdminBookingDto; onMoved: (next: AdminBookingDto, message: string) => void }) {
  const { t, c, locale } = useAdmin();
  const stayDate = useStayDate();
  const code = booking.bookingCode;
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthRange(booking.checkIn).start);
  const [data, setData] = useState<BookingMoveOptionsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  /** A stay in a month that has passed opens on the current month — once, then the admin navigates. */
  const settled = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { start, next } = monthRange(month);
    setData(null);
    setLoadError(null);
    apiGet<BookingMoveOptionsDto>(`/api/admin/bookings/${encodeURIComponent(code)}/move-options?from=${start}&days=${diffDays(start, next)}`, controller.signal)
      .then((res) => {
        const current = monthRange(res.today).start;
        if (!settled.current && current > month) {
          settled.current = true;
          setMonth(current);
          return;
        }
        settled.current = true;
        setData(res);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(t, err));
      });
    return () => controller.abort();
  }, [open, month, code, t, version]);

  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <div className="adm-move__open">
        <Button variant="secondary" onClick={() => setOpen(true)}>{t.bk.moveDates}</Button>
      </div>
    );
  }

  const nights = format(t.bk.nights, { n: booking.nights });
  const newOut = picked ? addDays(picked, booking.nights) : null;
  const monthName = (m: string) => new Intl.DateTimeFormat(locale.code, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}T00:00:00Z`));
  const weekday = new Intl.DateTimeFormat(locale.code, { weekday: "short", timeZone: "UTC" });
  // 2023-01-01 was a Sunday.
  const weekdays = Array.from({ length: 7 }, (_, i) => weekday.format(new Date(Date.UTC(2023, 0, 1 + i))));
  const prevMonth = monthRange(addDays(month, -1)).start;
  const nextMonth = monthRange(month).next;
  const canPrev = !!data && monthRange(data.today).start < month;
  const canNext = !!data && data.days[data.days.length - 1]?.state !== "TOO_FAR";
  const stateLabel: Record<MoveDayState, string> = {
    OK: t.bk.moveFree,
    TAKEN: t.bk.moveTaken,
    FOOD_FULL: `${t.bk.moveTaken} (${t.bk.moveFoodFull})`,
    TARP_FULL: `${t.bk.moveTaken} (${t.bk.moveTarpFull})`,
    PAST: `${t.bk.moveOff} (${t.bk.movePast})`,
    TOO_FAR: `${t.bk.moveOff} (${t.bk.moveTooFar})`,
    CURRENT: t.bk.moveCurrent,
  };

  const go = (m: string) => {
    setPicked(null);
    setSaveError(null);
    setMonth(m);
  };

  async function save() {
    if (!picked) return;
    setConfirming(false);
    setBusy(true);
    setSaveError(null);
    try {
      const next = await apiRequest<AdminBookingDto>("POST", `/api/admin/bookings/${encodeURIComponent(code)}/move`, { checkIn: picked });
      setOpen(false);
      onMoved(next, format(t.bk.moved, { from: stayDate(next.checkIn), to: stayDate(next.checkOut) }));
    } catch (err) {
      // Most often the day was taken meanwhile: show the calendar as it is now.
      setSaveError(detailMessage(t, err));
      setPicked(null);
      setVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-move" role="group" aria-labelledby="move-h">
      <div className="adm-move__bar">
        <h3 className="adm-move__title" id="move-h" ref={heading} tabIndex={-1}>{t.bk.moveDates}</h3>
        <Button variant="ghost" onClick={() => setOpen(false)}>{t.bk.moveClose}</Button>
      </div>
      <p className="adm-field__hint">{format(t.bk.moveHint, { nights })}</p>

      <div className="adm-move__nav">
        <Button variant="secondary" disabled={!canPrev} aria-label={`${c.ui.previous}: ${monthName(prevMonth)}`} onClick={() => go(prevMonth)}>←</Button>
        <p className="adm-move__month" aria-live="polite">{monthName(month)}</p>
        <Button variant="secondary" disabled={!canNext} aria-label={`${c.ui.next}: ${monthName(nextMonth)}`} onClick={() => go(nextMonth)}>→</Button>
      </div>

      {loadError && <Alert kind="error">{loadError}</Alert>}
      {!data && !loadError && <p role="status" className="adm-move__loading">{t.common.loading}</p>}
      {data && (
        <table className="adm-move__grid">
          <caption className="adm-sr">{monthName(month)}</caption>
          <thead>
            <tr>{weekdays.map((w) => <th key={w} scope="col">{w}</th>)}</tr>
          </thead>
          <tbody>
            {monthWeeks(month, data.days).map((week, i) => (
              <tr key={i}>
                {week.map((d, j) => {
                  if (!d) return <td key={`blank-${j}`} />;
                  const tone = MOVE_TONE[d.state];
                  const was = d.date >= booking.checkIn && d.date < booking.checkOut;
                  const inNew = picked !== null && newOut !== null && d.date >= picked && d.date < newOut;
                  const cls = ["adm-move__day", `adm-move__day--${tone}`, was && "adm-move__day--was", inNew && "adm-move__day--new", picked === d.date && "adm-move__day--picked"]
                    .filter(Boolean).join(" ");
                  return (
                    <td key={d.date} title={stateLabel[d.state]}>
                      <button type="button" className={cls} data-date={d.date} data-state={d.state} disabled={d.state !== "OK" || busy}
                        aria-pressed={d.state === "OK" ? picked === d.date : undefined}
                        aria-label={`${stayDate(d.date)} — ${stateLabel[d.state]}`}
                        onClick={() => { setPicked(d.date); setSaveError(null); }}>
                        {Number(d.date.slice(8))}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ul className="adm-move__legend">
        <li><span className="adm-move__swatch adm-move__day--ok" aria-hidden="true" />{t.bk.moveFree}</li>
        <li><span className="adm-move__swatch adm-move__day--taken" aria-hidden="true" />{t.bk.moveTaken}</li>
        <li><span className="adm-move__swatch adm-move__day--was" aria-hidden="true" />{t.bk.moveCurrent}</li>
        <li><span className="adm-move__swatch adm-move__day--off" aria-hidden="true" />{t.bk.moveOff}</li>
      </ul>

      <p className="adm-move__summary" aria-live="polite">
        {picked && newOut ? format(t.bk.moveNew, { from: stayDate(picked), to: stayDate(newOut), nights }) : t.bk.movePick}
      </p>
      <p className="adm-field__hint">{t.bk.movePriceNote}</p>
      {saveError && <p className="adm-field__error" role="alert">{saveError}</p>}
      <Button disabled={!picked} busy={busy} onClick={() => setConfirming(true)}>{t.bk.moveSave}</Button>
      <ConfirmDialog open={confirming} confirmLabel={t.bk.moveSave}
        message={picked && newOut ? format(t.bk.moveConfirm, {
          code, oldFrom: stayDate(booking.checkIn), oldTo: stayDate(booking.checkOut), from: stayDate(picked), to: stayDate(newOut),
        }) : ""}
        onConfirm={() => void save()} onCancel={() => setConfirming(false)} />
    </div>
  );
}
