import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, AdminBookingSummaryDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { Harness } from "../helpers/harness.ts";

// Several stays in one booking (migration 0026). Harness clock: 2027-01-10T03:00Z (Bangkok 10:00).
// House 01 ฿3,500/night (breakfast A for 2 included), House 02 ฿3,200, VIP-01 ฿1,800; camping per adult per night.
let seq = 0;
const key = () => `multi-key-${String(++seq).padStart(8, "0")}`;
const PHONE = "0812345678";

type Stay = Record<string, unknown>;
const house1: Stay = { kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 1 };
const house2: Stay = { kind: "UNIT", unitId: "dev_house_02", adults: 3, children: 0 };
const vip1: Stay = { kind: "UNIT", unitId: "dev_vip_01", adults: 2, children: 0 };
const camp: Stay = { kind: "CAMPING", tents: 2, adults: 3, children: 1 };

const body = (stays: Stay[], over: Record<string, unknown> = {}) => ({
  checkIn: "2027-02-01", checkOut: "2027-02-03", stays, food: [], lang: "en", ...over,
});

async function setup() {
  const h = new Harness({ seed: true });
  const admin = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const quote = (stays: Stay[], over: Record<string, unknown> = {}) =>
    h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: body(stays, over) });
  const book = async (stays: Stay[], over: Record<string, unknown> = {}) => {
    const q = await quote(stays, over);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body(stays, over), customer: { name: "Group Guest", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { quote: q.data, booking: res.data };
  };
  const get = async (code: string) => (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${code}`, { token: admin })).data;
  return { h, admin, quote, book, get };
}

describe("several stays in one booking", () => {
  it("quotes and books two houses, a VIP tent and own-tent camping on the same dates, each with its own guests", async () => {
    const { h, admin, quote, book, get } = await setup();
    const q = await quote([house1, house2, vip1, camp]);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.data.items.map((i) => [i.type, i.unitId, i.adults, i.children, i.quantity]), [
      ["HOUSE", "dev_house_01", 2, 1, 1], ["HOUSE", "dev_house_02", 3, 0, 1], ["VIP_TENT", "dev_vip_01", 2, 0, 1], ["OWN_TENT", null, 3, 1, 2],
    ]);
    assert.deepEqual([q.data.adults, q.data.children], [10, 2], "the booking's guests are the stays' guests");
    assert.deepEqual(q.data.items.slice(0, 3).map((i) => i.subtotalSatang), [700_000, 640_000, 360_000]);
    const campPerAdult = q.data.items[3]!.nightly.reduce((a, n) => a + n.priceSatang, 0);
    assert.equal(q.data.items[3]!.subtotalSatang, campPerAdult * 3, "camping: per adult per night");
    assert.equal(q.data.accommodationSubtotalSatang, q.data.items.reduce((a, i) => a + i.subtotalSatang, 0));
    assert.equal(q.data.item.unitId, "dev_house_01", "first stay kept for older pages");
    // Breakfast comes with House 01, for its own guests, and says so.
    assert.deepEqual(q.data.includedMeals.map((m) => [m.name, m.personsPerNight, m.stayName]), [["Breakfast A", 2, "House 01 — Sakura House"]]);
    assert.equal(q.data.depositSatang, null, "every stay paid in full");

    const { booking } = await book([house1, house2, vip1, camp]);
    assert.deepEqual(booking.items.map((i) => [i.unitId, i.status]), [
      ["dev_house_01", "ACTIVE"], ["dev_house_02", "ACTIVE"], ["dev_vip_01", "ACTIVE"], [null, "ACTIVE"],
    ]);
    assert.equal(booking.totalSatang, q.data.totalSatang);
    // Every house / tent night is held, and the tents are counted.
    const nights = h.db.all<{ unit_id: string }>("SELECT unit_id FROM booking_unit_nights WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = ?)", booking.bookingCode);
    assert.equal(nights.length, 6);
    assert.deepEqual([...new Set(nights.map((n) => n.unit_id))].sort(), ["dev_house_01", "dev_house_02", "dev_vip_01"]);
    assert.deepEqual(h.db.all<{ tents_used: number }>("SELECT tents_used FROM camping_night_inventory ORDER BY stay_date").map((r) => r.tents_used), [2, 2]);
    // Per-stay snapshot and guests.
    const snaps = h.db.all<{ adult_count: number; subtotal_satang: number }>(
      "SELECT s.adult_count, s.subtotal_satang FROM booking_price_snapshots s JOIN booking_items i ON i.id = s.booking_item_id ORDER BY i.created_at");
    assert.deepEqual(snaps.map((r) => r.adult_count), [2, 3, 2, 3]);

    // Another guest cannot book House 02 on those nights.
    const taken = await quote([{ kind: "UNIT", unitId: "dev_house_02", adults: 1, children: 0 }]);
    assert.equal(taken.error?.code, "UNIT_UNAVAILABLE");
    assert.equal(taken.error?.details?.unitId, "dev_house_02");

    // Admin list names every stay.
    const list = await h.api<{ items: AdminBookingSummaryDto[] }>("GET", "/api/admin/bookings", { token: admin });
    const row = list.data.items.find((i) => i.bookingCode === booking.bookingCode)!;
    assert.equal(row.itemName, "House 01 — Sakura House + House 02 — Stargazing House + VIP-01 + Bring your own tent");
    assert.deepEqual(row.stays.map((s) => [s.type, s.quantity]), [["HOUSE", 1], ["HOUSE", 1], ["VIP_TENT", 1], ["OWN_TENT", 2]]);

    // Cancelling the booking gives everything back.
    const cancelled = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${booking.bookingCode}/cancel`, { token: admin, body: { reason: "Group changed plans" } });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(h.db.all("SELECT 1 FROM booking_unit_nights WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = ?)", booking.bookingCode).length, 0);
    assert.deepEqual(h.db.all<{ tents_used: number }>("SELECT tents_used FROM camping_night_inventory ORDER BY stay_date").map((r) => r.tents_used), [0, 0]);
    assert.equal((await get(booking.bookingCode)).items.length, 4);
  });

  it("refuses the same house twice, two camping entries, a stay without guests, and too many guests for a house", async () => {
    const { quote } = await setup();
    assert.equal((await quote([house1, { ...house1 }])).error?.details?.["stays.1.unitId"], "DUPLICATE");
    assert.equal((await quote([camp, { ...camp }])).error?.details?.stays, "ONE_CAMPING");
    assert.equal((await quote([house1, { ...house2, adults: 0, children: 0 }])).error?.details?.["stays.1.guests"], "REQUIRED");
    assert.equal((await quote([house1, { ...house2, adults: 5 }])).error?.details?.["stays.1.guests"], "EXCEEDS_MAX_GUESTS");
    assert.equal((await quote([house1, { ...camp, adults: 0, children: 2 }])).error?.details?.["stays.1.adults"], "OUT_OF_RANGE", "camping is per adult");
    assert.equal((await quote([{ ...house1, adults: 0, children: 2 }])).error?.details?.adults, "OUT_OF_RANGE", "someone is an adult");
    assert.equal((await quote([])).error?.details?.stays, "REQUIRED");
    assert.equal((await quote([house1], { adults: 3 })).error?.details?.adults, "NOT_SUM_OF_STAYS");
    assert.equal((await quote([house1], { stay: { kind: "UNIT", unitId: "dev_house_01" } })).error?.details?.stay, "NOT_WITH_STAYS");
    assert.equal((await quote([{ ...house1, price: 1 }])).error?.details?.["stays.0"], "INVALID_VALUE");
  });

  it("deposit per stay: only the deposit houses leave half for check-in", async () => {
    const { h, admin, quote, book } = await setup();
    await h.api("PATCH", "/api/admin/accommodations/dev_house_01", { token: admin, body: { paymentMode: "DEPOSIT_50" } });
    const q = await quote([house1, house2]);
    assert.deepEqual(q.data.items.map((i) => i.payLaterSatang), [350_000, 0]);
    assert.equal(q.data.depositSatang, q.data.totalSatang - 350_000);
    const { booking } = await book([house1, house2]);
    assert.equal(booking.depositSatang, q.data.depositSatang);
    assert.deepEqual(h.db.all<{ p: number }>("SELECT pay_later_satang AS p FROM booking_items ORDER BY created_at").map((r) => r.p), [350_000, 0]);
  });

  it("deposit house + VIP tent paid in full: half the house + the whole tent now, the other half at check-in", async () => {
    const { h, admin, quote, book } = await setup();
    await h.api("PATCH", "/api/admin/accommodations/dev_house_01", { token: admin, body: { paymentMode: "DEPOSIT_50" } });
    const oneNight = { checkOut: "2027-02-02" };
    const q = await quote([house1, vip1], oneNight);
    // House 01 ฿3,500 (half = ฿1,750 at check-in), VIP-01 ฿1,800 paid in full.
    assert.deepEqual(q.data.items.map((i) => [i.subtotalSatang, i.payLaterSatang]), [[350_000, 175_000], [180_000, 0]]);
    assert.equal(q.data.depositSatang, 175_000 + 180_000);
    const { booking } = await book([house1, vip1], oneNight);
    assert.equal(booking.depositSatang, 355_000);

    // The other way round: house in full, VIP tent half.
    await h.api("PATCH", "/api/admin/accommodations/dev_house_01", { token: admin, body: { paymentMode: "FULL" } });
    await h.api("PATCH", "/api/admin/accommodations/dev_vip_01", { token: admin, body: { paymentMode: "DEPOSIT_50" } });
    const r = await quote([house1, vip1], { checkIn: "2027-02-05", checkOut: "2027-02-06" });
    assert.deepEqual(r.data.items.map((i) => i.payLaterSatang), [0, 90_000]);
    assert.equal(r.data.depositSatang, 350_000 + 90_000);
  });
});

describe("cancelling one stay of a booking", () => {
  it("unpaid booking: the stay's nights, tents, tarp and breakfast go back; the total and the amount asked follow", async () => {
    const { h, admin, quote, book, get } = await setup();
    const current = (await h.api<Record<string, unknown>>("GET", "/api/admin/camping", { token: admin })).data;
    await h.api("PUT", "/api/admin/camping", { token: admin, body: { ...current, depositBookings: undefined, tarpEnabled: true, tarpPricePerNightSatang: 15_000, maxTarpsPerNight: 2 } });
    const campTarp = { ...camp, tarp: true };
    const before = await quote([house1, house2, campTarp]);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    const { booking } = await book([house1, house2, campTarp]);
    const id = h.db.get<{ id: string }>("SELECT id FROM bookings WHERE booking_code = ?", booking.bookingCode)!.id;
    const items = (await get(booking.bookingCode)).items;
    const campItem = items.find((i) => i.type === "OWN_TENT")!;
    const tarpSub = before.data.tarp!.subtotalSatang;

    const cancel = (itemId: string, token = admin) =>
      h.api<AdminBookingDto>("POST", `/api/admin/bookings/${booking.bookingCode}/stays/${itemId}/cancel`, { token, body: { reason: "Fewer people" } });
    const done = await cancel(campItem.id!);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const b = done.data;
    assert.equal(b.status, "PENDING");
    assert.equal(b.totalSatang, before.data.totalSatang - campItem.subtotalSatang - tarpSub);
    assert.equal(b.accommodationSubtotalSatang, 700_000 + 640_000);
    assert.deepEqual([b.adults, b.children], [5, 1]);
    assert.deepEqual(b.items.map((i) => i.status), ["ACTIVE", "ACTIVE", "CANCELLED"]);
    assert.equal(b.tarp, null, "the tarp area went with the camping stay");
    assert.equal(b.paymentInstructions?.amountDueSatang, b.totalSatang, "the guest is asked for the new total");
    assert.deepEqual(h.db.all<{ tents_used: number }>("SELECT tents_used FROM camping_night_inventory ORDER BY stay_date").map((r) => r.tents_used), [0, 0]);
    assert.deepEqual(h.db.all<{ tarps_used: number }>("SELECT tarps_used FROM camping_tarp_night_inventory ORDER BY stay_date").map((r) => r.tarps_used), [0, 0]);
    assert.equal(h.db.all("SELECT 1 FROM booking_unit_nights WHERE booking_id = ?", id).length, 4, "the houses keep their nights");
    assert.equal(h.audits("CANCEL_STAY").length, 1);

    // The camping spots are free for another guest; the stay cannot be cancelled twice; the last stay cannot go alone.
    assert.equal((await quote([{ ...camp, tents: 2 }])).status, 200);
    assert.equal((await cancel(campItem.id!)).error?.code, "STAY_ALREADY_CANCELLED");
    const house2Item = items.find((i) => i.unitId === "dev_house_02")!;
    assert.equal((await cancel(house2Item.id!)).status, 200);
    assert.equal((await cancel(items[0]!.id!)).error?.code, "LAST_STAY");

    // House 01's breakfast stays; a desk without bookings.cancel cannot do this.
    const after = await get(booking.bookingCode);
    assert.deepEqual(after.includedMeals.map((m) => [m.name, m.stayName ?? null]), [["Breakfast A", null]]);
    assert.equal(after.totalSatang, 700_000 + after.foodSubtotalSatang);
    const deskId = `desk_${++seq}`;
    const email = await h.user({ id: deskId });
    h.grant(deskId, "bookings.view");
    const desk = await h.login(email);
    assert.equal((await cancel(items[0]!.id!, desk)).status, 403);
  });

  it("meals that came with the cancelled house leave the kitchen order", async () => {
    const { h, admin, book, get } = await setup();
    const { booking } = await book([house1, house2]);
    const item1 = (await get(booking.bookingCode)).items[0]!;
    const persons = () => h.db.all<{ total_persons: number; status: string }>(
      "SELECT o.total_persons, o.status FROM food_orders o JOIN bookings b ON b.id = o.booking_id WHERE b.booking_code = ? ORDER BY o.service_date", booking.bookingCode);
    assert.deepEqual(persons().map((o) => [o.total_persons, o.status]), [[2, "PENDING"], [2, "PENDING"]]);
    const res = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${booking.bookingCode}/stays/${item1.id}/cancel`, { token: admin, body: { reason: "Only one house" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(persons().map((o) => o.status), ["CANCELLED", "CANCELLED"]);
    assert.deepEqual(res.data.includedMeals, []);
    assert.equal(h.db.all("SELECT 1 FROM booking_food_items WHERE status = 'ACTIVE'").length, 0);
  });

  it("paid in full: the money for the cancelled house is shown as overpaid and refunded from the payment; the rest still counts", async () => {
    const { h, admin, book, get } = await setup();
    const { booking } = await book([house2, vip1], { checkIn: "2027-01-10", checkOut: "2027-01-11" });
    const total = booking.totalSatang;
    const pay = await h.api("POST", `/api/admin/bookings/${booking.bookingCode}/payments`, {
      token: admin, body: { amountSatang: total, method: "BANK_TRANSFER", paidAt: "2027-01-10T02:00:00Z" },
    });
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    const vipItem = (await get(booking.bookingCode)).items[1]!;
    const res = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${booking.bookingCode}/stays/${vipItem.id}/cancel`, { token: admin, body: { reason: "VIP not needed" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.data.status, res.data.totalSatang, res.data.paidSatang, res.data.overpaidSatang], ["CONFIRMED", 320_000, total, 180_000]);

    const paymentId = res.data.payments[0]!.id;
    const refund = (amountSatang: number) => h.api(`POST`, `/api/admin/bookings/${booking.bookingCode}/payments/${paymentId}/refund`, {
      token: admin, body: { amountSatang, reason: "VIP tent cancelled" },
    });
    assert.equal((await refund(180_100)).error?.details?.amountSatang, "MORE_THAN_OVERPAID");
    const r = await refund(180_000);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = await get(booking.bookingCode);
    assert.deepEqual([b.paidSatang, b.overpaidSatang, b.balanceSatang, b.paymentStatus], [320_000, 0, 0, "PAID"], "the rest of the payment still counts");
    // Nothing more to refund while the booking is on; check-in as usual.
    assert.equal((await refund(100)).error?.code, "CANCEL_BEFORE_REFUND");
    assert.equal((await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${booking.bookingCode}/stay/check-in`, { token: admin })).data?.status, "CHECKED_IN");
  });

  it("deposit plan: the deposit is worked out again from the stays left, and check-in counts a partly refunded payment", async () => {
    const { h, admin, book, get } = await setup();
    for (const unit of ["dev_house_01", "dev_house_02"]) {
      await h.api("PATCH", `/api/admin/accommodations/${unit}`, { token: admin, body: { paymentMode: "DEPOSIT_50" } });
    }
    const { booking } = await book([{ ...house1 }, { ...house2 }], { checkIn: "2027-01-10", checkOut: "2027-01-11" });
    // Later: 1,750 (House 01) + 1,600 (House 02); food: House 01's breakfast is included (free).
    assert.equal(booking.depositSatang, booking.totalSatang - 175_000 - 160_000);
    const deposit = booking.depositSatang!;
    await h.api("POST", `/api/admin/bookings/${booking.bookingCode}/payments`, {
      token: admin, body: { amountSatang: deposit, method: "BANK_TRANSFER", paidAt: "2027-01-10T02:00:00Z" },
    });
    const items = (await get(booking.bookingCode)).items;
    const res = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${booking.bookingCode}/stays/${items[0]!.id}/cancel`, { token: admin, body: { reason: "House 01 not needed" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const b = res.data;
    assert.equal(b.totalSatang, 320_000);
    assert.equal(b.depositSatang, 160_000, "House 02 alone: half now, half at check-in");
    // Paid 1,750 + 1,600 = 3,350 for a ฿3,200 stay: ฿150 to refund, nothing due at check-in.
    assert.deepEqual([b.paidSatang, b.overpaidSatang, b.balanceSatang], [deposit, deposit - 320_000, 0]);
    const r = await h.api("POST", `/api/admin/bookings/${booking.bookingCode}/payments/${b.payments[0]!.id}/refund`, {
      token: admin, body: { amountSatang: deposit - 320_000, reason: "House 01 cancelled" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // The database counts what is left of the refunded payment: the booking is paid in full and can check in.
    const inn = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${booking.bookingCode}/stay/check-in`, { token: admin });
    assert.equal(inn.status, 200, JSON.stringify(inn.body));
    assert.equal(inn.data.status, "CHECKED_IN");
  });

  it("refuses while a slip is being checked, and when only children would be left", async () => {
    const { h, admin, book, get } = await setup();
    const { booking } = await book([{ ...house1, adults: 2, children: 0 }, { ...house2, adults: 0, children: 2 }]);
    const items = (await get(booking.bookingCode)).items;
    const cancel = (itemId: string) => h.api(`POST`, `/api/admin/bookings/${booking.bookingCode}/stays/${itemId}/cancel`, { token: admin, body: { reason: "Test reason" } });
    assert.equal((await cancel(items[0]!.id!)).error?.code, "NO_ADULT_LEFT");
    h.db.run("INSERT INTO payments (id, booking_id, amount_satang, method, status, submitted_at, updated_at) VALUES ('pp', (SELECT id FROM bookings WHERE booking_code = ?), 100, 'BANK_TRANSFER', 'PENDING_VERIFICATION', '2027-01-10T03:00:00Z', '2027-01-10T03:00:00Z')", booking.bookingCode);
    assert.equal((await cancel(items[1]!.id!)).error?.code, "SLIP_PENDING");
  });
});

describe("changing the dates of a booking with several stays", () => {
  it("every house and the camping tents move together; any taken night blocks the day", async () => {
    const { h, admin, book } = await setup();
    const { booking } = await book([house1, vip1, camp]);
    // House 01 is booked by someone else on 2027-02-10.
    await book([{ kind: "UNIT", unitId: "dev_house_01", adults: 1, children: 0 }], { checkIn: "2027-02-10", checkOut: "2027-02-11" });
    const opts = await h.api<{ days: { date: string; state: string }[] }>("GET", `/api/admin/bookings/${booking.bookingCode}/move-options?from=2027-02-08&days=5`, { token: admin });
    assert.equal(opts.status, 200, JSON.stringify(opts.body));
    const state = Object.fromEntries(opts.data.days.map((d) => [d.date, d.state]));
    assert.equal(state["2027-02-09"], "TAKEN", "House 01 is taken on the 10th");
    assert.equal(state["2027-02-11"], "OK");
    const moved = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${booking.bookingCode}/move`, { token: admin, body: { checkIn: "2027-02-11" } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const nights = h.db.all<{ unit_id: string; stay_date: string }>(
      "SELECT unit_id, stay_date FROM booking_unit_nights WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = ?) ORDER BY unit_id, stay_date", booking.bookingCode);
    assert.deepEqual(nights.map((n) => `${n.unit_id}@${n.stay_date}`), [
      "dev_house_01@2027-02-11", "dev_house_01@2027-02-12", "dev_vip_01@2027-02-11", "dev_vip_01@2027-02-12",
    ]);
    const tents = h.db.all<{ stay_date: string; tents_used: number }>("SELECT stay_date, tents_used FROM camping_night_inventory WHERE tents_used > 0 ORDER BY stay_date");
    assert.deepEqual(tents.map((t) => [t.stay_date, t.tents_used]), [["2027-02-11", 2], ["2027-02-12", 2]]);
  });
});
