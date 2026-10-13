const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const SHOTS = process.env.E2E_SHOTS;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const GROUP = `C${"a1".repeat(16)}`;
const GUEST = `U${"d4".repeat(16)}`;
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 500)]); console.log("FAIL", name, String(e).slice(0, 500)); }
}
const day = (offset) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));
let seq = 0;
async function book(req, body, phone, name) {
  const full = { adults: 2, children: 0, food: [], lang: "th", ...body };
  const q = await (await req.post(`${BASE}/api/public/bookings/quote`, { headers: H, data: full })).json();
  if (!q.data) throw new Error(JSON.stringify(q));
  const r = await (await req.post(`${BASE}/api/public/bookings`, { headers: H, data: { ...full, customer: { name: name ?? `Guest ${++seq}`, phone }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `e2e-line-${Date.now()}-${++seq}` } })).json();
  if (!r.data) throw new Error(JSON.stringify(r));
  return r.data;
}
function watch(page) {
  // 401 on the login page = the "am I signed in?" probe before signing in (expected).
  page.on("console", (m) => { if (m.type() === "error" && !/status of (409|422|429)/.test(m.text()) && !(/\/admin\/login$/.test(page.url()) && /status of 401/.test(m.text()))) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 250));
  }
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "en-US" });
await admin.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
const pa = await admin.newPage(); watch(pa);
const req = admin.request;
const fakeLine = async () => (await (await req.get(`${BASE}/__e2e/line`)).json());
const cron = () => req.post(`${BASE}/__e2e/cron`);
const webhook = (source, text) => req.post(`${BASE}/__e2e/webhook`, { data: { destination: "Ubot", events: [{ type: "message", mode: "active", timestamp: Date.now(), replyToken: `r-${++seq}`, source, message: { type: "text", id: String(seq), text } }] } });

async function login(page, email, lang = "en") {
  await page.goto(`${BASE}/${lang}/admin/login`);
  await page.locator("input[autocomplete=username]").fill(email);
  await page.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await page.locator("form button[type=submit]").click();
  await page.waitForURL(`${BASE}/${lang}/admin`);
}
await check("admin login", () => login(pa, "admin@example.test"));

await check("LINE page: secrets shown as set (never their values), webhook URL, check connection", async () => {
  await pa.goto(`${BASE}/en/admin/settings-line`);
  await pa.getByRole("heading", { name: "Connection", exact: true }).waitFor();
  const card = pa.locator(".adm-card").first();
  if ((await card.getByText("✓ set").count()) !== 2) throw new Error("secrets not shown as set");
  const html = await pa.content();
  if (/e2e-channel-(token|secret)/.test(html)) throw new Error("secret leaked into the page");
  const webhook = await pa.locator("#line-webhook").inputValue();
  if (webhook !== `${BASE}/api/line/webhook`) throw new Error(webhook);
  await pa.getByRole("button", { name: "Check connection" }).click();
  await pa.getByText(/Connected · Messages this month: 12 of 300/).waitFor();
  await pa.getByText("Phasakura Test OA").waitFor();
  await pa.getByText("https://line.me/R/ti/p/@phasakura").waitFor();
});

await check("enable notifications, guest updates and the website button; schedule 1 day before 18:00", async () => {
  await pa.getByLabel("Send notifications on LINE").check();
  await pa.getByLabel(/Let guests receive/).check();
  await pa.getByLabel("Show a LINE button on the website").check();
  if ((await pa.getByLabel("Days before").inputValue()) !== "1" || (await pa.getByLabel("Time").inputValue()) !== "18:00") throw new Error("defaults");
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("Saved", { exact: false }).first().waitFor();
  await pa.screenshot({ path: `${SHOTS}/i-line-connection.png`, fullPage: true });
});

await check("pair a staff group with a one-time code (webhook), choose its notifications", async () => {
  await pa.getByRole("tab", { name: "Recipient chats" }).click();
  await pa.getByLabel(/Chat name/).fill("Front desk");
  await pa.getByRole("button", { name: "Create code" }).click();
  const message = (await pa.locator(".line-code__value").textContent()).trim();
  if (!/^LINK [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(message)) throw new Error(message);
  await pa.getByText(/Waiting for the message from LINE/).waitFor();
  await pa.screenshot({ path: `${SHOTS}/i-line-pairing.png`, fullPage: true });
  const res = await webhook({ type: "group", groupId: GROUP, userId: GUEST }, message);
  if (res.status() !== 200) throw new Error(await res.text());
  await pa.getByText("Connected: Front desk").waitFor({ timeout: 10000 });
  const row = pa.locator("tr", { hasText: "Front desk" });
  await row.waitFor();
  // New chats get "new booking" notices by default; this suite counts payment / kitchen messages only.
  if (!(await row.getByLabel("New bookings").isChecked())) throw new Error("new bookings should be on by default");
  await row.getByLabel("New bookings").uncheck();
  await until(async () => !(await row.getByLabel("New bookings").isChecked()) && !(await row.getByLabel("New bookings").isDisabled()));
  await row.getByLabel("Payments").check();
  await until(async () => (await row.getByLabel("Payments").isChecked()) && !(await row.getByLabel("Payments").isDisabled()));
  await row.getByLabel("Food / kitchen").check();
  await until(async () => !(await row.getByLabel("Food / kitchen").isDisabled()));
  const replies = (await fakeLine()).replies;
  if (!/Connected: this chat \(“Front desk”\)/.test(replies.at(-1)?.texts[0] ?? "")) throw new Error(JSON.stringify(replies));
});

await check("test message is delivered to the group at once", async () => {
  const row = pa.locator("tr", { hasText: "Front desk" });
  await row.getByRole("button", { name: "Test" }).click();
  await pa.getByText("Test message sent.").waitFor();
  const push = (await fakeLine()).pushes.at(-1);
  if (push.to !== GROUP || !/Test notification/.test(push.texts[0]) || !/payments/.test(push.texts[0])) throw new Error(JSON.stringify(push));
  await pa.screenshot({ path: `${SHOTS}/i-line-recipients.png`, fullPage: true });
});

let G;
const guest = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: "th-TH", isMobile: true, hasTouch: true });
const pg = await guest.newPage(); watch(pg);
await check("guest (mobile, TH) links LINE from the booking lookup page", async () => {
  G = await book(req, { checkIn: day(1), checkOut: day(3), stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [{ optionId: "dev_food_dinner_a", serviceDate: day(2), adults: 2 }] }, "0891234567", "สมหญิง ใจดี");
  await pg.goto(`${BASE}/th/booking/lookup`);
  await pg.locator("#lk-code").fill(G.bookingCode);
  await pg.locator("#lk-phone").fill("0891234567");
  await pg.locator("form button[type=submit]").click();
  await pg.getByRole("heading", { name: "รับการแจ้งเตือนทาง LINE" }).waitFor();
  await pg.getByRole("button", { name: "เชื่อมต่อกับ LINE" }).click();
  const link = pg.getByRole("link", { name: "เชื่อมต่อกับ LINE" });
  await link.waitFor();
  const href = await link.getAttribute("href");
  if (!href.startsWith("https://line.me/R/oaMessage/@phasakura/?")) throw new Error(href);
  const message = (await pg.locator(".line-updates__message").textContent()).trim();
  if (!message.includes(G.bookingCode) || !/LINK [A-Z2-9]{4}-[A-Z2-9]{4}/.test(message)) throw new Error(message);
  await pg.locator(".line-updates").screenshot({ path: `${SHOTS}/i-guest-line-connect.png` });
  await webhook({ type: "user", userId: GUEST }, message);
  await pg.getByRole("button", { name: "ตรวจสอบสถานะ" }).click();
  await pg.getByText("เชื่อมต่อแล้ว — เราจะแจ้งเตือนการจองนี้ทาง LINE").waitFor();
  await pg.screenshot({ path: `${SHOTS}/i-guest-line-linked.png`, fullPage: true });
  const reply = (await fakeLine()).replies.at(-1).texts[0];
  if (!reply.includes(`เชื่อมต่อการจอง ${G.bookingCode} กับ LINE แล้ว`)) throw new Error(reply);
});

await check("payment confirmed → staff (payment + kitchen) and guest messages via the cron; delivery log", async () => {
  const pay = await req.post(`${BASE}/api/admin/bookings/${G.bookingCode}/payments`, { headers: H, data: { amountSatang: G.totalSatang, method: "BANK_TRANSFER", paidAt: new Date(Date.now() - 60000).toISOString() } });
  if (!pay.ok()) throw new Error(await pay.text());
  const before = (await fakeLine()).pushes.length;
  await cron();
  const pushes = (await fakeLine()).pushes.slice(before);
  const staff = pushes.filter((p) => p.to === GROUP).map((p) => p.texts.join("\n")).join("\n---\n");
  const guestMsg = pushes.find((p) => p.to === GUEST)?.texts[0] ?? "";
  for (const re of [/Paid — booking confirmed/, new RegExp(G.bookingCode), /Customer: สมหญิง ใจดี/, /House\/VIP: /, /New food order/, /Dinner 18:30/]) {
    if (!re.test(staff)) throw new Error(`staff ${re}: ${staff}`);
  }
  if (!/ยืนยันการจองแล้ว/.test(guestMsg) || !guestMsg.includes(`${BASE}/th/booking/lookup`)) throw new Error(guestMsg);
  await pa.getByRole("tab", { name: "Delivery log" }).click();
  await pa.locator("tr", { hasText: "Guest: booking confirmed" }).locator(".adm-badge", { hasText: /^Sent$/ }).waitFor();
  await pa.locator("tr", { hasText: "New food order" }).getByText("Front desk").waitFor();
  await pa.screenshot({ path: `${SHOTS}/i-line-log.png`, fullPage: true });
});

await check("a failed delivery is shown and can be sent again", async () => {
  const B = await book(req, { checkIn: day(5), checkOut: day(6), stay: { kind: "UNIT", unitId: "dev_house_02" } }, "0870000000");
  await req.post(`${BASE}/__e2e/line/next`, { data: { status: 400 } });
  await req.post(`${BASE}/api/admin/bookings/${B.bookingCode}/payments`, { headers: H, data: { amountSatang: B.totalSatang, method: "CASH", paidAt: new Date(Date.now() - 60000).toISOString() } });
  await cron();
  await pa.getByRole("button", { name: "Search" }).click();
  const row = pa.locator("tr", { hasText: B.bookingCode });
  await row.locator(".adm-badge", { hasText: /^Failed$/ }).waitFor();
  await row.getByText(/HTTP_400/).waitFor();
  await row.getByRole("button", { name: "Send again" }).click();
  await row.locator(".adm-badge", { hasText: /^Waiting$/ }).waitFor();
  await pa.getByRole("button", { name: "Send due notifications now" }).click();
  await pa.getByText(/Sent 1 · retrying 0 · failed 0/).waitFor();
  await row.locator(".adm-badge", { hasText: /^Sent$/ }).waitFor();
});

await check("admin booking page shows the guest's LINE opt-in", async () => {
  await pa.goto(`${BASE}/en/admin/bookings/${G.bookingCode}`);
  await pa.getByText("Guest receives updates on LINE").waitFor();
});

await check("website LINE button (mobile + desktop) stacks above the booking button", async () => {
  // Turn the booking CTA on so we can see both.
  const cta = await req.put(`${BASE}/api/admin/settings/booking-cta`, { headers: H, data: {
    enabled: true, showOnDesktop: true, showOnMobile: true, desktopPosition: "BOTTOM_RIGHT", mobilePosition: "BOTTOM_BAR", size: "MD", icon: "calendar",
    color: null, animation: "NONE", closeable: false, pages: ["*"], labels: { th: "จองเลย", en: "Book now", "zh-CN": "立即预订" },
  } });
  if (!cta.ok()) throw new Error(await cta.text());
  await pg.goto(`${BASE}/th/`);
  const fab = pg.locator("a.line-fab");
  await fab.waitFor();
  if ((await fab.getAttribute("href")) !== "https://line.me/R/ti/p/@phasakura") throw new Error(await fab.getAttribute("href"));
  if ((await fab.getAttribute("aria-label")) !== "แชตกับเราทาง LINE") throw new Error("label");
  const a = await fab.boundingBox();
  const b = await pg.locator(".cta").boundingBox();
  if (a.y + a.height > b.y) throw new Error(`overlap mobile ${JSON.stringify([a, b])}`);
  await pg.screenshot({ path: `${SHOTS}/i-public-line-mobile.png` });
  const desk = await admin.newPage(); watch(desk);
  await desk.goto(`${BASE}/en/`);
  const a2 = await desk.locator("a.line-fab").boundingBox();
  const b2 = await desk.locator(".cta").boundingBox();
  if (a2.y + a2.height > b2.y) throw new Error(`overlap desktop ${JSON.stringify([a2, b2])}`);
  await desk.screenshot({ path: `${SHOTS}/i-public-line-desktop.png` });
  await pg.goto(`${BASE}/th/booking`);
  await pg.locator("h1").first().waitFor();
  if (await pg.locator("a.line-fab").count()) throw new Error("LINE button must not cover the booking form");
});

await check("Thai admin LINE page (390px)", async () => {
  const m = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: "th-TH" });
  const p = await m.newPage(); watch(p);
  await login(p, "admin@example.test", "th");
  await p.goto(`${BASE}/th/admin/settings-line`);
  await p.getByRole("heading", { name: "การเชื่อมต่อ", exact: true }).waitFor();
  await p.getByRole("tab", { name: "แชตผู้รับ" }).click();
  await p.locator("tr", { hasText: "Front desk" }).waitFor();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`horizontal scroll ${overflow}px`);
  await p.screenshot({ path: `${SHOTS}/i-line-th-mobile.png`, fullPage: true });
});

await check("Thai admin adds two more admins' LINE one after another: QR to add the OA, QR with the code, both get bookings + payments", async () => {
  await pa.goto(`${BASE}/th/admin/settings-line`);
  await pa.getByRole("tab", { name: "แชตผู้รับ" }).click();
  await pa.getByRole("heading", { name: "เพิ่ม LINE ของแอดมิน / ทีมงาน" }).waitFor();
  await pa.getByRole("img", { name: "สแกนเพื่อเพิ่มเพื่อน" }).waitFor();
  const people = [["แอดมินเอ", `U${"e5".repeat(16)}`], ["แอดมินบี", `U${"f6".repeat(16)}`]];
  for (const [i, [name, user]] of people.entries()) {
    if (i > 0) await pa.getByRole("button", { name: "เพิ่มคนถัดไป" }).click();
    await pa.getByLabel(/ชื่อแชต/).fill(name);
    await pa.getByRole("button", { name: "สร้างรหัส" }).click();
    await pa.getByRole("img", { name: "สแกนเพื่อส่งรหัสใน LINE" }).waitFor();
    const message = (await pa.locator(".line-code__value").textContent()).trim();
    const open = await pa.getByRole("link", { name: "เปิดใน LINE (บนมือถือเครื่องนี้)" }).getAttribute("href");
    if (!open.startsWith("https://line.me/R/oaMessage/@") || !open.endsWith(encodeURIComponent(message))) throw new Error(open);
    if (i === 0) await pa.screenshot({ path: `${SHOTS}/i-line-pair-qr.png`, fullPage: true });
    const res = await webhook({ type: "user", userId: user }, message);
    if (res.status() !== 200) throw new Error(await res.text());
    await pa.getByText(`เชื่อมต่อแล้ว: ${name}`).waitFor({ timeout: 10000 });
    const row = pa.locator("tr", { hasText: name });
    await row.waitFor();
    for (const label of ["การจองใหม่", "การชำระเงิน"]) if (!(await row.getByLabel(label).isChecked())) throw new Error(`${name}: ${label} off`);
    if (await row.getByLabel("อาหาร/ครัว").isChecked()) throw new Error(`${name}: food on`);
  }
});

await check("viewer without settings.line cannot open the LINE API", async () => {
  const v = await browser.newContext({ ignoreHTTPSErrors: true });
  const p = await v.newPage();
  await login(p, "viewer@example.test");
  const r = await v.request.get(`${BASE}/api/admin/line/settings`);
  if (r.status() !== 403) throw new Error(String(r.status()));
  const n = await v.request.get(`${BASE}/api/admin/notifications`);
  if (n.status() !== 403) throw new Error(String(n.status()));
});

console.log("console errors:", consoleErrors.length, consoleErrors.slice(0, 5));
console.log("CSP errors:", consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e)).length);
await browser.close();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
