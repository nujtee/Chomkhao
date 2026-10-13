import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicSiteDto } from "../../src/shared/api-types.ts";
import type { PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import {
  LINK_MESSAGE_PATTERN, type GuestLineLinkDto, type LineConnectionDto, type LineLinkCodeDto, type LineLinkStatusDto, type LineRecipientDto,
  type LineSettingsDto, type NotificationLogDto,
} from "../../src/shared/line-types.ts";
import { packMessages, retryKeyFor, signLineBody, verifyLineSignature } from "../../src/worker/line/line-api.ts";
import {
  checkinDigestBlocks, LINE_TEXT_DICTIONARIES, LineFormatter, type MsgBooking,
} from "../../src/worker/line/line-templates.ts";
import { newLinkCode } from "../../src/worker/services/line.service.ts";
import { Harness } from "../helpers/harness.ts";

// Harness clock: 2027-01-10T03:00Z = 10:00 in Bangkok. Reminder default: 1 day before at 18:00.
let seq = 0;
const key = () => `line-key-${String(++seq).padStart(10, "0")}`;
const GROUP = `C${"a1".repeat(16)}`;
const KITCHEN = `C${"b2".repeat(16)}`;
const OWNER = `U${"c3".repeat(16)}`;
const GUEST_USER = `U${"d4".repeat(16)}`;
const HOUR = 60 * 60_000;

async function staff(h: Harness, perms: string[]) {
  const id = `line_staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

const ADMIN_PERMS = ["settings.line", "notifications.view", "payments.verify", "bookings.view", "bookings.cancel", "slips.view"];

async function setup(opts: { secrets?: boolean } = {}) {
  const h = new Harness({ seed: true });
  if (opts.secrets !== false) h.lineSecrets();
  const admin = await staff(h, ADMIN_PERMS);
  return { h, admin };
}

const SETTINGS = { enabled: true, guestEnabled: false, publicButton: false, reminderDaysBefore: 1, reminderTime: "18:00", sendWhenEmpty: false };

async function enable(h: Harness, admin: string, extra: Partial<typeof SETTINGS> = {}) {
  const r = await h.api<LineSettingsDto>("PUT", "/api/admin/line/settings", { token: admin, body: { ...SETTINGS, ...extra } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
}

async function recipient(h: Harness, admin: string, targetId: string, flags: { checkin?: boolean; food?: boolean; payment?: boolean; booking?: boolean; language?: string; name?: string } = {}) {
  const r = await h.api<LineRecipientDto>("POST", "/api/admin/line/recipients", {
    token: admin,
    body: {
      targetId, name: flags.name ?? `Chat ${targetId.slice(0, 3)}`, language: flags.language ?? "th",
      notifyCheckin: flags.checkin ?? false, notifyFood: flags.food ?? false, notifyPayment: flags.payment ?? false, notifyBooking: flags.booking ?? false,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}

async function book(h: Harness, body: Record<string, unknown> = {}, phone = "0812345678", name = "LINE Guest") {
  const full = {
    adults: 2, children: 1, lang: "th", checkIn: "2027-01-11", checkOut: "2027-01-13", stay: { kind: "UNIT", unitId: "dev_house_01" },
    food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-12", adults: 2, children: 1 }],
    ...body,
  };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body: full });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...full, customer: { name, phone }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

async function pay(h: Harness, token: string, b: PublicBookingDto) {
  const r = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments`, {
    token, body: { amountSatang: b.totalSatang, method: "BANK_TRANSFER", paidAt: "2027-01-10T02:00:00Z" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

type LogRow = { id: string; notification_type: string; status: string; recipient: string; attempts: number; max_attempts: number; last_error: string | null; scheduled_for: string; next_attempt_at: string | null; language_code: string | null };
const logs = (h: Harness) => h.db.all<LogRow>("SELECT * FROM notification_logs ORDER BY created_at, notification_type, recipient");
const dispatch = (h: Harness) => h.app.scheduled(h.env, Date.parse("2027-01-10T03:01:00Z"));

const textMessage = (source: Record<string, string>, text: string, extra: Record<string, unknown> = {}) => ({
  destination: "Ubot",
  events: [{ type: "message", mode: "active", timestamp: 1, replyToken: `reply-${++seq}`, webhookEventId: `ev-${seq}`, deliveryContext: { isRedelivery: false }, source, message: { type: "text", id: "1", text }, ...extra }],
});

// =============================================================================== building blocks

describe("LINE building blocks", () => {
  it("retry key: a stable UUID per notification id", () => {
    const k = retryKeyFor("0123456789abcdef0123456789abcdef");
    assert.match(k, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(k, retryKeyFor("0123456789abcdef0123456789abcdef"));
    const uuid = crypto.randomUUID();
    assert.equal(retryKeyFor(uuid), uuid, "a v4 UUID id is its own key");
    assert.throws(() => retryKeyFor("not-hex"));
  });

  it("webhook signature: HMAC-SHA256 of the raw body, constant-time compare", async () => {
    const body = JSON.stringify({ events: [] });
    const sig = await signLineBody("secret", body);
    const bytes = new TextEncoder().encode(body);
    assert.equal(await verifyLineSignature("secret", bytes, sig), true);
    assert.equal(await verifyLineSignature("other", bytes, sig), false);
    assert.equal(await verifyLineSignature("secret", new TextEncoder().encode(`${body} `), sig), false);
    assert.equal(await verifyLineSignature("secret", bytes, null), false);
    assert.equal(await verifyLineSignature("secret", bytes, "not base64!"), false);
  });

  it("link codes: 8 unambiguous characters; only 'LINK XXXX-XXXX' counts", () => {
    for (let i = 0; i < 50; i++) assert.match(newLinkCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(LINK_MESSAGE_PATTERN.test("BK-20270110-ABCD\nLINK ABCD-EFGH"));
    assert.ok(LINK_MESSAGE_PATTERN.test("link: abcd-efgh"));
    assert.equal(LINK_MESSAGE_PATTERN.test("STRENGTH and ABCDEFGH"), false, "ordinary chat is ignored");
    assert.equal(LINK_MESSAGE_PATTERN.test("LINK ABCD-EFG1"), false);
  });

  it("packs blocks into ≤ 5 messages of ≤ 5,000 characters and says how many were left out", () => {
    const blocks = Array.from({ length: 40 }, (_, i) => `${i}:${"x".repeat(900)}`);
    const msgs = packMessages(blocks, (n) => `+${n} more`);
    assert.equal(msgs.length, 5);
    for (const m of msgs) assert.ok(m.text.length <= 5000);
    assert.match(msgs[4]!.text, /\+\d+ more$/);
    assert.deepEqual(packMessages(["a", "b"], () => "x").map((m) => m.text), ["a\n\nb"]);
  });

  it("templates: every spec §47 field, in TH / EN / ZH-CN, same keys everywhere", () => {
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v !== null ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
    assert.deepEqual(keys(LINE_TEXT_DICTIONARIES.en), keys(LINE_TEXT_DICTIONARIES.th));
    assert.deepEqual(keys(LINE_TEXT_DICTIONARIES["zh-CN"]), keys(LINE_TEXT_DICTIONARIES.th));
    const b: MsgBooking = {
      code: "BK-20270111-ABCD", customerName: "Somchai", checkIn: "2027-01-11", checkOut: "2027-01-13", nights: 2, itemType: "OWN_TENT",
      itemName: "Camping", tents: 2, adults: 3, children: 1, bookingStatus: "CONFIRMED", paymentStatus: "VERIFIED", totalSatang: 120000,
      food: [{ date: "2027-01-11", category: "Dinner", time: "18:30", dish: "Dinner A", quantity: 4 }],
    };
    const expect: Record<string, RegExp[]> = {
      th: [/Booking ID: BK-20270111-ABCD/, /ผู้จอง: Somchai/, /เช็กอิน: /, /เช็กเอาต์: .*\(2 คืน\)/, /ลานกางเต็นท์: 2 เต็นท์/, /ผู้ใหญ่ 3 · เด็ก 1/, /Dinner A ×4/, /การชำระเงิน: ชำระแล้ว/, /2570/],
      en: [/Booking ID: BK-20270111-ABCD/, /Customer: Somchai/, /Check-in: /, /Check-out: .*2 night/, /Camping: 2 tent/, /3 adult/, /Dinner A ×4/, /Payment: Paid/],
      "zh-CN": [/预订编号: BK-20270111-ABCD/, /预订人: Somchai/, /入住: /, /退房: /, /露营: 2 顶帐篷/, /成人 3 · 儿童 1/, /Dinner A ×4/, /付款: 已付款/],
    };
    for (const [lang, patterns] of Object.entries(expect)) {
      const text = checkinDigestBlocks(new LineFormatter(lang), { date: "2027-01-11", daysBefore: 1, siteName: "Site", bookings: [b], link: null }).join("\n");
      for (const p of patterns) assert.match(text, p, `${lang}: ${p}`);
    }
    const house = new LineFormatter("en").bookingBlock({ ...b, itemType: "HOUSE", itemName: "House 01", tents: 0, bookingStatus: "PENDING", paymentStatus: "UNPAID" });
    assert.match(house, /House\/VIP: House 01/);
    assert.match(house, /Payment: Unpaid · not confirmed yet/);
  });
});

// =============================================================================== settings & recipients

describe("LINE settings (admin)", () => {
  it("needs settings.line; secrets are never returned; enabling needs the token", async () => {
    const { h, admin } = await setup({ secrets: false });
    const viewer = await staff(h, ["reports.view"]);
    assert.equal((await h.api("GET", "/api/admin/line/settings", { token: viewer })).status, 403);
    assert.equal((await h.api("GET", "/api/admin/line/settings")).status, 401);

    const blocked = await h.api("PUT", "/api/admin/line/settings", { token: admin, body: SETTINGS });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.error?.details?.enabled, "LINE_TOKEN_MISSING");

    h.lineSecrets("super-secret-token-value", "super-secret-channel");
    const s = await h.api<LineSettingsDto>("GET", "/api/admin/line/settings", { token: admin });
    assert.equal(s.data.tokenConfigured, true);
    assert.equal(s.data.secretConfigured, true);
    assert.equal(s.data.webhookUrl, "https://phasakura.test/api/line/webhook");
    assert.doesNotMatch(JSON.stringify(s.body), /super-secret/);

    const saved = await enable(h, admin, { reminderTime: "17:30", reminderDaysBefore: 2 });
    assert.equal(saved.enabled, true);
    assert.equal(saved.reminderTime, "17:30");
    assert.equal(h.audits("UPDATE_LINE_SETTINGS").length, 1);

    const bad = await h.api("PUT", "/api/admin/line/settings", { token: admin, body: { ...SETTINGS, reminderTime: "24:00", reminderDaysBefore: 9, extra: 1 } });
    assert.deepEqual(bad.error?.details, { reminderTime: "INVALID_FORMAT", reminderDaysBefore: "OUT_OF_RANGE", extra: "UNKNOWN_FIELD" });
    // Guest updates need the webhook secret and a checked connection (for the chat link).
    const guest = await h.api("PUT", "/api/admin/line/settings", { token: admin, body: { ...SETTINGS, guestEnabled: true } });
    assert.equal(guest.error?.details?.guestEnabled, "LINE_NOT_CHECKED");
    const button = await h.api("PUT", "/api/admin/line/settings", { token: admin, body: { ...SETTINGS, publicButton: true } });
    assert.equal(button.error?.details?.publicButton, "LINE_URL_MISSING");
  });

  it("check connection reads the bot profile + quota and stores the Basic ID; a bad token is reported", async () => {
    const { h, admin } = await setup();
    const c = await h.api<LineConnectionDto>("POST", "/api/admin/line/check", { token: admin, body: {} });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.deepEqual(c.data, { ok: true, basicId: "@phasakura", displayName: "Phasakura Test OA", quotaLimit: 300, quotaUsed: 12 });
    const s = await h.api<LineSettingsDto>("GET", "/api/admin/line/settings", { token: admin });
    assert.equal(s.data.bot.basicId, "@phasakura");
    assert.equal(s.data.addFriendUrl, "https://line.me/R/ti/p/@phasakura");
    h.line.botStatus = 401;
    assert.equal((await h.api("POST", "/api/admin/line/check", { token: admin, body: {} })).error?.code, "LINE_TOKEN_INVALID");
    h.lineSecrets(null);
    assert.equal((await h.api("POST", "/api/admin/line/check", { token: admin, body: {} })).error?.code, "LINE_TOKEN_MISSING");
  });

  it("recipients: manual id validated, masked in the API, update / delete audited", async () => {
    const { h, admin } = await setup();
    const bad = await h.api("POST", "/api/admin/line/recipients", { token: admin, body: { targetId: "Cnope", name: "x", language: "th" } });
    assert.equal(bad.error?.details?.targetId, "INVALID_FORMAT");
    const r = await recipient(h, admin, GROUP, { checkin: true, name: "Front desk" });
    assert.equal(r.kind, "GROUP");
    assert.equal(r.targetMasked, `${GROUP.slice(0, 5)}…${GROUP.slice(-4)}`);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(GROUP));
    const dup = await h.api("POST", "/api/admin/line/recipients", { token: admin, body: { targetId: GROUP, name: "x", language: "th" } });
    assert.equal(dup.error?.code, "LINE_RECIPIENT_EXISTS");

    const upd = await h.api<LineRecipientDto>("PATCH", `/api/admin/line/recipients/${r.id}`, {
      token: admin, body: { name: "Kitchen", language: "en", notifyCheckin: false, notifyFood: true, notifyPayment: false, active: true },
    });
    assert.equal(upd.data.name, "Kitchen");
    assert.equal(upd.data.notifyFood, true);
    assert.equal((await h.api("DELETE", `/api/admin/line/recipients/${r.id}`, { token: admin })).status, 200);
    assert.deepEqual((await h.api<LineRecipientDto[]>("GET", "/api/admin/line/recipients", { token: admin })).data, []);
    assert.equal(h.audits("CREATE_LINE_RECIPIENT").length, 1);
    assert.equal(h.audits("UPDATE_LINE_RECIPIENT").length, 1);
    assert.equal(h.audits("DELETE_LINE_RECIPIENT").length, 1);
    // Re-adding a deleted chat brings the same row back.
    const again = await recipient(h, admin, GROUP, { name: "Again" });
    assert.equal(again.id, r.id);
  });
});

// =============================================================================== pairing & webhook

describe("LINE webhook", () => {
  it("rejects a missing / wrong signature (logged) and works without browser CSRF headers", async () => {
    const { h } = await setup();
    assert.equal((await h.webhook({ events: [] }, { signature: null })).status, 401);
    assert.equal((await h.webhook({ events: [] }, { signature: await signLineBody("wrong", "{}") })).status, 401);
    assert.equal(h.events("LINE_WEBHOOK_REJECTED").length, 2);
    const ok = await h.webhook({ destination: "Ubot", events: [] }); // LINE console "Verify"
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    h.lineSecrets("t", null);
    assert.equal((await h.webhook({ events: [] }, { signature: "x" })).status, 503);
  });

  it("pairs a staff group with a one-time code; codes are single-use and expire", async () => {
    const { h, admin } = await setup();
    const code = await h.api<LineLinkCodeDto>("POST", "/api/admin/line/link-codes", { token: admin, body: { name: "Front desk", language: "en" } });
    assert.equal(code.status, 201, JSON.stringify(code.body));
    assert.equal(code.data.message, `LINK ${code.data.code}`);
    assert.equal(h.db.all("SELECT code_hash FROM line_link_codes").filter((r) => JSON.stringify(r).includes(code.data.code)).length, 0, "only a hash is stored");
    assert.equal((await h.api<LineLinkStatusDto>("GET", `/api/admin/line/link-codes/${code.data.id}`, { token: admin })).data.status, "PENDING");

    // Ordinary chat in the group: ignored, no reply.
    await h.webhook(textMessage({ type: "group", groupId: GROUP, userId: OWNER }, "hello everyone"));
    assert.equal(h.line.replies.length, 0);

    const res = await h.webhook(textMessage({ type: "group", groupId: GROUP, userId: OWNER }, `please ${code.data.message.toLowerCase()} thanks`));
    assert.equal(res.body.data?.handled, 1);
    const status = await h.api<LineLinkStatusDto>("GET", `/api/admin/line/link-codes/${code.data.id}`, { token: admin });
    assert.equal(status.data.status, "LINKED");
    assert.equal(status.data.recipient?.kind, "GROUP");
    assert.equal(status.data.recipient?.name, "Front desk");
    assert.equal(status.data.recipient?.language, "en");
    assert.match(h.line.replies[0]!.texts[0]!, /Connected: this chat \(“Front desk”\)/);
    assert.equal(h.audits("LINK_LINE_RECIPIENT").length, 1);

    // Reused code → invalid reply, nothing new.
    await h.webhook(textMessage({ type: "user", userId: OWNER }, code.data.message));
    assert.match(h.line.replies[1]!.texts[0]!, /Invalid or expired code/);
    assert.equal(h.db.all("SELECT id FROM line_recipients").length, 1);

    // Expired code.
    const late = await h.api<LineLinkCodeDto>("POST", "/api/admin/line/link-codes", { token: admin, body: { name: "Owner", language: "th" } });
    h.advance(31 * 60_000);
    await h.webhook(textMessage({ type: "user", userId: OWNER }, late.data.message));
    assert.equal(h.db.all("SELECT id FROM line_recipients").length, 1);
    assert.equal((await h.api<LineLinkStatusDto>("GET", `/api/admin/line/link-codes/${late.data.id}`, { token: admin })).data.status, "EXPIRED");

    // The bot is removed from the group → recipient stops.
    await h.webhook({ events: [{ type: "leave", mode: "active", timestamp: 2, source: { type: "group", groupId: GROUP } }] });
    assert.equal(h.db.get<{ active: number }>("SELECT active FROM line_recipients")!.active, 0);
  });

  it("codes need the channel secret (webhook) and settings.line", async () => {
    const { h, admin } = await setup({ secrets: false });
    h.lineSecrets("token", null);
    assert.equal((await h.api("POST", "/api/admin/line/link-codes", { token: admin, body: { name: "x", language: "th" } })).error?.code, "LINE_SECRET_MISSING");
    const viewer = await staff(h, ["notifications.view"]);
    assert.equal((await h.api("POST", "/api/admin/line/link-codes", { token: viewer, body: { name: "x", language: "th" } })).status, 403);
  });
});

// =============================================================================== outbox & delivery

describe("LINE notifications: outbox, delivery, retry, idempotency", () => {
  it("nothing is queued while LINE is off", async () => {
    const { h, admin } = await setup();
    await recipient(h, admin, GROUP, { payment: true, food: true });
    await pay(h, admin, await book(h));
    assert.equal(logs(h).length, 0);
  });

  it("several admins, each linked with their own code, all get new bookings and payments by default", async () => {
    const { h, admin } = await setup();
    await enable(h, admin);
    await h.api("POST", "/api/admin/line/check", { token: admin, body: {} }); // stores the bot's Basic ID
    const admins = [["Owner", OWNER], ["Admin Aom", `U${"e5".repeat(16)}`], ["Admin Bee", `U${"f6".repeat(16)}`]] as const;
    for (const [name, user] of admins) {
      const code = await h.api<LineLinkCodeDto>("POST", "/api/admin/line/link-codes", { token: admin, body: { name, language: "th" } });
      assert.equal(code.status, 201, JSON.stringify(code.body));
      // Scanned on a phone: opens the chat with the Official Account, message filled in.
      assert.equal(code.data.url, `https://line.me/R/oaMessage/@phasakura/?${encodeURIComponent(code.data.message)}`);
      await h.webhook(textMessage({ type: "user", userId: user }, code.data.message));
      const linked = await h.api<LineLinkStatusDto>("GET", `/api/admin/line/link-codes/${code.data.id}`, { token: admin });
      assert.equal(linked.data.status, "LINKED");
      const r = linked.data.recipient!;
      assert.deepEqual([r.name, r.notifyBooking, r.notifyPayment, r.notifyCheckin, r.notifyFood], [name, true, true, true, false]);
    }
    const list = await h.api<LineRecipientDto[]>("GET", "/api/admin/line/recipients", { token: admin });
    assert.equal(list.data.length, 3);

    const b = await book(h);
    await pay(h, admin, b);
    await dispatch(h);
    for (const r of list.data) {
      // The outbox names the recipient row ("staff:<id>"), never the LINE id.
      const types = logs(h).filter((l) => l.recipient === `staff:${r.id}`).map((l) => [l.notification_type, l.status]).sort();
      assert.deepEqual(types, [["NEW_BOOKING", "SENT"], ["PAYMENT_CONFIRMED", "SENT"]], r.name);
    }
    for (const [, user] of admins) assert.equal(h.line.pushes.filter((p) => p.to === user).length, 2, user);
  });

  it("payment confirmed → payment + kitchen notices in the same transaction; delivered once with a stable retry key", async () => {
    const { h, admin } = await setup();
    await enable(h, admin);
    await recipient(h, admin, GROUP, { payment: true, name: "Owners" });
    await recipient(h, admin, KITCHEN, { food: true, language: "en", name: "Kitchen" });
    await recipient(h, admin, OWNER, { checkin: true }); // wants neither
    const b = await book(h);
    await pay(h, admin, b);

    assert.deepEqual(logs(h).map((l) => [l.notification_type, l.status]).sort(), [["FOOD_ORDER", "PENDING"], ["PAYMENT_CONFIRMED", "PENDING"]]);
    await pay(h, admin, b).catch(() => undefined); // second attempt is refused by the payment rules; no duplicate rows
    assert.equal(logs(h).length, 2);

    await dispatch(h);
    assert.equal(h.line.pushes.length, 2);
    const toGroup = h.line.pushes.find((p) => p.to === GROUP)!;
    assert.equal(toGroup.authorization, "Bearer test-channel-token");
    assert.match(toGroup.retryKey!, /^[0-9a-f-]{36}$/);
    assert.match(toGroup.texts[0]!, /ชำระเงินแล้ว — การจองยืนยัน/);
    assert.match(toGroup.texts[0]!, new RegExp(b.bookingCode));
    assert.match(toGroup.texts[0]!, /ผู้จอง: LINE Guest/);
    assert.match(toGroup.texts[0]!, /ชำระโดย: โอนเงิน/);
    const toKitchen = h.line.pushes.find((p) => p.to === KITCHEN)!;
    assert.match(toKitchen.texts[0]!, /New food order/);
    assert.match(toKitchen.texts[0]!, /Dinner 18:30 — อาหารเย็น A ×3/);
    assert.ok(logs(h).every((l) => l.status === "SENT"));

    await dispatch(h);
    assert.equal(h.line.pushes.length, 2, "sent once");
  });

  it("slip review notice waits for auto-verification: skipped when the slip is verified, sent when it is not", async () => {
    const { h, admin } = await setup();
    await enable(h, admin);
    await recipient(h, admin, GROUP, { payment: true });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 2, 0, 0, 0, 0, 0, 0, 0]);
    const b = await book(h);
    const up = await h.slip(b.bookingCode, "0812345678", { bytes: png, name: "slip.png", type: "image/png" });
    assert.equal(up.status, 201, JSON.stringify(up));
    const review = logs(h).find((l) => l.notification_type === "PAYMENT_REVIEW")!;
    assert.equal(review.scheduled_for, "2027-01-10T03:02:00.000Z", "two minutes later");
    await dispatch(h);
    assert.equal(h.line.pushes.length, 0, "not due yet");
    h.advance(3 * 60_000);
    await dispatch(h);
    assert.equal(h.line.pushes.length, 1);
    assert.match(h.line.pushes[0]!.texts[0]!, /สลิปรอตรวจสอบ/);

    // Same flow, but staff verify before the notice is due → it is skipped, the confirmation goes out.
    const b2 = await book(h, { stay: { kind: "UNIT", unitId: "dev_house_02" }, food: [] }, "0899999999");
    const up2 = await h.slip(b2.bookingCode, "0899999999", { bytes: new Uint8Array([...png, 1]), name: "s.png", type: "image/png" });
    assert.equal(up2.status, 201, JSON.stringify(up2));
    const pid = h.db.get<{ id: string }>("SELECT p.id FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.booking_code = ?", b2.bookingCode)!.id;
    assert.equal((await h.api("POST", `/api/admin/payments/${pid}/verify`, { token: admin, body: {} })).status, 200);
    h.advance(3 * 60_000);
    await dispatch(h);
    const l2 = logs(h).filter((l) => l.recipient === `staff:${h.db.get<{ id: string }>("SELECT id FROM line_recipients")!.id}`);
    assert.deepEqual(l2.map((l) => [l.notification_type, l.status, l.last_error]).slice(1).sort(), [
      ["PAYMENT_CONFIRMED", "SENT", null], ["PAYMENT_REVIEW", "CANCELLED", "NOT_RELEVANT"],
    ]);
  });

  it("retries temporary failures with backoff and the same retry key; permanent errors fail; 409 = already delivered", async () => {
    const { h, admin } = await setup();
    await enable(h, admin);
    await recipient(h, admin, GROUP, { payment: true });
    await pay(h, admin, await book(h, { food: [] }));
    const id = logs(h)[0]!.id;

    h.line.nextPush.push(500);
    await dispatch(h);
    let row = logs(h)[0]!;
    assert.equal(row.status, "PENDING");
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, "HTTP_500: error 500");
    assert.equal(row.next_attempt_at, "2027-01-10T03:01:00.000Z", "retry after 1 minute");

    await dispatch(h);
    assert.equal(logs(h)[0]!.attempts, 1, "not before the backoff");
    h.advance(60_000);
    h.line.nextPush.push(202); // LINE took it, but our request timed out
    await dispatch(h);
    row = logs(h)[0]!;
    assert.equal(row.status, "PENDING");
    assert.equal(row.last_error, "TIMEOUT");
    h.advance(5 * 60_000);
    await dispatch(h);
    row = logs(h)[0]!;
    assert.equal(row.status, "SENT", "LINE answered 409 for the same retry key → delivered exactly once");
    assert.equal(h.line.pushes.length, 1);
    assert.equal(retryKeyFor(id), h.line.pushes[0]!.retryKey);

    // A SENT row can never go back (DB trigger) — a retry cannot send twice.
    assert.throws(() => h.db.run("UPDATE notification_logs SET status = 'PENDING' WHERE id = ?", id), /NOTIFICATION_SENT_FINAL/);
    assert.equal((await h.api("POST", `/api/admin/notifications/${id}/retry`, { token: admin, body: {} })).error?.code, "NOTIFICATION_NOT_RETRYABLE");

    // Permanent error (bad recipient) → FAILED immediately; staff retry → delivered.
    await pay(h, admin, await book(h, { stay: { kind: "UNIT", unitId: "dev_house_02" }, food: [] }, "0811111111"));
    h.line.nextPush.push(400);
    await dispatch(h);
    const failed = logs(h).find((l) => l.status === "FAILED")!;
    assert.match(failed.last_error!, /^HTTP_400/);
    const retried = await h.api<NotificationLogDto>("POST", `/api/admin/notifications/${failed.id}/retry`, { token: admin, body: {} });
    assert.equal(retried.data.status, "PENDING");
    assert.equal(retried.data.maxAttempts, 4);
    await dispatch(h);
    assert.equal(logs(h).find((l) => l.id === failed.id)!.status, "SENT");
    assert.equal(h.audits("RETRY_NOTIFICATION").length, 1);
  });

  it("gives up after 5 attempts; parallel runs never send the same row twice", async () => {
    const { h, admin } = await setup();
    await enable(h, admin);
    await recipient(h, admin, GROUP, { payment: true });
    await pay(h, admin, await book(h, { food: [] }));
    for (let i = 0; i < 5; i++) {
      h.line.nextPush.push(i % 2 ? 429 : "network");
      await dispatch(h);
      h.advance(2 * HOUR);
    }
    const row = logs(h)[0]!;
    assert.equal(row.status, "FAILED");
    assert.equal(row.attempts, 5);
    assert.match(row.last_error!, /NETWORK|HTTP_429/);

    const fresh = await staff(h, ADMIN_PERMS); // long pause: new session
    await pay(h, fresh, await book(h, { stay: { kind: "UNIT", unitId: "dev_house_02" }, food: [] }, "0822222222"));
    await Promise.all([dispatch(h), dispatch(h), dispatch(h)]);
    assert.equal(h.line.pushes.length, 1);
  });

  it("deactivated / opted-out recipients and LINE switched off cancel pending notices", async () => {
    const { h, admin } = await setup();
    await enable(h, admin);
    const r = await recipient(h, admin, GROUP, { payment: true });
    await pay(h, admin, await book(h, { food: [] }));
    await h.api("PATCH", `/api/admin/line/recipients/${r.id}`, { token: admin, body: { name: "x", language: "th", notifyCheckin: false, notifyFood: false, notifyPayment: false, active: true } });
    await dispatch(h);
    assert.equal(logs(h)[0]!.last_error, "RECIPIENT_OPTED_OUT");

    await h.api("PATCH", `/api/admin/line/recipients/${r.id}`, { token: admin, body: { name: "x", language: "th", notifyCheckin: false, notifyFood: false, notifyPayment: true, active: true } });
    await pay(h, admin, await book(h, { stay: { kind: "UNIT", unitId: "dev_house_02" }, food: [] }, "0833333333"));
    await enable(h, admin, { enabled: false });
    await dispatch(h);
    assert.equal(logs(h)[1]!.last_error, "LINE_DISABLED");
    assert.equal(h.line.pushes.length, 0);
  });

  it("cancelling a confirmed booking with food tells the kitchen", async () => {
    const { h, admin } = await setup();
    await enable(h, admin);
    await recipient(h, admin, KITCHEN, { food: true });
    const b = await book(h);
    await h.api("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: admin, body: { reason: "test" } }); // pending: no notice
    assert.equal(logs(h).length, 0);
    const c = await book(h, { stay: { kind: "UNIT", unitId: "dev_house_02" } }, "0844444444");
    await pay(h, admin, c);
    await dispatch(h);
    h.advance(60_000);
    assert.equal((await h.api("POST", `/api/admin/bookings/${c.bookingCode}/cancel`, { token: admin, body: { reason: "guest asked" } })).status, 200);
    assert.deepEqual(logs(h).map((l) => l.notification_type), ["FOOD_ORDER", "FOOD_CANCELLED"]);
    await dispatch(h);
    assert.equal(h.line.pushes.length, 2);
    assert.match(h.line.pushes[1]!.texts[0]!, /ยกเลิกอาหาร/);
    assert.match(h.line.pushes[1]!.texts[0]!, /อาหารเย็น A ×3/);

    // Confirmed and cancelled before anything went out: the kitchen hears nothing at all.
    const d = await book(h, { stay: { kind: "UNIT", unitId: "dev_vip_01" } }, "0855555555");
    await pay(h, admin, d);
    h.advance(60_000);
    await h.api("POST", `/api/admin/bookings/${d.bookingCode}/cancel`, { token: admin, body: { reason: "mistake" } });
    await dispatch(h);
    assert.equal(h.line.pushes.length, 2);
    assert.deepEqual(logs(h).slice(2).map((l) => [l.notification_type, l.last_error]), [["FOOD_ORDER", "NOT_RELEVANT"], ["FOOD_CANCELLED", "NOT_RELEVANT"]]);
  });
});

// =============================================================================== daily digests

describe("LINE daily digests (spec §47: 1 day before, 18:00)", () => {
  it("plans once after the configured local time; check-in digest lists every field; kitchen digest sums portions", async () => {
    const { h, admin } = await setup();
    await enable(h, admin);
    await recipient(h, admin, GROUP, { checkin: true, name: "Front" });
    await recipient(h, admin, KITCHEN, { food: true, language: "zh-CN", name: "Kitchen" });
    h.now = new Date("2027-01-10T10:50:00.000Z"); // 17:50 Bangkok: the held booking is still within its hold at 18:00
    const fresh = await staff(h, ADMIN_PERMS);
    const paid = await book(h, { food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-11", adults: 2, children: 0 }], adults: 2, children: 0 }, "0811111111", "Paid Guest");
    await pay(h, fresh, paid);
    await book(h, { stay: { kind: "CAMPING", tents: 2 }, adults: 3, children: 0, food: [{ optionId: "dev_food_dinner_a", serviceDate: "2027-01-11", adults: 3, children: 0 }] }, "0822222222", "Held Guest");
    h.db.run("DELETE FROM notification_logs");
    await h.app.scheduled(h.env, h.now.getTime()); // 17:50 local
    assert.equal(logs(h).length, 0, "not before 18:00");
    h.now = new Date("2027-01-10T11:00:00.000Z"); // 18:00 Bangkok
    await h.app.scheduled(h.env, h.now.getTime());
    await h.app.scheduled(h.env, h.now.getTime());
    assert.deepEqual(logs(h).map((l) => [l.notification_type, l.status]).sort(), [["CHECKIN_DIGEST", "SENT"], ["FOOD_DIGEST", "SENT"]]);

    const front = h.line.pushes.find((p) => p.to === GROUP)!.texts.join("\n");
    assert.match(front, /📅 เช็กอินพรุ่งนี้: /);
    assert.match(front, /2 การจอง/);
    for (const p of [/Booking ID: BK-/, /ผู้จอง: Paid Guest/, /ผู้จอง: Held Guest/, /เช็กเอาต์: /, /บ้านพัก\/VIP: /, /ลานกางเต็นท์: 2 เต็นท์/, /ผู้ใหญ่ 3 · เด็ก 0/, /อาหารเย็น 18:30 — อาหารเย็น A ×3/, /การชำระเงิน: ชำระแล้ว/, /ยังไม่ชำระ · การจองยังไม่ยืนยัน/]) {
      assert.match(front, p);
    }
    const kitchen = h.line.pushes.find((p) => p.to === KITCHEN)!.texts.join("\n");
    assert.match(kitchen, /明天需准备的餐饮/);
    assert.match(kitchen, /晚餐 · 18:30\n• อาหารเย็น A ×2 （待付款 \+3）/);

    // Next day, nothing to report → skipped (unless "send when empty").
    h.now = new Date("2027-01-11T11:05:00.000Z");
    await h.app.scheduled(h.env, h.now.getTime());
    const next = logs(h).filter((l) => l.scheduled_for.startsWith("2027-01-11"));
    assert.deepEqual(next.map((l) => [l.notification_type, l.status, l.last_error]).sort(), [["CHECKIN_DIGEST", "CANCELLED", "EMPTY"], ["FOOD_DIGEST", "SENT", null]]);
    assert.match(h.line.pushes.at(-1)!.texts.join("\n"), /早餐 · 08:00\n• อาหารเช้า A ×2/, "breakfast included with the house");
    await enable(h, await staff(h, ADMIN_PERMS), { sendWhenEmpty: true, reminderDaysBefore: 2, reminderTime: "18:30" });
    h.now = new Date("2027-01-11T11:31:00.000Z");
    await h.app.scheduled(h.env, h.now.getTime());
    const front2 = h.line.pushes.filter((p) => p.to === GROUP).at(-1)!.texts.join("\n");
    // Same formatter as the templates: the exact short weekday ("พ." / "พุธ") depends on the runtime's ICU data.
    const thDate = new Intl.DateTimeFormat("th", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date("2027-01-13T00:00:00Z"));
    assert.ok(front2.includes(`เช็กอินอีก 2 วัน: ${thDate}`), front2);
    assert.match(thDate, /13 ม\.ค\. 2570/);
    assert.match(front2, /ไม่มีการเช็กอิน/);
  });
});

// =============================================================================== guests

describe("LINE updates for guests (opt-in per booking)", () => {
  async function guestReady() {
    const { h, admin } = await setup();
    await h.api("POST", "/api/admin/line/check", { token: admin, body: {} });
    await enable(h, admin, { guestEnabled: true });
    return { h, admin };
  }

  it("links from the booking page via the Official Account chat, then confirms and reminds in the booking's language", async () => {
    const { h, admin } = await guestReady();
    const b = await book(h, { lang: "en" }, "0812345678", "Anna");
    assert.deepEqual(b.lineUpdates, { available: true, linked: false });

    const wrongPhone = await h.api("POST", "/api/public/bookings/line-link", { body: { bookingCode: b.bookingCode, phone: "0800000000" } });
    assert.equal(wrongPhone.status, 404);
    const link = await h.api<GuestLineLinkDto>("POST", "/api/public/bookings/line-link", { body: { bookingCode: b.bookingCode, phone: "0812345678" } });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.ok(link.data.url.startsWith("https://line.me/R/oaMessage/@phasakura/?"));
    assert.equal(decodeURIComponent(link.data.url.split("?")[1]!), link.data.message);
    assert.match(link.data.message, new RegExp(`${b.bookingCode}\\nLINK ${link.data.code}`));

    // From a group: refused politely, code not used.
    await h.webhook(textMessage({ type: "group", groupId: GROUP, userId: GUEST_USER }, link.data.message));
    assert.match(h.line.replies[0]!.texts[0]!, /ส่งรหัสนี้ในแชตส่วนตัว|one-to-one|一对一/);
    await h.webhook(textMessage({ type: "user", userId: GUEST_USER }, link.data.message));
    assert.match(h.line.replies[1]!.texts[0]!, new RegExp(`Booking ${b.bookingCode} is now linked to LINE`));
    const lookup = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: "0812345678" } });
    assert.deepEqual(lookup.data.lineUpdates, { available: true, linked: true });
    assert.equal(h.events("LINE_GUEST_LINKED").length, 1);

    await pay(h, admin, b);
    await dispatch(h);
    const confirmed = h.line.pushes.find((p) => p.to === GUEST_USER)!.texts[0]!;
    assert.match(confirmed, /Your booking is confirmed/);
    assert.match(confirmed, /Thank you, Anna/);
    assert.doesNotMatch(confirmed, /Customer:/, "the guest's own message does not repeat the customer line");
    const row = logs(h).find((l) => l.notification_type === "GUEST_CONFIRMED")!;
    assert.equal(row.recipient, `guest:${h.db.get<{ id: string }>("SELECT id FROM bookings WHERE booking_code = ?", b.bookingCode)!.id}`);
    assert.doesNotMatch(JSON.stringify(logs(h)), new RegExp(GUEST_USER), "the log never stores the guest's LINE id");

    h.now = new Date("2027-01-10T11:01:00.000Z");
    await h.app.scheduled(h.env, h.now.getTime());
    const reminder = h.line.pushes.filter((p) => p.to === GUEST_USER)[1]!.texts[0]!;
    assert.match(reminder, /Reminder: check-in tomorrow/);
    assert.match(reminder, /Hello Anna/);
    assert.match(reminder, /Payment: Paid/);
  });

  it("guest can unlink; blocking the account unlinks; links are purged 30 days after check-out", async () => {
    const { h, admin } = await guestReady();
    const b = await book(h);
    const link = await h.api<GuestLineLinkDto>("POST", "/api/public/bookings/line-link", { body: { bookingCode: b.bookingCode, phone: "0812345678" } });
    await h.webhook(textMessage({ type: "user", userId: GUEST_USER }, link.data.message));
    await pay(h, admin, b);
    const off = await h.api("POST", "/api/public/bookings/line-unlink", { body: { bookingCode: b.bookingCode, phone: "0812345678" } });
    assert.deepEqual(off.data, { available: true, linked: false });
    assert.equal(logs(h).find((l) => l.notification_type === "GUEST_CONFIRMED")!.last_error, "NOT_LINKED");

    const c = await book(h, { stay: { kind: "UNIT", unitId: "dev_house_02" } }, "0899999999");
    const l2 = await h.api<GuestLineLinkDto>("POST", "/api/public/bookings/line-link", { body: { bookingCode: c.bookingCode, phone: "0899999999" } });
    await h.webhook(textMessage({ type: "user", userId: GUEST_USER }, l2.data.message));
    assert.equal(h.db.all("SELECT * FROM booking_line_links").length, 1);
    await h.webhook({ events: [{ type: "unfollow", mode: "active", timestamp: 3, source: { type: "user", userId: GUEST_USER } }] });
    assert.equal(h.db.all("SELECT * FROM booking_line_links").length, 0);

    const l3 = await h.api<GuestLineLinkDto>("POST", "/api/public/bookings/line-link", { body: { bookingCode: c.bookingCode, phone: "0899999999" } });
    await h.webhook(textMessage({ type: "user", userId: GUEST_USER }, l3.data.message));
    h.now = new Date("2027-02-13T03:30:00.000Z"); // check-out 2027-01-13 + 31 days
    await h.app.scheduled(h.env, h.now.getTime());
    assert.equal(h.db.all("SELECT * FROM booking_line_links").length, 0);
    assert.equal(h.db.all("SELECT * FROM line_link_codes").length, 0, "used / expired codes are purged too");
  });

  it("not offered when guest updates are off; rate-limited per booking", async () => {
    const { h, admin } = await setup();
    await enable(h, admin);
    const b = await book(h);
    assert.deepEqual(b.lineUpdates, { available: false, linked: false });
    assert.equal((await h.api("POST", "/api/public/bookings/line-link", { body: { bookingCode: b.bookingCode, phone: "0812345678" } })).error?.code, "LINE_UNAVAILABLE");
    await h.api("POST", "/api/admin/line/check", { token: admin, body: {} });
    await enable(h, admin, { guestEnabled: true });
    for (let i = 0; i < 5; i++) assert.equal((await h.api("POST", "/api/public/bookings/line-link", { body: { bookingCode: b.bookingCode, phone: "0812345678" } })).status, 200);
    assert.equal((await h.api("POST", "/api/public/bookings/line-link", { body: { bookingCode: b.bookingCode, phone: "0812345678" } })).status, 429);
  });
});

// =============================================================================== admin log, test, public button

describe("LINE admin: log, test message, public button", () => {
  it("log needs notifications.view; filters; test message is sent at once (rate-limited); public LINE button", async () => {
    const { h, admin } = await setup();
    await h.api("POST", "/api/admin/line/check", { token: admin, body: {} });
    await enable(h, admin, { publicButton: true });
    const r = await recipient(h, admin, GROUP, { payment: true, name: "Owners" });
    const test = await h.api<NotificationLogDto>("POST", `/api/admin/line/recipients/${r.id}/test`, { token: admin, body: {} });
    assert.equal(test.data.status, "SENT", JSON.stringify(test.body));
    assert.equal(test.data.recipientName, "Owners");
    assert.match(h.line.pushes[0]!.texts[0]!, /ทดสอบการแจ้งเตือน/);
    assert.match(h.line.pushes[0]!.texts[0]!, /การชำระเงิน/);

    await pay(h, admin, await book(h, { food: [] }));
    const viewer = await staff(h, ["notifications.view"]);
    const list = await h.api<{ items: NotificationLogDto[] }>("GET", "/api/admin/notifications?status=PENDING", { token: viewer });
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.items.map((i) => [i.type, i.audience, i.recipientName]), [["PAYMENT_CONFIRMED", "STAFF", "Owners"]]);
    assert.match(list.data.items[0]!.bookingCode!, /^BK-/);
    assert.equal((await h.api("GET", "/api/admin/notifications?type=NOPE", { token: viewer })).status, 422);
    assert.equal((await h.api("POST", `/api/admin/notifications/${list.data.items[0]!.id}/cancel`, { token: viewer, body: {} })).status, 403);
    assert.equal((await h.api<NotificationLogDto>("POST", `/api/admin/notifications/${list.data.items[0]!.id}/cancel`, { token: admin, body: {} })).data.status, "CANCELLED");
    const runNow = await h.api<{ sent: number }>("POST", "/api/admin/notifications/run", { token: admin, body: {} });
    assert.equal(runNow.status, 200);

    for (let i = 0; i < 9; i++) await h.api("POST", `/api/admin/line/recipients/${r.id}/test`, { token: admin, body: {} });
    assert.equal((await h.api("POST", `/api/admin/line/recipients/${r.id}/test`, { token: admin, body: {} })).status, 429);

    const site = await h.api<PublicSiteDto>("GET", "/api/public/site");
    assert.deepEqual(site.data.lineButton, { url: "https://line.me/R/ti/p/@phasakura" });
    h.db.run("UPDATE site_settings SET line_oa_url = 'https://lin.ee/abc123' WHERE id = 1");
    assert.deepEqual((await h.api<PublicSiteDto>("GET", "/api/public/site")).data.lineButton, { url: "https://lin.ee/abc123" });
  });
});
