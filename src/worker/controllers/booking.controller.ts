import type { BookingStatus, FoodSelection, PaymentStatus, PricingRuleInput } from "../../shared/booking-types.ts";
import { BOOKING_CODE_PATTERN, IDEMPOTENCY_KEY_PATTERN, MAX_STAYS_PER_BOOKING } from "../../shared/booking-types.ts";
import { MAX_PRICE_SATANG } from "../../shared/booking-rules.ts";
import { BALANCE_METHODS, type BalanceMethod } from "../../shared/payment-types.ts";
import { isIsoDate } from "../../shared/dates.ts";
import { DEFAULT_LOCALE, parseLocale } from "../../shared/i18n/locales.ts";
import { requestMeta, withAuth, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { BadRequestError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { MAX_FOOD_LINES, MAX_GUESTS_PER_BOOKING, type QuoteInput, type StayInput } from "../services/quote.service.ts";
import { ID_PATTERN, Validator } from "../validation.ts";
import { currentConsent, metaBrowserIds } from "../../shared/consent.ts";
import type { Services } from "../container.ts";
import type { Attribution } from "../repositories/marketing.repository.ts";
import type { RequestMeta } from "../services/auth-context.ts";

const NO_STORE = { "Cache-Control": "no-store" };
const BOOKING_STATUSES = ["PENDING", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "EXPIRED", "NO_SHOW"] as const;
const PAYMENT_STATUSES = ["UNPAID", "PENDING_VERIFICATION", "VERIFIED", "PAID", "REJECTED", "REFUNDED"] as const;
const TARGET_TYPES = ["UNIT", "UNIT_TYPE", "CAMPING"] as const;
const UNIT_TYPES = ["HOUSE", "VIP_TENT"] as const;
const RULE_STATUSES = ["ACTIVE", "INACTIVE"] as const;
const DAYS = /^[0-6]{1,7}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function langOf(raw: unknown) {
  if (raw === undefined || raw === null) return DEFAULT_LOCALE;
  const locale = typeof raw === "string" ? parseLocale(raw) : null;
  if (!locale) throw new BadRequestError("Unsupported language", "UNSUPPORTED_LANGUAGE");
  return locale;
}

function int(v: Validator, value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    v.errors[key] = value === undefined ? "REQUIRED" : "OUT_OF_RANGE";
    return min;
  }
  return value;
}

function date(v: Validator, value: unknown, key: string): string {
  if (!isIsoDate(value)) {
    v.errors[key] = value === undefined ? "REQUIRED" : "INVALID_DATE";
    return "";
  }
  return value;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const QUOTE_FIELDS = ["checkIn", "checkOut", "adults", "children", "stay", "stays", "food", "lang"] as const;

/**
 * One stay: a house / VIP tent, or own-tent camping. `withGuests`: an entry of `stays`, which carries its own
 * adults / children; the legacy single `stay` does not (the booking's guests are its guests).
 */
function parseStay(raw: unknown, v: Validator, key: string, withGuests: boolean): StayInput | null {
  const s = obj(raw);
  const guestKeys = withGuests ? ["adults", "children"] : [];
  if (!s) {
    v.errors[key] = "REQUIRED";
    return null;
  }
  const guests = () => ({
    adults: withGuests ? int(v, s.adults, `${key}.adults`, 0, MAX_GUESTS_PER_BOOKING) : 0,
    children: withGuests ? (s.children === undefined ? 0 : int(v, s.children, `${key}.children`, 0, MAX_GUESTS_PER_BOOKING)) : 0,
  });
  if (s.kind === "UNIT" && Object.keys(s).every((k) => ["kind", "unitId", ...guestKeys].includes(k))) {
    if (typeof s.unitId !== "string" || !ID_PATTERN.test(s.unitId)) {
      v.errors[`${key}.unitId`] = "INVALID_ID";
      return null;
    }
    return { kind: "UNIT", unitId: s.unitId, ...guests() };
  }
  if (s.kind === "CAMPING" && Object.keys(s).every((k) => ["kind", "tents", "tarp", ...guestKeys].includes(k))) {
    if (s.tarp !== undefined && typeof s.tarp !== "boolean") v.errors[`${key}.tarp`] = "INVALID_VALUE";
    return { kind: "CAMPING", tents: int(v, s.tents, `${key}.tents`, 1, 100), tarp: s.tarp === true, ...guests() };
  }
  v.errors[key] = "INVALID_VALUE";
  return null;
}

/** Parses the stay/guests/food part shared by quote and create. Strict: unknown fields are rejected. */
function parseQuote(body: Record<string, unknown>, v: Validator): QuoteInput {
  const checkIn = date(v, body.checkIn, "checkIn");
  const checkOut = date(v, body.checkOut, "checkOut");

  // Several stays (each with its own guests), or one legacy `stay` with the booking's guests.
  let stays: StayInput[] = [];
  let adults = 1;
  let children = 0;
  const legacy = body.stays === undefined;
  if (!legacy) {
    if (body.stay !== undefined) v.errors.stay = "NOT_WITH_STAYS";
    if (!Array.isArray(body.stays) || body.stays.length === 0) v.errors.stays = "REQUIRED";
    else if (body.stays.length > MAX_STAYS_PER_BOOKING) v.errors.stays = "TOO_MANY";
    else {
      stays = body.stays.map((raw, i) => parseStay(raw, v, `stays.${i}`, true)).filter((x): x is StayInput => x !== null);
      // The booking's guests are the stays' guests (a total sent alongside must agree).
      adults = stays.reduce((acc, x) => acc + x.adults, 0);
      children = stays.reduce((acc, x) => acc + x.children, 0);
      if (body.adults !== undefined && body.adults !== adults) v.errors.adults = "NOT_SUM_OF_STAYS";
      if (body.children !== undefined && body.children !== children) v.errors.children = "NOT_SUM_OF_STAYS";
      if (adults < 1) v.errors.adults = "OUT_OF_RANGE";
      if (adults + children > MAX_GUESTS_PER_BOOKING) v.errors.guests = "OUT_OF_RANGE";
    }
  } else {
    adults = int(v, body.adults, "adults", 1, MAX_GUESTS_PER_BOOKING);
    children = body.children === undefined ? 0 : int(v, body.children, "children", 0, MAX_GUESTS_PER_BOOKING);
    const stay = parseStay(body.stay, v, "stay", false);
    if (stay) stays = [{ ...stay, adults, children }];
  }

  const food: FoodSelection[] = [];
  if (body.food !== undefined) {
    if (!Array.isArray(body.food)) v.errors.food = "EXPECTED_ARRAY";
    else if (body.food.length > MAX_FOOD_LINES) v.errors.food = "TOO_MANY";
    else {
      body.food.forEach((raw, i) => {
        const f = obj(raw);
        const key = `food.${i}`;
        if (!f || !Object.keys(f).every((k) => ["optionId", "serviceDate", "adults", "children", "quantity"].includes(k))) {
          v.errors[key] = "INVALID_VALUE";
          return;
        }
        if (typeof f.optionId !== "string" || !ID_PATTERN.test(f.optionId)) {
          v.errors[`${key}.optionId`] = "INVALID_ID";
          return;
        }
        const line: FoodSelection = { optionId: f.optionId, serviceDate: date(v, f.serviceDate, `${key}.serviceDate`) };
        if (f.adults !== undefined) line.adults = int(v, f.adults, `${key}.adults`, 0, MAX_GUESTS_PER_BOOKING);
        if (f.children !== undefined) line.children = int(v, f.children, `${key}.children`, 0, MAX_GUESTS_PER_BOOKING);
        if (f.quantity !== undefined) line.quantity = int(v, f.quantity, `${key}.quantity`, 1, 500);
        food.push(line);
      });
    }
  }
  return { checkIn, checkOut, adults, children, stays, legacy, food, lang: langOf(body.lang).code };
}

function parseRule(body: Record<string, unknown>, partial: boolean): Partial<PricingRuleInput> {
  const v = new Validator(body).allowOnly(["targetType", "unitId", "unitType", "name", "dateFrom", "dateTo", "daysOfWeek", "priceSatang", "priority", "status"]);
  const out: Partial<PricingRuleInput> = {};
  const want = (k: string) => !partial || v.has(k);
  if (want("targetType")) out.targetType = v.oneOf("targetType", TARGET_TYPES, { required: true });
  if (v.has("unitId")) out.unitId = body.unitId === null ? null : v.string("unitId", { pattern: ID_PATTERN }) ?? null;
  if (v.has("unitType")) out.unitType = body.unitType === null ? null : v.oneOf("unitType", UNIT_TYPES) ?? null;
  if (want("name")) out.name = v.string("name", { required: true, max: 80 });
  if (want("dateFrom")) out.dateFrom = date(v, body.dateFrom, "dateFrom");
  if (want("dateTo")) out.dateTo = date(v, body.dateTo, "dateTo");
  if (v.has("daysOfWeek") || !partial) out.daysOfWeek = v.string("daysOfWeek", { pattern: DAYS }) ?? "0123456";
  if (want("priceSatang")) out.priceSatang = int(v, body.priceSatang, "priceSatang", 0, MAX_PRICE_SATANG);
  if (v.has("priority") || !partial) out.priority = body.priority === undefined ? 0 : int(v, body.priority, "priority", -1000, 1000);
  if (v.has("status") || !partial) out.status = v.oneOf("status", RULE_STATUSES) ?? "ACTIVE";
  v.assertValid();
  if (!partial) {
    if (out.targetType === "UNIT" && !out.unitId) throw new ValidationError({ unitId: "REQUIRED" });
    if (out.targetType === "UNIT_TYPE" && !out.unitType) throw new ValidationError({ unitType: "REQUIRED" });
    if (out.dateTo! < out.dateFrom!) throw new ValidationError({ dateTo: "BEFORE_START" });
    out.unitId ??= null;
    out.unitType ??= null;
  }
  return out;
}

function codeParam(ctx: RequestContext): string {
  const code = (ctx.params.code ?? "").toUpperCase();
  if (!BOOKING_CODE_PATTERN.test(code)) throw new ValidationError({ code: "INVALID_FORMAT" });
  return code;
}

export function bookingController(services: ServicesFor) {
  return {
    // ------------------------------------------------------------------ public
    /** GET /api/public/food-options?checkIn=&checkOut=&lang= — live menu, deadlines and remaining portions. */
    foodOptions: (async (ctx) => {
      const q = ctx.url.searchParams;
      const data = await services(ctx).quotes.catalogue(q.get("checkIn") ?? "", q.get("checkOut") ?? "", langOf(q.get("lang") ?? undefined).code);
      return jsonOk(data, { headers: NO_STORE });
    }) satisfies Handler,

    /** POST /api/public/bookings/quote — server-side price for the current selection. */
    quote: (async (ctx) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(QUOTE_FIELDS);
      const input = parseQuote(body, v);
      v.assertValid();
      return jsonOk(await services(ctx).bookings.quote(input), { headers: NO_STORE });
    }) satisfies Handler,

    /** POST /api/public/bookings — creates a PENDING booking (unpaid hold). */
    create: (async (ctx) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly([...QUOTE_FIELDS, "customer", "privacyAccepted", "expectedTotalSatang", "idempotencyKey"]);
      const input = parseQuote(body, v);
      const c = obj(body.customer);
      const cv = new Validator(c ?? {}).allowOnly(["name", "phone", "email", "lineId", "note"]);
      const customer = {
        name: cv.string("name", { required: true, max: 100 }),
        phone: cv.string("phone", { required: true, max: 24 }),
        email: cv.email("email") ?? null,
        lineId: cv.string("lineId", { max: 50 }) ?? null,
        note: cv.string("note", { max: 1000, raw: true })?.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") || null,
      };
      if (!c) v.errors.customer = "REQUIRED";
      for (const [k, e] of Object.entries(cv.errors)) v.errors[`customer.${k}`] = e;
      if (body.privacyAccepted !== true) v.errors.privacyAccepted = "MUST_ACCEPT";
      const expectedTotalSatang = int(v, body.expectedTotalSatang, "expectedTotalSatang", 0, MAX_PRICE_SATANG * 100);
      const idempotencyKey = v.string("idempotencyKey", { required: true, pattern: IDEMPOTENCY_KEY_PATTERN })!;
      v.assertValid();
      const meta = requestMeta(ctx);
      const { booking, replayed } = await services(ctx).bookings.create(
        { ...input, customer, expectedTotalSatang, idempotencyKey, attribution: await attributionOf(ctx, services(ctx), meta) },
        meta,
      );
      return jsonOk(booking, { status: replayed ? 200 : 201, headers: NO_STORE });
    }) satisfies Handler,

    /** POST /api/public/bookings/lookup { bookingCode, phone } — POST keeps the phone out of URLs and logs. */
    lookup: (async (ctx) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["bookingCode", "phone"]);
      const bookingCode = v.string("bookingCode", { required: true, max: 20 });
      const phone = v.string("phone", { required: true, max: 24 });
      v.assertValid();
      return jsonOk(await services(ctx).bookings.lookup(bookingCode, phone, requestMeta(ctx)), { headers: NO_STORE });
    }) satisfies Handler,

    // ------------------------------------------------------------------ admin bookings
    list: withPermission("bookings.view", services, async (ctx, auth) => {
      const q = ctx.url.searchParams;
      const v = new Validator(Object.fromEntries(q.entries()));
      const status = v.oneOf("status", BOOKING_STATUSES) as BookingStatus | undefined;
      const payment = v.oneOf("payment", PAYMENT_STATUSES) as PaymentStatus | undefined;
      const from = q.get("from") ? date(v, q.get("from"), "from") : undefined;
      const to = q.get("to") ? date(v, q.get("to"), "to") : undefined;
      const search = v.string("q", { max: 60 });
      const before = v.string("before", { pattern: TIMESTAMP });
      const limitRaw = Number(q.get("limit") ?? 50);
      const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 50;
      // Deposit plan: confirmed bookings that still owe the rest (dashboard "still due at check-in").
      const due = q.get("due") === "1";
      v.assertValid();
      return jsonOk(await services(ctx).bookings.adminList(auth, { status, payment, from, to, q: search, before, limit, due }, requestMeta(ctx)), { headers: NO_STORE });
    }),

    get: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).bookings.adminGet(auth, codeParam(ctx), requestMeta(ctx)), { headers: NO_STORE })),

    /** GET /api/admin/bookings/:code/move-options?from=YYYY-MM-DD&days=42 — which new check-in days work. */
    moveOptions: withPermission("bookings.edit", services, async (ctx, auth) => {
      const q = ctx.url.searchParams;
      const v = new Validator(Object.fromEntries(q.entries())).allowOnly(["from", "days"]);
      const from = date(v, q.get("from") ?? undefined, "from");
      const days = Number(q.get("days") ?? 42);
      if (!Number.isInteger(days) || days < 1 || days > 62) v.errors.days = "OUT_OF_RANGE";
      v.assertValid();
      return jsonOk(await services(ctx).bookings.moveOptions(auth, codeParam(ctx), from, days, requestMeta(ctx)), { headers: NO_STORE });
    }),

    /** POST /api/admin/bookings/:code/move { checkIn } — same number of nights, same price. */
    move: withPermission("bookings.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["checkIn"]);
      const checkIn = date(v, body.checkIn, "checkIn");
      v.assertValid();
      return jsonOk(await services(ctx).bookings.moveDates(auth, codeParam(ctx), checkIn, requestMeta(ctx)), { headers: NO_STORE });
    }),

    /** GET /api/admin/bookings/:code/balance — deposit plan: what is still due and where to pay it. */
    balance: withPermission("bookings.edit", services, async (ctx, auth) =>
      jsonOk(await services(ctx).bookings.balance(auth, codeParam(ctx), requestMeta(ctx)), { headers: NO_STORE })),

    /** POST /api/admin/bookings/:code/balance { method, reference?, checkIn } — staff took the rest; usually checks in too. */
    payBalance: withPermission("payments.verify", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["method", "reference", "checkIn"]);
      const method = v.oneOf("method", BALANCE_METHODS, { required: true }) as BalanceMethod;
      const reference = v.string("reference", { max: 100 }) || null;
      const checkIn = v.boolean("checkIn", false);
      v.assertValid();
      return jsonOk(await services(ctx).bookings.payBalance(auth, codeParam(ctx), { method, reference, checkIn }, requestMeta(ctx)), { headers: NO_STORE });
    }),

    cancel: withPermission("bookings.cancel", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["reason"]);
      const reason = v.string("reason", { required: true, min: 3, max: 500 });
      v.assertValid();
      return jsonOk(await services(ctx).bookings.adminCancel(auth, codeParam(ctx), reason, requestMeta(ctx)), { headers: NO_STORE });
    }),

    /** One stay of a booking with several (the booking goes on). */
    cancelStay: withPermission("bookings.cancel", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["reason"]);
      const reason = v.string("reason", { required: true, min: 3, max: 500 });
      const itemId = ctx.params.itemId ?? "";
      if (!ID_PATTERN.test(itemId)) v.errors.itemId = "INVALID_ID";
      v.assertValid();
      return jsonOk(await services(ctx).bookings.cancelStay(auth, codeParam(ctx), itemId, reason, requestMeta(ctx)), { headers: NO_STORE });
    }),

    // ------------------------------------------------------------------ admin pricing rules
    rules: withPermission("accommodation.view", services, async (ctx, auth) => {
      const q = ctx.url.searchParams;
      const v = new Validator(Object.fromEntries(q.entries())).allowOnly(["targetType", "unitId", "status"]);
      const filter = {
        targetType: v.oneOf("targetType", TARGET_TYPES),
        unitId: v.string("unitId", { pattern: ID_PATTERN }),
        status: v.oneOf("status", RULE_STATUSES),
      };
      v.assertValid();
      return jsonOk(await services(ctx).pricingRules.list(auth, filter, requestMeta(ctx)));
    }),

    createRule: withPermission("pricing.edit", services, async (ctx, auth) => {
      const input = parseRule(await readJsonObject(ctx.request), false) as PricingRuleInput;
      return jsonOk(await services(ctx).pricingRules.create(auth, input, requestMeta(ctx)), { status: 201 });
    }),

    updateRule: withPermission("pricing.edit", services, async (ctx, auth) => {
      const ruleId = ctx.params.id ?? "";
      if (!ID_PATTERN.test(ruleId)) throw new ValidationError({ id: "INVALID_ID" });
      const patch = parseRule(await readJsonObject(ctx.request), true);
      return jsonOk(await services(ctx).pricingRules.update(auth, ruleId, patch, requestMeta(ctx)));
    }),
  };
}

/**
 * What the visitor agreed to (consent cookie, current version only) and — only with Marketing consent —
 * the Meta browser ids, user agent, IP and page (without query string), for the Conversions API.
 */
async function attributionOf(ctx: Parameters<Handler>[0], s: Services, meta: RequestMeta): Promise<Attribution> {
  const cookies = ctx.request.headers.get("Cookie");
  const version = (await s.site.getPublicSite(DEFAULT_LOCALE)).consent.version;
  const consent = currentConsent(cookies, version);
  const ids = metaBrowserIds(cookies);
  let sourceUrl: string | null = null;
  try {
    const ref = new URL(ctx.request.headers.get("Referer") ?? "");
    if (ref.origin === ctx.url.origin) sourceUrl = `${ref.origin}${ref.pathname}`;
  } catch {
    sourceUrl = null;
  }
  return {
    consentVersion: consent?.version ?? 0,
    analytics: consent?.analytics ?? false,
    marketing: consent?.marketing ?? false,
    fbp: ids.fbp, fbc: ids.fbc, userAgent: meta.userAgent, ip: meta.ip, sourceUrl,
  };
}
