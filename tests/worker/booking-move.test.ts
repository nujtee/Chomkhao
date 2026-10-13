import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, BookingMoveOptionsDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import { Harness } from "../helpers/harness.ts";
import type { SQLInputValue } from "node:sqlite";

// Admin → booking → Change dates. Harness clock: 2027-01-10 (Bangkok). House 01: ฿3,500 / night, breakfast included.
let seq = 0;
const key = () => `move-key-${String(++seq).padStart(8, "0")}`;

async function book(h: Harness, body: Record<string, unknown>) {
  const full = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "th", ...body };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: full });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...full, customer: { name: "Mover", phone: `08${String(10000000 + ++seq)}` }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

async function setup() {
  const h = new Harness({ seed: true });
  const admin = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const options = (code: string, from: string, days = 14) =>
    h.api<BookingMoveOptionsDto>("GET", `/api/admin/bookings/${code}/move-options?from=${from}&days=${days}`, { token: admin });
  const move = (code: string, checkIn: string, token = admin) => h.api<AdminBookingDto>("POST", `/api/admin/bookings/${code}/move`, { token, body: { checkIn } });
  const states = async (code: string, from: string, days = 14) =>
    Object.fromEntries((await options(code, from, days)).data.days.map((d) => [d.date, d.state]));
  return { h, admin, options, move, states };
}

const rows = (h: Harness, sql: string, ...args: SQLInputValue[]) => h.db.all<Record<string, unknown>>(sql, ...args).map((r) => ({ ...r }));

describe("change the stay dates (same nights, same price)", () => {
  it("house: calendar shows free / taken days; moving keeps the price and moves nights, meals and kitchen capacity", async () => {
    const { h, options, move, states } = await setup();
    const b = await book(h, { food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 2 }] });
    await book(h, { checkIn: "2027-02-10", checkOut: "2027-02-11" }); // someone else, 10 Feb
    h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason) VALUES ('dev_house_01', '2027-02-06', 'maintenance')");

    const s = await states(b.bookingCode, "2027-01-30", 14);
    assert.equal(s["2027-02-01"], "CURRENT");
    assert.equal(s["2027-02-02"], "OK", "overlapping its own nights is fine");
    assert.equal(s["2027-02-05"], "TAKEN", "2 nights would hit the blocked 6 Feb");
    assert.equal(s["2027-02-06"], "TAKEN");
    assert.equal(s["2027-02-07"], "OK");
    assert.equal(s["2027-02-09"], "TAKEN", "would hit the other booking on 10 Feb");
    assert.equal(s["2027-02-11"], "OK");
    const o = (await options(b.bookingCode, "2027-01-05", 7)).data;
    assert.equal(o.today, "2027-01-10");
    assert.equal(o.days.find((d) => d.date === "2027-01-09")!.state, "PAST");
    assert.equal(o.nights, 2);

    const before = rows(h, "SELECT food_category_id, SUM(used_quantity) AS used FROM food_daily_capacity GROUP BY food_category_id ORDER BY 1");
    const moved = await move(b.bookingCode, "2027-02-02");
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.data.checkIn, "2027-02-02");
    assert.equal(moved.data.checkOut, "2027-02-04");
    assert.equal(moved.data.totalSatang, b.totalSatang, "the guest keeps the price they booked at");
    assert.equal(moved.data.status, "PENDING");

    const id = h.db.get<{ id: string }>("SELECT id FROM bookings WHERE booking_code = ?", b.bookingCode)!.id;
    assert.deepEqual(rows(h, "SELECT stay_date FROM booking_unit_nights WHERE booking_id = ? ORDER BY 1", id), [{ stay_date: "2027-02-02" }, { stay_date: "2027-02-03" }]);
    // Every meal moved by one day (dinner on the first evening, breakfast on the following mornings).
    const orders = rows(h, "SELECT f.code, o.service_date FROM food_orders o JOIN food_categories f ON f.id = o.food_category_id WHERE o.booking_id = ? ORDER BY 2, 1", id);
    assert.deepEqual(orders, [
      { code: "DINNER", service_date: "2027-02-02" }, { code: "BREAKFAST", service_date: "2027-02-03" }, { code: "BREAKFAST", service_date: "2027-02-04" },
    ]);
    assert.deepEqual(rows(h, "SELECT DISTINCT service_date FROM booking_food_items WHERE booking_id = ? ORDER BY 1", id).map((r) => r.service_date), ["2027-02-02", "2027-02-03", "2027-02-04"]);
    // Kitchen capacity: the same totals, now on the new days.
    assert.deepEqual(rows(h, "SELECT food_category_id, SUM(used_quantity) AS used FROM food_daily_capacity GROUP BY food_category_id ORDER BY 1"), before);
    assert.deepEqual(rows(h, "SELECT service_date, used_quantity FROM food_daily_capacity WHERE food_category_id = 'dev_food_dinner' AND used_quantity > 0"),
      [{ service_date: "2027-02-02", used_quantity: 2 }]);
    assert.equal(h.audits("MOVE_BOOKING").length, 1);
    assert.match(h.audits("MOVE_BOOKING")[0]!.new_value!, /2027-02-02/);
    // The snapshot (price per night as booked) is untouched.
    assert.equal(moved.data.item.subtotalSatang, b.item.subtotalSatang);
  });

  it("refuses taken, past, unchanged and far days; the database stays as it was", async () => {
    const { h, move } = await setup();
    const b = await book(h, {});
    await book(h, { checkIn: "2027-02-10", checkOut: "2027-02-11" });
    const nights = () => rows(h, "SELECT unit_id, stay_date, booking_id FROM booking_unit_nights ORDER BY 1, 2");
    const was = nights();
    assert.equal((await move(b.bookingCode, "2027-02-09")).error?.code, "DATES_UNAVAILABLE");
    assert.equal((await move(b.bookingCode, "2027-02-01")).error?.code, "SAME_DATES");
    assert.equal((await move(b.bookingCode, "2027-01-09")).error?.code, "DATE_IN_PAST");
    assert.equal((await move(b.bookingCode, "2029-06-01")).error?.code, "DATE_TOO_FAR");
    assert.equal((await move(b.bookingCode, "2027-02-30")).error?.details?.checkIn, "INVALID_DATE");
    assert.deepEqual(nights(), was);
  });

  it("camping with a tarp area: tents and tarp areas move between the nightly counters", async () => {
    const { h, move, states } = await setup();
    h.db.run("UPDATE camping_settings SET tarp_enabled = 1, tarp_price_per_night_satang = 15000, max_tarps_per_night = 2");
    const b = await book(h, { stay: { kind: "CAMPING", tents: 2, tarp: true }, adults: 2 });
    h.db.run("INSERT INTO camping_night_inventory (stay_date, max_tents, tents_used, is_override, updated_at) VALUES ('2027-02-21', 1, 0, 1, '2027-01-10T00:00:00Z')");
    h.db.run("INSERT INTO camping_tarp_night_inventory (stay_date, max_tarps, tarps_used, updated_at) VALUES ('2027-02-16', 1, 1, '2027-01-10T00:00:00Z')");
    const s = await states(b.bookingCode, "2027-02-14", 10);
    assert.equal(s["2027-02-15"], "TARP_FULL", "no tarp area left on 16 Feb");
    assert.equal(s["2027-02-20"], "TAKEN", "only 1 tent on 21 Feb");
    assert.equal(s["2027-02-18"], "OK");

    assert.equal((await move(b.bookingCode, "2027-02-15")).error?.code, "TARP_FULL");
    const res = await move(b.bookingCode, "2027-02-18");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const tents = rows(h, "SELECT stay_date, tents_used FROM camping_night_inventory WHERE stay_date IN ('2027-02-01', '2027-02-02', '2027-02-18', '2027-02-19') ORDER BY 1");
    assert.deepEqual(tents, [
      { stay_date: "2027-02-01", tents_used: 0 }, { stay_date: "2027-02-02", tents_used: 0 },
      { stay_date: "2027-02-18", tents_used: 2 }, { stay_date: "2027-02-19", tents_used: 2 },
    ]);
    const tarps = rows(h, "SELECT stay_date, tarps_used FROM camping_tarp_night_inventory WHERE stay_date IN ('2027-02-01', '2027-02-18', '2027-02-19') ORDER BY 1");
    assert.deepEqual(tarps, [{ stay_date: "2027-02-01", tarps_used: 0 }, { stay_date: "2027-02-18", tarps_used: 1 }, { stay_date: "2027-02-19", tarps_used: 1 }]);
    assert.equal(res.data.totalSatang, b.totalSatang);
  });

  it("a night taken between the calendar and the click: the database refuses, nothing moves", async () => {
    const { h, move } = await setup();
    const b = await book(h, { food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 2 }] });
    const id = h.db.get<{ id: string }>("SELECT id FROM bookings WHERE booking_code = ?", b.bookingCode)!.id;
    const snapshot = () => ({
      booking: { ...h.db.get("SELECT check_in, check_out FROM bookings WHERE id = ?", id) },
      nights: rows(h, "SELECT stay_date FROM booking_unit_nights WHERE booking_id = ? ORDER BY 1", id),
      orders: rows(h, "SELECT service_date FROM food_orders WHERE booking_id = ? ORDER BY 1", id),
      capacity: rows(h, "SELECT food_category_id, service_date, used_quantity FROM food_daily_capacity ORDER BY 1, 2"),
    });
    const was = snapshot();
    // Someone blocks 13 Feb after the check passed, right before the batch runs.
    const db = h.env.DB as unknown as { batch: (s: unknown[]) => Promise<unknown> };
    const batch = db.batch.bind(db);
    db.batch = async (statements: unknown[]) => {
      db.batch = batch;
      h.db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason) VALUES ('dev_house_01', '2027-02-13', 'last minute')");
      return batch(statements);
    };
    const res = await move(b.bookingCode, "2027-02-12");
    assert.equal(res.status, 409);
    assert.equal(res.error?.code, "DATES_UNAVAILABLE");
    assert.deepEqual(snapshot(), was, "booking, nights, meals and kitchen counters all as before");
    assert.equal(h.audits("MOVE_BOOKING").length, 0);
  });

  it("a sold-out meal on the new day, a meal already cooking, a cancelled booking and missing permission stop the move", async () => {
    const { h, move, states } = await setup();
    const b = await book(h, { food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-02-01", adults: 2 }] });
    h.db.run("INSERT INTO food_daily_capacity (food_category_id, service_date, max_quantity, used_quantity, updated_at) VALUES ('dev_food_dinner', '2027-02-08', 3, 2, '2027-01-10T00:00:00Z')");
    assert.equal((await states(b.bookingCode, "2027-02-07", 3))["2027-02-08"], "FOOD_FULL");
    assert.equal((await move(b.bookingCode, "2027-02-08")).error?.code, "FOOD_UNAVAILABLE");

    const viewerId = `viewer_${++seq}`;
    const viewer = await h.login(await h.user({ id: viewerId }));
    h.grant(viewerId, "bookings.view");
    assert.equal((await move(b.bookingCode, "2027-02-12", viewer)).status, 403);
    assert.equal((await h.api("GET", `/api/admin/bookings/${b.bookingCode}/move-options?from=2027-02-01`, { token: viewer })).status, 403);

    h.db.run("UPDATE food_orders SET status = 'CONFIRMED' WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = ?)", b.bookingCode);
    h.db.run("UPDATE food_orders SET status = 'PREPARING' WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = ?)", b.bookingCode);
    assert.equal((await move(b.bookingCode, "2027-02-12")).error?.code, "KITCHEN_STARTED");

    const c = await book(h, { stay: { kind: "UNIT", unitId: "dev_house_02" } });
    const root = await h.login(await h.user({ id: `root2_${++seq}`, roles: ["SUPER_ADMIN"] }));
    assert.equal((await h.api("POST", `/api/admin/bookings/${c.bookingCode}/cancel`, { token: root, body: { reason: "guest asked" } })).status, 200);
    assert.equal((await move(c.bookingCode, "2027-02-12")).error?.code, "BOOKING_STATUS_INVALID");
  });
});
