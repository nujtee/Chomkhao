import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type { ReportDto, ReportTable } from "../../src/shared/report-types.ts";
import { buildXlsx, crc32, xmlEscape } from "../../src/worker/reports/xlsx.ts";
import { allocateNights } from "../../src/worker/services/report.service.ts";
import { ORIGIN, Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10T03:00Z → today 2027-01-10 (Asia/Bangkok).
let seq = 0;
const key = () => `rep-key-${String(++seq).padStart(10, "0")}`;

async function staff(h: Harness, perms: string[]) {
  const id = `rep_staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

async function book(h: Harness, body: Record<string, unknown>, phone = "0812345678", name = "Report Guest") {
  const full = { adults: 2, children: 0, food: [], lang: "th", ...body };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: full });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...full, customer: { name, phone }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

async function pay(h: Harness, token: string, b: PublicBookingDto, method = "CASH") {
  const r = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments`, {
    token, body: { amountSatang: b.totalSatang, method, paidAt: "2027-01-10T02:00:00Z" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

const report = (h: Harness, token: string, type: string, q: string) => h.api<ReportDto>("GET", `/api/admin/reports/${type}?${q}`, { token });
const table = (r: ReportDto, k: string) => r.tables.find((t) => t.key === k)!;
const rowOf = (t: ReportTable, col: string, value: string) => t.rows.find((r) => r[col] === value)!;

/** Reads a stored (uncompressed) ZIP into name → text. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  while (view.getUint32(p, true) === 0x04034b50) {
    assert.equal(view.getUint16(p + 8, true), 0, "stored entries");
    const size = view.getUint32(p + 18, true);
    const nameLen = view.getUint16(p + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const data = bytes.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
    assert.equal(crc32(data), view.getUint32(p + 14, true), `crc ${name}`);
    out.set(name, new TextDecoder().decode(data));
    p += 30 + nameLen + size;
  }
  return out;
}

describe("report building blocks", () => {
  it("splits a stay's revenue over its nights by nightly price, exactly", () => {
    const parts = allocateNights({
      check_in: "2027-01-30", check_out: "2027-02-02",
      nightly_prices_json: JSON.stringify([{ date: "2027-01-30", priceSatang: 100000 }, { date: "2027-01-31", priceSatang: 100000 }, { date: "2027-02-01", priceSatang: 200000 }]),
    }, 400001);
    assert.deepEqual([...parts.keys()], ["2027-01-30", "2027-01-31", "2027-02-01"], "check-out day is not a night");
    assert.equal([...parts.values()].reduce((a, b) => a + b, 0), 400001);
    assert.equal(parts.get("2027-01-30"), 100000);
    const equal = allocateNights({ check_in: "2027-01-01", check_out: "2027-01-04", nightly_prices_json: null }, 1000);
    assert.deepEqual([...equal.values()], [333, 333, 334]);
  });

  it("XLSX: valid ZIP with CRC, inline strings only (no formulas), escaped XML", () => {
    assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
    assert.equal(xmlEscape('<a href="x">&\u0001'), "&lt;a href=&quot;x&quot;&gt;&amp;");
    const files = unzip(buildXlsx([{
      name: "Sheet: [1]", titleLines: ["รายงาน"], columns: [{ label: "ชื่อ", kind: "text", width: 20 }, { label: "เงิน", kind: "money", width: 12 }],
      rows: [["=HYPERLINK(\"http://evil\",\"x\")", 1234.5], ["อาหาร <B>", null]], totals: ["รวม", 1234.5],
    }], { title: "t", createdAt: "2027-01-10T03:00:00Z" }));
    for (const f of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
      assert.ok(files.has(f), f);
    }
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    assert.doesNotMatch(sheet, /<f>/, "never a formula");
    assert.match(sheet, /t="inlineStr" s="0"><is><t xml:space="preserve">=HYPERLINK\(&quot;http:\/\/evil&quot;,&quot;x&quot;\)<\/t>/);
    assert.match(sheet, /<v>1234\.5<\/v>/);
    assert.match(sheet, /อาหาร &lt;B&gt;/);
    assert.match(files.get("xl/workbook.xml")!, /<sheet name="Sheet\s+1"/, "invalid sheet-name characters replaced");
  });
});

describe("revenue report (spec §50)", () => {
  it("splits stays across months by night, counts food on its service date, and cash by confirmation date", async () => {
    const h = new Harness({ seed: true });
    const admin = await staff(h, ["reports.view", "payments.verify", "payments.refund", "bookings.cancel"]);
    const cross = await book(h, {
      checkIn: "2027-01-30", checkOut: "2027-02-02", stay: { kind: "UNIT", unitId: "dev_house_02" },
      food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-31", adults: 2 }],
    });
    await pay(h, admin, cross);
    await book(h, { checkIn: "2027-01-20", checkOut: "2027-01-21", stay: { kind: "UNIT", unitId: "dev_vip_01" } }, "0899999999"); // unpaid: not revenue
    const refunded = await book(h, { checkIn: "2027-01-25", checkOut: "2027-01-26", stay: { kind: "UNIT", unitId: "dev_vip_02" } }, "0866666666");
    await pay(h, admin, refunded, "BANK_TRANSFER");
    await h.api("POST", `/api/admin/bookings/${refunded.bookingCode}/cancel`, { token: admin, body: { reason: "guest asked" } });
    const detail = (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${refunded.bookingCode}`, { token: await staff(h, ["bookings.view", "payments.view"]) })).data;
    const refund = await h.api("POST", `/api/admin/bookings/${refunded.bookingCode}/payments/${detail.payments[0]!.id}/refund`, {
      token: admin, body: { amountSatang: refunded.totalSatang, reason: "cancelled" },
    });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));

    const res = await report(h, admin, "revenue", "from=2027-01-01&to=2027-02-28&group=month");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const t = table(res.data, "byPeriod");
    assert.deepEqual(t.rows.map((r) => r.period), ["2027-01", "2027-02"]);
    const jan = t.rows[0]!;
    const feb = t.rows[1]!;
    const crossDetail = (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${cross.bookingCode}`, { token: await staff(h, ["bookings.view"]) })).data;
    const nightly = crossDetail.item.nightly;
    assert.equal(jan.accommodation, nightly[0]!.priceSatang + nightly[1]!.priceSatang, "2 January nights");
    assert.equal(feb.accommodation, nightly[2]!.priceSatang, "1 February night");
    assert.equal(jan.unitNights, 2);
    assert.equal(feb.unitNights, 1);
    assert.equal(jan.food, crossDetail.foodSubtotalSatang, "dinner on 31 January");
    assert.equal(t.totals!.total, cross.totalSatang, "unpaid and refunded bookings are not revenue");
    assert.equal(jan.received, cross.totalSatang + refunded.totalSatang, "cash basis: money received on 10 January");
    assert.equal(jan.refunded, refunded.totalSatang);
    assert.equal(jan.net, cross.totalSatang);
    const byType = table(res.data, "byType");
    assert.equal(rowOf(byType, "type", "HOUSE").nights, 3);
    assert.equal(rowOf(byType, "type", "FOOD").revenue, crossDetail.foodSubtotalSatang);
    assert.deepEqual(res.data.notes, ["stayBasis", "cashBasis"]);

    const days = await report(h, admin, "revenue", "from=2027-01-29&to=2027-02-02&group=day");
    assert.deepEqual(table(days.data, "byPeriod").rows.map((r) => r.unitNights), [0, 1, 1, 1, 0], "every day present, zeros included");
  });
});

describe("booking, accommodation, camping, food and payment reports", () => {
  it("counts by status with details; customer names only with bookings.view", async () => {
    const h = new Harness({ seed: true });
    const admin = await staff(h, ["reports.view", "payments.verify", "bookings.view"]);
    const a = await book(h, { checkIn: "2027-01-15", checkOut: "2027-01-17", stay: { kind: "UNIT", unitId: "dev_house_01" } }, "0811111111", "Somchai");
    await pay(h, admin, a);
    await book(h, { checkIn: "2027-01-15", checkOut: "2027-01-16", stay: { kind: "UNIT", unitId: "dev_vip_01" } }, "0822222222", "Malee");
    const r = (await report(h, admin, "booking", "from=2027-01-10&to=2027-01-10")).data;
    const period = table(r, "byPeriod");
    assert.equal(period.rows[0]!.created, 2);
    assert.equal(period.rows[0]!.confirmed, 1);
    assert.equal(period.rows[0]!.pending, 1);
    assert.equal(rowOf(table(r, "byStatus"), "status", "CONFIRMED").count, 1);
    const details = table(r, "details");
    assert.ok(details.columns.some((c) => c.key === "customer"));
    assert.deepEqual(details.rows.map((x) => x.customer).sort(), ["Malee", "Somchai"]);

    const noNames = await staff(h, ["reports.view"]);
    const r2 = (await report(h, noNames, "booking", "from=2027-01-10&to=2027-01-10")).data;
    assert.ok(!table(r2, "details").columns.some((c) => c.key === "customer"));
    assert.doesNotMatch(JSON.stringify(r2), /Somchai|Malee|0811111111/);
    assert.ok(r2.notes.includes("piiHidden"));
  });

  it("occupancy per unit (blocked nights reduce availability) and camping capacity per night", async () => {
    const h = new Harness({ seed: true });
    const admin = await staff(h, ["reports.view", "payments.verify", "accommodation.block"]);
    const a = await book(h, { checkIn: "2027-01-15", checkOut: "2027-01-17", stay: { kind: "UNIT", unitId: "dev_house_01" } });
    await pay(h, admin, a);
    const blk = await h.api("POST", "/api/admin/accommodations/dev_house_02/blocks", { token: admin, body: { startDate: "2027-01-15", endDate: "2027-01-15", reason: "repair" } });
    assert.ok(blk.status < 300, JSON.stringify(blk.body));
    const tent = await book(h, { checkIn: "2027-01-15", checkOut: "2027-01-16", adults: 4, stay: { kind: "CAMPING", tents: 2 } }, "0833333333");
    await pay(h, admin, tent);

    const acc = (await report(h, admin, "accommodation", "from=2027-01-15&to=2027-01-16")).data;
    const units = table(acc, "byUnit");
    const h1 = units.rows.find((r) => String(r.unit).includes("01") && r.type === "HOUSE")!;
    assert.deepEqual([h1.available, h1.sold, h1.occupancy], [2, 2, 100]);
    assert.equal(h1.revenue, a.totalSatang);
    assert.equal(h1.adr, Math.round(a.totalSatang / 2));
    const h2 = units.rows.find((r) => String(r.unit).includes("02") && r.type === "HOUSE")!;
    assert.deepEqual([h2.available, h2.blocked], [1, 1]);

    const camp = (await report(h, admin, "camping", "from=2027-01-15&to=2027-01-16")).data;
    const nights = table(camp, "byPeriod").rows;
    assert.deepEqual(nights.map((n) => [n.capacity, n.tentsSold, n.adults]), [[30, 2, 4], [30, 0, 0]]);
    assert.equal(nights[0]!.occupancy, 6.7);
    assert.equal(table(camp, "byPeriod").totals!.revenue, tent.totalSatang);
  });

  it("food sales by dish and payment report by method / verification", async () => {
    const h = new Harness({ seed: true });
    const admin = await staff(h, ["reports.view", "payments.verify"]);
    const b = await book(h, {
      checkIn: "2027-01-12", checkOut: "2027-01-14", stay: { kind: "UNIT", unitId: "dev_house_01" },
      food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-12", adults: 2 }],
    });
    await pay(h, admin, b, "PROMPTPAY");
    const food = (await report(h, admin, "food", "from=2027-01-12&to=2027-01-15")).data;
    const dinner = rowOf(table(food, "byDish"), "dish", "อาหารเย็น A");
    assert.deepEqual([dinner.quantity, dinner.included, dinner.extra], [2, 0, 2]);
    const breakfast = table(food, "byDish").rows.find((r) => String(r.dish).startsWith("อาหารเช้า"))!;
    assert.equal(breakfast.included, 4, "House Sakura: breakfast for 2 × 2 mornings included");
    assert.equal(breakfast.revenue, 0);

    const pay2 = (await report(h, admin, "payment", "from=2027-01-10&to=2027-01-10")).data;
    assert.equal(rowOf(table(pay2, "byMethod"), "method", "PROMPTPAY").amount, b.totalSatang);
    assert.equal(rowOf(table(pay2, "byVerification"), "verification", "RECORDED").count, 1);
    assert.equal(table(pay2, "details").rows[0]!.bookingCode, b.bookingCode);
  });
});

describe("kitchen report", () => {
  it("needs only kitchen.view, shows unpaid bookings separately, no money", async () => {
    const h = new Harness({ seed: true });
    const fin = await staff(h, ["payments.verify"]);
    const paid = await book(h, { checkIn: "2027-01-12", checkOut: "2027-01-13", stay: { kind: "UNIT", unitId: "dev_house_02" }, food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-12", adults: 2 }] });
    await pay(h, fin, paid);
    await book(h, { checkIn: "2027-01-12", checkOut: "2027-01-13", adults: 3, stay: { kind: "UNIT", unitId: "dev_vip_01" }, food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-12", adults: 3 }] }, "0899999999");
    const kitchen = await staff(h, ["kitchen.view"]);
    const r = await report(h, kitchen, "kitchen", "from=2027-01-12&to=2027-01-12");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const dinner = table(r.data, "production").rows.find((x) => x.dish === "อาหารเย็น A")!;
    assert.deepEqual([dinner.portions, dinner.portionsPending], [2, 3]);
    assert.ok(!r.data.tables.some((t) => t.columns.some((c) => c.kind === "money")), "kitchen report has no money");
    assert.equal(table(r.data, "orders").rows.length, 2);
    assert.equal((await report(h, kitchen, "revenue", "from=2027-01-12&to=2027-01-12")).status, 403);
    const tooLong = await report(h, kitchen, "kitchen", "from=2027-01-01&to=2027-03-01");
    assert.equal(tooLong.error?.details?.to, "RANGE_TOO_LONG");
    // Kitchen staff may print/export the kitchen sheet (operational, no money).
    const xlsx = await h.app.fetch(new Request(`${ORIGIN}/api/admin/reports/kitchen/export?from=2027-01-12&to=2027-01-12&lang=en`, {
      headers: { Cookie: `__Host-sid=${kitchen}` },
    }), h.env);
    assert.equal(xlsx.status, 200);
  });
});

describe("report permissions, validation and exports", () => {
  it("view needs reports.view; Excel/PDF need reports.export and are audited", async () => {
    const h = new Harness({ seed: true });
    const viewer = await staff(h, ["reports.view"]);
    const exporter = await staff(h, ["reports.view", "reports.export", "payments.verify"]);
    const nobody = await staff(h, []);
    assert.equal((await report(h, nobody, "revenue", "from=2027-01-01&to=2027-01-31")).status, 403);
    assert.equal((await h.api("GET", "/api/admin/reports/revenue?from=2027-01-01&to=2027-01-31")).status, 401);
    assert.equal((await report(h, viewer, "secret", "from=2027-01-01&to=2027-01-31")).status, 404);
    assert.equal((await report(h, viewer, "revenue", "from=2027-01-01&to=2027-01-31&evil=1")).error?.details?.evil, "UNKNOWN_FIELD");
    assert.equal((await report(h, viewer, "revenue", "from=2026-01-01&to=2027-02-15&group=day")).error?.details?.to, "RANGE_TOO_LONG");
    assert.equal((await report(h, viewer, "revenue", "from=2027-01-01&to=2028-12-31&group=month")).status, 200);
    assert.equal((await report(h, viewer, "revenue", "from=2027-02-01&to=2027-01-01")).error?.details?.to, "BEFORE_START");
    assert.equal((await report(h, viewer, "revenue", "from=2027-13-01&to=2027-01-01")).error?.details?.from, "INVALID_DATE");
    assert.equal((await report(h, viewer, "revenue", "from=2027-01-01&to=2027-01-31&export=pdf")).status, 403, "PDF export needs reports.export");
    assert.equal(h.audits("EXPORT_REPORT").length, 0);

    const b = await book(h, { checkIn: "2027-01-15", checkOut: "2027-01-16", stay: { kind: "UNIT", unitId: "dev_house_01" } });
    await pay(h, exporter, b);
    const pdf = await report(h, exporter, "revenue", "from=2027-01-01&to=2027-01-31&export=pdf&lang=en");
    assert.equal(pdf.status, 200);
    const get = (path: string, token: string) => h.app.fetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: `__Host-sid=${token}` } }), h.env);
    const denied = await get("/api/admin/reports/revenue/export?from=2027-01-01&to=2027-01-31", viewer);
    assert.equal(denied.status, 403);
    const res = await get("/api/admin/reports/revenue/export?from=2027-01-01&to=2027-01-31&group=day&lang=th", exporter);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(res.headers.get("Content-Disposition"), 'attachment; filename="chomkhao-revenue-2027-01-01_2027-01-31.xlsx"');
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const files = unzip(new Uint8Array(await res.arrayBuffer()));
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    assert.match(sheet, /รายงาน: รายได้/);
    assert.match(sheet, /สรุปตามช่วงเวลา/);
    assert.match(sheet, new RegExp(`<v>${b.totalSatang / 100}</v>`), "money exported in baht");
    assert.match(files.get("xl/workbook.xml")!, /sheet name="สรุปตามช่วงเวลา"/);
    const audits = h.audits("EXPORT_REPORT");
    assert.equal(audits.length, 2);
    assert.match(audits[1]!.new_value!, /"format":"xlsx"/);
    assert.doesNotMatch(audits[1]!.new_value!, /satang|Report Guest/, "audit holds the request, never the data");
  });
});

describe("report labels (TH / EN / ZH-CN)", () => {
  it("dictionaries match and every column, table, note and code a report emits has a label", async () => {
    const { reportTh, reportEn, reportZhCN } = await import("../../src/shared/i18n/report-messages.ts");
    const keys = (o: object, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    for (const d of [reportEn, reportZhCN]) assert.deepEqual(keys(d).sort(), keys(reportTh).sort());

    const h = new Harness({ seed: true });
    const admin = await staff(h, ["reports.view", "kitchen.view", "bookings.view", "payments.verify"]);
    const b = await book(h, { checkIn: "2027-01-12", checkOut: "2027-01-14", stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-12", adults: 2 }] });
    await pay(h, admin, b);
    for (const type of ["revenue", "booking", "accommodation", "camping", "food", "kitchen", "payment"]) {
      const r = (await report(h, admin, type, "from=2027-01-10&to=2027-01-14")).data;
      for (const n of r.notes) assert.ok((reportTh.notes as Record<string, string>)[n], `${type} note ${n}`);
      for (const t of r.tables) {
        assert.ok((reportTh.tables as Record<string, string>)[t.key], `${type} table ${t.key}`);
        for (const c of t.columns) {
          assert.ok((reportTh.cols as Record<string, string>)[c.key], `${type}.${t.key} column ${c.key}`);
          if (c.kind !== "code") continue;
          for (const row of t.rows) if (row[c.key] != null) assert.ok((reportTh.codes as Record<string, string>)[String(row[c.key])], `${type} code ${row[c.key]}`);
        }
      }
    }
  });
});
