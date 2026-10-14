import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { AvailabilityDto, PublicCampingDto } from "../../src/shared/accommodation-types.ts";
import type { QuoteDto } from "../../src/shared/booking-types.ts";
import { getLocale, type LocaleCode } from "../../src/shared/i18n/index.ts";
import { CampingBooker, campingFits } from "../../src/client/booking/CampingBooker.tsx";
import { BookingSummary } from "../../src/client/booking/Summary.tsx";
import { I18nProvider } from "../../src/client/i18n/I18nProvider.tsx";
import { quoteItems } from "../../src/client/analytics/booking-events.ts";

const wrap = (node: ReactNode, code: LocaleCode = "th") => renderToStaticMarkup(<I18nProvider locale={getLocale(code)}>{node}</I18nProvider>);

const camping: PublicCampingDto = {
  enabled: true, name: "นำเต็นท์มาเอง", description: null, pricePerAdultNightSatang: 25000, childFreeUnderAge: 12,
  maxGuestsPerTent: 4, maxTentsPerNight: 30, cover: null, tarp: { pricePerNightSatang: 15000 },
};
const query = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 1, tents: 1 };
const noop = async () => ({});

describe("camping booking form", () => {
  it("dates, adults, children (free under the age), tents, tarp option with its price", () => {
    const html = wrap(<CampingBooker camping={camping} initial={query} onCheck={noop} onBook={() => {}} />);
    assert.equal((html.match(/type="date"/g) ?? []).length, 2);
    assert.match(html, /aria-label="ผู้ใหญ่"/);
    assert.match(html, /aria-label="เด็ก"/);
    assert.match(html, /เด็ก \(อายุต่ำกว่า 12 ปี\)/);
    assert.match(html, /aria-label="จำนวนเต็นท์"|aria-label="เต็นท์"/);
    assert.match(html, /<input type="checkbox"[^>]*\/?>.*เพิ่มพื้นที่กางทาร์ป/s);
    assert.match(html, /\+฿150 \/ คืน · 1 พื้นที่ต่อการจอง/);
    assert.match(html, /<button type="submit"[^>]*>จองลานกางเต็นท์<\/button>/);
    assert.match(html, /2 คืน/);
  });

  it("no tarp option when the owner does not offer it; English texts", () => {
    const html = wrap(<CampingBooker camping={{ ...camping, tarp: null }} initial={query} onCheck={noop} onBook={() => {}} />, "en");
    assert.doesNotMatch(html, /tarp/i);
    assert.match(html, /Children/);
  });

  it("books only when the tents fit and, if asked, a tarp area is free every night", () => {
    const base = {
      enabled: true, remaining: 5, nights: [], fitsTents: true, reason: null, shortNights: [], minTents: 1, maxTentsPerBooking: 10,
      tarp: { offered: true, remaining: 1, shortNights: [] },
    } satisfies AvailabilityDto["camping"];
    const a = (camping: Partial<AvailabilityDto["camping"]>) => ({ camping: { ...base, ...camping } }) as AvailabilityDto;
    assert.equal(campingFits(a({}), false), true);
    assert.equal(campingFits(a({}), true), true);
    assert.equal(campingFits(a({ fitsTents: false, reason: "FULL" }), false), false);
    assert.equal(campingFits(a({ tarp: { offered: true, remaining: 0, shortNights: ["2027-02-02"] } }), true), false);
    assert.equal(campingFits(a({ tarp: { offered: true, remaining: 0, shortNights: ["2027-02-02"] } }), false), true, "tents alone still fit");
    assert.equal(campingFits(a({ tarp: { offered: false, remaining: 0, shortNights: [] } }), true), false);
  });
});

describe("booking summary with a tarp area", () => {
  const stay: QuoteDto["item"] = {
    type: "OWN_TENT", unitId: null, slug: null, name: "นำเต็นท์มาเอง", quantity: 2, pricingType: "PER_ADULT_NIGHT",
    nightly: [{ date: "2027-02-01", priceSatang: 25000 }, { date: "2027-02-02", priceSatang: 25000 }], subtotalSatang: 100000,
    adults: 2, children: 1, payLaterSatang: 0,
  };
  const quote: QuoteDto = {
    checkIn: "2027-02-01", checkOut: "2027-02-03", nights: 2, adults: 2, children: 1,
    item: stay,
    items: [stay],
    tarp: { quantity: 1, pricePerNightSatang: 15000, nights: 2, subtotalSatang: 30000 },
    includedMeals: [], food: [], accommodationSubtotalSatang: 130000, foodSubtotalSatang: 0, discountSatang: 0, totalSatang: 130000, currency: "THB",
    depositSatang: null,
  };

  it("shows tents + tarp, the tarp line and a total that includes it", () => {
    const html = wrap(<BookingSummary quote={quote} />);
    assert.match(html, /2 เต็นท์.*\+.*พื้นที่กางทาร์ป/s);
    assert.match(html, /<dt>พื้นที่กางทาร์ป × 2 คืน<\/dt><dd>฿300<\/dd>/);
    assert.match(html, /<dt>ค่าที่พัก<\/dt><dd>฿1,300<\/dd>/);
    assert.match(html, /<dt>ยอดรวม<\/dt><dd>฿1,300<\/dd>/);
    assert.doesNotMatch(wrap(<BookingSummary quote={{ ...quote, tarp: null, accommodationSubtotalSatang: 100000, totalSatang: 100000 }} />), /ทาร์ป/);
  });

  it("deposit plan: what is paid now and at check-in; once the deposit is in, what is paid and still due", () => {
    const quoted = wrap(<BookingSummary quote={{ ...quote, depositSatang: 65000 }} />);
    assert.match(quoted, /<dt>มัดจำ ชำระตอนนี้<\/dt><dd>฿650<\/dd>/);
    assert.match(quoted, /<dt>ส่วนที่เหลือ ชำระวันเช็กอิน<\/dt><dd>฿650<\/dd>/);
    assert.match(quoted, /ที่พักนี้ชำระมัดจำ 50% ของค่าที่พัก/);
    const paid = wrap(<BookingSummary quote={{ ...quote, depositSatang: 65000, paidSatang: 65000, balanceSatang: 65000 } as QuoteDto} />, "en");
    assert.match(paid, /<dt>Paid<\/dt><dd>฿650<\/dd>/);
    assert.match(paid, /<dt>Balance, pay at check-in<\/dt><dd>฿650<\/dd>/);
    assert.match(wrap(<BookingSummary quote={{ ...quote, depositSatang: 65000, paidSatang: 130000, balanceSatang: 0 } as QuoteDto} />), /<dt>ชำระครบแล้ว<\/dt><dd>฿1,300<\/dd>/);
    assert.doesNotMatch(wrap(<BookingSummary quote={quote} />), /มัดจำ/);
  });

  it("analytics items carry the tarp area (ids and prices only)", () => {
    const items = quoteItems(quote);
    assert.deepEqual(items.map((i) => [i.id, i.price, i.quantity]), [["camping", 500, 2], ["camping_tarp", 300, 1]]);
  });
});
