import { useEffect, useId, useState, type FormEvent } from "react";
import type { AvailabilityDto, PublicCampingDto } from "../../shared/accommodation-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { nightsBetween, stayLimits, type StayQuery } from "../accommodation/data.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Stepper } from "./FoodStep.tsx";
import { useDateText } from "./Summary.tsx";
import { useBookingT } from "./useBookingT.ts";

type Check = { data?: AvailabilityDto; error?: string };

/** The requested tents fit every night, and the tarp area too when asked for. */
export function campingFits(a: AvailabilityDto, tarp: boolean): boolean {
  if (a.camping.fitsTents !== true) return false;
  return !tarp || (a.camping.tarp.offered && a.camping.tarp.remaining > 0 && a.camping.tarp.shortNights.length === 0);
}

/**
 * Own-tent camping booking: dates, adults and children (children under the free age stay free),
 * number of tents and the optional tarp area. "Book" checks the nights first and goes straight on
 * to the booking steps when everything fits; otherwise it says what to change, right here.
 * With `onPeek`, the tent spots (and tarp areas) still free on the chosen dates show as soon as the dates are set.
 */
export function CampingBooker({ camping, initial, initialTarp = false, onCheck, onPeek, onBook }: {
  camping: PublicCampingDto;
  initial: StayQuery;
  initialTarp?: boolean;
  onCheck: (q: StayQuery) => Promise<Check>;
  /** Live availability for the dates only (no side effects on the page): keep it stable (useCallback). */
  onPeek?: (q: StayQuery) => Promise<Check>;
  onBook: (q: StayQuery, tarp: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const bt = useBookingT();
  const dateText = useDateText();
  const id = useId();
  const limits = stayLimits();
  const [q, setQ] = useState<StayQuery>(initial);
  const [tarp, setTarp] = useState(initialTarp && !!camping.tarp);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ a: AvailabilityDto; q: StayQuery; tarp: boolean } | null>(null);
  /** Spots left, for the dates in `key` ("checkIn|checkOut"). */
  const [left, setLeft] = useState<{ key: string; a: AvailabilityDto } | null>(null);

  // Dates and guests chosen in the search at the top of the page carry over.
  useEffect(() => {
    setQ((cur) => ({ ...cur, checkIn: initial.checkIn, checkOut: initial.checkOut, adults: initial.adults, children: initial.children }));
  }, [initial.checkIn, initial.checkOut, initial.adults, initial.children]);

  const datesKey = `${q.checkIn}|${q.checkOut}`;
  const datesOk = !!q.checkIn && !!q.checkOut && q.checkIn < q.checkOut && q.checkIn >= limits.min && q.checkOut <= limits.max;
  // Spots left change with the dates only: ask once the guest stops changing them.
  useEffect(() => {
    if (!onPeek || !datesOk) return;
    let stale = false;
    const timer = setTimeout(() => {
      void onPeek({ checkIn: q.checkIn, checkOut: q.checkOut, adults: 1, children: 0, tents: 1 }).then((r) => {
        if (!stale && r.data) setLeft({ key: `${q.checkIn}|${q.checkOut}`, a: r.data });
      });
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [onPeek, datesOk, q.checkIn, q.checkOut]);

  const perTent = camping.maxGuestsPerTent;
  const minTents = perTent ? Math.max(1, Math.ceil((q.adults + q.children) / perTent)) : 1;
  const nights = nightsBetween(q);
  const change = (next: Partial<StayQuery>) => {
    setResult(null);
    setError(null);
    setQ((cur) => {
      const merged = { ...cur, ...next };
      // More guests than the tents hold: add tents (the guest can still see and change the number).
      const need = perTent ? Math.ceil((merged.adults + merged.children) / perTent) : 1;
      return merged.tents < need ? { ...merged, tents: need } : merged;
    });
  };

  async function run(query: StayQuery) {
    setBusy(true);
    setError(null);
    const r = await onCheck(query);
    setBusy(false);
    if (!r.data) {
      setResult(null);
      setError(r.error ?? bt.errors.UNKNOWN);
      return;
    }
    setResult({ a: r.data, q: query, tarp });
    setLeft({ key: `${query.checkIn}|${query.checkOut}`, a: r.data });
    if (campingFits(r.data, tarp)) onBook(query, tarp);
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(q);
  };

  const c = result?.a.camping;
  const live = onPeek && left?.key === datesKey ? left.a.camping : null;
  const shortDate = new Intl.DateTimeFormat(locale.code, { day: "numeric", month: "short", timeZone: "UTC" });
  const perNight = !!live && live.nights.length > 1 && new Set(live.nights.map((n) => n.remaining)).size > 1;
  const tarpBlocked = !!result && result.tarp && !!c && c.fitsTents === true && !campingFits(result.a, true);
  return (
    <form className="camping-form" onSubmit={submit} aria-labelledby={`${id}-title`} noValidate>
      <h3 id={`${id}-title`} className="camping-form__title">{bt.campingFormTitle}</h3>
      <div className="camping-form__dates">
        <div className="stay-search__field">
          <label htmlFor={`${id}-in`}>{t.accommodation.checkIn}</label>
          <input id={`${id}-in`} type="date" required min={limits.min} max={limits.max} value={q.checkIn}
            onChange={(e) => change({ checkIn: e.target.value })} />
        </div>
        <div className="stay-search__field">
          <label htmlFor={`${id}-out`}>{t.accommodation.checkOut}</label>
          <input id={`${id}-out`} type="date" required min={q.checkIn || limits.min} max={limits.max} value={q.checkOut}
            onChange={(e) => change({ checkOut: e.target.value })} />
        </div>
      </div>
      {onPeek && datesOk && (
        <div className="camping-form__left" aria-live="polite">
          {!live ? <p className="camping-form__left-line is-wait">{bt.campingLeftChecking}</p> : (
            <>
              <p className={`camping-form__left-line ${live.remaining >= q.tents ? "is-ok" : "is-bad"}`}>
                {live.remaining > 0 ? fill(bt.campingLeft, { n: live.remaining }) : bt.campingLeftNone}
              </p>
              {live.remaining > 0 && live.remaining < q.tents && <p className="camping-form__left-note">{fill(bt.campingLeftShort, { tents: q.tents })}</p>}
              {perNight && (
                <p className="camping-form__left-note">
                  {live.nights.map((n) => fill(bt.campingLeftNight, { date: shortDate.format(new Date(`${n.date}T00:00:00Z`)), n: n.remaining })).join(" · ")}
                </p>
              )}
            </>
          )}
        </div>
      )}

      <div className="camping-form__counts">
        <div className="camping-form__count">
          <span className="camping-form__label">{bt.adults}</span>
          <Stepper label={bt.adults} value={q.adults} min={1} max={50} onChange={(n) => change({ adults: n })} />
        </div>
        <div className="camping-form__count">
          <span className="camping-form__label">{fill(bt.children, { age: camping.childFreeUnderAge })}</span>
          <Stepper label={bt.childrenShort} value={q.children} min={0} max={50} onChange={(n) => change({ children: n })} />
        </div>
        <div className="camping-form__count">
          <span className="camping-form__label">{t.accommodation.tents}</span>
          <Stepper label={t.accommodation.tents} value={q.tents} min={minTents} max={50} onChange={(n) => change({ tents: n })} />
        </div>
      </div>
      {perTent && (
        <p className="camping-form__hint">{fill(bt.campingTooFewTents, { guests: q.adults + q.children, n: minTents, per: perTent })}</p>
      )}

      {camping.tarp && (
        <label className="camping-form__option">
          <input type="checkbox" checked={tarp} onChange={(e) => { setTarp(e.target.checked); setResult(null); }} />
          <span>
            <strong>{bt.tarpOption}</strong>
            <small>{fill(bt.tarpOptionPrice, { price: formatBaht(camping.tarp.pricePerNightSatang, locale.code) })}</small>
            {live?.tarp.offered && (
              <small className={live.tarp.remaining > 0 ? "is-ok" : "is-bad"}>
                {live.tarp.remaining > 0 ? fill(bt.tarpLeft, { n: live.tarp.remaining }) : bt.tarpLeftNone}
              </small>
            )}
          </span>
        </label>
      )}

      <div className="camping-form__foot">
        <button type="submit" className="button button--primary" disabled={busy} aria-busy={busy || undefined}>
          {busy ? t.accommodation.searching : bt.selectCamping}
        </button>
        {nights > 0 && <span className="stay-search__nights">{fill(t.accommodation.nights, { n: nights })}</span>}
      </div>

      <div aria-live="polite">
        {error && <p className="camping-hint camping-hint--error" role="alert">{error}</p>}
        {c && result && !campingFits(result.a, result.tarp) && (
          <>
            {!live && (
              <p className={`unit-card__badge-inline ${c.fitsTents && !tarpBlocked ? "is-ok" : "is-bad"}`}>
                {c.remaining > 0 ? fill(t.accommodation.tentsRemaining, { n: c.remaining }) : t.accommodation.campingFull}
              </p>
            )}
            {c.reason === "TOO_FEW_TENTS" && (
              <p className="camping-hint">
                {fill(bt.campingTooFewTents, { guests: result.q.adults + result.q.children, n: c.minTents, per: perTent ?? "" })}{" "}
                {c.minTents <= c.maxTentsPerBooking && (
                  <button type="button" className="button button--secondary" onClick={() => { const next = { ...q, tents: c.minTents }; setQ(next); void run(next); }}>
                    {fill(bt.useTents, { n: c.minTents })}
                  </button>
                )}
              </p>
            )}
            {c.reason === "TOO_MANY_TENTS" && <p className="camping-hint">{fill(bt.campingTooManyTents, { n: c.maxTentsPerBooking })}</p>}
            {c.reason === "FULL" && c.shortNights.length > 0 && c.remaining > 0 && (
              <p className="camping-hint">{fill(bt.campingShortNights, { tents: result.q.tents, dates: c.shortNights.map(dateText).join(", ") })}</p>
            )}
            {tarpBlocked && (
              <p className="camping-hint">
                {c.tarp.offered && c.tarp.shortNights.length
                  ? fill(bt.tarpFullNights, { dates: c.tarp.shortNights.map(dateText).join(", ") })
                  : c.tarp.offered ? bt.errors.TARP_FULL : bt.errors.TARP_UNAVAILABLE}
              </p>
            )}
          </>
        )}
      </div>
    </form>
  );
}
