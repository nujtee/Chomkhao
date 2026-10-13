const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const DIR = process.env.E2E_FIXTURES;
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

// ---------------------------------------------------------------- public (mobile TH)
const mobile = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "th-TH" });
const pm = await mobile.newPage(); watch(pm);
await check("public home shows floating CTA bar + footer contact (mobile TH)", async () => {
  await pm.goto(`${BASE}/th/`);
  const cta = pm.locator(".cta .cta__button");
  await cta.waitFor({ timeout: 10000 });
  if ((await cta.textContent()).trim() !== "จองที่พัก") throw new Error("label " + await cta.textContent());
  if ((await cta.getAttribute("href")) !== "/th/booking") throw new Error("href");
  const box = await pm.locator(".cta").boundingBox();
  if (box.y + box.height < 830) throw new Error("not at the bottom: " + JSON.stringify(box));
  await pm.locator(".site-footer__contact").waitFor();
  await pm.screenshot({ path: `${SHOTS}/g-public-cta-mobile.png`, fullPage: false });
});
await check("CTA hidden on the booking page", async () => {
  await pm.goto(`${BASE}/th/booking`);
  await pm.waitForTimeout(800);
  if (await pm.locator(".cta").count()) throw new Error("cta visible on booking page");
});

// ---------------------------------------------------------------- data via public API
const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "en-US" });
const pa = await admin.newPage(); watch(pa);
const req = admin.request;
const today = day(0);
const A = await book(req, { checkIn: today, checkOut: day(2), stay: { kind: "UNIT", unitId: "dev_house_01" } }, "0811111111");
await book(req, { checkIn: today, checkOut: day(1), stay: { kind: "UNIT", unitId: "dev_vip_01" } }, "0822222222"); // occupies the VIP tent today
const C = await book(req, { checkIn: today, checkOut: day(1), adults: 3, stay: { kind: "CAMPING", tents: 3 } }, "0833333333");
const D = await book(req, { checkIn: day(3), checkOut: day(4), stay: { kind: "UNIT", unitId: "dev_house_02" }, food: [{ optionId: "dev_food_dinner_a", serviceDate: day(3), adults: 2 }] }, "0844444444");

await check("admin login (EN)", async () => {
  await pa.goto(`${BASE}/en/admin/login`);
  await pa.getByLabel("Email or username").fill("admin@example.test");
  await pa.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await pa.getByRole("button", { name: "Sign in" }).click();
  await pa.waitForURL(`${BASE}/en/admin`);
});
for (const b of [A, C, D]) {
  const r = await req.post(`${BASE}/api/admin/bookings/${b.bookingCode}/payments`, { headers: H, data: { amountSatang: b.totalSatang, method: "CASH", paidAt: new Date(Date.now() - 60000).toISOString() } });
  if (!r.ok()) console.log("pay failed", await r.text());
}

await check("dashboard KPIs, revenue and arrivals", async () => {
  await pa.goto(`${BASE}/en/admin`);
  await pa.getByText("Check-ins today").waitFor();
  const kpi = pa.locator(".adm-kpi", { hasText: "Check-ins today" }).locator(".adm-kpi__value");
  if ((await kpi.textContent()) !== "3") throw new Error("check-ins " + await kpi.textContent());
  await pa.getByText(A.bookingCode).first().waitFor();
  await pa.getByText("Revenue (paid bookings, by check-in date)").waitFor();
  const tents = pa.locator(".adm-kpi", { hasText: "Tents booked tonight" }).locator(".adm-kpi__value");
  if ((await tents.textContent()) !== "3") throw new Error("tents");
  await pa.screenshot({ path: `${SHOTS}/g-admin-dashboard.png`, fullPage: true });
});

await check("calendar week shows multi-night booking", async () => {
  await pa.goto(`${BASE}/en/admin/calendar`);
  await pa.locator(".adm-cal").waitFor();
  const cells = pa.locator(`.adm-cal a[href="/en/admin/bookings/${A.bookingCode}"]`);
  if ((await cells.count()) < 1) throw new Error("no cells for A");
  await pa.getByText("Bookings in this range").waitFor();
  await pa.screenshot({ path: `${SHOTS}/g-admin-calendar.png`, fullPage: true });
  await pa.getByRole("tab", { name: "Month" }).click();
  await pa.waitForTimeout(500);
  if ((await pa.locator(".adm-cal thead th").count()) < 29) throw new Error("month view columns");
});

await check("check-in from the booking page", async () => {
  await pa.goto(`${BASE}/en/admin/bookings/${A.bookingCode}`);
  await pa.getByRole("button", { name: "Check in" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Check in" }).click();
  await pa.getByText(`${A.bookingCode}: Check in done`).waitFor();
  await pa.getByRole("button", { name: "Check out" }).waitFor();
});

await check("a future stay: Check in / No-show shown but not pressable before the arrival day", async () => {
  await pa.goto(`${BASE}/en/admin/bookings/${D.bookingCode}`);
  const stay = pa.getByRole("group", { name: "Stay" });
  if (!(await stay.getByRole("button", { name: "Check in" }).isDisabled())) throw new Error("check-in enabled early");
  if (!(await stay.getByRole("button", { name: "No-show" }).isDisabled())) throw new Error("no-show enabled early");
  await stay.getByText(/can be pressed from the arrival day/).waitFor();
});

await check("dashboard arrivals: check in straight from the list; bookings list: check out from the row", async () => {
  await pa.goto(`${BASE}/en/admin`);
  await pa.getByRole("button", { name: `Check in ${C.bookingCode}` }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Check in" }).click();
  await pa.getByText(`${C.bookingCode}: Check in done`).waitFor();
  await pa.getByRole("button", { name: `Check in ${C.bookingCode}` }).waitFor({ state: "detached" });
  // Arrivals offer check-in / no-show only: a guest just checked in is not one click from checking out.
  if (await pa.getByRole("button", { name: `Check out ${C.bookingCode}` }).count()) throw new Error("check-out offered in arrivals");
  await pa.screenshot({ path: `${SHOTS}/g-admin-dashboard-stay.png`, fullPage: true });

  await pa.goto(`${BASE}/en/admin/bookings`);
  const row = pa.locator("tbody tr", { hasText: C.bookingCode });
  await row.getByRole("button", { name: `Check out ${C.bookingCode}` }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Check out" }).click();
  await pa.getByText(`${C.bookingCode}: Check out done`).waitFor();
  await row.getByText("Checked out").waitFor();
  // Not paid yet: no stay buttons on that row.
  if (await pa.locator("tbody tr", { hasText: "0822222222" }).getByRole("button").count()) throw new Error("buttons on an unpaid booking");
  await pa.screenshot({ path: `${SHOTS}/g-admin-bookings-stay.png`, fullPage: true });
});

await check("payments list", async () => {
  await pa.goto(`${BASE}/en/admin/payments`);
  await pa.getByText(C.bookingCode).waitFor();
  if ((await pa.locator("tbody tr").count()) !== 3) throw new Error("rows " + await pa.locator("tbody tr").count());
});

await check("kitchen orders: confirm → preparing with note", async () => {
  await pa.goto(`${BASE}/en/admin/food-orders`);
  await pa.getByLabel("Service date").fill(day(3));
  await pa.getByText(D.bookingCode).waitFor();
  await pa.getByRole("button", { name: "Next: Confirmed" }).click();
  await pa.getByRole("button", { name: "Next: Preparing" }).waitFor();
  await pa.getByPlaceholder("Kitchen note").fill("No peanuts");
  await pa.getByRole("button", { name: "Save note" }).click();
  await pa.getByText("Saved").first().waitFor();
  await pa.screenshot({ path: `${SHOTS}/g-admin-kitchen.png`, fullPage: true });
});

await check("food menu: add a dish, capacity grid", async () => {
  await pa.goto(`${BASE}/en/admin/food`);
  await pa.getByRole("button", { name: "+ Add dish" }).click();
  await pa.getByLabel("Meal category").selectOption({ label: "Dinner" });
  await pa.getByLabel("Code").fill("DINNER_E2E");
  await pa.getByLabel("Price (THB)").fill("320");
  await pa.getByLabel("Status").selectOption("ACTIVE");
  await pa.getByLabel("Name").fill("ชุดอาหารเย็นพิเศษ");
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("ชุดอาหารเย็นพิเศษ").waitFor();
  await pa.getByRole("tab", { name: "Daily capacity" }).click();
  await pa.locator(".adm-captable").waitFor();
  await pa.screenshot({ path: `${SHOTS}/g-admin-food-capacity.png`, fullPage: true });
});

await check("food category: code \"001\" is explained at the field; empty code is made by the system", async () => {
  await pa.goto(`${BASE}/th/admin/food`);
  await pa.getByRole("tab", { name: "หมวดอาหาร" }).click();
  await pa.getByRole("button", { name: "+ เพิ่มหมวด" }).click();
  const code = pa.getByLabel("รหัส (ไม่บังคับ)");
  await pa.getByText("เว้นว่างได้ ระบบสร้างให้ · ถ้ากรอกเอง: ตัวอักษรภาษาอังกฤษ A–Z และ _ เท่านั้น").waitFor();
  await code.fill("001");
  await pa.getByLabel("ชื่อ").first().fill("ของว่างยามดึก");
  await pa.getByRole("button", { name: "บันทึก" }).first().click();
  await pa.locator(".adm-field__error", { hasText: "รหัสหมวดใช้ได้เฉพาะตัวอักษรภาษาอังกฤษ A–Z และ _" }).waitFor();
  await code.fill("late night");
  if (await code.inputValue() !== "LATE_NIGHT") throw new Error(`typed code tidied: ${await code.inputValue()}`);
  await code.fill("");
  await pa.getByRole("button", { name: "บันทึก" }).first().click();
  await pa.getByText("ของว่างยามดึก").first().waitFor();
  const cats = await (await req.get(`${BASE}/api/admin/cms/foodCategory`)).json();
  const made = (cats.data ?? []).find((c) => c.translations?.th?.name === "ของว่างยามดึก");
  if (!made || !/^CATEGORY(_[A-Z]+)?$/.test(made.code)) throw new Error(`auto code: ${JSON.stringify(made?.code)}`);
});

await check("home slide: upload, publish, visible in public API", async () => {
  await pa.goto(`${BASE}/en/admin/content-home`);
  await pa.getByRole("button", { name: "+ Add slide" }).click();
  await pa.locator("input[type=file]").first().setInputFiles(`${DIR}/slide.png`);
  await pa.locator(".adm-imagefield__preview img").first().waitFor();
  await pa.getByLabel("Title", { exact: true }).fill("ยินดีต้อนรับสู่ภูผาซากุระ");
  await pa.getByLabel("Button 1 link").fill("javascript:alert(1)");
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("Invalid link (use a /site-path or https://)").first().waitFor();
  await pa.getByLabel("Button 1 link").fill("/th/booking");
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("ยินดีต้อนรับสู่ภูผาซากุระ").waitFor();
  await pa.getByRole("button", { name: "Publish" }).first().click();
  await pa.getByText("Published", { exact: true }).first().waitFor();
  const home = await (await req.get(`${BASE}/api/public/home?lang=th`)).json();
  if (home.data.slides.length !== 1) throw new Error("public slides " + home.data.slides.length);
  await pa.screenshot({ path: `${SHOTS}/g-admin-home-slides.png`, fullPage: true });
});

await check("gallery: multi-upload two images, publish one", async () => {
  await pa.goto(`${BASE}/en/admin/content-gallery`);
  await pa.locator("input[type=file][multiple]").setInputFiles([`${DIR}/g1.png`, `${DIR}/g2.png`]);
  await pa.locator(".adm-cmsitem").nth(1).waitFor({ timeout: 10000 });
  await pa.getByRole("button", { name: "Publish" }).first().click();
  await pa.getByText("Published", { exact: true }).first().waitFor();
  const g = await (await req.get(`${BASE}/api/public/gallery?lang=en`)).json();
  if (g.data.images.length !== 1) throw new Error("public images " + g.data.images.length);
  await pa.screenshot({ path: `${SHOTS}/g-admin-gallery.png`, fullPage: true });
});

await check("branding: upload logo → public header shows it", async () => {
  await pa.goto(`${BASE}/en/admin/settings-branding`);
  await pa.locator("input[type=file]").first().setInputFiles(`${DIR}/logo.png`);
  await pa.locator(".adm-imagefield__preview img").first().waitFor();
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("Saved").first().waitFor();
  const site = await (await req.get(`${BASE}/api/public/site?lang=en`)).json();
  if (!site.data.logo.main) throw new Error("no logo");
});

await check("theme: Sakura preset → draft → publish → public colours", async () => {
  await pa.goto(`${BASE}/en/admin/settings-theme`);
  await pa.getByRole("button", { name: "Sakura" }).click();
  await pa.getByRole("button", { name: "Save draft" }).click();
  await pa.getByText("Saved").first().waitFor();
  await pa.screenshot({ path: `${SHOTS}/g-admin-theme.png`, fullPage: true });
  await pa.getByRole("button", { name: "Publish theme" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Publish theme" }).click();
  await pa.getByText("Published").first().waitFor();
  const p2 = await admin.newPage(); watch(p2);
  await p2.goto(`${BASE}/en/`);
  await p2.locator(".site-header, header").first().waitFor();
  await p2.waitForTimeout(800);
  const primary = await p2.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-primary").trim());
  if (primary !== "#b0476b") throw new Error("primary " + primary);
  await p2.screenshot({ path: `${SHOTS}/g-public-sakura.png` });
  await p2.close();
});

await check("theme preview mode on the live site (draft, admins only)", async () => {
  await pa.goto(`${BASE}/en/admin/settings-theme`);
  await pa.getByRole("button", { name: "Dark" }).click();
  await pa.getByRole("button", { name: "Save draft" }).click();
  await pa.getByText("Saved").first().waitFor();
  const p3 = await admin.newPage(); watch(p3);
  await p3.goto(`${BASE}/en/?themePreview=1`);
  await p3.getByText("Previewing the draft theme (admins only)").waitFor();
  await p3.waitForTimeout(500);
  const bg = await p3.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim());
  if (bg !== "#111614") throw new Error("preview bg " + bg);
  await p3.screenshot({ path: `${SHOTS}/g-public-preview-dark.png` });
  await p3.getByRole("button", { name: "Exit preview" }).click();
  await p3.waitForTimeout(300);
  const bg2 = await p3.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim());
  if (bg2 === "#111614") throw new Error("still preview");
  await p3.close();
  // A visitor without a session never sees the draft.
  const anon = await browser.newContext({ ignoreHTTPSErrors: true }); const p4 = await anon.newPage();
  await p4.goto(`${BASE}/en/?themePreview=1`);
  await p4.waitForTimeout(1200);
  if (await p4.getByText("Previewing the draft theme").count()) throw new Error("anon saw preview");
  await anon.close();
});

await check("booking CTA settings change the public button", async () => {
  await pa.goto(`${BASE}/en/admin/settings-booking-cta`);
  await pa.getByRole("tab", { name: "EN" }).click();
  await pa.getByLabel("Button text (EN)").fill("Reserve your stay");
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("Saved").first().waitFor();
  const p5 = await admin.newPage(); watch(p5);
  await p5.goto(`${BASE}/en/gallery`);
  await p5.locator(".cta__button").getByText("Reserve your stay").waitFor();
  await p5.screenshot({ path: `${SHOTS}/g-public-cta-desktop.png` });
  await p5.close();
});

await check("marketing: CAPI cannot be enabled without the Cloudflare secret", async () => {
  await pa.goto(`${BASE}/en/admin/capi`);
  await pa.getByLabel("Enable CAPI (server-side)").check();
  await pa.getByLabel("Pixel ID (digits)").fill("123456789012");
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("META_CAPI_ACCESS_TOKEN is not set in Cloudflare Secrets").first().waitFor();
});

await check("SEO: save title; redirect to reserved path refused", async () => {
  await pa.goto(`${BASE}/en/admin/seo`);
  await pa.getByRole("tab", { name: "Gallery" }).click();
  await pa.getByLabel("SEO title (aim for ≤ 60 characters)").fill("แกลเลอรีภาพ");
  await pa.getByRole("button", { name: "Save" }).first().click();
  await pa.getByText("Saved").first().waitFor();
  await pa.getByRole("button", { name: "+ Add redirect" }).click();
  await pa.getByLabel("From path").fill("/admin/users");
  await pa.getByLabel("To path").fill("/th/");
  await pa.getByRole("button", { name: "Save" }).last().click();
  await pa.getByText("This path is reserved by the system").first().waitFor();
  await pa.screenshot({ path: `${SHOTS}/g-admin-seo.png`, fullPage: true });
});

await check("Administration → Menu: hide the Marketing group and Kitchen report for everyone, then show them again", async () => {
  await pa.goto(`${BASE}/en/admin/admin-menu`);
  await pa.getByRole("heading", { name: "Admin menu" }).waitFor();
  const nav = pa.getByRole("navigation", { name: "Admin navigation" });
  await nav.getByRole("button", { name: "Marketing" }).waitFor();
  // The start page and this page cannot be unticked.
  if (!(await pa.getByRole("checkbox", { name: "Dashboard · Always shown" }).isDisabled())) throw new Error("dashboard hideable");
  if (!(await pa.getByRole("checkbox", { name: "Admin menu · Always shown" }).isDisabled())) throw new Error("menu page hideable");
  await pa.getByRole("group", { name: "Marketing" }).getByLabel("Show the whole group").uncheck();
  await pa.getByRole("group", { name: "Food" }).getByLabel("Kitchen report").uncheck();
  await pa.getByText("32 of 36 items shown").waitFor();
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText(/Menu saved/).waitFor();
  await nav.getByRole("button", { name: "Marketing" }).waitFor({ state: "detached" });
  await pa.screenshot({ path: `${SHOTS}/g-admin-menu.png`, fullPage: true });
  // For everyone, after a reload too; the pages themselves still open for people allowed to see them.
  await pa.goto(`${BASE}/en/admin/kitchen`);
  await pa.getByRole("heading", { name: "Kitchen report" }).first().waitFor();
  if (await nav.getByRole("link", { name: "Kitchen report" }).count()) throw new Error("kitchen still in the menu");
  await nav.getByRole("link", { name: "Food orders" }).waitFor();
  if (await nav.getByRole("button", { name: "Marketing" }).count()) throw new Error("marketing back after reload");
  await pa.goto(`${BASE}/en/admin/admin-menu`);
  await pa.getByRole("button", { name: "Show every item" }).click();
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText(/Menu saved/).waitFor();
  await nav.getByRole("button", { name: "Marketing" }).waitFor();
});

await check("website settings + booking rules", async () => {
  await pa.goto(`${BASE}/en/admin/settings-website`);
  await pa.getByLabel("Payment hold (minutes)").fill("45");
  await pa.locator("form", { hasText: "Booking rules" }).getByRole("button", { name: "Save" }).click();
  await pa.getByText("Saved").first().waitFor();
});

await check("amenities: add several in a row (form stays open), saved to the house, errors next to the field", async () => {
  const p = await pa.context().newPage();
  // 409 for the deliberately taken code (and the automatic retry) is expected here; anything else is not.
  p.on("console", (m) => { if (m.type() === "error" && !/status of 409/.test(m.text())) consoleErrors.push(`${p.url()} :: ${m.text()}`); });
  await p.goto(`${BASE}/th/admin/houses/dev_house_01`);
  const card = p.locator(".adm-card", { has: p.getByRole("heading", { name: "สิ่งอำนวยความสะดวก", level: 2 }) });
  await card.waitFor();
  await card.getByRole("button", { name: "+ เพิ่มรายการใหม่" }).click();
  const form = card.getByRole("form", { name: "เพิ่มสิ่งอำนวยความสะดวกใหม่" });
  const thai = form.getByLabel("ชื่อ (ไทย)");
  await thai.waitFor();
  if (!(await thai.evaluate((el) => el === document.activeElement))) throw new Error("focus in the first field");
  const add = async (th, en, code) => {
    await thai.fill(th);
    await form.getByLabel("ชื่อ (English)").fill(en);
    await form.getByLabel("รหัส (ไม่บังคับ)").fill(code);
    await form.getByRole("button", { name: "เพิ่ม", exact: true }).click();
  };
  // 1st, 2nd (Thai only → automatic code), 3rd (English "WiFi" → code "wifi" is taken by the seed → wifi_2): no reopening.
  await add("ที่จอดรถ", "Parking", "");
  await form.getByText("เพิ่ม “ที่จอดรถ” และเลือกให้ที่พักนี้แล้ว").waitFor();
  if (await thai.inputValue() !== "") throw new Error("form emptied for the next one");
  if (!(await thai.evaluate((el) => el === document.activeElement))) throw new Error("focus back in the first field");
  await add("สระว่ายน้ำ", "", "");
  await form.getByText("เพิ่ม “สระว่ายน้ำ” และเลือกให้ที่พักนี้แล้ว").waitFor();
  await add("ไวไฟความเร็วสูง", "WiFi", "");
  await form.getByText("เพิ่ม “ไวไฟความเร็วสูง” และเลือกให้ที่พักนี้แล้ว").waitFor();
  for (const name of ["ที่จอดรถ", "สระว่ายน้ำ", "ไวไฟความเร็วสูง"]) {
    if (!(await card.getByRole("checkbox", { name }).isChecked())) throw new Error(`${name} ticked`);
  }
  // A typed code that is taken: the message is at the code field, the form keeps what was typed.
  await add("ที่จอดรถในร่ม", "", "parking");
  await form.getByText("รหัสนี้ถูกใช้แล้ว").waitFor();
  if (await thai.inputValue() !== "ที่จอดรถในร่ม") throw new Error("typed name kept after an error");
  // Missing Thai name: message at the Thai field, nothing sent.
  await thai.fill("");
  await form.getByRole("button", { name: "เพิ่ม", exact: true }).click();
  await form.getByText("ต้องมีภาษาไทย").waitFor();
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/amenities-add.png` });
  // Saved to the house (not only ticked on screen).
  await p.reload();
  await card.waitFor();
  for (const name of ["ที่จอดรถ", "สระว่ายน้ำ", "ไวไฟความเร็วสูง"]) {
    if (!(await card.getByRole("checkbox", { name }).isChecked())) throw new Error(`${name} saved`);
  }
  await p.close();
});

await check("camping: owner offers a tarp area; a guest books dates, 2 adults + 1 child, 1 tent + tarp on a phone; admin sees it", async () => {
  // Owner (EN admin): Camping → tarp area on, ฿150 per area per night, 2 areas per night.
  const p = await pa.context().newPage(); watch(p);
  await p.goto(`${BASE}/en/admin/camping`);
  const box = p.locator("fieldset.adm-tarp");
  await box.waitFor();
  await box.getByLabel("Offer a tarp area").check();
  await box.getByLabel("Price / area / night (THB)").fill("150");
  await box.getByLabel("Tarp areas per night").fill("2");
  await p.locator("form.adm-card").first().getByRole("button", { name: "Save" }).click();
  await p.getByText("Saved").first().waitFor();
  await p.getByRole("columnheader", { name: /Tarp/ }).waitFor();
  await p.close();

  // Guest (TH, 390 px): the camping card has its own form.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "th-TH" });
  const g = await ctx.newPage(); watch(g);
  await g.goto(`${BASE}/th/booking#sec-camping`);
  const form = g.getByRole("form", { name: "เลือกวันที่ จำนวนคน และจำนวนเต็นท์" });
  await form.waitFor();
  await form.getByLabel("เช็คอิน").fill(day(20));
  await form.getByLabel("เช็คเอาท์").fill(day(22));
  await form.getByRole("button", { name: "เพิ่ม เด็ก" }).click();
  if ((await form.getByRole("group", { name: "ผู้ใหญ่" }).locator("output").textContent()) !== "2") throw new Error("2 adults");
  if ((await form.getByRole("group", { name: "เด็ก" }).locator("output").textContent()) !== "1") throw new Error("1 child");
  await form.getByText("+฿150 / คืน · 1 พื้นที่ต่อการจอง").waitFor();
  await form.getByRole("checkbox", { name: /เพิ่มพื้นที่กางทาร์ป/ }).check();
  if (SHOTS) await form.screenshot({ path: `${SHOTS}/camping-form-phone.png` });
  await form.getByRole("button", { name: "จองลานกางเต็นท์" }).click();

  await g.getByRole("heading", { name: "สั่งอาหารล่วงหน้า" }).waitFor();
  await g.locator(".flow-stay").getByText("1 เต็นท์ + พื้นที่กางทาร์ป").waitFor();
  const summary = g.locator(".summary").first();
  await summary.getByText("พื้นที่กางทาร์ป × 2 คืน").waitFor();
  if (!/฿300/.test(await summary.locator(".summary__line", { hasText: "พื้นที่กางทาร์ป × 2 คืน" }).innerText())) throw new Error("tarp ฿150 × 2 nights");
  await g.getByRole("button", { name: /ถัดไป/ }).click();
  await g.getByLabel("ชื่อ-นามสกุล").fill("Tarp Camper");
  await g.getByLabel("เบอร์โทรศัพท์").fill("0899999999");
  await g.getByRole("button", { name: /ถัดไป/ }).click();
  await g.getByRole("checkbox", { name: /ข้าพเจ้ายอมรับนโยบายความเป็นส่วนตัว/ }).check();
  await g.getByRole("button", { name: /ยืนยันการจอง/ }).click();
  await g.getByRole("heading", { name: "จองเรียบร้อย" }).waitFor();
  const code = (await g.locator(".confirmation__value").first().innerText()).trim();
  await g.locator(".summary").getByText("พื้นที่กางทาร์ป × 2 คืน").waitFor();
  if (SHOTS) await g.screenshot({ path: `${SHOTS}/camping-tarp-confirmation.png`, fullPage: true });
  await ctx.close();

  // Admin: list and detail show the tarp area.
  await pa.goto(`${BASE}/en/admin/bookings/${code}`);
  await pa.getByText("Tarp area × 2 nights").waitFor();
  await pa.getByText(/1 tents \+ tarp area/).waitFor();
});

// ---------------------------------------------------------------- permissions
await check("content admin: no money on dashboard, no payments menu", async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage(); watch(p);
  await p.goto(`${BASE}/en/admin/login`);
  await p.getByLabel("Email or username").fill("content@example.test");
  await p.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(`${BASE}/en/admin`);
  await p.getByText("Check-ins today").waitFor();
  if (await p.getByText("Revenue (paid bookings, by check-in date)").count()) throw new Error("revenue visible");
  if (await p.getByText("Arriving today").count()) throw new Error("arrivals visible");
  const nav = p.locator("#adm-sidebar nav");
  if (await nav.getByRole("button", { name: "Finance" }).count()) throw new Error("finance menu group visible");
  if (await nav.getByRole("link", { name: "Payments", exact: true, includeHidden: true }).count()) throw new Error("payments menu visible");
  // Menu groups start collapsed: open "Website" to reach its pages.
  await nav.getByRole("button", { name: "Website" }).click();
  await nav.getByRole("link", { name: "Gallery" }).waitFor();
  await ctx.close();
});

await check("mobile admin dashboard renders (390px)", async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); watch(p);
  await p.goto(`${BASE}/th/admin/login`);
  await p.getByLabel("อีเมลหรือชื่อผู้ใช้").fill("viewer@example.test");
  await p.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await p.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  await p.waitForURL(`${BASE}/th/admin`);
  await p.getByText("เช็กอินวันนี้").first().waitFor();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error("horizontal overflow");
  await p.screenshot({ path: `${SHOTS}/g-admin-dashboard-mobile.png`, fullPage: true });
  await ctx.close();
});

await browser.close();
const csp = consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e));
// Expected: 401 from /api/auth/me before sign-in, 4xx from the deliberate validation checks.
const real = consoleErrors.filter((e) => !/status of (401|409|422)/.test(e));
console.log("\nexpected HTTP 4xx logs:", consoleErrors.length - real.length);
console.log("console errors:", real.length, real.slice(0, 10));
console.log("CSP errors:", csp.length);
console.log(`\n${results.filter((r) => r[0] === "PASS").length}/${results.length} passed`);
