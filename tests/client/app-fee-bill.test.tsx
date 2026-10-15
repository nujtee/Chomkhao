import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { getLocale, type LocaleCode } from "../../src/shared/i18n/index.ts";
import { I18nProvider } from "../../src/client/i18n/I18nProvider.tsx";
import { BookingSummary } from "../../src/client/booking/Summary.tsx";
import { BillDocument } from "../../src/client/booking/Bill.tsx";

// App-usage fee (migration 0027): one line on the guest's price breakdown and on the printable statement.
const item = {
  type: "HOUSE" as const, unitId: "u1", slug: "house-01", name: "House 01", quantity: 1, pricingType: "PER_UNIT_NIGHT" as const,
  nightly: [{ date: "2027-02-01", priceSatang: 350000 }, { date: "2027-02-02", priceSatang: 350000 }],
  subtotalSatang: 700000, adults: 2, children: 0, payLaterSatang: 0,
};
const quote: QuoteDto = {
  checkIn: "2027-02-01", checkOut: "2027-02-03", nights: 2, adults: 2, children: 0, items: [item], item, tarp: null,
  includedMeals: [], food: [], accommodationSubtotalSatang: 700000, foodSubtotalSatang: 0, discountSatang: 0,
  totalSatang: 702000, currency: "THB", depositSatang: null, appFee: { units: 1, perUnitSatang: 2000, totalSatang: 2000 },
};
const booking = {
  ...quote, bookingCode: "BK-20270110-AB12", status: "PENDING", paymentStatus: "UNPAID", customerName: "Somchai",
  customerPhoneMasked: "xxx-xxx-5678", expiresAt: null, createdAt: "2027-01-10T03:00:00Z", lineUpdates: null,
  paidSatang: 0, balanceSatang: 702000, paymentInstructions: null, balancePayment: null, paymentRejectedReason: null, cancelReason: null,
} as unknown as PublicBookingDto;

const summary = (q: QuoteDto, code: LocaleCode = "th") =>
  renderToStaticMarkup(<I18nProvider locale={getLocale(code)}><BookingSummary quote={q} /></I18nProvider>);

describe("app usage fee — guest side", () => {
  it("the price breakdown lists the fee (units × price) before the total", () => {
    const html = summary(quote);
    assert.match(html, /ค่าธรรมเนียมการใช้ App<small>1 หลัง × ฿20<\/small><\/dt><dd>฿20<\/dd>/);
    assert.ok(html.indexOf("ค่าธรรมเนียมการใช้ App") < html.indexOf("summary__line--total"));
    assert.match(summary(quote, "en"), /App usage fee<small>1 units × ฿20/);
  });

  it("no fee (credit system off, or an older booking): no line", () => {
    assert.doesNotMatch(summary({ ...quote, appFee: null, totalSatang: 700000 }), /ค่าธรรมเนียม/);
  });
});

describe("printable statement (ใบแจ้งยอด)", () => {
  it("is labelled as a statement, not a tax invoice, with the fee, total, paid and balance", () => {
    const html = renderToStaticMarkup(<BillDocument booking={booking} lang="th" siteName="Chomkhao" phone="xxx-xxx-5678" onClose={() => undefined} />);
    assert.match(html, /<h1 id="bill-title" class="bill__title">ใบแจ้งยอด<\/h1>/);
    assert.match(html, /ไม่ใช่ใบกำกับภาษี/);
    assert.match(html, /BK-20270110-AB12/);
    assert.match(html, /House 01/);
    assert.match(html, /ค่าธรรมเนียมการใช้ App<\/td><td>1 หลัง × ฿20<\/td><td class="bill__num">฿20<\/td>/);
    assert.match(html, /ยอดรวม<\/th><td class="bill__num">฿7,020<\/td>/);
    assert.match(html, /คงค้าง<\/th><td class="bill__num">฿7,020<\/td>/);
    assert.match(html, /บันทึกเป็น PDF/);
  });
});
