import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AvailabilityDto, PublicUnitDto } from "../../shared/accommodation-types.ts";
import type { FoodCatalogueDto, PublicBookingDto, QuoteDto, QuoteRequest } from "../../shared/booking-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { isIsoDate } from "../../shared/dates.ts";
import { bookingLookupPath } from "../../shared/routes.ts";
import { campingItem, foodChangeEvents, quoteItems, unitItem } from "../analytics/booking-events.ts";
import { track } from "../analytics/tracker.ts";
import { useSite } from "../site/SiteProvider.tsx";
import { ApiError } from "../api/client.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { defaultStay, fetchAvailability, useAccommodations, type StayQuery } from "../accommodation/data.ts";
import { StaySearch } from "../accommodation/StaySearch.tsx";
import { fill, UnitCard, type Availability } from "../accommodation/UnitCard.tsx";
import {
  bookingErrorText,
  cartToSelections,
  createBooking,
  fetchFoodCatalogue,
  fetchQuote,
  newIdempotencyKey,
  type FoodCart,
} from "../booking/api.ts";
import { Confirmation } from "../booking/Confirmation.tsx";
import { FoodStep } from "../booking/FoodStep.tsx";
import { BookingSummary, useDateText } from "../booking/Summary.tsx";
import { CampingBooker } from "../booking/CampingBooker.tsx";
import { guestsForNewUnit, pickKey, pickProblem, PicksBar, StayPicks, type Pick } from "../booking/StayPicks.tsx";
import { useBookingT } from "../booking/useBookingT.ts";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { ResponsiveImage } from "../content/ResponsiveImage.tsx";

type Step = "choose" | "food" | "details" | "review" | "done";
const WIZARD: Step[] = ["food", "details", "review"];

interface Details {
  name: string;
  phone: string;
  email: string;
  lineId: string;
  note: string;
}

/** ?checkIn=&checkOut=&adults=&children=&unit=<slug> — deep link from an accommodation page. */
function initialFromUrl(): { query: StayQuery; unitSlug: string | null } {
  const base = defaultStay();
  if (typeof window === "undefined") return { query: base, unitSlug: null };
  const p = new URLSearchParams(window.location.search);
  const int = (k: string, min: number, fallback: number) => {
    const n = Number(p.get(k));
    return Number.isInteger(n) && n >= min && n <= 50 ? n : fallback;
  };
  const checkIn = p.get("checkIn");
  const checkOut = p.get("checkOut");
  const valid = isIsoDate(checkIn) && isIsoDate(checkOut);
  return {
    query: {
      checkIn: valid ? checkIn : base.checkIn,
      checkOut: valid ? checkOut : base.checkOut,
      adults: int("adults", 1, base.adults),
      children: p.has("children") ? int("children", 0, base.children) : base.children,
      tents: int("tents", 1, base.tents),
    },
    unitSlug: valid ? p.get("unit") : null,
  };
}

export function BookingPage() {
  const { locale, t } = useI18n();
  const bt = useBookingT();
  const dateText = useDateText();
  const { data, error } = useAccommodations(locale.path);
  const [initial] = useState(initialFromUrl);
  const [query, setQuery] = useState<StayQuery>(initial.query);
  const [searched, setSearched] = useState<StayQuery | null>(null);
  const [availability, setAvailability] = useState<AvailabilityDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("choose");
  /** The stays picked (several houses / VIP tents + camping, same dates), each with its own guests. */
  const [picks, setPicks] = useState<Pick[]>([]);
  const [catalogue, setCatalogue] = useState<FoodCatalogueDto | null>(null);
  const [cart, setCart] = useState<FoodCart>({});
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState<Details>({ name: "", phone: "", email: "", lineId: "", note: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [privacy, setPrivacy] = useState(false);
  const [idemKey, setIdemKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [booking, setBooking] = useState<PublicBookingDto | null>(null);
  /** Last tarp choice, kept when the guest goes back to change the stay. */
  const [campingTarp, setCampingTarp] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { site } = useSite();
  /** Funnel steps sent once per chosen stay. */
  const sent = useRef({ viewFood: false, begin: false });

  /** `quiet`: the caller shows the error itself (camping form), not the search box at the top. */
  const search = useCallback(async (q: StayQuery, quiet = false) => {
    setQuery(q);
    if (!quiet) setBusy(true);
    setSearchError(null);
    const result = await fetchAvailability(q, t);
    setBusy(false);
    setAvailability(result.data ?? null);
    setSearched(result.data ? q : null);
    if (!quiet) setSearchError(result.error ?? null);
    return result;
  }, [t]);

  /** Camping form: spots left on its dates, without touching the search results above. */
  const peek = useCallback((q: StayQuery) => fetchAvailability(q, t), [t]);

  // Deep link: run the search once, then go on with the unit if it is free and takes the guests (more can be added later).
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !data || !initial.unitSlug) return;
    autoRan.current = true;
    void search(initial.query).then(({ data: a }) => {
      const unit = [...data.houses, ...data.vipTents].find((u) => u.slug === initial.unitSlug);
      const state = a?.units.find((u) => u.unitId === unit?.id);
      if (!unit || !state?.available) return;
      track({ name: "select_accommodation", item: unitItem(unit) });
      if (state.fitsGuests) start([{ kind: "UNIT", unit, adults: initial.query.adults, children: initial.query.children }], initial.query);
      else setPicks([{ kind: "UNIT", unit, ...guestsForNewUnit(unit, initial.query, []) }]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const request = useCallback((q: StayQuery, chosen: Pick[], foodCart: FoodCart): QuoteRequest => ({
    checkIn: q.checkIn,
    checkOut: q.checkOut,
    adults: chosen.reduce((acc, p) => acc + p.adults, 0),
    children: chosen.reduce((acc, p) => acc + p.children, 0),
    // Every stay with its own guests, on the same dates.
    stays: chosen.map((p) => (p.kind === "UNIT"
      ? { kind: "UNIT", unitId: p.unit.id, adults: p.adults, children: p.children }
      : { kind: "CAMPING", tents: p.tents, ...(p.tarp ? { tarp: true } : {}), adults: p.adults, children: p.children })),
    food: cartToSelections(foodCart, (id) => catalogue?.categories.some((cat) => cat.options.some((o) => o.id === id && o.pricingType === "PER_PERSON")) ?? false),
    lang: locale.code,
  }), [catalogue, locale.code]);

  // Live server-side price whenever the selection changes (debounced).
  useEffect(() => {
    if (!picks.length || !searched || step === "choose" || step === "done") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setQuoting(true);
      fetchQuote(request(searched, picks, cart), controller.signal)
        .then((q) => { setQuote(q); setNotice(null); })
        .catch((err: unknown) => { if (!controller.signal.aborted) setNotice(bookingErrorText(bt, err)); })
        .finally(() => { if (!controller.signal.aborted) setQuoting(false); });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [picks, searched, cart, step, request, bt]);

  useEffect(() => {
    if (step !== "choose") headingRef.current?.focus();
  }, [step]);

  const trackItem = (p: Pick) => (p.kind === "UNIT" ? unitItem(p.unit) : campingItem(data?.camping ?? null, t.accommodation.camping, p.tents));

  /** Add a house / VIP tent to the stays (guests: whoever the search asked for and no other stay holds yet). */
  function addUnit(unit: PublicUnitDto) {
    track({ name: "select_accommodation", item: unitItem(unit) });
    setPicks((cur) => [...cur.filter((p) => pickKey(p) !== unit.id), { kind: "UNIT", unit, ...guestsForNewUnit(unit, searched ?? query, cur) }]);
  }

  /** Start the booking steps with these stays. */
  function start(chosen: Pick[], q: StayQuery = searched ?? query) {
    sent.current = { viewFood: false, begin: false };
    const items = chosen.map(trackItem);
    // Indicative value (one night); the exact total is known at checkout.
    track({ name: "begin_booking", value: chosen.reduce((acc, p, i) => acc + (items[i]!.price ?? 0) * (p.kind === "UNIT" ? 1 : p.adults), 0), items });
    setPicks(chosen);
    setCart({});
    setQuote(null);
    setCatalogue(null);
    setNotice(null);
    setStep("food");
    window.scrollTo({ top: 0 });
    fetchFoodCatalogue(q.checkIn, q.checkOut, locale.code)
      .then(setCatalogue)
      .catch(() => setCatalogue({ checkIn: q.checkIn, checkOut: q.checkOut, categories: [] }));
  }

  useEffect(() => {
    if (step !== "food" || !catalogue || sent.current.viewFood) return;
    sent.current.viewFood = true;
    track({ name: "view_food" });
  }, [step, catalogue]);

  function go(next: Step) {
    if (next === "details" && quote && !sent.current.begin) {
      sent.current.begin = true;
      track({ name: "begin_checkout", value: quote.totalSatang / 100, items: quoteItems(quote) });
    }
    if (next === "review") setIdemKey(newIdempotencyKey());
    setStep(next);
    window.scrollTo({ top: 0 });
  }

  async function confirm() {
    if (!picks.length || !searched || !quote || !idemKey) return;
    if (!privacy) {
      setFieldErrors({ privacyAccepted: bt.errors.MUST_ACCEPT });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const created = await createBooking({
        ...request(searched, picks, cart),
        customer: {
          name: details.name,
          phone: details.phone,
          ...(details.email.trim() ? { email: details.email.trim() } : {}),
          ...(details.lineId.trim() ? { lineId: details.lineId.trim() } : {}),
          ...(details.note.trim() ? { note: details.note.trim() } : {}),
        },
        privacyAccepted: true,
        expectedTotalSatang: quote.totalSatang,
        idempotencyKey: idemKey,
      });
      setBooking(created);
      // Lead: same event_id as the server copy (Conversions API) → Meta keeps one.
      track({ name: "generate_lead", bookingCode: created.bookingCode, value: created.totalSatang / 100 });
      setStep("done");
      window.scrollTo({ top: 0 });
    } catch (err) {
      const text = bookingErrorText(bt, err);
      if (err instanceof ApiError && err.code === "PRICE_CHANGED") {
        setNotice(bt.priceChanged);
        setQuote(await fetchQuote(request(searched, picks, cart)).catch(() => quote));
        setIdemKey(newIdempotencyKey());
      } else if (err instanceof ApiError && ["UNIT_UNAVAILABLE", "CAMPING_FULL", "ACCOMMODATION_NOT_FOUND", "CAMPING_UNAVAILABLE", "TARP_FULL", "TARP_UNAVAILABLE"].includes(err.code)) {
        // Back to the stays: the one just taken goes (the others stay picked).
        setStep("choose");
        const gone = err.details.unitId;
        setPicks((cur) => (gone ? cur.filter((p) => pickKey(p) !== gone)
          : err.code.startsWith("CAMPING") || err.code.startsWith("TARP") ? cur.filter((p) => p.kind !== "CAMPING") : []));
        void search(searched);
        setSearchError(text);
      } else if (err instanceof ApiError && Object.keys(err.details).some((k) => k.startsWith("customer."))) {
        const errors = bt.errors as Record<string, string>;
        setFieldErrors(Object.fromEntries(Object.entries(err.details).map(([k, c]) => [k.replace("customer.", ""), errors[c] ?? text])));
        setStep("details");
      } else if (err instanceof ApiError && (err.code === "FOOD_CAPACITY_EXCEEDED" || Object.keys(err.details).some((k) => k.startsWith("food")))) {
        setNotice(text);
        setStep("food");
        if (searched) fetchFoodCatalogue(searched.checkIn, searched.checkOut, locale.code).then(setCatalogue).catch(() => undefined);
      } else {
        setNotice(text);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function restart() {
    setStep("choose");
    setPicks([]);
    setBooking(null);
    setQuote(null);
    setCart({});
    setPrivacy(false);
    setAvailability(null);
    setSearched(null);
  }

  // A unit too small for the whole group can still be one of several stays: free is enough here.
  const availabilityFor = (unit: PublicUnitDto): Availability => {
    const a = availability?.units.find((u) => u.unitId === unit.id);
    return a ? { available: a.available, fitsGuests: true } : null;
  };

  // ------------------------------------------------------------------ confirmation
  if (step === "done" && booking) {
    return (
      <div className="page container">
        <Confirmation booking={booking} phone={details.phone} headingRef={headingRef} onNewBooking={restart} />
      </div>
    );
  }

  // ------------------------------------------------------------------ wizard
  if (step !== "choose" && picks.length && searched) {
    const index = WIZARD.indexOf(step);
    const titles: Record<string, string> = { food: bt.foodTitle, details: bt.stepDetails, review: bt.stepReview };
    const campingName = data?.camping.name ?? t.accommodation.camping;
    const submitDetails = (e: FormEvent) => {
      e.preventDefault();
      setFieldErrors({});
      go("review");
    };

    return (
      <div className="page container booking-flow">
        <ol className="flow-steps" aria-label={fill(bt.progress, { n: index + 1, total: WIZARD.length + 1 })}>
          {/* The payment step follows on the confirmation page, once the booking holds the stay. */}
          {[bt.stepFood, bt.stepDetails, bt.stepReview, bt.stepPay].map((label, i) => (
            <li key={label} className={i < index ? "is-done" : i === index ? "is-current" : undefined} aria-current={i === index ? "step" : undefined}>
              <span className="flow-steps__n" aria-hidden="true">{i + 1}</span> {label}
            </li>
          ))}
        </ol>

        <section className="flow-stay" aria-label={bt.yourStay}>
          <div>
            {picks.map((p, i) => (
              <span key={pickKey(p)} className="flow-stay__item">
                {i > 0 && " + "}
                <strong>{p.kind === "UNIT" ? p.unit.name : campingName}</strong>
                {p.kind === "CAMPING" && <> · {fill(bt.tentsLine, { n: p.tents })}{p.tarp && ` + ${bt.tarpLine}`}</>}
              </span>
            ))}
            <div className="flow-stay__meta">
              {fill(bt.stayLine, { checkIn: dateText(searched.checkIn), checkOut: dateText(searched.checkOut), n: quote?.nights ?? "" })}
              {" · "}
              {fill(bt.guestsLine, { adults: picks.reduce((a, p) => a + p.adults, 0), children: picks.reduce((a, p) => a + p.children, 0) })}
            </div>
          </div>
          <button type="button" className="button button--ghost" onClick={() => setStep("choose")}>{bt.change}</button>
        </section>

        <h1 className="page__title" tabIndex={-1} ref={headingRef}>{titles[step]}</h1>
        {notice && <p role="alert" className="notice notice--error">{notice}</p>}

        <div className="flow-layout">
          <div className="flow-main">
            {step === "food" && (
              catalogue ? <FoodStep catalogue={catalogue} quote={quote} cart={cart}
                onChange={(next) => { foodChangeEvents(cart, next, catalogue); setCart(next); }} />
                : <p role="status">{t.common.loading}</p>
            )}

            {step === "details" && (
              <form id="details-form" className="flow-form" onSubmit={submitDetails} noValidate={false}>
                <FormField id="bk-name" label={bt.name} required autoComplete="name" maxLength={100} value={details.name}
                  error={fieldErrors.name} onChange={(v) => setDetails({ ...details, name: v })} />
                <FormField id="bk-phone" label={bt.phone} required type="tel" inputMode="tel" autoComplete="tel" maxLength={24}
                  hint={bt.phoneHint} value={details.phone} error={fieldErrors.phone} onChange={(v) => setDetails({ ...details, phone: v })} />
                <FormField id="bk-email" label={bt.email} type="email" autoComplete="email" maxLength={254} value={details.email}
                  error={fieldErrors.email} onChange={(v) => setDetails({ ...details, email: v })} />
                <FormField id="bk-line" label={bt.lineId} maxLength={50} value={details.lineId} error={fieldErrors.lineId}
                  onChange={(v) => setDetails({ ...details, lineId: v })} />
                <div className="form-field">
                  <label htmlFor="bk-note">{bt.note}</label>
                  <textarea id="bk-note" rows={3} maxLength={1000} value={details.note} onChange={(e) => setDetails({ ...details, note: e.target.value })} />
                </div>
              </form>
            )}

            {step === "review" && quote && (
              <div className="flow-review">
                <dl className="review-contact">
                  <div><dt>{bt.name}</dt><dd>{details.name}</dd></div>
                  <div><dt>{bt.phone}</dt><dd>{details.phone}</dd></div>
                  {details.email && <div><dt>{bt.email}</dt><dd>{details.email}</dd></div>}
                  {details.lineId && <div><dt>{bt.lineId}</dt><dd>{details.lineId}</dd></div>}
                  {details.note && <div><dt>{bt.note}</dt><dd className="prose">{details.note}</dd></div>}
                </dl>
                <label className="check">
                  <input type="checkbox" checked={privacy} aria-invalid={fieldErrors.privacyAccepted ? true : undefined}
                    aria-describedby={fieldErrors.privacyAccepted ? "privacy-err" : undefined}
                    onChange={(e) => { setPrivacy(e.target.checked); setFieldErrors({}); }} />
                  <span>{bt.privacy}</span>
                </label>
                {site?.consent?.policyPath && (
                  // New tab: the guest keeps what they typed.
                  <p className="field-hint"><a href={site.consent.policyPath} target="_blank" rel="noopener">{t.footer.privacy}</a></p>
                )}
                {fieldErrors.privacyAccepted && <p id="privacy-err" className="field-error">{fieldErrors.privacyAccepted}</p>}
              </div>
            )}
          </div>

          <aside className="flow-aside">
            {quote ? <BookingSummary quote={quote} /> : <p role="status" className="summary">{bt.calculating}</p>}
            {quoting && quote && <p className="flow-aside__busy" role="status">{bt.calculating}</p>}
          </aside>
        </div>

        <div className="flow-nav">
          <button type="button" className="button button--secondary"
            onClick={() => (index === 0 ? setStep("choose") : go(WIZARD[index - 1]!))}>
            ← {bt.back}
          </button>
          {step === "food" && <button type="button" className="button button--primary" disabled={!quote || quoting} onClick={() => go("details")}>{bt.next} →</button>}
          {step === "details" && <button type="submit" form="details-form" className="button button--primary">{bt.next} →</button>}
          {step === "review" && (
            <button type="button" className="button button--primary" disabled={!quote || quoting || submitting} aria-busy={submitting || undefined}
              onClick={() => void confirm()}>
              {submitting ? bt.confirming : `${bt.confirm} · ${quote ? formatBaht(quote.totalSatang, locale.code) : ""}`}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------ choose
  const empty = data && data.houses.length === 0 && data.vipTents.length === 0 && !data.camping.enabled;
  const canBook = (unit: PublicUnitDto) => !!availabilityFor(unit)?.available;
  const picked = (unit: PublicUnitDto) => picks.some((p) => pickKey(p) === unit.id);
  const ready = picks.length > 0 && picks.reduce((a, p) => a + p.adults, 0) >= 1 && picks.every((p) => pickProblem(p, bt) === null);
  const unitGrid = (units: PublicUnitDto[]) => (
    <div className="unit-grid">
      {units.map((u) => (
        <div key={u.id} className={`unit-pick${picked(u) ? " is-picked" : ""}`}>
          <UnitCard unit={u} availability={availabilityFor(u)} />
          {canBook(u) && (picked(u) ? (
            <button type="button" className="button button--secondary unit-pick__btn" aria-pressed="true"
              onClick={() => setPicks((cur) => cur.filter((p) => pickKey(p) !== u.id))}>
              {bt.picked} · {bt.pickRemove}
            </button>
          ) : (
            <button type="button" className="button button--primary unit-pick__btn" aria-pressed="false" onClick={() => addUnit(u)}>
              {picks.length ? bt.pickAddMore : bt.pickAdd}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
  const campingPick = picks.find((p) => p.kind === "CAMPING");
  const goToCamping = () => document.getElementById("sec-camping")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className={`page container${picks.length ? " has-picks-bar" : ""}`}>
      <h1 className="page__title" tabIndex={-1} ref={headingRef}>{t.pages.booking.title}</h1>
      <p className="page__lead">{t.accommodation.chooseDates}</p>

      <StaySearch initial={query} busy={busy} error={searchError} childAge={data?.camping.childFreeUnderAge} showTents={false}
        onSearch={(q) => {
          // Other dates: what was picked may not be free then.
          if (searched && (q.checkIn !== searched.checkIn || q.checkOut !== searched.checkOut)) setPicks([]);
          void search(q);
        }} />
      {!availability && <p className="notice" role="note">{bt.searchFirst}</p>}
      <p className="lookup-link"><Link to={bookingLookupPath(locale)}>{bt.lookupLink} →</Link></p>
      {picks.length > 0 && (
        <StayPicks picks={picks} camping={data?.camping ?? null} campingName={data?.camping.name ?? t.accommodation.camping}
          onChange={setPicks} onEditCamping={goToCamping} onNext={() => start(picks)} />
      )}

      {error && <p role="alert" className="notice notice--error">{t.common.loadError}</p>}
      {!data && !error && <div className="unit-grid" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="unit-card unit-card--skeleton" />)}</div>}
      {empty && <EmptyState message={t.accommodation.noAccommodation} />}

      {data && data.houses.length > 0 && (
        <section aria-labelledby="sec-houses" className="unit-section">
          <h2 id="sec-houses" className="section-title">{t.accommodation.houses}</h2>
          {unitGrid(data.houses)}
        </section>
      )}

      {data && data.vipTents.length > 0 && (
        <section aria-labelledby="sec-vip" className="unit-section">
          <h2 id="sec-vip" className="section-title">{t.accommodation.vipTents}</h2>
          {unitGrid(data.vipTents)}
        </section>
      )}

      {data && (
        <section aria-labelledby="sec-camping" className="unit-section">
          <h2 id="sec-camping" className="section-title">{data.camping.name ?? t.accommodation.camping}</h2>
          <article className="camping-card">
            {data.camping.cover && <ResponsiveImage image={data.camping.cover} sizes={IMAGE_SIZES.half} className="camping-card__img" />}
            <div className="camping-card__body">
              {!data.camping.enabled ? (
                <p>{t.accommodation.campingDisabled}</p>
              ) : (
                <>
                  {data.camping.description && <p className="prose">{data.camping.description}</p>}
                  <p className="unit-card__price">
                    <strong>{formatBaht(data.camping.pricePerAdultNightSatang, locale.code)}</strong>{" "}
                    <span>{t.accommodation.perAdultPerNight}</span>
                  </p>
                  <p className="unit-card__meta">{fill(t.accommodation.childrenFree, { age: data.camping.childFreeUnderAge })}</p>
                  <CampingBooker camping={data.camping} initial={campingPick ? { ...(searched ?? query), adults: campingPick.adults, children: campingPick.children, tents: campingPick.tents } : searched ?? query}
                    initialTarp={campingPick ? campingPick.kind === "CAMPING" && campingPick.tarp : campingTarp}
                    label={campingPick ? bt.campingUpdate : picks.length ? bt.campingAdd : undefined}
                    onCheck={(q) => search(q, true)} onPeek={peek}
                    onBook={(q, tarp) => {
                      setCampingTarp(tarp);
                      const pick: Pick = { kind: "CAMPING", tents: q.tents, tarp, adults: q.adults, children: q.children };
                      track({ name: "select_accommodation", item: trackItem(pick) });
                      // Camping alone: straight to the booking steps. With other stays: one more stay in the list.
                      const others = picks.filter((p) => p.kind !== "CAMPING");
                      if (others.length) {
                        setPicks([...others, pick]);
                        document.getElementById("picks")?.scrollIntoView({ behavior: "smooth", block: "start" });
                      } else start([pick], q);
                    }} />
                </>
              )}
            </div>
          </article>
        </section>
      )}
      {picks.length > 0 && <PicksBar picks={picks} ready={ready} onNext={() => start(picks)} />}
    </div>
  );
}

function FormField({
  id, label, hint, error, value, onChange, ...input
}: {
  id: string; label: string; hint?: string; error?: string; value: string; onChange: (v: string) => void;
  required?: boolean; type?: string; inputMode?: "tel" | "email" | "text"; autoComplete?: string; maxLength?: number;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}{input.required && <span aria-hidden="true"> *</span>}</label>
      <input id={id} {...input} value={value} onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
      {error && <p id={`${id}-err`} className="field-error">{error}</p>}
    </div>
  );
}
