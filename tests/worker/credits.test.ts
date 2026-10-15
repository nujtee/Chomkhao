import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type {
  CreditLedgerEntryDto, CreditPaymentInfoDto, CreditRecipientDto, CreditSettingsDto, CreditSummaryDto, CreditTopupDto, MyLineDto, Page, TopupResultDto,
} from "../../src/shared/credit-types.ts";
import type { CurrentUserDto } from "../../src/shared/auth-types.ts";
import { creditState } from "../../src/worker/services/credit.service.ts";
import type { ProviderResult, VerifiedSlip } from "../../src/worker/slip/slip-verifier.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

// App-usage credits (migration 0027). Harness clock: 2027-01-10T03:00Z (Bangkok 10:00).
// Seed: House 01 ฿3,500/night, House 02 ฿3,200, VIP-01 ฿1,800; camping per adult per night.
let seq = 0;
const key = () => `credit-key-${String(++seq).padStart(8, "0")}`;
const PHONE = "0812345678";
const slipFile = (n: number) => ({ bytes: pngBytes(600 + n, 800 + n), name: `topup${n}.png`, type: "image/png" });

type Stay = Record<string, unknown>;
const house1: Stay = { kind: "UNIT", unitId: "dev_house_01", adults: 2, children: 0 };
const house2: Stay = { kind: "UNIT", unitId: "dev_house_02", adults: 2, children: 0 };
const vip1: Stay = { kind: "UNIT", unitId: "dev_vip_01", adults: 2, children: 0 };
const camp2: Stay = { kind: "CAMPING", tents: 2, adults: 3, children: 0 };

const SETTINGS = {
  enabled: true, feePerUnit: 20, lowThreshold: 500, approvalMode: "MANUAL", standardMin: 300, premiumMin: 1000,
  bankName: "Kasikorn", accountName: "Platform Owner", accountNumber: "111-2-33333-4", promptpayNumber: "0899999999",
  qrAssetId: null, notifyEmail: "owner@platform.test", alertTime1: "09:00", alertTime2: "17:00",
};

async function setup(opts: { enabled?: boolean; credits?: number; settings?: Partial<typeof SETTINGS> } = {}) {
  const h = new Harness({ seed: true });
  const root = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const managerId = `manager_${++seq}`;
  const manager = await h.login(await h.user({ id: managerId, roles: ["MANAGER"] }));
  if (opts.enabled !== false) {
    const s = await h.api<CreditSettingsDto>("PUT", "/api/admin/credit-admin/settings", { token: root, body: { ...SETTINGS, ...opts.settings } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
  }
  if (opts.credits) {
    const a = await h.api("POST", "/api/admin/credit-admin/adjustments", { token: root, body: { amount: opts.credits, note: "opening balance" } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
  }
  const body = (stays: Stay[], over: Record<string, unknown> = {}) => ({ checkIn: "2027-02-01", checkOut: "2027-02-03", stays, food: [], lang: "th", ...over });
  const quote = (stays: Stay[], over: Record<string, unknown> = {}) => h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: body(stays, over) });
  const book = async (stays: Stay[], over: Record<string, unknown> = {}) => {
    const q = await quote(stays, over);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    return h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { ...body(stays, over), customer: { name: "Credit Guest", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
  };
  const summary = async (token = root) => (await h.api<CreditSummaryDto>("GET", "/api/admin/credits/summary", { token })).data;
  const account = () => ({ ...h.db.get<{ balance: number; held: number; plan: string }>("SELECT balance, held, plan FROM credit_account WHERE id = 1")! });
  const hold = (code: string) => {
    const row = h.db.get<{ units: number; amount: number; status: string }>(
      "SELECT h.units, h.amount, h.status FROM credit_holds h JOIN bookings b ON b.id = h.booking_id WHERE b.booking_code = ?", code);
    return row ? { ...row } : undefined;
  };
  const pay = (code: string, amountSatang: number) => h.api(`POST`, `/api/admin/bookings/${code}/payments`, {
    token: root, body: { amountSatang, method: "BANK_TRANSFER", paidAt: "2027-01-10T02:55:00Z", reference: `TXN-${++seq}` },
  });
  const topup = (token: string, plan: string, amount: number, n = ++seq) =>
    h.multipart<TopupResultDto>(token, "/api/admin/credits/topups", [["plan", plan], ["amount", String(amount)], ["file", slipFile(n)]]);
  return { h, root, manager, managerId, quote, book, summary, account, hold, pay, topup };
}

describe("credit state (pure)", () => {
  it("OFF / NORMAL / LOW / EMPTY from the balance, what is held and the settings", () => {
    const s = { enabled: 1, fee_per_unit: 20, low_threshold: 500 };
    assert.deepEqual(creditState({ ...s, enabled: 0 }, { balance: 0, held: 0 }), { state: "OFF", available: 0, unitsLeft: null });
    assert.deepEqual(creditState(s, { balance: 1000, held: 0 }), { state: "NORMAL", available: 1000, unitsLeft: 50 });
    assert.deepEqual(creditState(s, { balance: 600, held: 120 }), { state: "LOW", available: 480, unitsLeft: 24 });
    assert.deepEqual(creditState(s, { balance: 39, held: 20 }), { state: "EMPTY", available: 19, unitsLeft: 0 });
    assert.equal(creditState(null, null).state, "OFF");
  });
});

describe("deploy order: admin keeps working before migration 0027", () => {
  it("permissions are read without the credit tables (no plan lock yet)", async () => {
    const h = new Harness({ seed: true });
    const token = await h.login(await h.user({ id: "mgr_pre0027", roles: ["MANAGER"] }));
    h.db.run("DROP TABLE credit_account");
    h.db.run("DROP TABLE credit_settings");
    const me = await h.api<CurrentUserDto>("GET", "/api/auth/me", { token });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.ok(me.data.permissions.includes("reports.view"));
  });
});

describe("app fee on bookings", () => {
  it("off by default: no fee, no hold, bookings exactly as before", async () => {
    const { quote, book, account, hold } = await setup({ enabled: false });
    const q = await quote([house1]);
    assert.equal(q.data.appFee, null);
    assert.equal(q.data.bookingUnavailable, false);
    assert.equal(q.data.totalSatang, 700_000);
    const b = await book([house1]);
    assert.equal(b.status, 201);
    assert.equal(b.data.appFee, null);
    assert.equal(hold(b.data.bookingCode), undefined);
    assert.deepEqual(account(), { balance: 0, held: 0, plan: "STANDARD" });
  });

  it("20 per house / VIP tent / own tent on the bill; held when booked, deducted once when paid", async () => {
    const { h, quote, book, account, hold, pay, summary } = await setup({ credits: 1000 });
    const q = await quote([house1, house2, vip1, camp2]);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.data.appFee, { units: 5, perUnitSatang: 2000, totalSatang: 10_000 });
    assert.equal(q.data.totalSatang, q.data.accommodationSubtotalSatang + q.data.foodSubtotalSatang + 10_000, "the fee is part of the total");
    const b = await book([house1, house2, vip1, camp2]);
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.deepEqual(b.data.appFee, { units: 5, perUnitSatang: 2000, totalSatang: 10_000 });
    assert.deepEqual(hold(b.data.bookingCode), { units: 5, amount: 100, status: "HELD" });
    assert.deepEqual(account(), { balance: 1000, held: 100, plan: "STANDARD" });
    assert.equal((await summary()).available, 900);

    // Paid (staff record the transfer): the held credits are deducted, once, with a ledger row.
    const paid = await pay(b.data.bookingCode, b.data.totalSatang);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.deepEqual(account(), { balance: 900, held: 0, plan: "STANDARD" });
    assert.equal(hold(b.data.bookingCode)!.status, "CAPTURED");
    const ledger = h.db.all<{ entry_type: string; amount: number; balance_after: number; units: number | null }>(
      "SELECT entry_type, amount, balance_after, units FROM credit_ledger ORDER BY created_at, entry_type");
    assert.deepEqual(ledger.map((l) => [l.entry_type, l.amount, l.balance_after]), [["ADJUST_ADD", 1000, 1000], ["FEE_CAPTURE", -100, 900]]);
    assert.equal(ledger[1]!.units, 5);
    // Cancelling after payment gives nothing back (the fee was earned).
    const cancel = await h.api(`POST`, `/api/admin/bookings/${b.data.bookingCode}/cancel`, { token: (await setupRoot(h)), body: { reason: "guest changed plans" } });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.deepEqual(account(), { balance: 900, held: 0, plan: "STANDARD" });
  });

  it("the guest's 'booking received' e-mail shows the fee line", async () => {
    const { h, root, quote } = await setup({ credits: 1000 });
    h.emailKey();
    await h.api("PUT", "/api/admin/email/settings", { token: root, body: { enabled: true, guestEnabled: true, fromEmail: "booking@phasakura.test" } });
    const q = await quote([house1, camp2]);
    const b = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
      body: { checkIn: "2027-02-01", checkOut: "2027-02-03", stays: [house1, camp2], food: [], lang: "th",
        customer: { name: "Credit Guest", phone: PHONE, email: "guest@example.test" }, privacyAccepted: true,
        expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
    });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    await h.app.scheduled(h.env, h.now.getTime() + 60_000);
    const mail = h.resend.requests.find((x) => (x.json!.to as string[])[0] === "guest@example.test");
    assert.ok(mail, "guest e-mail sent");
    assert.match(String(mail.json!.text), /ค่าธรรมเนียมการใช้ App \(3 หลัง\): ฿60/);
  });

  it("an unpaid booking that expires or is cancelled gives its credits back", async () => {
    const { h, book, account, hold, root } = await setup({ credits: 100 });
    const a = await book([house1]);
    const b = await book([vip1]);
    assert.deepEqual(account(), { balance: 100, held: 40, plan: "STANDARD" });
    const cancel = await h.api(`POST`, `/api/admin/bookings/${b.data.bookingCode}/cancel`, { token: root, body: { reason: "duplicate booking" } });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal(hold(b.data.bookingCode)!.status, "RELEASED");
    assert.deepEqual(account(), { balance: 100, held: 20, plan: "STANDARD" });
    h.advance(24 * 60 * 60_000);
    await h.app.scheduled(h.env, h.now.getTime());
    assert.equal(hold(a.data.bookingCode)!.status, "RELEASED");
    assert.deepEqual(account(), { balance: 100, held: 0, plan: "STANDARD" });
  });

  it("not enough credit: the booking is refused (409 CREDIT_INSUFFICIENT), online booking closes at < one unit", async () => {
    const { h, quote, book, account } = await setup({ credits: 40 });
    const q = await quote([house1, house2, vip1]);
    assert.equal(q.data.bookingUnavailable, true, "60 needed, 40 left");
    const refused = await book([house1, house2, vip1]);
    assert.equal(refused.status, 409);
    assert.equal(refused.error?.code, "CREDIT_INSUFFICIENT");
    assert.equal((await h.api<{ open: boolean }>("GET", "/api/public/bookings/status")).data.open, true, "one unit still fits");
    assert.equal((await book([house1, house2])).status, 201, "40 for two units");
    assert.deepEqual(account(), { balance: 40, held: 40, plan: "STANDARD" });
    assert.equal((await h.api<{ open: boolean }>("GET", "/api/public/bookings/status")).data.open, false);
    const none = await book([vip1]);
    assert.equal(none.error?.code, "CREDIT_INSUFFICIENT");
    // The database is the last line: even a direct insert with a fee cannot over-book the credits.
    assert.throws(() => h.db.run(
      `INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults, customer_name, customer_phone,
         customer_phone_normalized, accommodation_subtotal_satang, subtotal_satang, total_satang, app_fee_units, app_fee_satang)
       VALUES ('x1', 'BK-20270110-ZZZZ', 'th', '2027-03-01', '2027-03-02', 1, 1, 'X', '0800000000', '0800000000', 1000, 3000, 3000, 1, 2000)`),
    /CREDIT_INSUFFICIENT/);
  });

  it("cancelling one stay of an unpaid booking lowers its fee and its hold", async () => {
    const { h, root, book, account, hold } = await setup({ credits: 500 });
    const b = await book([house1, camp2]);
    assert.deepEqual(hold(b.data.bookingCode), { units: 3, amount: 60, status: "HELD" });
    const full = (await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${b.data.bookingCode}`, { token: root })).data;
    const campItem = full.items.find((i) => i.type === "OWN_TENT")!;
    const res = await h.api<AdminBookingDto>("POST", `/api/admin/bookings/${b.data.bookingCode}/stays/${campItem.id}/cancel`, { token: root, body: { reason: "camping not needed" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.data.appFee, { units: 1, perUnitSatang: 2000, totalSatang: 2000 });
    assert.equal(res.data.totalSatang, 700_000 + 2000);
    assert.deepEqual(hold(b.data.bookingCode), { units: 1, amount: 20, status: "HELD" });
    assert.deepEqual(account(), { balance: 500, held: 20, plan: "STANDARD" });
  });

  it("deposit plan: the fee is paid with the deposit", async () => {
    const { h, root, quote } = await setup({ credits: 500 });
    h.db.run("UPDATE accommodation_units SET payment_mode = 'DEPOSIT_50' WHERE id = 'dev_house_01'");
    const q = await quote([house1]);
    assert.equal(q.data.totalSatang, 702_000);
    assert.equal(q.data.depositSatang, 350_000 + 2000, "half the stay + the whole fee now");
    void root;
  });
});

describe("Super Admin only", () => {
  it("credits.manage stays with SUPER_ADMIN: routes, role editing and per-user grants refuse it", async () => {
    const { h, root, manager, managerId } = await setup({ enabled: false });
    assert.equal((await h.api("GET", "/api/admin/credit-admin/settings", { token: manager })).status, 403);
    assert.equal((await h.api("POST", "/api/admin/credit-admin/adjustments", { token: manager, body: { amount: 100, note: "free money" } })).status, 403);
    const me = (await h.api<CurrentUserDto>("GET", "/api/auth/me", { token: manager })).data;
    assert.ok(me.permissions.includes("credits.topup") && me.permissions.includes("credits.view"));
    assert.ok(!me.permissions.includes("credits.manage"));
    const roles = (await h.api<{ id: string; code: string; permissions: string[] }[]>("GET", "/api/admin/roles?lang=en", { token: root })).data;
    const managerRole = roles.find((r) => r.code === "MANAGER")!;
    const grantRole = await h.api("PUT", `/api/admin/roles/${managerRole.id}/permissions`, { token: root, body: { permissions: [...managerRole.permissions, "credits.manage"] } });
    assert.equal(grantRole.status, 422);
    const grantUser = await h.api("PUT", `/api/admin/users/${managerId}/permissions`, { token: root, body: { overrides: [{ code: "credits.manage", effect: "GRANT" }] } });
    assert.equal(grantUser.status, 422);
    assert.throws(() => h.grant(managerId, "credits.manage"), /CREDITS_MANAGE_SUPER_ADMIN_ONLY/);
  });
});

describe("top-ups", () => {
  it("manual approval: request with a slip, Super Admin approves (amount can be corrected), plan follows the top-up", async () => {
    const { h, root, manager, topup, account } = await setup();
    const info = await h.api<CreditPaymentInfoDto>("GET", "/api/admin/credits/topup-info", { token: manager });
    assert.equal(info.status, 200);
    assert.deepEqual(info.data.minimums, { STANDARD: 300, PREMIUM: 1000 });
    assert.equal(info.data.accountNumber, "111-2-33333-4");

    const low = await topup(manager, "PREMIUM", 500);
    assert.equal(low.status, 422, "below the Premium minimum");
    const res = await topup(manager, "PREMIUM", 1500);
    assert.equal(res.status, 201, JSON.stringify(res));
    assert.equal(res.data.outcome, "PENDING");
    assert.equal(account().balance, 0, "nothing until approved");
    const again = await h.multipart(manager, "/api/admin/credits/topups", [["plan", "PREMIUM"], ["amount", "1500"], ["file", slipFile(-1 + seq)]]);
    assert.ok(again.status === 201 || again.status === 409);

    const mine = await h.api<Page<CreditTopupDto>>("GET", "/api/admin/credits/topups?mine=1", { token: manager });
    assert.ok(mine.data.items.every((t) => t.requestedBy.name.length > 0));
    assert.equal((await h.api(`POST`, `/api/admin/credit-admin/topups/${res.data.topup.id}/approve`, { token: manager, body: {} })).status, 403);
    const slip = await h.get(`/api/admin/credits/topups/${res.data.topup.id}/slip`, { Cookie: `__Host-sid=${root}` });
    assert.equal(slip.status, 200);
    assert.equal(slip.headers.get("Cache-Control"), "private, no-store");

    const ok = await h.api<CreditTopupDto>("POST", `/api/admin/credit-admin/topups/${res.data.topup.id}/approve`, { token: root, body: { amount: 1400 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.data.status, "APPROVED");
    assert.equal(ok.data.amountCredited, 1400);
    assert.deepEqual(account(), { balance: 1400, held: 0, plan: "PREMIUM" });
    const twice = await h.api("POST", `/api/admin/credit-admin/topups/${res.data.topup.id}/approve`, { token: root, body: {} });
    assert.equal(twice.status, 409);
    const ledger = (await h.api<Page<CreditLedgerEntryDto>>("GET", "/api/admin/credits/ledger", { token: manager })).data.items;
    assert.deepEqual(ledger.map((l) => [l.type, l.amount, l.balanceAfter, l.plan]), [["TOPUP", 1400, 1400, "PREMIUM"]]);
  });

  it("rejection keeps the balance; the same slip cannot be sent twice", async () => {
    const { h, root, manager, account } = await setup();
    const file = slipFile(500);
    const first = await h.multipart<TopupResultDto>(manager, "/api/admin/credits/topups", [["plan", "STANDARD"], ["amount", "300"], ["file", file]]);
    assert.equal(first.status, 201);
    const dup = await h.multipart(manager, "/api/admin/credits/topups", [["plan", "STANDARD"], ["amount", "300"], ["file", file]]);
    assert.equal(dup.status, 409);
    assert.equal(dup.error?.code, "DUPLICATE_SLIP");
    const no = await h.api<CreditTopupDto>("POST", `/api/admin/credit-admin/topups/${first.data.topup.id}/reject`, { token: root, body: { reason: "No money arrived" } });
    assert.equal(no.status, 200);
    assert.equal(no.data.rejectReason, "No money arrived");
    assert.equal(account().balance, 0);
  });

  it("EasySlip: approved at once when the slip proves the transfer; otherwise waits with the reason", async () => {
    const good = (over: Partial<VerifiedSlip> = {}): VerifiedSlip => ({
      transactionRef: `TOPUP${++seq}`, amountSatang: 50_000, transferredAt: "2027-01-10T02:50:00.000Z", senderBank: "SCB",
      receiverBank: "KBANK", receiverAccountMasked: "xxx-x-x3333-x", receiverProxyMasked: null, ...over,
    });
    let answer: ProviderResult = { kind: "OK", slip: good() };
    const { h, root, manager, topup, account } = await setup({ enabled: false });
    h.verifier({ provider: "easyslip", verify: async () => answer });
    const saved = await h.api("PUT", "/api/admin/credit-admin/settings", { token: root, body: { ...SETTINGS, approvalMode: "EASYSLIP" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const auto = await topup(manager, "STANDARD", 500);
    assert.equal(auto.status, 201, JSON.stringify(auto));
    assert.equal(auto.data.outcome, "APPROVED");
    assert.equal(auto.data.topup.decidedVia, "EASYSLIP");
    assert.deepEqual(account(), { balance: 500, held: 0, plan: "STANDARD" });

    answer = { kind: "OK", slip: good({ amountSatang: 40_000 }) };
    const wrong = await topup(manager, "STANDARD", 500);
    assert.equal(wrong.data.outcome, "PENDING");
    assert.deepEqual(wrong.data.topup.verifyReasons, ["AMOUNT_MISMATCH"]);
    answer = { kind: "OK", slip: good({ receiverAccountMasked: "xxx-x-x1234-x" }) };
    const elsewhere = await topup(manager, "STANDARD", 500);
    assert.deepEqual(elsewhere.data.topup.verifyReasons, ["RECEIVER_MISMATCH", "receiver:KBANK · xxx-x-x1234-x"], "what EasySlip read is kept for Super Admin");

    // Paid by scanning a K PLUS "receive money" QR: the slip names its 15-digit e-Wallet ID (migration 0028).
    answer = { kind: "OK", slip: good({ receiverBank: null, receiverAccountMasked: null, receiverProxyMasked: "004xxxxxxxx5858" }) };
    const wallet = await topup(manager, "STANDARD", 500);
    assert.deepEqual(wallet.data.topup.verifyReasons, ["RECEIVER_MISMATCH", "receiver:004xxxxxxxx5858"]);
    const withQr = await h.api<CreditSettingsDto>("PUT", "/api/admin/credit-admin/settings", {
      token: root, body: { ...SETTINGS, approvalMode: "EASYSLIP", qrReceiver: "004 999 99999 5858" },
    });
    assert.equal(withQr.status, 200, JSON.stringify(withQr.body));
    assert.equal(withQr.data.qrReceiver, "004999999995858");
    const badQr = await h.api("PUT", "/api/admin/credit-admin/settings", { token: root, body: { ...SETTINGS, qrReceiver: "12ab" } });
    assert.equal(badQr.error?.details?.qrReceiver, "INVALID_FORMAT");
    answer = { kind: "OK", slip: good({ receiverBank: null, receiverAccountMasked: null, receiverProxyMasked: "004xxxxxxxx5858" }) };
    const viaQr = await topup(manager, "STANDARD", 500);
    assert.equal(viaQr.data.outcome, "APPROVED", JSON.stringify(viaQr.data.topup));
    const reused = (auto.data.topup.transactionRef)!;
    answer = { kind: "OK", slip: good({ transactionRef: reused }) };
    const twice = await topup(manager, "STANDARD", 500);
    assert.deepEqual(twice.data.topup.verifyReasons, ["DUPLICATE_TRANSACTION"]);
    assert.equal(account().balance, 1000, "the first top-up and the one paid through the QR");
  });

  it("Super Admin adjusts: add, deduct (never below what unpaid bookings hold), set the plan", async () => {
    const { h, root, book, account } = await setup({ credits: 100 });
    await book([house1]);
    const tooMuch = await h.api("POST", "/api/admin/credit-admin/adjustments", { token: root, body: { amount: -90, note: "correction" } });
    assert.equal(tooMuch.status, 409);
    assert.equal(tooMuch.error?.code, "CREDIT_INSUFFICIENT");
    assert.equal((await h.api("POST", "/api/admin/credit-admin/adjustments", { token: root, body: { amount: -80, note: "correction" } })).status, 200);
    assert.deepEqual(account(), { balance: 20, held: 20, plan: "STANDARD" });
    const plan = await h.api<CreditSummaryDto>("PUT", "/api/admin/credit-admin/plan", { token: root, body: { plan: "PREMIUM", note: "trial" } });
    assert.equal(plan.data.plan, "PREMIUM");
    assert.equal((await h.api("POST", "/api/admin/credit-admin/adjustments", { token: root, body: { amount: 0, note: "nothing" } })).status, 422);
  });
});

describe("plan: STANDARD hides Reports, Marketing and Theme", () => {
  it("removes the permissions for everyone but SUPER_ADMIN while the system is on; PREMIUM brings them back", async () => {
    const { h, root, manager } = await setup();
    const perms = async (token: string) => (await h.api<CurrentUserDto>("GET", "/api/auth/me", { token })).data.permissions;
    for (const p of ["reports.view", "marketing.view", "settings.theme"]) assert.ok(!(await perms(manager)).includes(p as never), p);
    assert.ok((await perms(root)).includes("reports.view"), "Super Admin keeps everything");
    assert.equal((await h.api("GET", "/api/admin/reports/revenue?from=2027-01-01&to=2027-01-31", { token: manager })).status, 403);
    await h.api("PUT", "/api/admin/credit-admin/plan", { token: root, body: { plan: "PREMIUM", note: "upgrade" } });
    for (const p of ["reports.view", "marketing.view", "settings.theme"]) assert.ok((await perms(manager)).includes(p as never), p);
    // Switched off: no plan lock at all.
    await h.api("PUT", "/api/admin/credit-admin/plan", { token: root, body: { plan: "STANDARD", note: "back" } });
    await h.api("PUT", "/api/admin/credit-admin/settings", { token: root, body: { ...SETTINGS, enabled: false } });
    assert.ok((await perms(manager)).includes("reports.view"));
  });
});

describe("notices", () => {
  it("low: once a day from 09:00; empty: at 09:00 and 17:00 — e-mail to every back-office user, LINE to those who linked it", async () => {
    const { h, root, managerId } = await setup({ credits: 450 });
    h.emailKey();
    await h.api("PUT", "/api/admin/email/settings", { token: root, body: { enabled: true, guestEnabled: false, fromEmail: "booking@phasakura.test" } });
    const rows = () => h.db.all<{ notification_type: string; recipient: string; idempotency_key: string }>(
      "SELECT notification_type, recipient, idempotency_key FROM email_logs WHERE notification_type LIKE 'CREDIT_%' ORDER BY idempotency_key");
    h.now = new Date("2027-01-10T01:30:00Z"); // 08:30 Bangkok
    await h.app.scheduled(h.env, h.now.getTime());
    assert.equal(rows().length, 0, "before 09:00");
    h.now = new Date("2027-01-10T02:05:00Z"); // 09:05
    await h.app.scheduled(h.env, h.now.getTime());
    await h.app.scheduled(h.env, h.now.getTime());
    const low = rows().filter((r) => r.notification_type === "CREDIT_LOW");
    assert.deepEqual(low.map((r) => r.recipient), [`user:${managerId}`], "every user but Super Admin, once");

    // Used up: twice a day.
    await h.api("POST", "/api/admin/credit-admin/adjustments", { token: root, body: { amount: -440, note: "test" } });
    await h.app.scheduled(h.env, h.now.getTime());
    h.now = new Date("2027-01-10T10:10:00Z"); // 17:10
    await h.app.scheduled(h.env, h.now.getTime());
    await h.app.scheduled(h.env, h.now.getTime());
    const empty = rows().filter((r) => r.notification_type === "CREDIT_EMPTY");
    assert.deepEqual(empty.map((r) => r.idempotency_key.split(":").slice(0, 3).join(":")), ["CREDIT_EMPTY:2027-01-10:1", "CREDIT_EMPTY:2027-01-10:2"]);
  });

  it("My account → LINE: a user links their own LINE with a code from a one-to-one chat", async () => {
    const { h, root, manager, managerId } = await setup();
    h.lineSecrets();
    await h.api("PUT", "/api/admin/line/settings", { token: root, body: { enabled: true, guestEnabled: false, publicButton: false, reminderDaysBefore: 1, reminderTime: "18:00", sendWhenEmpty: false } });
    await h.api("POST", "/api/admin/line/check", { token: root });
    const code = await h.api<{ id: string; code: string; message: string }>("POST", "/api/admin/me/line/link-code", { token: manager, body: { language: "th" } });
    assert.equal(code.status, 201, JSON.stringify(code.body));
    const user = `U${"c".repeat(32)}`;
    const hook = await h.webhook({ events: [{ type: "message", mode: "active", replyToken: "r1", source: { type: "user", userId: user }, message: { type: "text", text: code.data.message } }] });
    assert.equal(hook.status, 200);
    const mine = await h.api<MyLineDto>("GET", "/api/admin/me/line", { token: manager });
    assert.equal(mine.data.linked, true);
    const recipients = (await h.api<CreditRecipientDto[]>("GET", "/api/admin/credit-admin/recipients", { token: root })).data;
    assert.equal(recipients.find((r) => r.userId === managerId)?.lineLinked, true);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM line_recipients")!.n, 0, "not a staff chat");
    const off = await h.api<MyLineDto>("DELETE", "/api/admin/me/line", { token: manager, body: {} });
    assert.equal(off.data.linked, false);
  });
});

async function setupRoot(h: Harness): Promise<string> {
  return h.login(await h.user({ id: `root_x_${++seq}`, roles: ["SUPER_ADMIN"] }));
}
