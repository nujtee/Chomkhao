import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminUnitDto, CampingSettingsDto } from "../../src/shared/accommodation-types.ts";
import type { AdminBookingDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { balanceDue, depositDue } from "../../src/shared/booking-rules.ts";
import type { BalanceDueDto, SlipUploadResultDto } from "../../src/shared/payment-types.ts";
import { guestConfirmedText, LineFormatter, newBookingText, type MsgBooking } from "../../src/worker/line/line-templates.ts";
import type { ProviderResult, SlipVerifier } from "../../src/worker/slip/slip-verifier.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

// Deposit plan (migration 0025). Harness clock: 2027-01-10 Bangkok. House 01: ฿3,500 / night, breakfast included.
let seq = 0;
const key = () => `deposit-key-${String(++seq).padStart(8, "0")}`;
const PHONE = "0812345678";

async function setup() {
  const h = new Harness({ seed: true });
  const admin = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const staff = async (perms: string[]) => {
    const id = `staff_${++seq}`;
    const email = await h.user({ id });
    for (const p of perms) h.grant(id, p);
    return h.login(email);
  };
  const setMode = async (unitId: string, paymentMode: string, token = admin) =>
    h.api<AdminUnitDto>("PATCH", `/api/admin/accommodations/${unitId}`, { token, body: { paymentMode } });
  const stayBody = (over: Record<string, unknown> = {}) => ({
    checkIn: "2027-01-10", checkOut: "2027-01-12", adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" },
    food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-11", adults: 2 }], lang: "th", ...over,
  });
  const book = async (over: Record<string, unknown> = {}) => {
    const body = stayBody(over);
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Deposit Guest", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { quote: q.data, booking: res.data };
  };
  const record = (code: string, amountSatang: number) => h.api<unknown>("POST", `/api/admin/bookings/${code}/payments`, {
    token: admin, body: { amountSatang, method: "BANK_TRANSFER", paidAt: "2027-01-10T02:00:00Z" },
  });
  const get = (code: string) => h.api<AdminBookingDto>("GET", `/api/admin/bookings/${code}`, { token: admin });
  const balance = (code: string, token = admin) => h.api<BalanceDueDto>("GET", `/api/admin/bookings/${code}/balance`, { token });
  const payBalance = (code: string, body: Record<string, unknown>, token = admin) =>
    h.api<AdminBookingDto>("POST", `/api/admin/bookings/${code}/balance`, { token, body });
  const stay = (code: string, action: string, token = admin) => h.api<AdminBookingDto>("POST", `/api/admin/bookings/${code}/stay/${action}`, { token });
  return { h, admin, staff, setMode, book, record, get, balance, payBalance, stay };
}

class FakeVerifier implements SlipVerifier {
  readonly provider = "fake";
  constructor(private readonly amountSatang: number) {}
  async verify(): Promise<ProviderResult> {
    return {
      kind: "OK",
      slip: {
        transactionRef: `DEP${++seq}`, amountSatang: this.amountSatang, transferredAt: "2027-01-10T02:58:00.000Z", senderBank: "KBANK",
        receiverBank: "DEV", receiverAccountMasked: "xxx-x-x0000-x", receiverProxyMasked: null,
      },
    };
  }
}

describe("deposit rule (shared)", () => {
  it("half of the stay is left for check-in (rounded down to whole baht); food and the rest are paid now", () => {
    assert.equal(depositDue("FULL", 700_000, 760_000), null);
    assert.equal(depositDue("DEPOSIT_50", 700_000, 760_000), 410_000, "฿7,000 stay + ฿600 food → ฿4,100 now, ฿3,500 later");
    assert.equal(depositDue("DEPOSIT_50", 350_050, 350_050), 175_050, "฿1,750 later, ฿1,750.50 now");
    assert.equal(depositDue("DEPOSIT_50", 100, 100), null, "half of ฿1 rounds to nothing later: pay in full");
    assert.equal(depositDue("DEPOSIT_50", 0, 50_000), null);
    assert.equal(balanceDue(760_000, 410_000), 350_000);
    assert.equal(balanceDue(760_000, 800_000), 0);
  });
});

describe("deposit booking: half now, the rest at check-in", () => {
  it("owner sets a house to deposit; the guest pays the deposit; check-in waits for the rest, taken in one step", async () => {
    const { h, admin, staff, setMode, book, record, get, balance, payBalance, stay } = await setup();
    const unit = await setMode("dev_house_01", "DEPOSIT_50");
    assert.equal(unit.status, 200, JSON.stringify(unit.body));
    assert.equal(unit.data.paymentMode, "DEPOSIT_50");

    const { quote, booking } = await book();
    assert.equal(quote.accommodationSubtotalSatang, 700_000);
    const later = 350_000;
    assert.equal(quote.depositSatang, quote.totalSatang - later, "food is paid in full now");
    assert.equal(booking.depositSatang, quote.depositSatang);
    const deposit = booking.depositSatang!;
    assert.equal(booking.paymentInstructions?.amountDueSatang, deposit, "the guest is asked for the deposit");
    assert.ok(booking.paymentInstructions?.promptpayPayload?.includes(`54${String((deposit / 100).toFixed(2).length).padStart(2, "0")}${(deposit / 100).toFixed(2)}`),
      "PromptPay QR carries the deposit");
    assert.deepEqual([booking.paidSatang, booking.balanceSatang], [0, quote.totalSatang]);

    // Staff record the transfer: the deposit, not the total.
    assert.equal((await record(booking.bookingCode, quote.totalSatang)).error?.details?.amountSatang, "MUST_EQUAL_DEPOSIT");
    const paid = await record(booking.bookingCode, deposit);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    let b = (await get(booking.bookingCode)).data;
    assert.equal(b.status, "CONFIRMED");
    assert.deepEqual([b.paidSatang, b.balanceSatang], [deposit, later]);
    const listed = await h.api<{ items: { bookingCode: string; balanceSatang: number; depositSatang: number | null }[] }>("GET", "/api/admin/bookings", { token: admin });
    assert.deepEqual(listed.data.items.map((i) => [i.bookingCode, i.depositSatang, i.balanceSatang]), [[booking.bookingCode, deposit, later]]);

    // Check-in is refused while the rest is due.
    assert.equal((await stay(booking.bookingCode, "check-in")).error?.code, "BALANCE_DUE");

    // What to collect and where: today's primary account, a PromptPay QR for exactly the rest.
    const due = (await balance(booking.bookingCode)).data;
    assert.deepEqual([due.totalSatang, due.paidSatang, due.balanceSatang], [quote.totalSatang, deposit, later]);
    assert.equal(due.account?.bankName, "DEV BANK (ตัวอย่าง)");
    assert.ok(due.promptpayPayload?.includes("54073500.00"), due.promptpayPayload ?? "no QR");

    // Front desk without payments.verify cannot take money.
    const desk = await staff(["bookings.view", "bookings.edit"]);
    assert.equal((await payBalance(booking.bookingCode, { method: "CASH", checkIn: true }, desk)).status, 403);
    assert.equal((await balance(booking.bookingCode, desk)).status, 200, "but can see what is due");

    const done = await payBalance(booking.bookingCode, { method: "CASH", checkIn: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    b = done.data;
    assert.equal(b.status, "CHECKED_IN");
    assert.deepEqual([b.paidSatang, b.balanceSatang], [quote.totalSatang, 0]);
    assert.deepEqual(b.payments.map((p) => [p.amountSatang, p.method, p.status]).sort(),
      [[deposit, "BANK_TRANSFER", "PAID"], [later, "CASH", "PAID"]].sort());
    assert.deepEqual(h.audits("RECORD_BALANCE_PAYMENT").length, 1);
    assert.deepEqual(h.audits("CHECK_IN").length, 1);

    // Nothing more to take; the deposit agreed at booking time never changes.
    assert.equal((await payBalance(booking.bookingCode, { method: "CASH", checkIn: true })).error?.code, "BOOKING_STATUS_INVALID");
    assert.throws(() => h.db.run("UPDATE bookings SET deposit_satang = 100 WHERE booking_code = ?", booking.bookingCode), /DEPOSIT_IMMUTABLE/);
  });

  it("the database refuses checking in a deposit booking that still owes money; the rest may be paid before the day", async () => {
    const { h, setMode, book, record, payBalance, stay } = await setup();
    await setMode("dev_house_01", "DEPOSIT_50");
    const { booking } = await book({ checkIn: "2027-01-20", checkOut: "2027-01-22", food: [] });
    await record(booking.bookingCode, booking.depositSatang!);
    assert.throws(() => h.db.run("UPDATE bookings SET booking_status = 'CHECKED_IN' WHERE booking_code = ?", booking.bookingCode), /BALANCE_DUE/);

    // Paid by PromptPay a week early, without checking in.
    assert.equal((await payBalance(booking.bookingCode, { method: "PROMPTPAY", reference: "TXN-123", checkIn: true })).error?.code, "STAY_NOT_STARTED");
    const early = await payBalance(booking.bookingCode, { method: "PROMPTPAY", reference: "TXN-123", checkIn: false });
    assert.equal(early.status, 200, JSON.stringify(early.body));
    assert.deepEqual([early.data.status, early.data.balanceSatang], ["CONFIRMED", 0]);
    assert.equal(early.data.payments.find((p) => p.method === "PROMPTPAY")?.reference, "TXN-123");
    assert.equal((await payBalance(booking.bookingCode, { method: "CASH", checkIn: false })).error?.code, "NOTHING_DUE");

    h.advance(10 * 24 * 60 * 60_000);
    // A new day, a new sign-in (sessions expire).
    const today = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
    const inn = await stay(booking.bookingCode, "check-in", today);
    assert.equal(inn.data?.status, "CHECKED_IN", JSON.stringify(inn.body));
  });

  it("slip and PayPal ask for the deposit; a full-payment house works as before", async () => {
    const { h, admin, setMode, book, balance, payBalance, stay } = await setup();
    await setMode("dev_house_01", "DEPOSIT_50");
    const { booking } = await book();
    const deposit = booking.depositSatang!;

    h.verifier(new FakeVerifier(deposit));
    const slip = await h.slip<{ booking: PublicBookingDto } & SlipUploadResultDto>(booking.bookingCode, PHONE, { bytes: pngBytes(640, 900), name: "s.png", type: "image/png" });
    assert.equal(slip.data.outcome, "VERIFIED", JSON.stringify(slip));
    assert.equal(slip.data.booking.status, "CONFIRMED");
    assert.equal(h.db.get<{ a: number }>("SELECT amount_satang AS a FROM payments")!.a, deposit);

    // PayPal: the order is for the deposit too.
    h.paypalSecrets();
    const s = await h.api("PUT", "/api/admin/payment-settings", {
      token: admin, body: { approvalMode: "AUTO", channels: { PROMPTPAY: true, BANK_TRANSFER: true, QR_CODE: true, PAYPAL: true } },
    });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const second = (await book({ checkIn: "2027-02-01", checkOut: "2027-02-03", food: [] })).booking;
    const order = await h.api("POST", "/api/public/bookings/paypal/order", { body: { bookingCode: second.bookingCode, phone: PHONE } });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const sent = h.paypal.requests.find((x) => x.url.endsWith("/v2/checkout/orders"))!;
    const unit = (sent.json!.purchase_units as { amount: { value: string } }[])[0]!;
    assert.equal(unit.amount.value, (second.depositSatang! / 100).toFixed(2));
    assert.equal(h.db.get<{ a: number }>("SELECT amount_satang AS a FROM paypal_orders")!.a, second.depositSatang);

    // House 02 is still paid in full: no deposit, check-in needs no extra step.
    const full = (await book({ stay: { kind: "UNIT", unitId: "dev_house_02" }, food: [] })).booking;
    assert.equal(full.depositSatang, null);
    assert.equal(full.paymentInstructions?.amountDueSatang, full.totalSatang);
    await h.api("POST", `/api/admin/bookings/${full.bookingCode}/payments`, { token: admin, body: { amountSatang: full.totalSatang, method: "CASH", paidAt: "2027-01-10T02:00:00Z" } });
    assert.equal((await balance(full.bookingCode)).data.balanceSatang, 0);
    assert.equal((await payBalance(full.bookingCode, { method: "CASH", checkIn: true })).error?.code, "NOTHING_DUE");
    assert.equal((await stay(full.bookingCode, "check-in")).data.status, "CHECKED_IN");
  });

  it("camping: the deposit counts the tarp area as part of the stay; food is paid in full now", async () => {
    const { h, admin, book } = await setup();
    const current = (await h.api<CampingSettingsDto>("GET", "/api/admin/camping", { token: admin })).data;
    const saved = await h.api<CampingSettingsDto>("PUT", "/api/admin/camping", {
      token: admin, body: { ...current, tarpEnabled: true, tarpPricePerNightSatang: 15_000, maxTarpsPerNight: 2, paymentMode: "DEPOSIT_50" },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.data.paymentMode, "DEPOSIT_50");
    const { quote } = await book({ stay: { kind: "CAMPING", tents: 1, tarp: true } });
    assert.equal(quote.tarp?.subtotalSatang, 30_000);
    const later = Math.floor(quote.accommodationSubtotalSatang / 2 / 100) * 100;
    assert.equal(quote.depositSatang, quote.totalSatang - later);
    assert.ok(quote.foodSubtotalSatang > 0 && quote.depositSatang! > quote.foodSubtotalSatang);
  });

  it("how a stay is paid is a money setting: it needs pricing.edit", async () => {
    const { staff, setMode } = await setup();
    const editor = await staff(["accommodation.view", "accommodation.edit"]);
    assert.equal((await setMode("dev_house_01", "DEPOSIT_50", editor)).status, 403);
    assert.equal((await setMode("dev_house_01", "HALF")).status, 422);
  });

  it("messages show the deposit and what is left for check-in", () => {
    const b: MsgBooking = {
      code: "BK-20270110-ABCD", customerName: "Deposit Guest", customerPhoneMasked: "081•••5678", customerEmailMasked: null,
      checkIn: "2027-01-10", checkOut: "2027-01-12", nights: 2, itemType: "HOUSE", itemName: "House 01", tents: 0, adults: 2, children: 0,
      bookingStatus: "CONFIRMED", paymentStatus: "PAID", totalSatang: 760_000, depositSatang: 410_000, food: [],
    };
    const th = guestConfirmedText(new LineFormatter("th"), b, { siteName: null, link: null });
    assert.match(th, /มัดจำที่ชำระแล้ว: ฿4,100/);
    assert.match(th, /คงเหลือ ชำระวันเช็กอิน: ฿3,500/);
    const en = newBookingText(new LineFormatter("en"), { ...b, bookingStatus: "PENDING", paymentStatus: "UNPAID" }, null);
    assert.match(en, /Deposit \(paid online\): ฿4,100/);
    assert.doesNotMatch(guestConfirmedText(new LineFormatter("th"), { ...b, depositSatang: null }, { siteName: null, link: null }), /มัดจำ/);
  });
});
