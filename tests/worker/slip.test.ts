import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBookingDto, PublicBookingDto, QuoteDto } from "../../src/shared/booking-types.ts";
import type { SlipQueueItemDto, SlipUploadResultDto } from "../../src/shared/payment-types.ts";
import {
  createSlipVerifier, EasySlipVerifier, evaluateSlip, maskedMatches, parseEasySlip,
  type ProviderResult, type SlipVerifier, type VerifiedSlip,
} from "../../src/worker/slip/slip-verifier.ts";
import type { MemoryBucket } from "../helpers/fake-env.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes, svgBytes } from "../helpers/images.ts";

// Harness clock: 2027-01-10T03:00Z. Seed primary account: 000-0-00000-0 / PromptPay 0000000000. House 01: ฿3,500/night.
let seq = 0;
const key = () => `slip-key-${String(++seq).padStart(10, "0")}`;
const PHONE = "0812345678";
const slipImage = (n: number) => ({ bytes: pngBytes(600 + n, 900), name: `slip${n}.png`, type: "image/png" });

async function book(h: Harness, unitId = "dev_house_01") {
  const body = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 2, children: 0, stay: { kind: "UNIT", unitId }, food: [], lang: "th" };
  const q = await h.api<QuoteDto>("POST", "/api/public/bookings/quote", { body });
  const res = await h.api<PublicBookingDto>("POST", "/api/public/bookings", {
    body: { ...body, customer: { name: "Guest Payer", phone: PHONE }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: key() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.data;
}

async function admin(h: Harness, perms: string[]) {
  const id = `staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

const goodSlip = (over: Partial<VerifiedSlip> = {}): VerifiedSlip => ({
  transactionRef: `TXN${++seq}`,
  amountSatang: 700000,
  transferredAt: "2027-01-10T02:58:00.000Z",
  senderBank: "KBANK",
  receiverBank: "DEV",
  receiverAccountMasked: "xxx-x-x0000-x",
  receiverProxyMasked: null,
  ...over,
});

class FakeVerifier implements SlipVerifier {
  readonly provider = "fake";
  calls = 0;
  constructor(public next: () => Promise<ProviderResult>) {}
  async verify(): Promise<ProviderResult> {
    this.calls++;
    return this.next();
  }
}

type SlipResult = { booking: PublicBookingDto } & SlipUploadResultDto;

describe("slip checks (pure)", () => {
  it("matches bank-masked numbers right-aligned, needs ≥ 4 visible digits", () => {
    assert.equal(maskedMatches("xxx-x-x5678-x", "123-4-45678-9"), true);
    assert.equal(maskedMatches("xxx-x-x5679-x", "123-4-45678-9"), false);
    assert.equal(maskedMatches("xxx-xxx-5678", "0812345678"), true);
    assert.equal(maskedMatches("XXX-X-X567X-X", "123-4-45678-9"), null, "only 3 visible digits");
    assert.equal(maskedMatches("xxxxxxxxxxxx5678", "5678"), true);
    assert.equal(maskedMatches("1234567890123", "567890123"), false, "longer than ours");
  });

  it("evaluates amount, date window, destination and duplicates", () => {
    const expect = { amountSatang: 700000, notBefore: "2027-01-10T03:00:00Z", now: "2027-01-10T04:00:00Z", accountNumber: "000-0-00000-0", promptpayNumber: "0812345678", transactionAlreadyUsed: false };
    assert.equal(evaluateSlip(goodSlip(), expect), null);
    assert.equal(evaluateSlip(goodSlip({ amountSatang: 699999 }), expect), "AMOUNT_MISMATCH");
    assert.equal(evaluateSlip(goodSlip({ transferredAt: "2027-01-09T10:00:00Z" }), expect), "DATE_OUT_OF_RANGE", "older than the booking");
    assert.equal(evaluateSlip(goodSlip({ transferredAt: "2027-01-10T05:00:00Z" }), expect), "DATE_OUT_OF_RANGE", "in the future");
    assert.equal(evaluateSlip(goodSlip({ receiverAccountMasked: "xxx-x-x1234-x" }), expect), "RECEIVER_MISMATCH");
    assert.equal(evaluateSlip(goodSlip({ receiverAccountMasked: null, receiverProxyMasked: "xxx-xxx-5678" }), expect), null, "PromptPay proxy");
    assert.equal(evaluateSlip(goodSlip({ receiverAccountMasked: null, receiverProxyMasked: null }), expect), "RECEIVER_UNCONFIRMED");
    // The bank may print a Thai mobile PromptPay number with the country code.
    assert.equal(evaluateSlip(goodSlip({ receiverAccountMasked: null, receiverProxyMasked: "+66-81-xxx-5678" }), expect), null, "+66 PromptPay");
    assert.equal(evaluateSlip(goodSlip({ receiverAccountMasked: null, receiverProxyMasked: "66812xx5678" }), expect), null, "66 PromptPay");
    assert.equal(evaluateSlip(goodSlip({ receiverAccountMasked: null, receiverProxyMasked: "+66-89-xxx-5678" }), expect), "RECEIVER_MISMATCH", "another number");
    assert.equal(evaluateSlip(goodSlip(), { ...expect, transactionAlreadyUsed: true }), "DUPLICATE_TRANSACTION");
  });

  it("parses provider answers strictly; anything odd → null", () => {
    const answer = {
      status: 200,
      data: {
        transRef: "015123ABC", date: "2027-01-10T09:58:00+07:00", amount: { amount: 7000, local: { amount: 0, currency: "" } },
        sender: { bank: { id: "004", name: "กสิกรไทย", short: "KBANK" }, account: { name: { th: "นาย ผู้โอน", en: "MR PAYER" }, bank: { type: "BANKAC", account: "xxx-x-x1111-x" } } },
        receiver: { bank: { id: "014", short: "SCB" }, account: { name: { th: "บจก ผา" }, bank: { type: "BANKAC", account: "xxx-x-x0000-x" }, proxy: { type: "MSISDN", account: "xxx-xxx-5678" } } },
      },
    };
    const parsed = parseEasySlip(answer)!;
    assert.deepEqual(parsed, {
      transactionRef: "015123ABC", amountSatang: 700000, transferredAt: "2027-01-10T02:58:00.000Z", senderBank: "KBANK",
      receiverBank: "SCB", receiverAccountMasked: "xxx-x-x0000-x", receiverProxyMasked: "xxx-xxx-5678",
    });
    assert.equal(JSON.stringify(parsed).includes("PAYER"), false, "payer names are not kept");
    assert.equal(parseEasySlip({ data: { ...answer.data, amount: { amount: "7000" } } }), null);
    assert.equal(parseEasySlip({ data: { ...answer.data, date: "yesterday" } }), null);
    assert.equal(parseEasySlip({ data: { ...answer.data, transRef: "" } }), null);
    assert.equal(parseEasySlip({ data: { ...answer.data, amount: { amount: -5 } } }), null);
    assert.equal(parseEasySlip({ status: 200 }), null);
    assert.equal(parseEasySlip(null), null);
  });

  it("EasySlip adapter: bearer key, multipart file, error mapping, timeout", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const ok = new EasySlipVerifier("SECRET-KEY", async (url, init) => {
      seen = { url, init };
      return Response.json({ status: 200, data: { transRef: "R1", date: "2027-01-10T09:58:00+07:00", amount: { amount: 7000 }, receiver: { account: { bank: { account: "xxx-x-x0000-x" } } } } });
    });
    const r = await ok.verify(pngBytes(), "image/png");
    assert.equal(r.kind, "OK");
    assert.equal((seen!.init.headers as Record<string, string>).Authorization, "Bearer SECRET-KEY");
    assert.ok(seen!.init.body instanceof FormData && (seen!.init.body as FormData).get("file") instanceof Blob);
    assert.equal(JSON.stringify(r).includes("SECRET"), false);

    const notFound = new EasySlipVerifier("k", async () => Response.json({ status: 404, message: "slip_not_found" }, { status: 404 }));
    assert.deepEqual(await notFound.verify(pngBytes(), "image/png"), { kind: "NOT_A_SLIP", code: "SLIP_NOT_FOUND" });
    const quota = new EasySlipVerifier("k", async () => Response.json({ status: 403, message: "quota_exceeded" }, { status: 403 }));
    assert.deepEqual(await quota.verify(pngBytes(), "image/png"), { kind: "ERROR", code: "QUOTA_EXCEEDED" });
    const down = new EasySlipVerifier("k", async () => { throw new Error("ECONNRESET"); });
    assert.deepEqual(await down.verify(pngBytes(), "image/png"), { kind: "ERROR", code: "PROVIDER_UNREACHABLE" });
    const html = new EasySlipVerifier("k", async () => new Response("<html>", { status: 200 }));
    assert.equal((await html.verify(pngBytes(), "image/png")).kind, "ERROR");
    const weird = new EasySlipVerifier("k", async () => Response.json({ status: 200, data: { amount: 7000 } }));
    assert.deepEqual(await weird.verify(pngBytes(), "image/png"), { kind: "ERROR", code: "UNEXPECTED_RESPONSE" });
    const slow = new EasySlipVerifier("k", (_u, init) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))), undefined, 20);
    assert.deepEqual(await slow.verify(pngBytes(), "image/png"), { kind: "ERROR", code: "PROVIDER_TIMEOUT" });
  });

  it("is off unless both provider and secret key are configured", () => {
    assert.equal(createSlipVerifier({}), null);
    assert.equal(createSlipVerifier({ SLIP_VERIFY_PROVIDER: "easyslip" }), null);
    assert.equal(createSlipVerifier({ SLIP_VERIFY_PROVIDER: "ocr", SLIP_VERIFICATION_API_KEY: "k" }), null, "unknown provider ≠ OCR fallback");
    assert.equal(createSlipVerifier({ SLIP_VERIFY_PROVIDER: "EasySlip", SLIP_VERIFICATION_API_KEY: "k" })?.provider, "easyslip");
  });
});

describe("guest slip upload", () => {
  it("stores the slip privately and waits for review (manual mode)", async () => {
    const h = new Harness({ seed: true });
    const b = await book(h);
    const wrong = await h.slip(b.bookingCode, "0899999999", slipImage(1));
    assert.equal(wrong.status, 404, "Booking ID + phone required");
    assert.equal(h.events("BOOKING_LOOKUP_FAILED").length, 1, "counts toward the lookup throttle");
    assert.equal((await h.slip(b.bookingCode, PHONE, { bytes: svgBytes, name: "x.png", type: "image/png" })).error?.details?.file, "UNSUPPORTED_IMAGE");

    const res = await h.slip<SlipResult>(b.bookingCode, PHONE, slipImage(1));
    assert.equal(res.status, 201, JSON.stringify(res.error));
    assert.equal(res.data.outcome, "PENDING_REVIEW");
    assert.equal(res.data.booking.paymentStatus, "PENDING_VERIFICATION");
    assert.equal(res.data.booking.paymentInstructions, null);

    const asset = h.db.get<{ bucket: string; object_key: string; purpose: string }>("SELECT bucket, object_key, purpose FROM media_assets WHERE purpose = 'PAYMENT_SLIP'")!;
    assert.equal(asset.bucket, "PRIVATE");
    assert.match(asset.object_key, /^slips\/2027\/01\/[A-Za-z0-9_-]+\.png$/, "server-generated key");
    assert.ok((h.env.MEDIA_PRIVATE as MemoryBucket).objects.has(asset.object_key));
    assert.equal(h.bucket.objects.has(asset.object_key), false, "never in the public bucket");
    assert.equal((await h.get(`/media/${asset.object_key}`)).status, 404, "not reachable via /media");

    h.advance(3 * 60 * 60_000);
    await h.app.scheduled(h.env);
    assert.equal(h.db.get<{ booking_status: string }>("SELECT booking_status FROM bookings")!.booking_status, "PENDING", "a submitted slip keeps the hold until staff decide");
    assert.equal((await h.slip(b.bookingCode, PHONE, slipImage(2))).error?.code, "SLIP_NOT_ACCEPTED", "one slip under review at a time");
  });

  it("refuses the same slip image twice (duplicate slip), and multipart mass assignment", async () => {
    const h = new Harness({ seed: true });
    const a = await book(h);
    const b = await book(h, "dev_house_02");
    assert.equal((await h.slip(a.bookingCode, PHONE, slipImage(5))).status, 201);
    const dup = await h.slip(b.bookingCode, PHONE, slipImage(5));
    assert.equal(dup.status, 409);
    assert.equal(dup.error?.code, "DUPLICATE_SLIP");
    assert.equal((h.env.MEDIA_PRIVATE as MemoryBucket).objects.size, 1, "no orphan object for the refused upload");

    const form = new FormData();
    form.set("bookingCode", b.bookingCode); form.set("phone", PHONE); form.set("status", "VERIFIED");
    form.set("file", new File([slipImage(6).bytes as BlobPart], "s.png", { type: "image/png" }));
    const res = await h.app.fetch(new Request("https://phasakura.test/api/public/bookings/slip", {
      method: "POST", headers: { Origin: "https://phasakura.test", "X-Requested-With": "phasakura" }, body: form,
    }), h.env);
    assert.equal(res.status, 422);
  });

  it("refuses slips for expired, paid or cancelled bookings", async () => {
    const h = new Harness({ seed: true });
    const b = await book(h);
    h.advance(61 * 60_000);
    assert.equal((await h.slip(b.bookingCode, PHONE, slipImage(7))).error?.code, "SLIP_NOT_ACCEPTED");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payments")!.n, 0);
  });
});

describe("auto verification (real service, fail-safe)", () => {
  it("all checks pass → booking confirmed immediately", async () => {
    const h = new Harness({ seed: true });
    const fake = new FakeVerifier(async () => ({ kind: "OK", slip: goodSlip({ transactionRef: "KBANK001" }) }));
    h.verifier(fake);
    const b = await book(h);
    const res = await h.slip<SlipResult>(b.bookingCode, PHONE, slipImage(10));
    assert.equal(res.data.outcome, "VERIFIED");
    assert.equal(res.data.booking.status, "CONFIRMED");
    assert.equal(res.data.booking.paymentStatus, "VERIFIED");
    const v = h.db.get<{ method: string; result: string; transaction_ref: string; provider_response_redacted: string }>("SELECT method, result, transaction_ref, provider_response_redacted FROM slip_verifications")!;
    assert.deepEqual([v.method, v.result, v.transaction_ref], ["AUTO", "PASSED", "KBANK001"]);
    assert.equal(fake.calls, 1);
  });

  for (const [name, answer, code] of [
    ["wrong amount", { kind: "OK", slip: goodSlip({ amountSatang: 70000 }) }, "AMOUNT_MISMATCH"],
    ["paid to another account", { kind: "OK", slip: goodSlip({ receiverAccountMasked: "xxx-x-x9999-x" }) }, "RECEIVER_MISMATCH"],
    ["old transfer", { kind: "OK", slip: goodSlip({ transferredAt: "2026-12-01T00:00:00Z" }) }, "DATE_OUT_OF_RANGE"],
    ["not a real slip", { kind: "NOT_A_SLIP", code: "SLIP_NOT_FOUND" }, "SLIP_NOT_FOUND"],
    ["provider down", { kind: "ERROR", code: "PROVIDER_TIMEOUT" }, "PROVIDER_TIMEOUT"],
  ] as const) {
    it(`${name} → left for staff (${code})`, async () => {
      const h = new Harness({ seed: true });
      h.verifier(new FakeVerifier(async () => answer as ProviderResult));
      const b = await book(h);
      const res = await h.slip<SlipResult>(b.bookingCode, PHONE, slipImage(20));
      assert.equal(res.data.outcome, "PENDING_REVIEW");
      assert.equal(res.data.booking.status, "PENDING");
      assert.equal(res.data.booking.paymentStatus, "PENDING_VERIFICATION");
      assert.equal(h.db.get<{ failure_code: string }>("SELECT failure_code FROM slip_verifications")!.failure_code, code);
    });
  }

  it("a crashing provider never breaks the upload", async () => {
    const h = new Harness({ seed: true });
    h.verifier(new FakeVerifier(async () => { throw new Error("boom"); }));
    const b = await book(h);
    const res = await h.slip<SlipResult>(b.bookingCode, PHONE, slipImage(30));
    assert.equal(res.status, 201);
    assert.equal(res.data.outcome, "PENDING_REVIEW");
    assert.deepEqual({ ...h.db.get<{ result: string; failure_code: string }>("SELECT result, failure_code FROM slip_verifications")! }, { result: "ERROR", failure_code: "INTERNAL" });
  });

  it("the same bank transaction cannot pay two bookings (duplicate transaction)", async () => {
    const h = new Harness({ seed: true });
    h.verifier(new FakeVerifier(async () => ({ kind: "OK", slip: goodSlip({ transactionRef: "SAME-REF" }) })));
    const a = await book(h);
    const b = await book(h, "dev_house_02");
    assert.equal((await h.slip<SlipResult>(a.bookingCode, PHONE, slipImage(40))).data.outcome, "VERIFIED");
    const second = await h.slip<SlipResult>(b.bookingCode, PHONE, slipImage(41)); // different image, same transaction
    assert.equal(second.data.outcome, "PENDING_REVIEW");
    assert.equal(h.db.get<{ failure_code: string }>("SELECT failure_code FROM slip_verifications ORDER BY created_at DESC, rowid DESC")!.failure_code, "DUPLICATE_TRANSACTION");
  });
});

describe("staff verification", () => {
  it("queue, private slip view (audited), verify → confirmed", async () => {
    const h = new Harness({ seed: true });
    const b = await book(h);
    await h.slip(b.bookingCode, PHONE, slipImage(50));
    const none = await admin(h, ["bookings.view"]);
    assert.equal((await h.api("GET", "/api/admin/slips", { token: none })).status, 403);

    const viewer = await admin(h, ["slips.view"]);
    const queue = await h.api<{ items: SlipQueueItemDto[] }>("GET", "/api/admin/slips", { token: viewer });
    assert.equal(queue.data.items.length, 1);
    const item = queue.data.items[0]!;
    assert.equal(item.bookingCode, b.bookingCode);

    const img = await h.get(item.slipUrl!, { Cookie: `__Host-sid=${viewer}` });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("Content-Type"), "image/png");
    assert.equal(img.headers.get("Cache-Control"), "private, no-store");
    assert.equal(img.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal((await h.get(item.slipUrl!)).status, 401, "no session, no slip");
    assert.equal(h.audits("VIEW_SLIP").length, 1);

    assert.equal((await h.api("POST", `/api/admin/payments/${item.paymentId}/verify`, { token: viewer, body: {} })).status, 403);
    const finance = await admin(h, ["payments.verify"]);
    assert.equal((await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments`, {
      token: finance, body: { amountSatang: 700000, method: "CASH", paidAt: "2027-01-10T02:00:00Z" },
    })).error?.code, "SLIP_PENDING_REVIEW", "no double counting next to a pending slip");
    const ok = await h.api<SlipQueueItemDto>("POST", `/api/admin/payments/${item.paymentId}/verify`, { token: finance, body: { transactionRef: "KB-778899" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.data.status, "VERIFIED");
    assert.equal(ok.data.verifications.at(-1)?.method, "MANUAL");
    assert.equal(h.db.get<{ booking_status: string; payment_status: string }>("SELECT booking_status, payment_status FROM bookings")!.booking_status, "CONFIRMED");
    assert.equal((await h.api("POST", `/api/admin/payments/${item.paymentId}/verify`, { token: finance, body: {} })).error?.code, "SLIP_ALREADY_HANDLED");
    assert.equal(h.audits("VERIFY_SLIP").length, 1);
  });

  it("reject → guest gets a fresh hold, sees payment details again, can upload a new slip", async () => {
    const h = new Harness({ seed: true });
    const b = await book(h);
    await h.slip(b.bookingCode, PHONE, slipImage(60));
    const finance = await admin(h, ["payments.verify", "slips.view"]);
    const paymentId = h.db.get<{ id: string }>("SELECT id FROM payments")!.id;
    assert.equal((await h.api("POST", `/api/admin/payments/${paymentId}/reject`, { token: finance, body: {} })).status, 422, "reason required");
    h.advance(30 * 60_000);
    const rejected = await h.api<SlipQueueItemDto>("POST", `/api/admin/payments/${paymentId}/reject`, { token: finance, body: { reason: "ยอดไม่ตรง" } });
    assert.equal(rejected.data.status, "REJECTED");

    const look = await h.api<PublicBookingDto>("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.bookingCode, phone: PHONE } });
    assert.equal(look.data.paymentStatus, "REJECTED");
    assert.equal(look.data.expiresAt, "2027-01-10T04:30:00.000Z", "fresh 60-minute hold from the rejection");
    assert.ok(look.data.paymentInstructions);
    // The reason is written for the guest (the admin form says so): shown with the payment details.
    assert.equal(look.data.paymentRejectedReason, "ยอดไม่ตรง");

    assert.equal((await h.slip(b.bookingCode, PHONE, slipImage(61))).status, 201);
    const detail = await h.api<AdminBookingDto>("GET", `/api/admin/bookings/${b.bookingCode}`, { token: await admin(h, ["bookings.view"]) });
    assert.deepEqual(detail.data.payments.map((p) => p.status), ["REJECTED", "PENDING_VERIFICATION"]);
  });

  it("a rejected hold that is not paid expires like any other", async () => {
    const h = new Harness({ seed: true });
    const b = await book(h);
    await h.slip(b.bookingCode, PHONE, slipImage(70));
    const finance = await admin(h, ["payments.verify"]);
    const paymentId = h.db.get<{ id: string }>("SELECT id FROM payments")!.id;
    await h.api("POST", `/api/admin/payments/${paymentId}/reject`, { token: finance, body: { reason: "blurry" } });
    h.advance(61 * 60_000);
    await h.app.scheduled(h.env);
    assert.equal(h.db.get<{ booking_status: string }>("SELECT booking_status FROM bookings")!.booking_status, "EXPIRED");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM booking_unit_nights")!.n, 0, "nights released");
  });

  it("a verified slip of a cancelled booking can be refunded", async () => {
    const h = new Harness({ seed: true });
    h.verifier(new FakeVerifier(async () => ({ kind: "OK", slip: goodSlip() })));
    const b = await book(h);
    await h.slip(b.bookingCode, PHONE, slipImage(80));
    const staff = await admin(h, ["bookings.cancel", "payments.refund"]);
    await h.api("POST", `/api/admin/bookings/${b.bookingCode}/cancel`, { token: staff, body: { reason: "guest asked" } });
    const paymentId = h.db.get<{ id: string }>("SELECT id FROM payments")!.id;
    const res = await h.api("POST", `/api/admin/bookings/${b.bookingCode}/payments/${paymentId}/refund`, { token: staff, body: { amountSatang: 700000, reason: "full refund" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(h.db.get<{ payment_status: string }>("SELECT payment_status FROM bookings")!.payment_status, "REFUNDED");
  });
});

describe("slip verifier configuration", () => {
  it("a key without a provider name means EasySlip (the supported service); no key = staff check every slip", () => {
    assert.equal(createSlipVerifier({ SLIP_VERIFY_PROVIDER: "", SLIP_VERIFICATION_API_KEY: "k" })?.provider, "easyslip");
    assert.equal(createSlipVerifier({ SLIP_VERIFICATION_API_KEY: "k" })?.provider, "easyslip");
    assert.equal(createSlipVerifier({ SLIP_VERIFY_PROVIDER: "", SLIP_VERIFICATION_API_KEY: " " }), null);
    assert.equal(createSlipVerifier({}), null);
  });
});
