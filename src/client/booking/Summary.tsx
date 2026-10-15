import type { PublicBookingDto, QuoteDto } from "../../shared/booking-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { fill } from "../accommodation/UnitCard.tsx";
import { useBookingT } from "./useBookingT.ts";

/** A calendar date (YYYY-MM-DD) in the reader's language — never shifted by their time zone. */
export function useDateText() {
  const { locale } = useI18n();
  const fmt = new Intl.DateTimeFormat(locale.code, { day: "numeric", month: "short", year: "numeric", weekday: "short", timeZone: "UTC" });
  return (date: string) => fmt.format(new Date(`${date}T00:00:00Z`));
}

export function useDateTimeText() {
  const { locale } = useI18n();
  const fmt = new Intl.DateTimeFormat(locale.code, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });
  return (iso: string) => fmt.format(new Date(iso));
}

/** Price breakdown for a quote or a booking (booking values come from its snapshots). */
export function BookingSummary({ quote, headingLevel = 2 }: { quote: QuoteDto; headingLevel?: 2 | 3 }) {
  const { locale } = useI18n();
  const bt = useBookingT();
  const dateText = useDateText();
  const baht = (s: number) => formatBaht(s, locale.code);
  const H = `h${headingLevel}` as "h2" | "h3";
  const extra = quote.food.filter((f) => f.includedQuantity === 0);
  // Several stays (houses / VIP tents / camping, same dates); a booking also lists a stay staff cancelled alone.
  const stays = quote.items?.length ? quote.items : [quote.item];
  const live = stays.filter((x) => x.status !== "CANCELLED");
  const cancelled = stays.filter((x) => x.status === "CANCELLED");
  const several = live.length > 1;
  const adultsOf = (x: (typeof stays)[number]) => x.adults ?? quote.adults;

  return (
    <section className="summary" aria-labelledby="summary-h">
      <H id="summary-h" className="summary__title">{bt.summary}</H>
      <p className="summary__item">
        {live.map((x, i) => (
          <span key={x.id ?? `${x.type}|${x.unitId ?? i}`}>
            {i > 0 && " + "}
            <strong>{x.name}</strong>
            {x.type === "OWN_TENT" && <> · {fill(bt.tentsLine, { n: x.quantity })}</>}
            {x.type === "OWN_TENT" && quote.tarp && <> + {bt.tarpLine}</>}
          </span>
        ))}
      </p>
      <p className="summary__meta">
        {fill(bt.stayLine, { checkIn: dateText(quote.checkIn), checkOut: dateText(quote.checkOut), n: quote.nights })}
        <br />
        {fill(bt.guestsLine, { adults: quote.adults, children: quote.children })}
      </p>

      <dl className="summary__lines">
        {live.flatMap((x, i) => {
          const k = x.id ?? `${x.type}|${x.unitId ?? i}`;
          return [
            several && (
              <div key={`${k}|stay`} className="summary__line summary__line--stay">
                <dt>
                  {x.name}
                  <small>{fill(bt.guestsLine, { adults: x.adults, children: x.children })}</small>
                </dt>
                <dd>{baht(x.subtotalSatang + (x.type === "OWN_TENT" && quote.tarp ? quote.tarp.subtotalSatang : 0))}</dd>
              </div>
            ),
            ...x.nightly.map((n) => (
              <div key={`${k}|${n.date}`} className="summary__line summary__line--sub">
                <dt>{dateText(n.date)}{x.pricingType === "PER_ADULT_NIGHT" && ` × ${adultsOf(x)}`}</dt>
                <dd>{baht(x.pricingType === "PER_ADULT_NIGHT" ? n.priceSatang * adultsOf(x) : n.priceSatang)}</dd>
              </div>
            )),
            x.type === "OWN_TENT" && quote.tarp && (
              <div key={`${k}|tarp`} className="summary__line summary__line--sub">
                <dt>{fill(bt.tarpNights, { n: quote.tarp.nights })}</dt>
                <dd>{baht(quote.tarp.subtotalSatang)}</dd>
              </div>
            ),
          ];
        })}
        {cancelled.map((x, i) => (
          <div key={x.id ?? i} className="summary__line summary__line--cancelled">
            <dt>{x.name}</dt>
            <dd>{bt.stayCancelled}</dd>
          </div>
        ))}
        <div className="summary__line">
          <dt>{bt.accommodation}</dt>
          <dd>{baht(quote.accommodationSubtotalSatang)}</dd>
        </div>

        {quote.includedMeals.map((m, i) => (
          <div key={`${m.categoryCode}|${i}`} className="summary__line summary__line--sub">
            <dt>{fill(bt.includedLine, { name: m.name, n: m.personsPerNight, nights: m.nights })}{m.stayName && ` · ${m.stayName}`}</dt>
            <dd>{bt.included}</dd>
          </div>
        ))}
        {extra.map((f) => (
          <div key={`${f.optionId}|${f.serviceDate}`} className="summary__line summary__line--sub">
            <dt>{f.name} · {dateText(f.serviceDate)} × {f.quantity}</dt>
            <dd>{f.subtotalSatang === 0 ? bt.free : baht(f.subtotalSatang)}</dd>
          </div>
        ))}
        {extra.length > 0 && (
          <div className="summary__line">
            <dt>{bt.food}</dt>
            <dd>{baht(quote.foodSubtotalSatang)}</dd>
          </div>
        )}
        {quote.appFee && quote.appFee.totalSatang > 0 && (
          <div className="summary__line">
            <dt>
              {bt.appFee}
              <small>{fill(bt.appFeeLine, { n: quote.appFee.units, price: baht(quote.appFee.perUnitSatang) })}</small>
            </dt>
            <dd>{baht(quote.appFee.totalSatang)}</dd>
          </div>
        )}
        <div className="summary__line summary__line--total">
          <dt>{bt.total}</dt>
          <dd>{baht(quote.totalSatang)}</dd>
        </div>
        <DepositLines quote={quote} baht={baht} />
      </dl>
      {quote.depositSatang !== null && paidOf(quote) === 0 && <p className="summary__note">{bt.depositNote}</p>}
    </section>
  );
}

/** Money received so far — only a booking (not a quote) has it. */
function paidOf(quote: QuoteDto): number {
  return "paidSatang" in quote ? (quote as PublicBookingDto).paidSatang : 0;
}

/** Deposit plan: what is paid now / at check-in, or what is paid and still due once the deposit is in. */
function DepositLines({ quote, baht }: { quote: QuoteDto; baht: (s: number) => string }) {
  const bt = useBookingT();
  if (quote.depositSatang === null) return null;
  const paid = paidOf(quote);
  const rows: [string, number, string][] = paid === 0
    ? [[bt.depositNow, quote.depositSatang, "summary__line--due"], [bt.depositLater, quote.totalSatang - quote.depositSatang, ""]]
    : paid >= quote.totalSatang
      ? [[bt.paidInFull, paid, ""]]
      : [[bt.paidSoFar, paid, ""], [bt.depositLater, quote.totalSatang - paid, "summary__line--due"]];
  return (
    <>
      {rows.map(([label, amount, cls]) => (
        <div key={label} className={`summary__line summary__line--deposit ${cls}`.trim()}>
          <dt>{label}</dt>
          <dd>{baht(amount)}</dd>
        </div>
      ))}
    </>
  );
}
