// Several stays in one booking (migration 0026): the guest picks two houses, a VIP tent and camping with guests per
// stay; staff cancel one stay from the booking page (new total) and refund what was paid for it.
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const SHOTS = process.env.E2E_SHOTS;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 600)]); console.log("FAIL", name, String(e).slice(0, 600)); }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const day = (offset) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));
const baht = (s) => `฿${(s / 100).toLocaleString("en-US")}`;
function watch(page) {
  page.on("console", (m) => { if (m.type() === "error" && !/status of (401|404|409|422|429)/.test(m.text())) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, locale: "en-US" });
const pa = await admin.newPage(); watch(pa);
const req = admin.request;

await check("admin login", async () => {
  await pa.goto(`${BASE}/en/admin/login`);
  await pa.locator("input[autocomplete=username]").fill("admin@example.test");
  await pa.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await pa.locator("form button[type=submit]").click();
  await pa.waitForURL(`${BASE}/en/admin`);
});

const guest = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: "th-TH", isMobile: true, hasTouch: true });
const pg = await guest.newPage(); watch(pg);
let CODE = "";

await check("guest (mobile, TH) picks two houses, a VIP tent and camping in one booking, with guests per stay", async () => {
  const ci = day(30), co = day(32);
  await pg.goto(`${BASE}/th/booking?checkIn=${ci}&checkOut=${co}&adults=6&children=1`);
  await pg.locator("form.stay-search button[type=submit]").click();
  const card = (name) => pg.locator(".unit-pick", { has: pg.getByRole("heading", { name }) });
  await card(/House 01/).getByRole("button", { name: "เลือกหลังนี้" }).click();
  const picks = pg.locator("#picks");
  await picks.getByRole("heading", { name: "ที่พักที่เลือก" }).waitFor();
  await card(/House 02/).getByRole("button", { name: "เพิ่มหลังนี้" }).click();
  await card(/VIP-01/).getByRole("button", { name: "เพิ่มหลังนี้" }).click();
  await card(/House 01/).getByRole("button", { name: /เลือกแล้ว/ }).waitFor();
  // The bar follows the guest down the page …
  await card(/VIP-01/).scrollIntoViewIfNeeded();
  await pg.locator(".picks-bar").getByText("3 รายการ").waitFor();
  // … and steps aside while the panel's own total and "next" are on screen.
  await picks.locator(".picks__foot").scrollIntoViewIfNeeded();
  await pg.locator(".picks-bar").waitFor({ state: "detached" });
  // Guests split from the search (6 adults, 1 child): House 01 takes 4, House 02 the other 2 + the child; VIP gets 1.
  const value = (stay, what) => picks.getByRole("group", { name: new RegExp(`${stay}.* · ${what}$`) }).locator("output").textContent();
  assert(await value("House 01", "ผู้ใหญ่") === "4", "House 01: 4 adults");
  assert(await value("House 02", "ผู้ใหญ่") === "2" && await value("House 02", "เด็ก") === "1", "House 02: 2 + 1");
  assert(await value("VIP-01", "ผู้ใหญ่") === "1", "VIP: 1 adult");
  // One fewer in House 01; one more in the VIP tent.
  await picks.getByRole("group", { name: /House 01.* · ผู้ใหญ่$/ }).getByRole("button", { name: /^ลด / }).click();
  await picks.getByRole("group", { name: /VIP-01.* · ผู้ใหญ่$/ }).getByRole("button", { name: /^เพิ่ม / }).click();
  await picks.getByText("รวม 3 รายการ · ผู้ใหญ่ 7 · เด็ก 1").waitFor();

  // Camping joins the same booking: 2 adults, 1 tent.
  const form = pg.getByRole("form", { name: "เลือกวันที่ จำนวนคน และจำนวนเต็นท์" });
  const adults = form.getByRole("group", { name: "ผู้ใหญ่" });
  for (let i = 0; i < 4; i++) await adults.getByRole("button", { name: /^ลด / }).click();
  await form.getByRole("group", { name: "เด็ก" }).getByRole("button", { name: /^ลด / }).click();
  await form.getByRole("button", { name: "เพิ่มลานกางเต็นท์ในการจองนี้" }).click();
  await picks.getByText("รวม 4 รายการ · ผู้ใหญ่ 9 · เด็ก 1").waitFor();
  await picks.getByText("ผู้ใหญ่ 2 · เด็ก 0").waitFor();
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `horizontal scroll ${overflow}px`);
  await picks.screenshot({ path: `${SHOTS}/multistay-picks.png` });
  await pg.screenshot({ path: `${SHOTS}/multistay-bar.png` });

  await picks.getByRole("button", { name: /ถัดไป/ }).click();
  await pg.getByRole("heading", { name: "สั่งอาหารล่วงหน้า" }).waitFor();
  const stay = pg.locator(".flow-stay");
  for (const name of ["House 01", "House 02", "VIP-01", "1 เต็นท์"]) await stay.getByText(name, { exact: false }).first().waitFor();
  const summary = pg.locator(".summary").first();
  await summary.locator(".summary__line--stay", { hasText: "House 02" }).getByText("ผู้ใหญ่ 2 · เด็ก 1").waitFor();
  await summary.locator(".summary__line--stay", { hasText: "VIP-01" }).getByText("ผู้ใหญ่ 2 · เด็ก 0").waitFor();
  await pg.getByRole("button", { name: /ถัดไป/ }).click();
  await pg.locator("#bk-name").fill("กลุ่ม เพื่อนเที่ยว");
  await pg.locator("#bk-phone").fill("0867777777");
  await pg.getByRole("button", { name: /ถัดไป/ }).click();
  await pg.getByLabel(/ข้าพเจ้ายอมรับนโยบายความเป็นส่วนตัว/).check();
  await pg.getByRole("button", { name: /ยืนยันการจอง/ }).click();
  await pg.getByRole("heading", { name: "จองเรียบร้อย" }).waitFor();
  CODE = (await pg.locator(".confirmation__value").first().textContent()).trim();
  await pg.screenshot({ path: `${SHOTS}/multistay-confirmation.png`, fullPage: true });

  const b = (await (await req.get(`${BASE}/api/admin/bookings/${CODE}`)).json()).data;
  assert(b.items.length === 4, `stays ${b.items.length}`);
  assert(JSON.stringify(b.items.map((i) => [i.adults, i.children])) === JSON.stringify([[3, 0], [2, 1], [2, 0], [2, 0]]), JSON.stringify(b.items.map((i) => [i.adults, i.children])));
  assert(b.adults === 9 && b.children === 1, `${b.adults}/${b.children}`);
});

await check("admin: the booking lists its stays; cancelling the VIP tent alone gives a new total", async () => {
  await pa.goto(`${BASE}/en/admin/bookings`);
  await pa.locator("tr", { hasText: CODE }).getByText(/House 01.*\+.*House 02.*\+.*VIP-01.*\+/).waitFor();
  await pa.goto(`${BASE}/en/admin/bookings/${CODE}`);
  await pa.getByRole("heading", { name: "Stays in this booking (4)" }).waitFor();
  const before = (await (await req.get(`${BASE}/api/admin/bookings/${CODE}`)).json()).data;
  const vip = before.items.find((i) => i.unitId === "dev_vip_01");
  const stay = pa.locator(".adm-stay", { has: pa.getByRole("heading", { name: /VIP-01/ }) });
  await stay.getByRole("button", { name: "Cancel this stay" }).click();
  const dialog = pa.locator("dialog[open]");
  await dialog.getByRole("heading", { name: /Cancel VIP-01/ }).waitFor();
  await dialog.getByLabel(/Reason for cancelling/).fill("One tent less");
  await pa.screenshot({ path: `${SHOTS}/multistay-cancel-dialog.png` });
  await dialog.getByRole("button", { name: "Cancel this stay" }).click();
  const total = before.totalSatang - vip.subtotalSatang;
  await pa.getByText(`VIP-01 cancelled — new total ${baht(total)}.`, { exact: false }).waitFor();
  await stay.getByText("Cancelled").waitFor();
  await pa.getByRole("heading", { name: "Stays in this booking (3)" }).waitFor();
  // "Record payment" now asks for the new total, not the old one.
  const amount = await pa.getByLabel(/Amount \(THB\)/).inputValue();
  assert(amount === String(total / 100), `record payment amount ${amount}`);
  await pa.screenshot({ path: `${SHOTS}/multistay-admin.png`, fullPage: true });
  const after = (await (await req.get(`${BASE}/api/admin/bookings/${CODE}`)).json()).data;
  assert(after.totalSatang === total && after.status === "PENDING", `${after.totalSatang} ${after.status}`);
  // The guest page shows the stay as cancelled and asks for the new total.
  await pg.goto(`${BASE}/th/booking/lookup?code=${CODE}`);
  await pg.locator("#lk-phone").fill("0867777777");
  await pg.locator("form button[type=submit]").click();
  await pg.locator(".summary__line--cancelled", { hasText: "VIP-01" }).getByText("ยกเลิกแล้ว").waitFor();
  await pg.locator(".pay__amount").getByText(baht(total)).waitFor();
});

await check("paid booking: cancelling a stay shows the money to refund; staff refund it from the payment", async () => {
  const body = { checkIn: day(40), checkOut: day(41), stays: [
    { kind: "UNIT", unitId: "dev_house_02", adults: 2, children: 0 }, { kind: "UNIT", unitId: "dev_vip_02", adults: 2, children: 0 },
  ], food: [], lang: "en" };
  const q = await (await req.post(`${BASE}/api/public/bookings/quote`, { headers: H, data: body })).json();
  const created = await (await req.post(`${BASE}/api/public/bookings`, { headers: H, data: { ...body, customer: { name: "Paid Group", phone: "0868888888" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `e2e-multi-${Date.now()}` } })).json();
  const P = created.data;
  assert(P, JSON.stringify(created));
  const paid = await req.post(`${BASE}/api/admin/bookings/${P.bookingCode}/payments`, { headers: H, data: { amountSatang: P.totalSatang, method: "BANK_TRANSFER", paidAt: new Date().toISOString() } });
  assert(paid.ok(), await paid.text());
  await pa.goto(`${BASE}/en/admin/bookings/${P.bookingCode}`);
  const vipSub = P.items[1].subtotalSatang;
  const stay = pa.locator(".adm-stay", { has: pa.getByRole("heading", { name: /VIP-02/ }) });
  await stay.getByRole("button", { name: "Cancel this stay" }).click();
  const dialog = pa.locator("dialog[open]");
  await dialog.getByLabel(/Reason for cancelling/).fill("VIP not needed");
  await dialog.getByRole("button", { name: "Cancel this stay" }).click();
  await pa.locator("#payment").getByText(`The guest paid ${baht(vipSub)} more than the total (a stay was cancelled).`, { exact: false }).waitFor();
  await pa.locator("#payment").getByRole("button", { name: "Refund" }).click();
  if ((await pa.getByLabel("Refund amount (THB)").inputValue()) !== String(vipSub / 100)) throw new Error("refund amount not the overpaid money");
  await pa.locator("form.adm-subform").getByLabel("Reason").fill("VIP tent cancelled");
  await pa.locator("form.adm-subform").getByRole("button", { name: "Refund" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Refund" }).click();
  await pa.getByText("Refund recorded", { exact: false }).first().waitFor();
  const b = (await (await req.get(`${BASE}/api/admin/bookings/${P.bookingCode}`)).json()).data;
  assert(b.overpaidSatang === 0 && b.paidSatang === b.totalSatang && b.status === "CONFIRMED", JSON.stringify([b.overpaidSatang, b.paidSatang, b.totalSatang, b.status]));
  await pa.screenshot({ path: `${SHOTS}/multistay-refund.png`, fullPage: true });
});

console.log("console errors:", consoleErrors.length, consoleErrors.slice(0, 5));
await check("no CSP violations or page errors", async () => {
  const bad = consoleErrors.filter((e) => /Content Security Policy|Refused to|pageerror/i.test(e));
  assert(!bad.length, bad.join("\n"));
});
await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
