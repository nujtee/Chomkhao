import { CREDIT_PLANS, MAX_CREDIT_AMOUNT, type CreditPlan, type CreditSettingsInput } from "../../shared/credit-types.ts";
import { ACCOUNT_NUMBER_PATTERN, PROMPTPAY_PATTERN } from "../../shared/payment-types.ts";
import { requestMeta, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { HttpError, PayloadTooLargeError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { TOPUP_LIMITS } from "../services/credit.service.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TOPUP_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;

function topupId(ctx: RequestContext): string {
  const id = ctx.params.id ?? "";
  if (!ID_PATTERN.test(id)) throw new ValidationError({ id: "INVALID_ID" });
  return id;
}

function page(q: URLSearchParams, extra: string[] = []): { before: string | null; limit: number; v: Validator } {
  const v = new Validator(Object.fromEntries(q.entries())).allowOnly(["before", "limit", ...extra]);
  const before = v.string("before", { pattern: TIMESTAMP }) ?? null;
  const raw = Number(q.get("limit") ?? 30);
  const limit = Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 30;
  return { before, limit, v };
}

function int(v: Validator, body: Record<string, unknown>, key: string, opts: { min: number; max: number; required?: boolean; nullable?: boolean }): number | null {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    if (opts.required && !(opts.nullable && value === null)) v.errors[key] = "REQUIRED";
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < opts.min || value > opts.max) {
    v.errors[key] = "OUT_OF_RANGE";
    return null;
  }
  return value;
}

function nullableText(v: Validator, body: Record<string, unknown>, key: string, max: number): string | null {
  if (body[key] === null || body[key] === "") return null;
  return v.string(key, { max })?.trim() || null;
}

/** PUT /api/admin/credit-admin/settings body (every field, like the form). */
export function parseCreditSettings(body: Record<string, unknown>): CreditSettingsInput {
  const v = new Validator(body).allowOnly([
    "enabled", "feePerUnit", "lowThreshold", "approvalMode", "standardMin", "premiumMin", "bankName", "accountName", "accountNumber",
    "promptpayNumber", "qrAssetId", "notifyEmail", "alertTime1", "alertTime2",
  ]);
  const enabled = v.boolean("enabled", false);
  const feePerUnit = int(v, body, "feePerUnit", { min: 1, max: 100_000, required: true }) ?? 0;
  const lowThreshold = int(v, body, "lowThreshold", { min: 0, max: 100_000_000, required: true }) ?? 0;
  const approvalMode = v.oneOf("approvalMode", ["MANUAL", "EASYSLIP"] as const, { required: true }) ?? "MANUAL";
  const standardMin = int(v, body, "standardMin", { min: 1, max: MAX_CREDIT_AMOUNT });
  const premiumMin = int(v, body, "premiumMin", { min: 1, max: MAX_CREDIT_AMOUNT });
  const bankName = nullableText(v, body, "bankName", 100);
  const accountName = nullableText(v, body, "accountName", 150);
  let accountNumber: string | null = null;
  if (body.accountNumber !== null && body.accountNumber !== undefined && body.accountNumber !== "") {
    accountNumber = v.string("accountNumber", { pattern: ACCOUNT_NUMBER_PATTERN }) ?? null;
  }
  let promptpayNumber: string | null = null;
  const pp = body.promptpayNumber;
  if (pp !== null && pp !== undefined && pp !== "") {
    if (typeof pp !== "string") v.errors.promptpayNumber = "EXPECTED_STRING";
    else {
      const digits = pp.replace(/[\s-]/g, "");
      if (PROMPTPAY_PATTERN.test(digits)) promptpayNumber = digits;
      else v.errors.promptpayNumber = "INVALID_FORMAT";
    }
  }
  const qrAssetId = body.qrAssetId === null || body.qrAssetId === undefined || body.qrAssetId === "" ? null : v.string("qrAssetId", { pattern: ID_PATTERN }) ?? null;
  const notifyEmail = body.notifyEmail === null || body.notifyEmail === undefined || body.notifyEmail === "" ? null : v.email("notifyEmail") ?? null;
  const alertTime1 = v.string("alertTime1", { required: true, pattern: TIME }) ?? "09:00";
  const alertTime2 = v.string("alertTime2", { required: true, pattern: TIME }) ?? "17:00";
  if (alertTime1 && alertTime2 && alertTime2 <= alertTime1 && !v.errors.alertTime2) v.errors.alertTime2 = "MUST_BE_LATER";
  if (bankName === null && accountNumber !== null) v.errors.bankName = "REQUIRED";
  v.assertValid();
  return {
    enabled, feePerUnit, lowThreshold, approvalMode, standardMin, premiumMin, bankName, accountName, accountNumber,
    promptpayNumber, qrAssetId, notifyEmail, alertTime1, alertTime2,
  };
}

export function creditController(services: ServicesFor) {
  return {
    /** GET /api/public/bookings/status — can guests book online right now (app-usage credit, migration 0027)? */
    publicStatus: (async (ctx) => {
      const open = await services(ctx).credits.bookingOpen().catch(() => true);
      return jsonOk({ open }, { headers: { "Cache-Control": "no-store" } });
    }) satisfies Handler,

    summary: withPermission("credits.view", services, async (ctx, auth) => jsonOk(await services(ctx).credits.summary(auth, requestMeta(ctx)))),

    topupInfo: withPermission("credits.topup", services, async (ctx, auth) => jsonOk(await services(ctx).credits.paymentInfo(auth, requestMeta(ctx)))),

    /** POST /api/admin/credits/topups — multipart { plan, amount, file }. */
    submitTopup: withPermission("credits.topup", services, async (ctx, auth) => {
      const type = ctx.request.headers.get("Content-Type") ?? "";
      if (!/^multipart\/form-data;/i.test(type)) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use multipart/form-data");
      if (Number(ctx.request.headers.get("Content-Length") ?? "0") > TOPUP_LIMITS.maxBytes + 64 * 1024) throw new PayloadTooLargeError();
      let form: FormData;
      try {
        form = await ctx.request.formData();
      } catch {
        throw new ValidationError({ body: "INVALID_MULTIPART" });
      }
      const unknown = [...form.keys()].filter((k) => !["plan", "amount", "file"].includes(k));
      if (unknown.length) throw new ValidationError(Object.fromEntries(unknown.map((k) => [k, "UNKNOWN_FIELD"])));
      const plan = form.get("plan");
      const amountRaw = form.get("amount");
      const file = form.get("file");
      const errors: Record<string, string> = {};
      if (typeof plan !== "string" || !(CREDIT_PLANS as readonly string[]).includes(plan)) errors.plan = "INVALID_VALUE";
      const amount = typeof amountRaw === "string" && /^\d{1,9}$/.test(amountRaw) ? Number(amountRaw) : NaN;
      if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CREDIT_AMOUNT) errors.amount = "OUT_OF_RANGE";
      if (!(file instanceof File)) errors.file = "REQUIRED";
      if (Object.keys(errors).length) throw new ValidationError(errors);
      const result = await services(ctx).credits.submitTopup(auth, { plan: plan as CreditPlan, amount, file: file as File }, requestMeta(ctx));
      return jsonOk(result, { status: 201, headers: { "Cache-Control": "no-store" } });
    }),

    /** GET /api/admin/credits/topups?status&mine&before&limit — own requests (credits.topup) or all (credits.manage). */
    topups: withPermission(["credits.topup", "credits.manage"], services, async (ctx, auth) => {
      const { before, limit, v } = page(ctx.url.searchParams, ["status", "mine"]);
      const status = v.oneOf("status", TOPUP_STATUSES) ?? null;
      const mine = ctx.url.searchParams.get("mine") === "1";
      v.assertValid();
      return jsonOk(await services(ctx).credits.topups(auth, { status, mine, before, limit }, requestMeta(ctx)));
    }),

    slip: withPermission(["credits.topup", "credits.manage"], services, async (ctx, auth) => services(ctx).credits.slipImage(auth, topupId(ctx), requestMeta(ctx))),

    ledger: withPermission(["credits.topup", "credits.manage"], services, async (ctx, auth) => {
      const { before, limit, v } = page(ctx.url.searchParams);
      v.assertValid();
      return jsonOk(await services(ctx).credits.ledger(auth, { before, limit }, requestMeta(ctx)));
    }),

    // ------------------------------------------------------------ Super Admin

    settings: withPermission("credits.manage", services, async (ctx, auth) => jsonOk(await services(ctx).credits.getSettings(auth, requestMeta(ctx)))),

    saveSettings: withPermission("credits.manage", services, async (ctx, auth) =>
      jsonOk(await services(ctx).credits.saveSettings(auth, parseCreditSettings(await readJsonObject(ctx.request)), requestMeta(ctx)))),

    recipients: withPermission("credits.manage", services, async (ctx, auth) => jsonOk(await services(ctx).credits.recipients(auth, requestMeta(ctx)))),

    pending: withPermission("credits.manage", services, async (ctx, auth) => jsonOk({ count: await services(ctx).credits.pendingCount(auth, requestMeta(ctx)) })),

    /** { amount?, plan? } — credit the slip's / asked amount unless Super Admin corrects it. */
    approve: withPermission("credits.manage", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["amount", "plan"]);
      const amount = int(v, body, "amount", { min: 1, max: MAX_CREDIT_AMOUNT });
      const plan = (v.oneOf("plan", CREDIT_PLANS) as CreditPlan | undefined) ?? null;
      v.assertValid();
      return jsonOk(await services(ctx).credits.approve(auth, topupId(ctx), { amount, plan }, requestMeta(ctx)));
    }),

    reject: withPermission("credits.manage", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["reason"]);
      const reason = v.string("reason", { required: true, min: 3, max: 300 })!;
      v.assertValid();
      return jsonOk(await services(ctx).credits.reject(auth, topupId(ctx), reason.trim(), requestMeta(ctx)));
    }),

    /** { amount (+ add / − deduct, ≠ 0), note } */
    adjust: withPermission("credits.manage", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["amount", "note"]);
      const amount = int(v, body, "amount", { min: -MAX_CREDIT_AMOUNT, max: MAX_CREDIT_AMOUNT, required: true }) ?? 0;
      if (amount === 0 && !v.errors.amount) v.errors.amount = "OUT_OF_RANGE";
      const note = v.string("note", { required: true, min: 3, max: 300 })!;
      v.assertValid();
      return jsonOk(await services(ctx).credits.adjust(auth, { amount, note: note.trim() }, requestMeta(ctx)));
    }),

    plan: withPermission("credits.manage", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["plan", "note"]);
      const plan = v.oneOf("plan", CREDIT_PLANS, { required: true }) as CreditPlan;
      const note = v.string("note", { required: true, min: 3, max: 300 })!;
      v.assertValid();
      return jsonOk(await services(ctx).credits.setPlan(auth, { plan, note: note.trim() }, requestMeta(ctx)));
    }),

    // ------------------------------------------------------------ My account → LINE (credit notices; every role has credits.view)

    myLine: withPermission("credits.view", services, async (ctx, auth) => jsonOk(await services(ctx).line.myLine(auth))),

    myLineCode: withPermission("credits.view", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["language"]);
      const language = v.oneOf("language", ["th", "en", "zh-CN"] as const) ?? "th";
      v.assertValid();
      return jsonOk(await services(ctx).line.createMyLinkCode(auth, language, requestMeta(ctx)), { status: 201 });
    }),

    myLineStatus: withPermission("credits.view", services, async (ctx, auth) => jsonOk(await services(ctx).line.myLinkStatus(auth, topupId(ctx)))),

    myLineUnlink: withPermission("credits.view", services, async (ctx, auth) => jsonOk(await services(ctx).line.unlinkMyLine(auth, requestMeta(ctx)))),
  };
}
