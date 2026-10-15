import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PublicBookingDto } from "../../shared/booking-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { getBookingMessages } from "../../shared/i18n/booking-messages.ts";
import type { LocaleCode } from "../../shared/i18n/locales.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useSite } from "../site/SiteProvider.tsx";

const fillText = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

/**
 * Printable statement of a booking (ใบแจ้งยอด — not a tax invoice). Opens over the page; "Save as PDF" is the
 * browser's print dialog, which shapes Thai and Chinese text correctly without embedding fonts. Used by the guest
 * (confirmation / lookup, after code + phone) and by staff (booking detail). Needs no i18n provider: the admin passes
 * its own language.
 */
export function BookingBill(props: BillProps) {
  const { booking: b, onClose } = props;
  const m = getBookingMessages(props.lang).bill;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const title = document.title;
    document.title = `${m.title} ${b.bookingCode}`;
    return () => { document.removeEventListener("keydown", onKey); document.title = title; };
  }, [onClose, m.title, b.bookingCode]);
  return createPortal(<BillDocument {...props} />, document.body);
}

interface BillProps {
  booking: PublicBookingDto;
  lang: LocaleCode;
  siteName: string | null;
  logoUrl?: string | null;
  /** The phone to print: full for staff, masked for the guest. */
  phone: string;
  onClose: () => void;
}

/** The statement itself (toolbar + A4 sheet), without the portal. */
export function BillDocument({ booking: b, lang, siteName, logoUrl, phone, onClose }: BillProps) {
  const bt = getBookingMessages(lang);
  const m = bt.bill;
  const baht = (s: number) => formatBaht(s, lang);
  const day = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const date = (d: string) => day.format(new Date(`${d}T00:00:00Z`));
  const issued = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date());

  const live = (b.items?.length ? b.items : [b.item]).filter((x) => x.status !== "CANCELLED");
  const extra = b.food.filter((f) => f.includedQuantity === 0);
  const rows: { name: string; qty: string; amount: string }[] = [
    ...live.map((x) => ({
      name: x.name,
      qty: [fillText(m.nights, { n: b.nights }), x.type === "OWN_TENT" ? fillText(bt.tentsLine, { n: x.quantity }) : null,
        x.pricingType === "PER_ADULT_NIGHT" ? fillText(m.perAdult, { n: x.adults }) : null].filter(Boolean).join(" · "),
      amount: baht(x.subtotalSatang),
    })),
    ...(b.tarp ? [{ name: m.tarp, qty: fillText(m.nights, { n: b.tarp.nights }), amount: baht(b.tarp.subtotalSatang) }] : []),
    ...b.includedMeals.map((x) => ({ name: x.name, qty: `${x.personsPerNight} × ${fillText(m.nights, { n: x.nights })}`, amount: bt.included })),
    ...extra.map((f) => ({ name: `${f.name} · ${date(f.serviceDate)}`, qty: String(f.quantity), amount: f.subtotalSatang === 0 ? bt.free : baht(f.subtotalSatang) })),
    ...(b.appFee && b.appFee.totalSatang > 0
      ? [{ name: bt.appFee, qty: fillText(bt.appFeeLine, { n: b.appFee.units, price: baht(b.appFee.perUnitSatang) }), amount: baht(b.appFee.totalSatang) }]
      : []),
  ];

  return (
    <div className="bill-overlay" role="dialog" aria-modal="true" aria-labelledby="bill-title" lang={lang}>
      <div className="bill-toolbar">
        <button type="button" className="bill-btn" onClick={onClose}>← {m.back}</button>
        <button type="button" className="bill-btn bill-btn--primary" onClick={() => window.print()} autoFocus>{m.print}</button>
      </div>
      <article className="bill">
        <header className="bill__head">
          {logoUrl && <img src={logoUrl} alt="" className="bill__logo" />}
          <div>
            {siteName && <p className="bill__site">{siteName}</p>}
            <h1 id="bill-title" className="bill__title">{m.title}</h1>
          </div>
        </header>
        <dl className="bill__meta">
          <div><dt>{m.bookingId}</dt><dd translate="no">{b.bookingCode}</dd></div>
          <div><dt>{m.issued}</dt><dd>{issued}</dd></div>
          <div><dt>{m.customer}</dt><dd>{b.customerName}</dd></div>
          <div><dt>{m.phone}</dt><dd>{phone}</dd></div>
          <div><dt>{m.stay}</dt><dd>{date(b.checkIn)} → {date(b.checkOut)} ({fillText(m.nights, { n: b.nights })})</dd></div>
          <div><dt>{m.status}</dt><dd>{m.statuses[b.paymentStatus]}</dd></div>
        </dl>
        <table className="bill__table">
          <thead>
            <tr><th scope="col">{m.item}</th><th scope="col">{m.qty}</th><th scope="col" className="bill__num">{m.amount}</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}><td>{r.name}</td><td>{r.qty}</td><td className="bill__num">{r.amount}</td></tr>
            ))}
          </tbody>
          <tfoot>
            {b.discountSatang > 0 && <tr><th scope="row" colSpan={2}>{m.discount}</th><td className="bill__num">−{baht(b.discountSatang)}</td></tr>}
            <tr className="bill__total"><th scope="row" colSpan={2}>{m.total}</th><td className="bill__num">{baht(b.totalSatang)}</td></tr>
            <tr><th scope="row" colSpan={2}>{m.paid}</th><td className="bill__num">{baht(b.paidSatang)}</td></tr>
            <tr className="bill__due"><th scope="row" colSpan={2}>{m.balance}</th><td className="bill__num">{baht(Math.max(0, b.balanceSatang))}</td></tr>
          </tfoot>
        </table>
        <p className="bill__note">{m.notTax}</p>
      </article>
    </div>
  );
}

/** Guest side: "View bill / save as PDF" under a booking the guest opened (code + phone). */
export function GuestBillButton({ booking }: { booking: PublicBookingDto }) {
  const { locale } = useI18n();
  const { site } = useSite();
  const [open, setOpen] = useState(false);
  const bt = getBookingMessages(locale.code);
  return (
    <>
      <p className="bill-link">
        <button type="button" className="button button--secondary" onClick={() => setOpen(true)}>{bt.viewBill}</button>
      </p>
      {open && (
        <BookingBill booking={booking} lang={locale.code} siteName={site?.siteName ?? null} logoUrl={site?.logo.main?.url ?? null}
          phone={booking.customerPhoneMasked} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
