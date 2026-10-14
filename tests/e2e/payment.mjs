// Payment step (migration 0023): ways to pay, PromptPay QR, slip upload, Manual approve, decline with a reason
// (guest told by LINE / e-mail), new-booking notices to staff, PayPal Checkout round trip (fake PayPal).
const { chromium } = await import("playwright");
const BASE = process.env.E2E_BASE ?? "https://localhost:4190";
const SHOTS = process.env.E2E_SHOTS;
const FIXTURES = process.env.E2E_FIXTURES;
const H = { Origin: BASE, "X-Requested-With": "phasakura" };
const GROUP = `C${"5e".repeat(16)}`;
const results = [];
const consoleErrors = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); console.log("PASS", name); }
  catch (e) { results.push(["FAIL", name, String(e).slice(0, 600)]); console.log("FAIL", name, String(e).slice(0, 600)); }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const day = (offset) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));
let seq = 0;
function watch(page) {
  page.on("console", (m) => { if (m.type() === "error" && !/status of (401|404|409|422|429)/.test(m.text())) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const admin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, locale: "en-US" });
const pa = await admin.newPage(); watch(pa);
const req = admin.request;
const cron = () => req.post(`${BASE}/__e2e/cron`);
const emails = async () => (await (await req.get(`${BASE}/__e2e/email`)).json());
const linePushes = async () => (await (await req.get(`${BASE}/__e2e/line`)).json()).pushes;

async function book(body, phone, extra = {}) {
  const full = { adults: 2, children: 0, food: [], lang: "th", ...body };
  const q = await (await req.post(`${BASE}/api/public/bookings/quote`, { headers: H, data: full })).json();
  if (!q.data) throw new Error(JSON.stringify(q));
  const r = await (await req.post(`${BASE}/api/public/bookings`, { headers: H, data: { ...full, customer: { name: `Guest ${++seq}`, phone, ...extra }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: `e2e-pay-${Date.now()}-${++seq}` } })).json();
  if (!r.data) throw new Error(JSON.stringify(r));
  return r.data;
}

await check("admin login", async () => {
  await pa.goto(`${BASE}/en/admin/login`);
  await pa.locator("input[autocomplete=username]").fill("admin@example.test");
  await pa.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await pa.locator("form button[type=submit]").click();
  await pa.waitForURL(`${BASE}/en/admin`);
});

await check("payment settings page: PayPal on, Manual approve; secrets shown as set, never their values", async () => {
  await pa.goto(`${BASE}/en/admin/payment-settings`);
  await pa.getByRole("heading", { name: "Payment settings" }).waitFor();
  await pa.getByText(/PayPal: sandbox/).waitFor();
  await pa.getByText(/PayPal is not added as a receiving account/).waitFor();
  await pa.getByRole("button", { name: "Check PayPal connection" }).click();
  await pa.getByText(/PayPal \(sandbox \(test\) — no real money\) works — a THB 100 test order was created/).waitFor();
  await pa.getByLabel(/PayPal — card or PayPal account/).check();
  await pa.getByLabel(/Manual approve/).check();
  await pa.getByText(/There is no verification service yet/).waitFor({ state: "detached" }).catch(() => undefined);
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("Payment settings saved.").waitFor();
  assert(!/e2e-paypal-(client|secret)/.test(await pa.content()), "PayPal secret leaked");
  await pa.screenshot({ path: `${SHOTS}/pay-settings.png`, fullPage: true });
  const s = await (await req.get(`${BASE}/api/admin/payment-settings`, { headers: H })).json();
  assert(s.data.approvalMode === "MANUAL" && s.data.channels.PAYPAL === true, JSON.stringify(s.data));
});

await check("receiving accounts page says PayPal is set up in Payment settings, with a link there", async () => {
  await pa.goto(`${BASE}/en/admin/receiving-accounts`);
  await pa.getByText(/PayPal is not added here/).waitFor();
  await pa.getByRole("link", { name: "Payment settings" }).first().click();
  await pa.waitForURL(`${BASE}/en/admin/payment-settings`);
});

await check("e-mail page: Zoho Mail connected; sender + staff address; test e-mail goes out from the Zoho mailbox", async () => {
  await pa.goto(`${BASE}/en/admin/settings-email`);
  await pa.getByRole("heading", { name: "E-mail notifications", exact: true }).waitFor();
  await pa.getByText("✓ Zoho Mail").waitFor();
  assert(!(await pa.getByLabel("Sender name").count()), "Zoho uses the mailbox's own name");
  await pa.getByLabel("Send e-mail notifications").check();
  await pa.getByLabel("Sender address").fill("booking@phasakura.test");
  await pa.getByRole("button", { name: "Save" }).click();
  await pa.getByText("Saved", { exact: false }).first().waitFor();
  await pa.locator(".email-add").getByLabel("E-mail").fill("owner@phasakura.test");
  await pa.locator(".email-add").getByLabel("Name").fill("Owner");
  await pa.getByRole("button", { name: "Add address" }).click();
  await pa.getByText("Address added.").waitFor();
  await pa.locator("tr", { hasText: "owner@phasakura.test" }).getByRole("button", { name: "Send test" }).click();
  await pa.getByText(/Test e-mail sent/).waitFor();
  const sent = await emails();
  assert(sent.some((m) => m.to[0] === "owner@phasakura.test" && m.from === "booking@phasakura.test" && /Test/.test(m.subject)), JSON.stringify(sent));
  assert(!/e2e-zoho-(secret|refresh)|E2EZOHOCLIENT/.test(await pa.content()), "Zoho secret leaked");
  await pa.screenshot({ path: `${SHOTS}/pay-email.png`, fullPage: true });
});

await check("LINE staff chat wants new bookings and payments", async () => {
  const s = await req.put(`${BASE}/api/admin/line/settings`, { headers: H, data: { enabled: true, guestEnabled: false, publicButton: false, reminderDaysBefore: 1, reminderTime: "18:00", sendWhenEmpty: false } });
  assert(s.ok(), await s.text());
  const r = await req.post(`${BASE}/api/admin/line/recipients`, { headers: H, data: { targetId: GROUP, name: "Front desk", language: "th", notifyBooking: true, notifyPayment: true, notifyCheckin: false, notifyFood: false } });
  assert(r.status() === 201, await r.text());
});

// ------------------------------------------------------------------ guest: book in the browser, pay by slip
const guest = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: "th-TH", isMobile: true, hasTouch: true });
const pg = await guest.newPage(); watch(pg);
let A = "";
await check("guest (mobile, TH): booking flow ends on the payment step; PromptPay QR with the amount; choose a channel", async () => {
  const ci = day(20), co = day(22);
  await pg.goto(`${BASE}/th/booking?checkIn=${ci}&checkOut=${co}&adults=2&children=0&unit=house-sakura`);
  await pg.getByRole("button", { name: "ถัดไป" }).click({ timeout: 15000 });
  await pg.locator("#bk-name").fill("สมชาย จ่ายเงิน");
  await pg.locator("#bk-phone").fill("0861234567");
  await pg.locator("#bk-email").fill("somchai@example.test");
  await pg.getByRole("button", { name: "ถัดไป" }).click();
  await pg.getByLabel(/ข้าพเจ้ายอมรับนโยบายความเป็นส่วนตัว/).check();
  await pg.getByRole("button", { name: /ยืนยันการจอง/ }).click();
  await pg.getByRole("heading", { name: "จองเรียบร้อย" }).waitFor();
  A = (await pg.locator(".confirmation__value").textContent()).trim();
  await pg.locator(".flow-steps [aria-current=step]", { hasText: "ชำระเงิน" }).waitFor();
  await pg.getByRole("group", { name: "เลือกช่องทางชำระเงิน" }).waitFor();
  for (const label of ["พร้อมเพย์", "โอนเข้าบัญชี", "PayPal"]) await pg.getByRole("radio", { name: new RegExp(label) }).waitFor();
  const qr = pg.locator("svg.qr");
  await qr.waitFor();
  assert(/PromptPay QR สำหรับชำระ ฿/.test(await qr.getAttribute("aria-label")), "QR label with the amount");
  const box = await qr.boundingBox();
  assert(box.width >= 180, `QR too small ${box.width}`);
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `horizontal scroll ${overflow}px`);
  await pg.locator(".pay").screenshot({ path: `${SHOTS}/pay-step-promptpay.png` });
  await pg.getByRole("radio", { name: /โอนเข้าบัญชี/ }).check();
  await pg.getByText(/โอนยอด ฿[\d,]+ เข้าบัญชีนี้/).waitFor();
  await pg.locator(".pay").screenshot({ path: `${SHOTS}/pay-step-bank.png` });
});

await check("guest attaches the slip (bank transfer) → waiting for staff (Manual approve)", async () => {
  await pg.locator(".slip input[type=file]").setInputFiles(`${FIXTURES}/g1.png`);
  await pg.getByRole("button", { name: "ส่งสลิป" }).click();
  await pg.getByText("ได้รับการชำระเงินแล้ว เจ้าหน้าที่กำลังตรวจสอบ", { exact: false }).waitFor();
  const detail = await (await req.get(`${BASE}/api/admin/bookings/${A}`, { headers: H })).json();
  assert(detail.data.payments[0].channel === "BANK_TRANSFER" && detail.data.paymentStatus === "PENDING_VERIFICATION", JSON.stringify(detail.data.payments));
});

await check("staff hear about the new booking on LINE and e-mail; the guest gets 'booking received'", async () => {
  await cron();
  const pushes = (await linePushes()).filter((p) => p.to === GROUP).map((p) => p.texts.join("\n"));
  assert(pushes.some((t) => /การจองใหม่ — รอชำระเงิน/.test(t) && t.includes(A)), JSON.stringify(pushes));
  const mail = await emails();
  assert(mail.some((m) => m.to[0] === "owner@phasakura.test" && m.subject.includes(`New booking ${A}`)), JSON.stringify(mail.map((m) => m.subject)));
  assert(mail.some((m) => m.to[0] === "somchai@example.test" && m.subject.includes(A) && /กรุณาชำระเงิน/.test(m.subject)), "guest booking received");
});

await check("LINE new-booking notice: guest contact half hidden + admin link; the link opens the booking after signing in", async () => {
  const text = (await linePushes()).filter((p) => p.to === GROUP).map((p) => p.texts.join("\n")).find((t) => /การจองใหม่/.test(t) && t.includes(A));
  assert(text, "no new-booking notice");
  assert(text.includes("ผู้จอง: สมชาย จ่ายเงิน\nโทร: 086*****67\nอีเมล: som****@example.test"), text);
  assert(!text.includes("0861234567") && !text.includes("somchai@example.test"), "full contact in LINE");
  const link = text.split("\n").at(-1);
  assert(link === `${BASE}/th/admin/bookings/${A}`, link);
  // Opened from the LINE app: no admin session there yet → sign in → straight to that booking.
  const phone = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: "th-TH", isMobile: true, hasTouch: true });
  const pl = await phone.newPage(); watch(pl);
  await pl.goto(link);
  await pl.waitForURL(`${BASE}/th/admin/login?next=${encodeURIComponent(`bookings/${A}`)}`);
  await pl.locator("input[autocomplete=username]").fill("admin@example.test");
  await pl.locator("input[autocomplete=current-password]").fill("correct horse battery staple");
  await pl.locator("form button[type=submit]").click();
  await pl.waitForURL(`${BASE}/th/admin/bookings/${A}`);
  await pl.getByRole("heading", { name: A }).waitFor();
  await pl.screenshot({ path: `${SHOTS}/pay-line-link-booking.png` });
  await phone.close();
});

await check("slip review (Manual): banner, decline with a reason + cancel the booking; the guest is told", async () => {
  await pa.goto(`${BASE}/en/admin/slips`);
  await pa.getByText(/Manual approve: staff approve every payment/).waitFor();
  const card = pa.locator(".adm-slip", { hasText: A });
  await card.getByText("Bank transfer").waitFor();
  await card.getByRole("button", { name: "Decline / cancel" }).click();
  const dialog = pa.locator("dialog.slip-decline");
  await dialog.getByLabel(/Reason \(sent to the guest\)/).fill("ไม่พบยอดเงินเข้าบัญชี กรุณาติดต่อเรา");
  await dialog.getByLabel(/Cancel this booking/).check();
  await pa.screenshot({ path: `${SHOTS}/pay-decline-dialog.png` });
  await dialog.getByRole("button", { name: /Cancel this booking/ }).click();
  await pa.getByText("Booking cancelled — the guest was told.").waitFor();
  await cron();
  const mail = (await emails()).find((m) => m.to[0] === "somchai@example.test" && /ถูกยกเลิก/.test(m.subject));
  assert(mail && mail.text.includes("ไม่พบยอดเงินเข้าบัญชี กรุณาติดต่อเรา"), JSON.stringify(mail));
  await pg.goto(`${BASE}/th/booking/lookup?code=${A}`);
  assert((await pg.locator("#lk-code").inputValue()) === A, "code from the link");
  await pg.locator("#lk-phone").fill("0861234567");
  await pg.locator("form button[type=submit]").click();
  await pg.getByText("การจองนี้ถูกยกเลิก — ไม่พบยอดเงินเข้าบัญชี กรุณาติดต่อเรา").waitFor();
});

await check("approve: another slip is approved → confirmed, staff and guest told", async () => {
  const B = await book({ checkIn: day(24), checkOut: day(25), stay: { kind: "UNIT", unitId: "dev_house_02" } }, "0861111111", { email: "b@example.test" });
  await pg.goto(`${BASE}/th/booking/lookup?code=${B.bookingCode}`);
  await pg.locator("#lk-phone").fill("0861111111");
  await pg.locator("form button[type=submit]").click();
  await pg.getByRole("radio", { name: /โอนเข้าบัญชี/ }).check();
  await pg.locator(".slip input[type=file]").setInputFiles(`${FIXTURES}/g2.png`);
  await pg.getByRole("button", { name: "ส่งสลิป" }).click();
  await pg.getByText("ได้รับการชำระเงินแล้ว", { exact: false }).waitFor();
  await pa.goto(`${BASE}/en/admin/slips`);
  const card = pa.locator(".adm-slip", { hasText: B.bookingCode });
  await card.getByRole("button", { name: "Approve" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Approve" }).click();
  await pa.getByText(/Approved — the booking is confirmed/).waitFor();
  await cron();
  assert((await emails()).some((m) => m.to[0] === "b@example.test" && /ยืนยันการจอง/.test(m.subject)), "guest confirmed e-mail");
});

await check("booking page: staff decline (pay again) then approve the slip without leaving the booking", async () => {
  const E = await book({ checkIn: day(32), checkOut: day(33), stay: { kind: "UNIT", unitId: "dev_house_02" } }, "0864444444", { email: "e@example.test" });
  const upload = async (file) => {
    await pg.goto(`${BASE}/th/booking/lookup?code=${E.bookingCode}`);
    await pg.locator("#lk-phone").fill("0864444444");
    await pg.locator("form button[type=submit]").click();
    await pg.getByRole("radio", { name: /โอนเข้าบัญชี/ }).check();
    await pg.locator(".slip input[type=file]").setInputFiles(file);
    await pg.getByRole("button", { name: "ส่งสลิป" }).click();
    await pg.getByText("ได้รับการชำระเงินแล้ว", { exact: false }).waitFor();
  };
  await upload(`${FIXTURES}/g-sq.png`);
  await pa.goto(`${BASE}/en/admin/bookings/${E.bookingCode}`);
  const review = pa.getByRole("group", { name: "Slip waiting for review" });
  await review.locator("img").waitFor();
  await review.getByText("Bank transfer").waitFor();
  await pa.screenshot({ path: `${SHOTS}/pay-booking-review.png`, fullPage: true });
  await review.getByRole("button", { name: "Decline / cancel" }).click();
  const dialog = pa.locator("dialog.slip-decline");
  await dialog.getByLabel(/Reason \(sent to the guest\)/).fill("ยอดเงินไม่ตรง กรุณาส่งสลิปใหม่");
  await dialog.getByLabel(/Let the guest pay again/).check();
  await dialog.getByRole("button", { name: "Decline / cancel" }).click();
  // The panel is rebuilt with the reloaded booking: the note must still be there afterwards.
  await review.waitFor({ state: "detached" });
  await pa.getByText("Declined — the guest was told the reason.").waitFor({ timeout: 5000 });
  let d = (await (await req.get(`${BASE}/api/admin/bookings/${E.bookingCode}`, { headers: H })).json()).data;
  assert(d.status === "PENDING" && d.paymentStatus === "REJECTED", JSON.stringify([d.status, d.paymentStatus]));
  await cron();
  const told = (await emails()).filter((m) => m.to[0] === "e@example.test");
  assert(told.some((m) => m.text.includes("ยอดเงินไม่ตรง กรุณาส่งสลิปใหม่")), `guest told the decline reason ${JSON.stringify(told.map((m) => m.subject))}`);

  await upload(`${FIXTURES}/food.png`);
  await pa.reload();
  await review.getByRole("button", { name: "Approve" }).waitFor();
  await review.getByLabel("Transaction reference (optional)").fill("E2EREF0001");
  await review.getByRole("button", { name: "Approve" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Approve" }).click();
  await review.waitFor({ state: "detached" });
  await pa.getByText("Approved — the booking is confirmed and the guest was told.").waitFor({ timeout: 5000 });
  d = (await (await req.get(`${BASE}/api/admin/bookings/${E.bookingCode}`, { headers: H })).json()).data;
  assert(d.status === "CONFIRMED" && d.paymentStatus === "VERIFIED", JSON.stringify([d.status, d.paymentStatus]));
  assert(d.payments.filter((p) => p.status === "VERIFIED").length === 1 && d.payments.filter((p) => p.status === "REJECTED").length === 1, JSON.stringify(d.payments.map((p) => p.status)));
  await cron();
  assert((await emails()).some((m) => m.to[0] === "e@example.test" && /ยืนยันการจอง/.test(m.subject)), "guest confirmed e-mail");
});

// ------------------------------------------------------------------ PayPal round trip
await check("PayPal: guest pays at (fake) PayPal and comes back to a confirmed booking", async () => {
  const C = await book({ checkIn: day(26), checkOut: day(27), stay: { kind: "UNIT", unitId: "dev_vip_01" } }, "0862222222");
  // Stand-in for PayPal's approval page: it sends the guest back to our return_url, as PayPal does.
  await pg.route("https://www.sandbox.paypal.com/**", (route) => {
    const token = new URL(route.request().url()).searchParams.get("token");
    return route.fulfill({ status: 302, headers: { location: `${BASE}/th/booking/lookup?paypal=return&code=${C.bookingCode}&token=${token}&PayerID=FAKEPAYER` } });
  });
  await pg.goto(`${BASE}/th/booking/lookup?code=${C.bookingCode}`);
  await pg.locator("#lk-phone").fill("0862222222");
  await pg.locator("form button[type=submit]").click();
  await pg.getByRole("radio", { name: /PayPal/ }).check();
  await pg.locator(".pay").screenshot({ path: `${SHOTS}/pay-step-paypal.png` });
  await pg.getByRole("button", { name: /ชำระด้วย PayPal/ }).click();
  await pg.waitForURL(/\/th\/booking\/lookup/);
  await pg.getByText("ชำระเงินผ่าน PayPal สำเร็จ การจองของคุณได้รับการยืนยันแล้ว").waitFor({ timeout: 15000 });
  // The phone was kept for this tab only: the booking opens by itself, confirmed.
  await pg.locator(".status-pill--confirmed").waitFor();
  assert(!/paypal=return|token=/.test(pg.url()), `query cleaned ${pg.url()}`);
  const calls = (await (await req.get(`${BASE}/__e2e/paypal`)).json()).requests;
  assert(calls.filter((c) => c.endsWith("/capture")).length === 1, JSON.stringify(calls));
  await pg.screenshot({ path: `${SHOTS}/pay-paypal-done.png`, fullPage: true });
  await pg.unroute("https://www.sandbox.paypal.com/**");
});

await check("PayPal declined → nothing taken, the guest can choose again", async () => {
  const D = await book({ checkIn: day(28), checkOut: day(29), stay: { kind: "UNIT", unitId: "dev_vip_01" } }, "0863333333");
  await req.post(`${BASE}/__e2e/paypal/mode`, { data: { mode: "DECLINED" } });
  await pg.route("https://www.sandbox.paypal.com/**", (route) => {
    const token = new URL(route.request().url()).searchParams.get("token");
    return route.fulfill({ status: 302, headers: { location: `${BASE}/th/booking/lookup?paypal=return&code=${D.bookingCode}&token=${token}` } });
  });
  await pg.goto(`${BASE}/th/booking/lookup?code=${D.bookingCode}`);
  await pg.locator("#lk-phone").fill("0863333333");
  await pg.locator("form button[type=submit]").click();
  await pg.getByRole("radio", { name: /PayPal/ }).check();
  await pg.getByRole("button", { name: /ชำระด้วย PayPal/ }).click();
  await pg.getByText(/PayPal ตัดเงินไม่สำเร็จ ยังไม่มีการตัดเงิน/).waitFor({ timeout: 15000 });
  await pg.getByRole("group", { name: "เลือกช่องทางชำระเงิน" }).waitFor();
  await pg.unroute("https://www.sandbox.paypal.com/**");
  await req.post(`${BASE}/__e2e/paypal/mode`, { data: { mode: "COMPLETED" } });
});

await check("deposit: House 02 takes 50%; the guest is asked for the deposit; check-in takes the rest (PromptPay QR / account / cash) in one step", async () => {
  // Owner: House 02 → Payment → 50% deposit.
  await pa.goto(`${BASE}/en/admin/houses/dev_house_02`);
  await pa.getByLabel("Payment", { exact: true }).selectOption("DEPOSIT_50");
  await pa.getByText("Deposit = half of the stay (tarp area included) plus food in full. Applies to new bookings only.").waitFor();
  await pa.locator("form.adm-card").first().getByRole("button", { name: "Save" }).click();
  await pa.getByText("Saved").first().waitFor();
  const unit = (await (await req.get(`${BASE}/api/admin/accommodations/dev_house_02`)).json()).data;
  assert(unit.paymentMode === "DEPOSIT_50", `mode ${unit.paymentMode}`);

  // Guest books tonight + tomorrow: asked for the deposit, told the rest is paid at check-in.
  const D = await book({ checkIn: day(0), checkOut: day(2), stay: { kind: "UNIT", unitId: "dev_house_02" } }, "0865555555");
  assert(D.depositSatang > 0 && D.depositSatang < D.totalSatang, JSON.stringify([D.depositSatang, D.totalSatang]));
  const baht = (s) => `฿${(s / 100).toLocaleString("en-US")}`;
  const later = D.totalSatang - D.depositSatang;
  await pg.goto(`${BASE}/th/booking/lookup?code=${D.bookingCode}`);
  await pg.locator("#lk-phone").fill("0865555555");
  await pg.locator("form button[type=submit]").click();
  await pg.locator(".pay__amount", { hasText: "ยอดมัดจำที่ต้องชำระตอนนี้" }).getByText(baht(D.depositSatang)).waitFor();
  await pg.getByText(`ส่วนที่เหลือ ${baht(later)} ชำระที่หน้าที่พักตอนเช็กอิน (เงินสด พร้อมเพย์ หรือโอน)`).waitFor();
  await pg.locator(".summary__line--due", { hasText: "มัดจำ ชำระตอนนี้" }).waitFor();
  if (SHOTS) await pg.screenshot({ path: `${SHOTS}/deposit-guest-payment.png`, fullPage: true });

  // Staff record the deposit (the form is filled in with it); check-in then opens the balance dialog.
  await pa.goto(`${BASE}/en/admin/bookings/${D.bookingCode}`);
  await pa.getByText(`Record the ${baht(D.depositSatang)} deposit; the rest is taken at check-in.`).waitFor();
  if ((await pa.getByLabel("Amount (THB)").inputValue()) !== String(D.depositSatang / 100)) throw new Error("amount not the deposit");
  await pa.getByRole("button", { name: "Record payment received" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Record payment received" }).click();
  await pa.getByText("Still due").waitFor();
  await pa.locator(".adm-deposit .adm-due", { hasText: baht(later) }).waitFor();
  const stay = pa.getByRole("group", { name: "Stay" });
  await stay.getByText(`${baht(later)} due`).waitFor();
  await stay.getByRole("button", { name: "Check in" }).click();
  const dialog = pa.locator("dialog[open]");
  await dialog.getByRole("heading", { name: "Take the balance before check-in" }).waitFor();
  await dialog.locator(".adm-balance__due", { hasText: baht(later) }).waitFor();
  await dialog.getByRole("img", { name: `PromptPay QR ${baht(later)}` }).waitFor();
  await pa.screenshot({ path: `${SHOTS}/deposit-checkin-qr.png` });
  await dialog.getByText("Bank transfer", { exact: true }).click();
  await dialog.getByText("000-0-00000-0").waitFor();
  await dialog.getByText("Cash", { exact: true }).click();
  await dialog.getByRole("button", { name: "Cash received" }).click();
  await dialog.getByText(`Confirm you received ${baht(later)} (Cash) and check in ${D.bookingCode}?`).waitFor();
  await dialog.getByRole("button", { name: "Confirm payment and check in" }).click();
  await pa.getByText(`${D.bookingCode}: ${baht(later)} received and checked in`).waitFor();
  await pa.locator(".adm-pagehead").getByText("Checked in").waitFor();
  await pa.locator(".adm-deposit").getByText("Paid in full").waitFor();
  const after = (await (await req.get(`${BASE}/api/admin/bookings/${D.bookingCode}`)).json()).data;
  assert(after.paidSatang === after.totalSatang && after.balanceSatang === 0 && after.payments.length === 2, JSON.stringify([after.paidSatang, after.balanceSatang, after.payments.length]));
  await pa.screenshot({ path: `${SHOTS}/deposit-checked-in.png`, fullPage: true });

  // Back to full payment for anything after this check.
  await req.patch(`${BASE}/api/admin/accommodations/dev_house_02`, { headers: H, data: { paymentMode: "FULL" } });
});

await check("deposit: the dashboard totals what is still due at check-in; the guest transfers the rest ahead from the booking page; staff approve it", async () => {
  await req.patch(`${BASE}/api/admin/accommodations/dev_house_02`, { headers: H, data: { paymentMode: "DEPOSIT_50" } });
  const R = await book({ checkIn: day(40), checkOut: day(42), stay: { kind: "UNIT", unitId: "dev_house_02" } }, "0866666666");
  const baht = (s) => `฿${(s / 100).toLocaleString("en-US")}`;
  const later = R.totalSatang - R.depositSatang;
  const rec = await req.post(`${BASE}/api/admin/bookings/${R.bookingCode}/payments`, {
    headers: H, data: { amountSatang: R.depositSatang, method: "BANK_TRANSFER", paidAt: new Date().toISOString() },
  });
  assert(rec.ok(), await rec.text());

  // Dashboard: the total still to take at check-in, linking to those bookings.
  await pa.goto(`${BASE}/en/admin`);
  const kpi = pa.locator(".adm-kpi", { hasText: "Still due at check-in" });
  await kpi.getByText(baht(later)).waitFor();
  await kpi.getByText("Deposit bookings still owing: 1").waitFor();
  await kpi.screenshot({ path: `${SHOTS}/balance-dashboard-kpi.png` });
  await kpi.getByRole("link").click();
  await pa.waitForURL(/\/en\/admin\/bookings\?due=1$/);
  assert(await pa.getByLabel("Only those still owing at check-in").isChecked(), "filter not on");
  await pa.locator(".adm-table tbody tr").filter({ hasText: R.bookingCode }).getByText(`${baht(later)} due`).waitFor();
  assert((await pa.locator(".adm-table tbody tr").count()) === 1, "only bookings that still owe");

  // The owner switches House 02 back to full payment: told that this booking keeps its deposit plan.
  await pa.goto(`${BASE}/en/admin/houses/dev_house_02`);
  const mode = pa.getByLabel("Payment", { exact: true });
  await mode.selectOption("FULL");
  const kept = pa.locator(".adm-paymode-kept");
  await kept.getByText("Bookings made with a deposit keep it — full payment applies to new bookings only").waitFor();
  await kept.getByText(`Deposit paid, rest still due: 1 (in total ${baht(later)})`, { exact: false }).waitFor();
  await pa.locator("form.adm-card").first().getByRole("button", { name: "Save" }).click();
  await pa.getByText("Saved").first().waitFor();
  await kept.waitFor(); // still shown once saved: the booking is still open
  await pa.locator("form.adm-card").first().screenshot({ path: `${SHOTS}/balance-mode-switch.png` });
  const unitNow = (await (await req.get(`${BASE}/api/admin/accommodations/dev_house_02`)).json()).data;
  assert(unitNow.paymentMode === "FULL" && unitNow.depositBookings.paid === 1, JSON.stringify(unitNow.depositBookings));
  await pa.goto(`${BASE}/en/admin/bookings/${R.bookingCode}`);
  await pa.locator(".adm-deposit__kept").getByText("This stay now takes full payment", { exact: false }).waitFor();

  // Guest: the rest, by PromptPay QR (no PayPal here), then the slip — the plan agreed at booking time still holds.
  await pg.goto(`${BASE}/th/booking/lookup?code=${R.bookingCode}`);
  await pg.locator("#lk-phone").fill("0866666666");
  await pg.locator("form button[type=submit]").click();
  const pay = pg.locator(".pay", { has: pg.getByRole("heading", { name: "ชำระส่วนที่เหลือก่อนเข้าพัก" }) });
  await pay.locator(".pay__amount", { hasText: "ยอดคงเหลือ" }).getByText(baht(later)).waitFor();
  await pay.getByText(`ได้รับมัดจำแล้ว ${baht(R.depositSatang)}`, { exact: false }).waitFor();
  assert(!(await pay.getByRole("radio", { name: /PayPal/ }).count()), "PayPal offered for the rest");
  const qr = pay.locator("svg.qr");
  await qr.waitFor();
  assert((await qr.getAttribute("aria-label")).includes(baht(later)), "QR for the rest");
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `horizontal scroll ${overflow}px`);
  await pg.screenshot({ path: `${SHOTS}/balance-guest-pay.png`, fullPage: true });
  await pay.locator(".slip input[type=file]").setInputFiles(`${FIXTURES}/story.png`);
  await pay.getByRole("button", { name: "ส่งสลิป" }).click();
  await pg.getByText("ได้รับสลิปยอดคงเหลือแล้ว กำลังตรวจสอบ", { exact: false }).waitFor();
  await pg.getByText("ชำระส่วนที่เหลือก่อนเข้าพัก").waitFor({ state: "detached" });

  // Staff: the booking page shows the slip for the rest; approve it.
  await pa.goto(`${BASE}/en/admin/bookings/${R.bookingCode}`);
  const review = pa.getByRole("group", { name: "Balance slip waiting for review" });
  await review.locator("img").waitFor();
  await review.getByText(baht(later)).waitFor();
  await pa.locator("tr", { hasText: "Slip pending" }).locator(".adm-deposit__kind", { hasText: "Balance" }).waitFor();
  await pa.screenshot({ path: `${SHOTS}/balance-admin-review.png`, fullPage: true });
  await review.getByRole("button", { name: "Decline / cancel" }).click();
  const decline = pa.locator("dialog.slip-decline");
  await decline.getByText("The booking stays confirmed — the guest can send a new slip or pay the rest at check-in.").waitFor();
  assert(!(await decline.getByLabel(/Cancel this booking/).count()), "cancel offered for a balance slip");
  await decline.getByRole("button", { name: "Close" }).click();
  await review.getByRole("button", { name: "Approve" }).click();
  await pa.locator("dialog[open]").getByRole("button", { name: "Approve" }).click();
  await pa.getByText("Approved — the balance is recorded and the booking is paid in full.").waitFor();
  await pa.locator(".adm-deposit").getByText("Paid in full").waitFor();
  const after = (await (await req.get(`${BASE}/api/admin/bookings/${R.bookingCode}`)).json()).data;
  assert(after.status === "CONFIRMED" && after.balanceSatang === 0, JSON.stringify([after.status, after.balanceSatang]));

  await pg.reload();
  await pg.locator("#lk-phone").fill("0866666666");
  await pg.locator("form button[type=submit]").click();
  await pg.getByText("ชำระครบแล้ว — เช็กอินได้เลยโดยไม่ต้องชำระเพิ่ม").waitFor();

  // Nothing open with a deposit any more: the note on House 02 goes away.
  await pa.goto(`${BASE}/en/admin/houses/dev_house_02`);
  await pa.getByLabel("Payment", { exact: true }).waitFor();
  assert(!(await pa.locator(".adm-paymode-kept").count()), "note still shown with nothing open");
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
