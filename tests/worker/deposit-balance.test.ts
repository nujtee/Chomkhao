import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminUnitDto, CampingSettingsDto } from "../../src/shared/accommodation-types.ts";
import type { AdminBookingDto, AdminBookingSummaryDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type { DashboardDto } from "../../src/shared/dashboard-types.ts";
import type { BalanceDueDto, SlipQueueDto, SlipQueueItemDto, SlipUploadResultDto } from "../../src/shared/payment-types.ts";
import {
  balanceReceivedText, checkinDigestBlocks, guestBalanceRejectedText, guestCheckinText, LineFormatter, paymentReviewText, type MsgBooking,
} from "../../src/worker/line/line-templates.ts";
import { PaymentRepository } from "../../src/worker/repositories/payment.repository.ts";
import type { ProviderResult, SlipVerifier } from "../../src/worker/slip/slip-verifier.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

// Deposit plan, the rest paid by the guest before the stay. Harness clock: 2027-01-10T03:00Z (Bangkok 10:00).
// House 01: ฿3,500 / night → 2 nights = ฿7,000: deposit ฿3,500 now, ฿3,500 later. Seed account 000-0-00000-0.
let seq = 0;
const key = () => `balance-key-${String(++seq).padStart(8, "0")}`;
const PHONE = "0812345678";
const GROUP = `C${"d".repeat(32)}`;
const GUEST_LINE = `U${"e".repeat(32)}`;
const LATER = 350_000;
const slipImage = (n: number) => ({ bytes: pngBytes(800 + n, 900), name: `balance${n}.png`, type: "image/png" });

/** Answers like EasySlip for a transfer of `amountSatang` into the seed account. */
const verifier = (amountSatang: number): SlipVerifier => ({
  provider: "easyslip",
  verify: async (): Promise<ProviderResult> => ({
    kind: "OK",
    slip: {
      transactionRef: `BAL${++seq}`, amountSatang, transferredAt: "2027-01-10T03:00:30.000Z", senderBank: "KBANK",
      receiverBank: "DEV", receiverAccountMasked: "xxx-x-x0000-x", receiverProxyMasked: null,
    },
  }),
});

async function setup(opts: { manual?: boolean } = {}) {
  const h = new Harness({ seed: true });
  const admin = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  assert.equal((await h.api("PATCH", "/api/admin/accommodations/dev_house_01", { token: admin, body: { paymentMode: "DEPOSIT_50" } })).status, 200);
  if (opts.manual) {
    const s = await h.api("PUT", "/api/admin/payment-settings", {
      token: admin, body: { approvalMode: "MANUAL", channels: { PROMPTPAY: true, BANK_TRANSFER: true, QR_CODE: true, PAYPAL: false } },
    });
    assert.equal(s.status, 200, JSON.stringify(s.body));
  }
  const book = async (checkIn = "2027-01-20", checkOut = "2027-01-22") => {
    const body = { checkIn, checkOut, adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "th" };
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Balance Guest", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.data;
  };
  /** A confirmed deposit booking: staff recorded the deposit, then a minute passes. */
  const confirmed = async (checkIn?: string, checkOut?: string) => {
    const b = await book(checkIn, checkOut);
    const paid = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments`, {
      token: admin, body: { amountSatang: b.depositSatang, method: "BANK_TRANSFER", paidAt: "2027-01-10T02:00:00Z" },
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    h.advance(60_000);
    return b;
  };
  const lookup = async (code: string) => {
    const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: code, phone: PHONE } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.data;
  };
  const upload = (code: string, n: number) => h.slip<{ booking: PublicBookingDto } & SlipUploadResultDto>(code, PHONE, slipImage(n), "PROMPTPAY");
  const get = async (code: string) => (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${code}`, { token: admin })).data;
  const paymentsOf = (code: string) => h.db.all<{ id: string; amount_satang: number; status: string }>(
    "SELECT p.id, p.amount_satang, p.status FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.booking_code = ? ORDER BY p.submitted_at", code);
  return { h, admin, book, confirmed, lookup, upload, get, paymentsOf };
}

describe("deposit plan: the guest transfers the rest before the stay", () => {
  it("the booking page offers the rest (account copied at booking time, no PayPal); a verified slip settles it, the booking stays confirmed", async () => {
    const { h, admin, confirmed, lookup, upload, get, paymentsOf } = await setup();
    h.lineSecrets();
    h.db.run("UPDATE line_settings SET enabled = 1");
    await h.api("POST", "/api/admin/line/recipients", { token: admin, body: { targetId: GROUP, name: "Owners", language: "th", notifyPayment: true, notifyBooking: false } });
    const b = await confirmed();

    const seen = await lookup(b.bookingCode);
    assert.equal(seen.status, "CONFIRMED");
    assert.equal(seen.paymentInstructions, null, "the deposit is in: nothing asked to confirm");
    assert.deepEqual([seen.paidSatang, seen.balanceSatang], [b.depositSatang, LATER]);
    const offer = seen.balancePayment!;
    assert.ok(offer, "the rest can be paid ahead");
    assert.deepEqual([offer.reviewing, offer.rejectedReason], [false, null]);
    assert.equal(offer.instructions?.amountDueSatang, LATER);
    assert.equal(offer.instructions?.accountNumber, "000-0-00000-0");
    assert.ok(!offer.instructions?.channels.includes("PAYPAL"));
    assert.ok(offer.instructions?.promptpayPayload?.includes("54073500.00"), "PromptPay QR for exactly the rest");

    h.verifier(verifier(LATER));
    const sent = await upload(b.bookingCode, 1);
    assert.equal(sent.status, 201, JSON.stringify(sent.error));
    assert.equal(sent.data.outcome, "VERIFIED");
    assert.equal(sent.data.booking.status, "CONFIRMED");
    assert.deepEqual([sent.data.booking.balanceSatang, sent.data.booking.balancePayment], [0, null]);
    assert.deepEqual(paymentsOf(b.bookingCode).map((p) => [p.amount_satang, p.status]), [[b.depositSatang, "PAID"], [LATER, "VERIFIED"]]);

    // Reception has nothing left to take; check-in needs no extra step on the day.
    const admin2 = await get(b.bookingCode);
    assert.equal(admin2.balanceSatang, 0);
    assert.equal((await h.api("POST", `/api/admin/bookings/${b.bookingCode}/balance`, { token: admin, body: { method: "CASH", checkIn: false } })).error?.code, "NOTHING_DUE");
    // …and the guest cannot send a second slip for it.
    assert.equal((await upload(b.bookingCode, 2)).error?.code, "NOTHING_DUE");

    // Staff hear that the rest came in (not a second "booking confirmed"); no new Purchase event.
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:02:00Z"));
    const texts = h.line.pushes.filter((p) => p.to === GROUP).map((p) => p.texts[0]!);
    const received = texts.filter((t) => t.includes("ได้รับยอดคงเหลือแล้ว"));
    assert.equal(received.length, 1, JSON.stringify(texts));
    assert.match(received[0]!, /ยอดคงเหลือ: ฿3,500 · ชำระโดย: พร้อมเพย์/);
    assert.equal(texts.filter((t) => t.includes("ชำระเงินแล้ว — การจองยืนยัน")).length, 1, "the deposit's confirmation only");
    assert.equal(h.db.all("SELECT id FROM marketing_events WHERE event_name = 'Purchase'").length <= 1, true);

    // The guest page now says there is nothing left to pay.
    const after = await lookup(b.bookingCode);
    assert.deepEqual([after.balanceSatang, after.balancePayment], [0, null]);
  });

  it("staff review: one slip at a time, reception cannot take the rest twice, a decline keeps the booking and the guest can send another", async () => {
    const { h, admin, confirmed, lookup, upload, get, paymentsOf } = await setup({ manual: true });
    h.lineSecrets();
    h.db.run("UPDATE line_settings SET enabled = 1, guest_enabled = 1, bot_basic_id = '@phasakura'");
    const b = await confirmed();
    const bookingId = h.db.get<{ id: string }>("SELECT id FROM bookings WHERE booking_code = ?", b.bookingCode)!.id;
    h.db.run("INSERT INTO booking_line_links (booking_id, line_user_id, linked_at) VALUES (?, ?, ?)", bookingId, GUEST_LINE, "2027-01-10T03:00:00Z");

    const sent = await upload(b.bookingCode, 3);
    assert.equal(sent.status, 201, JSON.stringify(sent.error));
    assert.equal(sent.data.outcome, "PENDING_REVIEW");
    assert.equal(sent.data.booking.status, "CONFIRMED");
    assert.deepEqual([sent.data.booking.balancePayment?.reviewing, sent.data.booking.balancePayment?.instructions], [true, null]);
    assert.equal((await upload(b.bookingCode, 4)).error?.code, "SLIP_PENDING", "one slip at a time");

    // Reception sees the slip and is stopped from taking the money again.
    const due = await h.api<BalanceDueDto>("GET", `/api/admin/bookings/${b.bookingCode}/balance`, { token: admin });
    assert.equal(due.data.pendingSlip?.amountSatang, LATER);
    assert.equal((await h.api("POST", `/api/admin/bookings/${b.bookingCode}/balance`, { token: admin, body: { method: "CASH", checkIn: false } })).error?.code, "BALANCE_SLIP_PENDING");
    // The database refuses it too (two desks, or a stale page).
    const repo = new PaymentRepository(h.env.DB);
    const raced = await repo.insertBalancePaymentStatement({ id: "race", bookingId, amount: LATER, method: "CASH", reference: null, by: "x", now: "2027-01-10T03:05:00.000Z" }).all();
    assert.equal(raced.results.length, 0);

    // The queue marks it as the rest of a deposit; it cannot cancel the confirmed booking.
    const queue = await h.api<SlipQueueDto>("GET", "/api/admin/slips?status=PENDING_VERIFICATION", { token: admin });
    const item = queue.data.items.find((i) => i.bookingCode === b.bookingCode)!;
    assert.deepEqual([item.balance, item.amountSatang, item.bookingStatus], [true, LATER, "CONFIRMED"]);
    const dash = await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: admin });
    assert.equal(dash.data.counts.slipsToReview, 1, "balance slips are counted for review");
    assert.equal((await h.api("POST", `/api/admin/payments/${item.paymentId}/reject`, { token: admin, body: { reason: "ยอดไม่ตรง", cancelBooking: true } })).error?.code, "BOOKING_ALREADY_CONFIRMED");
    const declined = await h.api<SlipQueueItemDto>("POST", `/api/admin/payments/${item.paymentId}/reject`, { token: admin, body: { reason: "ยอดไม่ตรง", cancelBooking: false } });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    const row = await get(b.bookingCode);
    assert.deepEqual([row.status, row.paymentStatus, row.balanceSatang], ["CONFIRMED", "PAID", LATER], "still confirmed, the deposit still counts");

    // The guest reads why, and may pay again (or at reception); LINE tells them the booking stands.
    const seen = await lookup(b.bookingCode);
    assert.equal(seen.balancePayment?.rejectedReason, "ยอดไม่ตรง");
    assert.equal(seen.balancePayment?.instructions?.amountDueSatang, LATER);
    await h.app.scheduled(h.env, Date.parse("2027-01-10T03:03:00Z"));
    const guest = h.line.pushes.find((p) => p.to === GUEST_LINE);
    assert.ok(guest, JSON.stringify(h.line.pushes));
    assert.match(guest.texts[0]!, /สลิปยอดคงเหลือยังไม่ผ่านการตรวจสอบ/);
    assert.match(guest.texts[0]!, /การจองของคุณยังยืนยันอยู่/);
    assert.match(guest.texts[0]!, /ยอดคงเหลือ: ฿3,500/);

    // A new slip, approved by staff: paid in full.
    h.advance(60_000);
    const again = await upload(b.bookingCode, 5);
    assert.equal(again.data.outcome, "PENDING_REVIEW", JSON.stringify(again.error));
    const pid = paymentsOf(b.bookingCode).at(-1)!.id;
    const ok = await h.api<SlipQueueItemDto>("POST", `/api/admin/payments/${pid}/verify`, { token: admin, body: { transactionRef: "KB-778899" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.data.balance, true);
    assert.equal((await get(b.bookingCode)).balanceSatang, 0);
    assert.equal(h.audits("VERIFY_SLIP").length, 1);
  });

  it("taken at reception first: the guest's slip is no longer accepted; a full-payment booking is never offered the rest", async () => {
    const { h, admin, book, confirmed, lookup, upload } = await setup();
    const b = await confirmed();
    const took = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${b.bookingCode}/balance`, { token: admin, body: { method: "CASH", checkIn: false } });
    assert.equal(took.status, 200, JSON.stringify(took.body));
    assert.equal((await lookup(b.bookingCode)).balancePayment, null);
    assert.equal((await upload(b.bookingCode, 6)).error?.code, "NOTHING_DUE");

    // Still waiting for the deposit: the usual payment step, nothing about the rest yet.
    const pending = await book("2027-02-01", "2027-02-03");
    const p = await lookup(pending.bookingCode);
    assert.equal(p.balancePayment, null);
    assert.equal(p.paymentInstructions?.amountDueSatang, pending.depositSatang);

    // House 02 is paid in full: once confirmed, a slip is refused as before.
    const body = { checkIn: "2027-02-05", checkOut: "2027-02-06", adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_02" }, food: [], lang: "th" };
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    const full = (await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Full Guest", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    })).data;
    await h.api("POST", `/api/admin/bookings/${full.bookingCode}/payments`, { token: admin, body: { amountSatang: full.totalSatang, method: "CASH", paidAt: "2027-01-10T02:00:00Z" } });
    assert.equal((await lookup(full.bookingCode)).balancePayment, null);
    assert.equal((await upload(full.bookingCode, 7)).error?.code, "SLIP_NOT_ACCEPTED");
  });
});

describe("switching a stay from deposit to full payment: bookings made with a deposit keep it", () => {
  it("the owner is told which bookings keep the deposit; check-in still takes the rest; new bookings pay in full", async () => {
    const { h, admin, book, confirmed, lookup, upload, get } = await setup();
    const paid = await confirmed(); // deposit paid, ฿3,500 still due
    const waiting = await book("2027-02-01", "2027-02-03"); // deposit not paid yet
    const before = await h.api<AdminUnitDto>("GET", "/api/admin/accommodations/dev_house_01", { token: admin });
    assert.deepEqual(before.data.depositBookings, { paid: 1, dueSatang: LATER, awaiting: 1 });

    // The owner switches House 01 to full payment.
    const switched = await h.api<AdminUnitDto>("PATCH", "/api/admin/accommodations/dev_house_01", { token: admin, body: { paymentMode: "FULL" } });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.data.paymentMode, "FULL");
    assert.deepEqual(switched.data.depositBookings, { paid: 1, dueSatang: LATER, awaiting: 1 }, "they are still open, with their deposit");
    const audit = h.audits("UPDATE").find((a) => a.record_id === "dev_house_01" && a.new_value?.includes("keptDepositBookings"));
    assert.ok(audit, "the audit log records the bookings that kept their deposit");

    // The paid booking keeps its plan: staff see why, check-in still asks for the rest, the guest can still send it.
    const row = await get(paid.bookingCode);
    assert.deepEqual([row.depositSatang, row.balanceSatang, row.depositPlanKept], [paid.depositSatang, LATER, true]);
    // The booking still waiting is asked for the deposit it was given (not the full amount).
    assert.equal((await lookup(waiting.bookingCode)).paymentInstructions?.amountDueSatang, waiting.depositSatang);

    h.advance(10 * 24 * 60 * 60_000); // 2027-01-20, the arrival day (the unpaid hold has long expired)
    const desk = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
    assert.equal((await h.api("POST", `/api/admin/bookings/${paid.bookingCode}/stay/check-in`, { token: desk })).error?.code, "BALANCE_DUE");
    const due = await h.api<BalanceDueDto>("GET", `/api/admin/bookings/${paid.bookingCode}/balance`, { token: desk });
    assert.equal(due.data.balanceSatang, LATER);
    assert.equal((await lookup(paid.bookingCode)).balancePayment?.instructions?.amountDueSatang, LATER);
    const inn = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${paid.bookingCode}/balance`, { token: desk, body: { method: "CASH", checkIn: true } });
    assert.equal(inn.status, 200, JSON.stringify(inn.body));
    assert.deepEqual([inn.data.status, inn.data.paidSatang, inn.data.balanceSatang], ["CHECKED_IN", paid.totalSatang, 0]);

    // A new booking pays in full and is not marked.
    const fresh = await book("2027-03-01", "2027-03-03");
    assert.equal(fresh.depositSatang, null);
    assert.equal(fresh.paymentInstructions?.amountDueSatang, fresh.totalSatang);
    assert.equal((await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${fresh.bookingCode}`, { token: desk })).data.depositPlanKept, false);
    // No upload for the checked-in booking.
    assert.equal((await upload(paid.bookingCode, 9)).error?.code, "SLIP_NOT_ACCEPTED");
  });

  it("camping: the same check for tent bookings", async () => {
    const { h, admin } = await setup();
    const current = (await h.api<CampingSettingsDto>("GET", "/api/admin/camping", { token: admin })).data;
    assert.deepEqual(current.depositBookings, { paid: 0, dueSatang: 0, awaiting: 0 });
    await h.api("PUT", "/api/admin/camping", { token: admin, body: { ...current, paymentMode: "DEPOSIT_50" } });
    const body = { checkIn: "2027-01-20", checkOut: "2027-01-22", adults: 2, children: 0, stay: { kind: "CAMPING", tents: 1 }, food: [], lang: "th" };
    const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
    const b = (await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Tent Guest", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    })).data;
    assert.ok(b.depositSatang);
    await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments`, { token: admin, body: { amountSatang: b.depositSatang, method: "CASH", paidAt: "2027-01-10T02:00:00Z" } });
    const saved = await h.api<CampingSettingsDto>("PUT", "/api/admin/camping", { token: admin, body: { ...current, paymentMode: "FULL" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.data.depositBookings, { paid: 1, dueSatang: b.totalSatang - b.depositSatang!, awaiting: 0 });
    const row = (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${b.bookingCode}`, { token: admin })).data;
    assert.deepEqual([row.depositPlanKept, row.balanceSatang], [true, b.totalSatang - b.depositSatang!]);
    // House 01 (still deposit) is not affected by the camping switch.
    assert.deepEqual((await h.api<AdminUnitDto>("GET", "/api/admin/accommodations/dev_house_01", { token: admin })).data.depositBookings, { paid: 0, dueSatang: 0, awaiting: 0 });
  });
});

describe("dashboard: everything still due at check-in", () => {
  it("sums what confirmed deposit bookings still owe, and lists them", async () => {
    const { h, admin, book, confirmed } = await setup();
    const one = await confirmed();
    const two = await confirmed("2027-01-25", "2027-01-26"); // 1 night: ฿1,750 later
    await book("2027-02-10", "2027-02-12"); // deposit not paid yet: nothing due at check-in
    let dash = (await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: admin })).data;
    assert.equal(dash.counts.balanceDue, 2);
    assert.equal(dash.money?.balanceDueSatang, LATER + 175_000);

    const listed = await h.api<{ items: AdminBookingSummaryDto[] }>("GET", "/api/admin/bookings?due=1", { token: admin });
    assert.deepEqual(listed.data.items.map((i) => i.bookingCode).sort(), [one.bookingCode, two.bookingCode].sort());

    // Paid at reception: it leaves the list and the total.
    await h.api("POST", `/api/admin/bookings/${two.bookingCode}/balance`, { token: admin, body: { method: "CASH", checkIn: false } });
    dash = (await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: admin })).data;
    assert.deepEqual([dash.counts.balanceDue, dash.money?.balanceDueSatang], [1, LATER]);
    assert.deepEqual((await h.api<{ items: AdminBookingSummaryDto[] }>("GET", "/api/admin/bookings?due=1", { token: admin })).data.items.map((i) => i.bookingCode), [one.bookingCode]);

    // Without money permissions: the count only.
    const id = `desk_${++seq}`;
    const email = await h.user({ id });
    h.grant(id, "dashboard.view");
    const desk = await h.login(email);
    const limited = (await h.api<DashboardDto>("GET", "/api/admin/dashboard", { token: desk })).data;
    assert.deepEqual([limited.counts.balanceDue, limited.money], [1, null]);
  });
});

describe("messages about the rest of a deposit", () => {
  const b: MsgBooking = {
    code: "BK-20270120-WXYZ", customerName: "Balance Guest", customerPhoneMasked: "081•••5678", customerEmailMasked: null,
    checkIn: "2027-01-20", checkOut: "2027-01-22", nights: 2, itemType: "HOUSE", itemName: "House 01", tents: 0, adults: 2, children: 0,
    bookingStatus: "CONFIRMED", paymentStatus: "PAID", totalSatang: 700_000, depositSatang: 350_000, paidSatang: 350_000, food: [],
  };
  const th = new LineFormatter("th");
  const place = { daysBefore: 1, siteName: "Phasakura", address: null, mapUrl: null, phone: null, link: "https://phasakura.test/th/booking/lookup" };

  it("the check-in reminder says what is still due (and that it can be sent ahead), or nothing once paid", () => {
    const owing = guestCheckinText(th, b, place);
    assert.match(owing, /คงเหลือ ชำระวันเช็กอิน: ฿3,500\nโอนล่วงหน้าได้ที่หน้าการจอง/);
    assert.doesNotMatch(guestCheckinText(th, { ...b, paidSatang: 700_000 }, place), /คงเหลือ/);
    const digest = checkinDigestBlocks(th, { date: "2027-01-20", daysBefore: 0, siteName: null, bookings: [b, { ...b, code: "BK-20270120-PAID", paidSatang: 700_000 }], link: null });
    assert.match(digest[1]!, /💰 ค้างรับตอนเช็กอิน: ฿3,500$/);
    assert.doesNotMatch(digest[2]!, /ค้างรับ/);
  });

  it("staff: a slip for the rest is labelled; the rest received; the guest: a declined slip keeps the booking", () => {
    assert.match(paymentReviewText(th, b, 350_000, null), /ยอดคงเหลือ \(รับมัดจำแล้ว\)/);
    assert.doesNotMatch(paymentReviewText(th, { ...b, bookingStatus: "PENDING" }, 350_000, null), /รับมัดจำแล้ว/);
    const en = balanceReceivedText(new LineFormatter("en"), { ...b, paidSatang: 700_000 }, 350_000, "BANK_TRANSFER", "PROMPTPAY");
    assert.match(en, /^💰 Balance received — paid in full\nBK-20270120-WXYZ · Balance Guest\nBalance: ฿3,500 · Paid by: PromptPay\nTotal: ฿7,000/);
    const zh = guestBalanceRejectedText(new LineFormatter("zh-CN"), b, { reason: "金额不符", link: null, siteName: null });
    assert.match(zh, /余款转账暂未通过审核/);
    assert.match(zh, /原因: 金额不符/);
    assert.match(zh, /余款: ฿3,500/);
  });
});
