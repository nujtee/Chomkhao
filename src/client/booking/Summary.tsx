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

  return (
    <section className="summary" aria-labelledby="summary-h">
      <H id="summary-h" className="summary__title">{bt.summary}</H>
      <p className="summary__item">
        <strong>{quote.item.name}</strong>
        {quote.item.type === "OWN_TENT" && <> · {fill(bt.tentsLine, { n: quote.item.quantity })}</>}
        {quote.tarp && <> + {bt.tarpLine}</>}
      </p>
      <p className="summary__meta">
        {fill(bt.stayLine, { checkIn: dateText(quote.checkIn), checkOut: dateText(quote.checkOut), n: quote.nights })}
        <br />
        {fill(bt.guestsLine, { adults: quote.adults, children: quote.children })}
      </p>

      <dl className="summary__lines">
        {quote.item.nightly.map((n) => (
          <div key={n.date} className="summary__line summary__line--sub">
            <dt>{dateText(n.date)}{quote.item.pricingType === "PER_ADULT_NIGHT" && ` × ${quote.adults}`}</dt>
            <dd>{baht(quote.item.pricingType === "PER_ADULT_NIGHT" ? n.priceSatang * quote.adults : n.priceSatang)}</dd>
          </div>
        ))}
        {quote.tarp && (
          <div className="summary__line summary__line--sub">
            <dt>{fill(bt.tarpNights, { n: quote.tarp.nights })}</dt>
            <dd>{baht(quote.tarp.subtotalSatang)}</dd>
          </div>
        )}
        <div className="summary__line">
          <dt>{bt.accommodation}</dt>
          <dd>{baht(quote.accommodationSubtotalSatang)}</dd>
        </div>

        {quote.includedMeals.map((m) => (
          <div key={m.categoryCode} className="summary__line summary__line--sub">
            <dt>{fill(bt.includedLine, { name: m.name, n: m.personsPerNight, nights: m.nights })}</dt>
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
