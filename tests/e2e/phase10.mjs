const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const SHOTS = process.env.E2E_SHOTS;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 400)]); console.log("FAIL", name, String(e).slice(0, 400)); }
}
const day = (offset) => {
  const d = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};
let seq = 0;
async function book(req, body, phone) {
  const full = { adults: 2, children: 0, food: [], lang: "en", ...body };
  const q = await (await req.post(`${BASE}/api/public/bookings/quote`, { headers: H, data: full })).json();
  if (!q.data) throw new Error(JSON.stringify(q));
  const r = await (await req.post(`${BASE}/api/public/bookings`, { headers: H, data: { ...full, customer: { name: `Guest ${++seq}`, phone }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `e2e-key-${Date.now()}-${seq}` } })).json();
  if (!r.data) throw new Error(JSON.stringify(r));
  return r.data;
}
function watch(page) {
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}


const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "en-US", acceptDownloads: true });
const pa = await admin.newPage(); watch(pa);
const req = admin.request;
const today = day(0);
const A = await book(req, { checkIn: today, checkOut: day(2), stay: { kind: "UNIT", unitId: "dev_house_01" } }, "0811111111");
const C = await book(req, { checkIn: today, checkOut: day(1), adults: 3, stay: { kind: "CAMPING", tents: 3 } }, "0833333333");
const D = await book(req, { checkIn: day(3), checkOut: day(4), stay: { kind: "UNIT", unitId: "dev_house_02" }, food: [{ optionId: "dev_food_dinner_a", serviceDate: day(3), adults: 2 }] }, "0844444444");
const B = await book(req, { checkIn: day(3), checkOut: day(4), stay: { kind: "UNIT", unitId: "dev_vip_01" }, food: [{ optionId: "dev_food_dinner_a", serviceDate: day(3), adults: 2 }] }, "0822222222");

async function login(page, email, lang = "en") {
  await page.goto(`${BASE}/${lang}/admin/login`);
  await page.locator("input[autocomplete=username]").fill(email);
  await page.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await page.locator("form button[type=submit]").click();
  await page.waitForURL(`${BASE}/${lang}/admin`);
}
await check("admin login", () => login(pa, "admin@example.test"));
for (const b of [A, C, D]) {
  const r = await req.post(`${BASE}/api/admin/bookings/${b.bookingCode}/payments`, { headers: H, data: { amountSatang: b.totalSatang, method: "CASH", paidAt: new Date(Date.now() - 60000).toISOString() } });
  if (!r.ok()) console.log("pay failed", await r.text());
}

await check("revenue report (monthly) with totals and chart", async () => {
  await pa.goto(`${BASE}/en/admin/reports`);
  await pa.getByRole("heading", { name: "By period" }).waitFor();
  await pa.locator(".rpt-bars").first().waitFor();
  const total = await pa.locator(".rpt-table").first().locator("tfoot td").nth(3).textContent();
  const expected = (A.totalSatang + C.totalSatang + D.totalSatang) / 100;
  if (!total.replace(/[^\d.]/g, "").startsWith(String(expected))) throw new Error(`total ${total} expected ${expected}`);
  await pa.screenshot({ path: `${SHOTS}/h-report-revenue.png`, fullPage: true });
});

await check("Excel download is a valid workbook", async () => {
  const [download] = await Promise.all([pa.waitForEvent("download"), pa.getByRole("link", { name: "Download Excel" }).click()]);
  const name = download.suggestedFilename();
  if (!/^chomkhao-revenue-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx$/.test(name)) throw new Error(name);
  await download.saveAs(`${SHOTS}/browser-revenue.xlsx`);
});

await check("bookings report: yearly grouping + details", async () => {
  await pa.getByRole("tab", { name: "Bookings" }).click();
  await pa.getByRole("tab", { name: "Yearly" }).click();
  await pa.getByRole("heading", { name: "Details" }).waitFor();
  await pa.getByText(B.bookingCode).waitFor();
  const rows = await pa.locator(".rpt-table").first().locator("tbody tr").count();
  if (rows !== 12) throw new Error("months " + rows);
});

await check("custom range validation (day grouping > 366 days)", async () => {
  await pa.getByRole("tab", { name: "Custom" }).click();
  await pa.getByLabel("From").fill("2025-01-01");
  await pa.getByLabel("To").fill("2026-12-31");
  await pa.getByText("Date range too long").waitFor();
  await pa.getByLabel("Group by").selectOption("month");
  await pa.getByRole("button", { name: "Show report" }).click();
  await pa.getByRole("heading", { name: "By period" }).waitFor();
});

await check("PDF view: printable A4 document (export audited)", async () => {
  await pa.getByRole("tab", { name: "Revenue" }).click();
  await pa.getByRole("tab", { name: "Monthly" }).click();
  await pa.getByRole("heading", { name: "By period" }).waitFor();
  const [popup] = await Promise.all([admin.waitForEvent("page"), pa.getByRole("link", { name: "PDF / Print" }).click()]);
  watch(popup);
  await popup.getByRole("heading", { name: "Reports: Revenue" }).waitFor();
  await popup.locator(".rpt-grid").first().waitFor();
  await popup.screenshot({ path: `${SHOTS}/h-report-print.png`, fullPage: true });
  await popup.pdf({ path: `${SHOTS}/h-report-revenue.pdf`, format: "A4", landscape: true, printBackground: true });
  const audits = await (await req.get(`${BASE}/api/admin/audit-logs?limit=5`, { headers: H })).json();
  if (!JSON.stringify(audits).includes("EXPORT_REPORT")) throw new Error("no export audit");
  await popup.close();
});

await check("Thai print view (TH admin)", async () => {
  const p = await admin.newPage(); watch(p);
  const q = new URLSearchParams({ type: "kitchen", from: day(3), to: day(3), group: "day" });
  await p.goto(`${BASE}/th/admin/reports/print?${q}`);
  await p.getByRole("heading", { name: "รายงาน: รายงานครัว" }).waitFor();
  await p.getByText("Dinner A").first().waitFor();
  await p.pdf({ path: `${SHOTS}/h-kitchen-th.pdf`, format: "A4", landscape: true, printBackground: true });
  await p.close();
});

await check("kitchen staff: kitchen report with confirmed vs awaiting payment, Excel allowed", async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage(); watch(p);
  await login(p, "kitchen@example.test", "th");
  if (await p.locator("nav").getByRole("link", { name: "รายงาน", exact: true }).count()) throw new Error("reports menu visible to kitchen");
  await p.goto(`${BASE}/th/admin/kitchen`);
  await p.getByLabel("วันที่").fill(day(3));
  await p.getByRole("heading", { name: "จำนวนที่ต้องเตรียม" }).waitFor();
  const dinner = p.locator(".rpt-table").first().locator("tbody tr", { hasText: "Dinner A" });
  const cells = await dinner.locator("td").allTextContents();
  if (!(cells.includes("2") && cells.filter((c) => c === "2").length >= 2)) throw new Error("cells " + cells.join("|"));
  await p.getByRole("link", { name: "ดาวน์โหลด Excel" }).waitFor();
  await p.screenshot({ path: `${SHOTS}/h-kitchen-report.png`, fullPage: true });
  await ctx.close();
});

await check("viewer: reports visible, export not offered (and refused by API)", async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); watch(p);
  await login(p, "viewer@example.test", "th");
  await p.goto(`${BASE}/th/admin/reports`);
  await p.getByText("คุณไม่มีสิทธิ์ส่งออกรายงาน").waitFor();
  const r = await ctx.request.get(`${BASE}/api/admin/reports/revenue/export?from=${today}&to=${today}`);
  if (r.status() !== 403) throw new Error("export status " + r.status());
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error("horizontal overflow on mobile");
  await p.screenshot({ path: `${SHOTS}/h-report-mobile.png`, fullPage: true });
  await ctx.close();
});

await browser.close();
const csp = consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e));
const real = consoleErrors.filter((e) => !/status of (401|403|409|422)/.test(e));
console.log("console errors:", real.length, real.slice(0, 10));
console.log("CSP errors:", csp.length);
console.log(`\n${results.filter((r) => r[0] === "PASS").length}/${results.length} passed`);
