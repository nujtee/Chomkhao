import {
  CREDIT_PLANS, MAX_CREDIT_AMOUNT, PREMIUM_ONLY_MENU_PATHS,
  type CreditLedgerEntryDto, type CreditPaymentInfoDto, type CreditPlan, type CreditRecipientDto, type CreditSettingsDto,
  type CreditSettingsInput, type CreditState, type CreditSummaryDto, type CreditTopupDto, type Page, type TopupResultDto,
} from "../../shared/credit-types.ts";
import { DEFAULT_TIMEZONE, localDateTimeIn } from "../../shared/dates.ts";
import type { D1DatabaseLike, R2BucketLike } from "../env.ts";
import { ConflictError, ForbiddenError, HttpError, NotFoundError, TooManyRequestsError, ValidationError } from "../http/errors.ts";
import { sniffImage } from "../media/image-sniff.ts";
import type { CreditAccountRow, CreditRepository, CreditSettingsRow, LedgerRow, TopupRow } from "../repositories/credit.repository.ts";
import type { MediaRepository } from "../repositories/media.repository.ts";
import { isMissingSchema } from "../repositories/inventory.repository.ts";
import { newId } from "../security/tokens.ts";
import { evaluateSlip, receiverSummary, type SlipVerifier } from "../slip/slip-verifier.ts";
import { addMs, iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import { publicMediaUrl } from "./media-url.ts";
import type { SecurityLogService } from "./security-log.service.ts";

export const TOPUP_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxDimension: 10_000,
  perUserPerHour: 10,
  /** A transfer older than this cannot top up automatically (Super Admin can still approve it). */
  maxSlipAgeMs: 24 * 60 * 60_000,
} as const;

const SLIP_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseReasons(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function toTopupDto(r: TopupRow): CreditTopupDto {
  return {
    id: r.id, plan: r.plan, amountRequested: r.amount_requested, amountCredited: r.amount_credited, status: r.status,
    requestedBy: { id: r.requested_by, name: r.requested_by_name },
    verifyResult: r.verify_result, verifyReasons: parseReasons(r.verify_reasons), verifiedAmount: r.verified_amount,
    transactionRef: r.transaction_ref,
    decidedBy: r.decided_by ? { id: r.decided_by, name: r.decided_by_name ?? "" } : null,
    decidedVia: r.decided_via, decidedAt: r.decided_at, rejectReason: r.reject_reason, createdAt: r.created_at,
  };
}

function toLedgerDto(r: LedgerRow): CreditLedgerEntryDto {
  return {
    id: r.id, type: r.entry_type, amount: r.amount, balanceAfter: r.balance_after, plan: r.plan, bookingCode: r.booking_code,
    units: r.units, note: r.note, actorName: r.actor_name, createdAt: r.created_at,
  };
}

/** Pure: the state shown everywhere (status bar, booking page, notices). */
export function creditState(s: Pick<CreditSettingsRow, "enabled" | "fee_per_unit" | "low_threshold"> | null, a: Pick<CreditAccountRow, "balance" | "held"> | null): {
  state: CreditState; available: number; unitsLeft: number | null;
} {
  const available = Math.max(0, (a?.balance ?? 0) - (a?.held ?? 0));
  if (!s || s.enabled !== 1) return { state: "OFF", available, unitsLeft: null };
  const unitsLeft = Math.floor(available / s.fee_per_unit);
  const state: CreditState = available < s.fee_per_unit ? "EMPTY" : available < s.low_threshold ? "LOW" : "NORMAL";
  return { state, available, unitsLeft };
}

/** What the booking page needs: the fee per unit (satang) and the credits new bookings may use; null = system off. */
export interface AppFeeTerms {
  perUnitSatang: number;
  availableCredits: number;
}

export interface CreditConfig {
  mediaBaseUrl: string | undefined;
  timezone: () => Promise<string | null>;
  /** Notices can go out (switches on + provider keys present). */
  emailReady: () => Promise<boolean>;
  lineReady: () => Promise<boolean>;
}

/**
 * App-usage credits (migration 0027): balance, top-ups (manual or EasySlip), Super Admin adjustments and plan,
 * settings, and the daily low / empty notices. The per-booking hold / capture / release run as D1 triggers.
 */
export class CreditService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: CreditRepository,
    private readonly media: MediaRepository,
    private readonly bucket: R2BucketLike,
    private readonly verifier: SlipVerifier | null,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly config: CreditConfig,
  ) {}

  // ================================================================ read

  /** Settings + balance; both null before migration 0027 (the system then counts as off). */
  private async load(): Promise<{ s: CreditSettingsRow | null; a: CreditAccountRow | null }> {
    try {
      const [s, a] = await Promise.all([this.repo.settings(), this.repo.account()]);
      return { s, a };
    } catch (error) {
      if (isMissingSchema(error)) return { s: null, a: null };
      throw error;
    }
  }

  private summaryOf(s: CreditSettingsRow | null, a: CreditAccountRow | null): CreditSummaryDto {
    const { state, available, unitsLeft } = creditState(s, a);
    return {
      enabled: s?.enabled === 1, balance: a?.balance ?? 0, held: a?.held ?? 0, available,
      feePerUnit: s?.fee_per_unit ?? 20, lowThreshold: s?.low_threshold ?? 500, state, unitsLeft, plan: a?.plan ?? "STANDARD",
    };
  }

  async summary(actor: AuthContext, meta: RequestMeta): Promise<CreditSummaryDto> {
    await this.authz.requirePermission(actor, "credits.view", meta);
    const { s, a } = await this.load();
    return this.summaryOf(s, a);
  }

  /** For quotes and booking creation (no actor): null when the credit system is off. */
  async feeTerms(): Promise<AppFeeTerms | null> {
    const { s, a } = await this.load();
    if (!s || s.enabled !== 1) return null;
    return { perUnitSatang: s.fee_per_unit * 100, availableCredits: creditState(s, a).available };
  }

  /** Public: can a guest book online at all right now (enough credit for one unit)? */
  async bookingOpen(): Promise<boolean> {
    const { s, a } = await this.load();
    return creditState(s, a).state !== "EMPTY";
  }

  async paymentInfo(actor: AuthContext, meta: RequestMeta): Promise<CreditPaymentInfoDto> {
    await this.authz.requirePermission(actor, "credits.topup", meta);
    const { s, a } = await this.load();
    return {
      bankName: s?.bank_name ?? null, accountName: s?.account_name ?? null, accountNumber: s?.account_number ?? null,
      promptpayNumber: s?.promptpay_number ?? null, qrUrl: publicMediaUrl(s?.qr_key, this.config.mediaBaseUrl),
      minimums: { STANDARD: s?.standard_min ?? null, PREMIUM: s?.premium_min ?? null },
      premiumOnly: [...PREMIUM_ONLY_MENU_PATHS],
      summary: this.summaryOf(s, a),
    };
  }

  // ================================================================ top-up request (any user with credits.topup)

  async submitTopup(actor: AuthContext, input: { plan: CreditPlan; amount: number; file: File }, meta: RequestMeta): Promise<TopupResultDto> {
    await this.authz.requirePermission(actor, "credits.topup", meta);
    const s = await this.repo.settings();
    if (!s || (!s.account_number && !s.promptpay_number && !s.qr_asset_id)) {
      throw new ConflictError("Top-ups are not set up yet", "TOPUP_NOT_CONFIGURED");
    }
    const minimum = input.plan === "PREMIUM" ? s.premium_min : s.standard_min;
    if (minimum === null) throw new ConflictError("This plan cannot be chosen yet", "PLAN_NOT_AVAILABLE");
    if (!Number.isInteger(input.amount) || input.amount < minimum || input.amount > MAX_CREDIT_AMOUNT) {
      throw new ValidationError({ amount: input.amount < minimum ? "BELOW_MINIMUM" : "OUT_OF_RANGE" }, `The minimum for this plan is ${minimum}`);
    }

    const now = this.clock();
    if ((await this.log.countRecent(["CREDIT_TOPUP_REQUESTED"], 60 * 60_000, { userId: actor.userId })) >= TOPUP_LIMITS.perUserPerHour) {
      throw new TooManyRequestsError(15 * 60);
    }
    if (input.file.size <= 0) throw new ValidationError({ file: "REQUIRED" });
    if (input.file.size > TOPUP_LIMITS.maxBytes) throw new HttpError(413, "FILE_TOO_LARGE", "Slip image must be 10 MB or smaller");
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    const image = sniffImage(bytes);
    if (!image || !SLIP_MIMES.has(image.mime)) {
      await this.log.event("UPLOAD_REJECTED", "WARNING", meta, { userId: actor.userId, details: { reason: "topup_slip_not_an_image", size: input.file.size } });
      throw new ValidationError({ file: "UNSUPPORTED_IMAGE" }, "Only JPEG, PNG or WebP images are allowed");
    }
    if (image.width > TOPUP_LIMITS.maxDimension || image.height > TOPUP_LIMITS.maxDimension) throw new ValidationError({ file: "IMAGE_TOO_LARGE_DIMENSIONS" });
    const sha256 = await sha256Hex(bytes);
    if (await this.repo.slipInUse(sha256)) throw new ConflictError("This slip has already been used", "DUPLICATE_SLIP");

    const at = iso(now);
    const assetId = newId();
    const topupId = newId();
    const key = `slips/${at.slice(0, 4)}/${at.slice(5, 7)}/${assetId}.${image.extension}`;
    await this.bucket.put(key, bytes, { httpMetadata: { contentType: image.mime, cacheControl: "private, no-store" } });
    try {
      await this.db.batch([
        this.repo.insertSlipAssetStatement({ id: assetId, key, mime: image.mime, size: bytes.length, width: image.width, height: image.height, sha256, userId: actor.userId, now: at }),
        this.repo.insertTopupStatement({ id: topupId, userId: actor.userId, plan: input.plan, amount: input.amount, assetId, sha256, now: at }),
        this.log.eventStatement("CREDIT_TOPUP_REQUESTED", "INFO", meta, { userId: actor.userId }),
        this.log.auditStatement(actor.userId, "REQUEST_CREDIT_TOPUP", "credits", topupId, null, { plan: input.plan, amount: input.amount }, meta),
      ]);
    } catch (error) {
      await this.bucket.delete(key).catch(() => undefined);
      if (/UNIQUE constraint failed: credit_topups\.slip_sha256/.test(String(error))) throw new ConflictError("This slip has already been used", "DUPLICATE_SLIP");
      throw error;
    }

    let outcome: TopupResultDto["outcome"] = "PENDING";
    if (s.approval_mode === "EASYSLIP" && this.verifier) outcome = await this.autoVerify(topupId, bytes, image.mime, s, input.plan);
    // Still waiting: Super Admin hears about it (after the automatic check, so the notice carries its result).
    if (outcome === "PENDING") await this.db.batch(this.repo.topupRequestStatements(topupId, iso(this.clock())));
    const [topup, account] = await Promise.all([this.repo.topup(topupId), this.repo.account()]);
    return { topup: toTopupDto(topup!), outcome, summary: this.summaryOf(await this.repo.settings(), account) };
  }

  /**
   * EasySlip: approved at once (credited = the slip's amount) only when the slip is real, went to Super Admin's
   * account / PromptPay, is recent, was never used before and shows exactly the amount asked. Anything else waits.
   */
  private async autoVerify(topupId: string, bytes: Uint8Array, mime: string, s: CreditSettingsRow, plan: CreditPlan): Promise<TopupResultDto["outcome"]> {
    const now = iso(this.clock());
    try {
      const answer = await this.verifier!.verify(bytes, mime);
      if (answer.kind !== "OK") {
        await this.repo.recordVerificationStatement(topupId, { result: answer.kind === "NOT_A_SLIP" ? "NOT_A_SLIP" : "ERROR", reasons: [answer.code], amount: null, ref: null, now }).run();
        return "PENDING";
      }
      const slip = answer.slip;
      const topup = (await this.repo.topup(topupId))!;
      const used = await this.repo.transactionRefUsed(slip.transactionRef, topupId);
      const failure = evaluateSlip(slip, {
        amountSatang: topup.amount_requested * 100,
        notBefore: iso(addMs(new Date(now), -TOPUP_LIMITS.maxSlipAgeMs)),
        now,
        accountNumber: s.account_number,
        promptpayNumber: s.promptpay_number,
        otherReceivers: s.qr_receiver ? [s.qr_receiver] : [],
        transactionAlreadyUsed: used,
      });
      const credited = Math.floor(slip.amountSatang / 100);
      // A refused destination: keep what EasySlip read so Super Admin can see why ("receiver:" entry).
      const read = failure === "RECEIVER_MISMATCH" || failure === "RECEIVER_UNCONFIRMED" ? receiverSummary(slip) : null;
      const reasons = failure ? [failure, ...(read ? [`receiver:${read}`] : [])] : [];
      // A reference already taken stays off this row (the unique index would refuse it); the reason says why.
      await this.repo.recordVerificationStatement(topupId, {
        result: failure ? "FAILED" : "PASSED", reasons, amount: credited, ref: used ? null : slip.transactionRef, now,
      }).run();
      if (failure) return "PENDING";
      const results = await this.db.batch([
        ...this.repo.approveStatements({ id: topupId, amount: credited, plan, via: "EASYSLIP", actorId: null, now }),
        ...this.repo.topupResultStatements(topupId, topup.requested_by, now),
      ]);
      return results[0]?.results.length ? "APPROVED" : "PENDING";
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "credit_topup_verify_failed", topupId, error: String(error).slice(0, 200) }));
      await this.repo.recordVerificationStatement(topupId, { result: "ERROR", reasons: ["INTERNAL"], amount: null, ref: null, now }).run().catch(() => undefined);
      return "PENDING";
    }
  }

  async topups(actor: AuthContext, q: { status: string | null; mine: boolean; before: string | null; limit: number }, meta: RequestMeta): Promise<Page<CreditTopupDto>> {
    // Everyone with credits.topup sees their own; Super Admin (credits.manage) sees all.
    const all = !q.mine && this.authz.can(actor, "credits.manage");
    if (!all) await this.authz.requirePermission(actor, "credits.topup", meta);
    const rows = await this.repo.topups({ status: q.status, userId: all ? null : actor.userId, before: q.before, limit: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    return { items: page.map(toTopupDto), nextCursor: rows.length > q.limit ? page[page.length - 1]!.created_at : null };
  }

  /** The slip image: to Super Admin, or to the user who sent it. Private, audited. */
  async slipImage(actor: AuthContext, id: string, meta: RequestMeta): Promise<Response> {
    const topup = await this.repo.topup(id);
    if (!topup) throw new NotFoundError("Top-up not found", "TOPUP_NOT_FOUND");
    if (topup.requested_by !== actor.userId) await this.authz.requirePermission(actor, "credits.manage", meta);
    if (!topup.slip_key || !topup.slip_mime) throw new NotFoundError("Slip not found", "SLIP_NOT_FOUND");
    const object = await this.bucket.get(topup.slip_key);
    if (!object) throw new NotFoundError("Slip not found", "SLIP_NOT_FOUND");
    await this.log.auditStatement(actor.userId, "VIEW_TOPUP_SLIP", "credits", id, null, null, meta).run();
    return new Response(object.body, {
      headers: {
        "Content-Type": topup.slip_mime, "Content-Length": String(object.size), "Cache-Control": "private, no-store",
        "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  }

  async ledger(actor: AuthContext, q: { before: string | null; limit: number }, meta: RequestMeta): Promise<Page<CreditLedgerEntryDto>> {
    if (!this.authz.can(actor, "credits.manage")) await this.authz.requirePermission(actor, "credits.topup", meta);
    const rows = await this.repo.ledger({ before: q.before, limit: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    return { items: page.map(toLedgerDto), nextCursor: rows.length > q.limit ? page[page.length - 1]!.created_at : null };
  }

  // ================================================================ Super Admin (credits.manage)

  private async requireManage(actor: AuthContext, meta: RequestMeta): Promise<void> {
    await this.authz.requirePermission(actor, "credits.manage", meta);
    // Belt and braces: the permission is SUPER_ADMIN-only in D1 (triggers + rbac query) — never trust anything else.
    if (!this.authz.isSuperAdmin(actor)) throw new ForbiddenError("Only a SUPER_ADMIN can manage credits", "SUPER_ADMIN_REQUIRED");
  }

  async approve(actor: AuthContext, id: string, input: { amount: number | null; plan: CreditPlan | null }, meta: RequestMeta): Promise<CreditTopupDto> {
    await this.requireManage(actor, meta);
    const topup = await this.repo.topup(id);
    if (!topup) throw new NotFoundError("Top-up not found", "TOPUP_NOT_FOUND");
    if (topup.status !== "PENDING") throw new ConflictError("This top-up was already decided", "TOPUP_ALREADY_DECIDED");
    const amount = input.amount ?? topup.verified_amount ?? topup.amount_requested;
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CREDIT_AMOUNT) throw new ValidationError({ amount: "OUT_OF_RANGE" });
    const plan = input.plan ?? topup.plan;
    const now = iso(this.clock());
    const results = await this.db.batch([
      ...this.repo.approveStatements({ id, amount, plan, via: "STAFF", actorId: actor.userId, now }),
      ...this.repo.topupResultStatements(id, topup.requested_by, now),
      this.log.auditStatement(actor.userId, "APPROVE_CREDIT_TOPUP", "credits", id, { status: "PENDING", amountRequested: topup.amount_requested, plan: topup.plan },
        { status: "APPROVED", amountCredited: amount, plan }, meta),
    ]);
    if (!results[0]?.results.length) throw new ConflictError("This top-up was already decided", "TOPUP_ALREADY_DECIDED");
    return toTopupDto((await this.repo.topup(id))!);
  }

  async reject(actor: AuthContext, id: string, reason: string, meta: RequestMeta): Promise<CreditTopupDto> {
    await this.requireManage(actor, meta);
    const topup = await this.repo.topup(id);
    if (!topup) throw new NotFoundError("Top-up not found", "TOPUP_NOT_FOUND");
    const now = iso(this.clock());
    const results = await this.db.batch([
      this.repo.rejectStatement(id, reason, actor.userId, now),
      ...this.repo.topupResultStatements(id, topup.requested_by, now),
      this.log.auditStatement(actor.userId, "REJECT_CREDIT_TOPUP", "credits", id, { status: topup.status }, { status: "REJECTED", reason }, meta),
    ]);
    if (!results[0]?.results.length) throw new ConflictError("This top-up was already decided", "TOPUP_ALREADY_DECIDED");
    return toTopupDto((await this.repo.topup(id))!);
  }

  /** Add (> 0) or take away (< 0) credits with a reason. Never below what unpaid bookings hold. */
  async adjust(actor: AuthContext, input: { amount: number; note: string }, meta: RequestMeta): Promise<CreditSummaryDto> {
    await this.requireManage(actor, meta);
    const before = await this.repo.account();
    // Checked here so a refused deduction leaves no audit row; the SQL guard still covers a race.
    if ((before?.balance ?? 0) + input.amount < (before?.held ?? 0)) {
      throw new ConflictError("Not enough usable credits to deduct that much", "CREDIT_INSUFFICIENT");
    }
    const now = iso(this.clock());
    const results = await this.db.batch([
      ...this.repo.adjustStatements({ amount: input.amount, note: input.note, actorId: actor.userId, now }),
      this.log.auditStatement(actor.userId, input.amount > 0 ? "ADD_CREDITS" : "DEDUCT_CREDITS", "credits", "account",
        { balance: before?.balance ?? 0 }, { amount: input.amount, note: input.note }, meta),
    ]);
    if (!results[0]?.results.length) throw new ConflictError("Not enough usable credits to deduct that much", "CREDIT_INSUFFICIENT");
    const { s, a } = await this.load();
    return this.summaryOf(s, a);
  }

  async setPlan(actor: AuthContext, input: { plan: CreditPlan; note: string }, meta: RequestMeta): Promise<CreditSummaryDto> {
    await this.requireManage(actor, meta);
    const before = await this.repo.account();
    if (before?.plan === input.plan) {
      const { s, a } = await this.load();
      return this.summaryOf(s, a); // already on that plan: nothing to record
    }
    const now = iso(this.clock());
    await this.db.batch([
      ...this.repo.planStatements({ plan: input.plan, note: input.note, actorId: actor.userId, now }),
      this.log.auditStatement(actor.userId, "SET_CREDIT_PLAN", "credits", "account", { plan: before?.plan ?? null }, { plan: input.plan, note: input.note }, meta),
    ]);
    const { s, a } = await this.load();
    return this.summaryOf(s, a);
  }

  private async settingsDto(s: CreditSettingsRow | null): Promise<CreditSettingsDto> {
    const [emailReady, lineReady] = await Promise.all([this.config.emailReady(), this.config.lineReady()]);
    return {
      enabled: s?.enabled === 1, feePerUnit: s?.fee_per_unit ?? 20, lowThreshold: s?.low_threshold ?? 500,
      approvalMode: s?.approval_mode ?? "MANUAL", standardMin: s?.standard_min ?? null, premiumMin: s?.premium_min ?? null,
      bankName: s?.bank_name ?? null, accountName: s?.account_name ?? null, accountNumber: s?.account_number ?? null,
      promptpayNumber: s?.promptpay_number ?? null, qrAssetId: s?.qr_asset_id ?? null, qrUrl: publicMediaUrl(s?.qr_key, this.config.mediaBaseUrl),
      qrReceiver: s?.qr_receiver ?? null,
      notifyEmail: s?.notify_email ?? null, alertTime1: s?.alert_time_1 ?? "09:00", alertTime2: s?.alert_time_2 ?? "17:00",
      verifierConfigured: this.verifier !== null, emailReady, lineReady, updatedAt: s?.updated_at ?? "",
    };
  }

  async getSettings(actor: AuthContext, meta: RequestMeta): Promise<CreditSettingsDto> {
    await this.requireManage(actor, meta);
    return this.settingsDto(await this.repo.settings());
  }

  async saveSettings(actor: AuthContext, input: CreditSettingsInput, meta: RequestMeta): Promise<CreditSettingsDto> {
    await this.requireManage(actor, meta);
    if (input.qrAssetId) {
      const asset = await this.media.findById(input.qrAssetId);
      if (!asset || asset.status !== "ACTIVE" || asset.purpose !== "PAYMENT_QR" || asset.parent_asset_id) throw new ValidationError({ qrAssetId: "INVALID_IMAGE" });
    }
    if (input.approvalMode === "EASYSLIP" && !this.verifier) throw new ValidationError({ approvalMode: "VERIFIER_NOT_CONFIGURED" }, "Set SLIP_VERIFICATION_API_KEY first");
    if (input.enabled && !input.accountNumber && !input.promptpayNumber && !input.qrAssetId) {
      throw new ValidationError({ accountNumber: "ACCOUNT_OR_PROMPTPAY_REQUIRED" }, "Set where top-ups are paid first");
    }
    const before = await this.repo.settings();
    const now = iso(this.clock());
    const save = (withQrReceiver: boolean) => this.db.batch([
      this.repo.saveSettingsStatement(input, actor.userId, now, withQrReceiver),
      this.log.auditStatement(actor.userId, "UPDATE_CREDIT_SETTINGS", "credits", "settings", before ? {
        enabled: before.enabled === 1, feePerUnit: before.fee_per_unit, lowThreshold: before.low_threshold, approvalMode: before.approval_mode,
        standardMin: before.standard_min, premiumMin: before.premium_min,
      } : null, { ...input }, meta),
    ]);
    try {
      await save(true);
    } catch (error) {
      if (!isMissingSchema(error)) throw error;
      await save(false); // before migration 0028: everything but the QR receiver
    }
    return this.settingsDto(await this.repo.settings());
  }

  async recipients(actor: AuthContext, meta: RequestMeta): Promise<CreditRecipientDto[]> {
    await this.requireManage(actor, meta);
    return (await this.repo.staffUsers()).map((u) => ({
      userId: u.id, name: u.display_name, email: u.email, roles: u.roles ? u.roles.split(",") : [], lineLinked: u.line_user_id !== null,
    }));
  }

  async pendingCount(actor: AuthContext, meta: RequestMeta): Promise<number> {
    await this.requireManage(actor, meta);
    return this.repo.pendingCount();
  }

  // ================================================================ cron: low / empty notices

  /**
   * Once a minute: queues today's notice when its time has come — LOW once a day (alert_time_1), EMPTY twice
   * (alert_time_1 and alert_time_2). The idempotency key (date + slot + user) makes each one go out once; a notice
   * whose state is gone by the time it is sent is dropped by the renderer.
   */
  async tick(): Promise<number> {
    const { s, a } = await this.load();
    const { state, available, unitsLeft } = creditState(s, a);
    if (!s || (state !== "LOW" && state !== "EMPTY")) return 0;
    const now = this.clock();
    const local = localDateTimeIn((await this.config.timezone()) ?? DEFAULT_TIMEZONE, now);
    const date = local.slice(0, 10);
    const time = local.slice(11, 16);
    const at = iso(now);
    const slots = state === "EMPTY" ? [["1", s.alert_time_1], ["2", s.alert_time_2]] as const : [["1", s.alert_time_1]] as const;
    let queued = 0;
    for (const [slot, from] of slots) {
      if (time < from) continue;
      // A later slot covers an earlier one that was missed (one notice per run).
      if (slot === "1" && state === "EMPTY" && time >= s.alert_time_2 && s.alert_time_2 > s.alert_time_1) continue;
      const key = state === "EMPTY" ? `CREDIT_EMPTY:${date}:${slot}:user:` : `CREDIT_LOW:${date}:user:`;
      const payload = state === "EMPTY" ? { date, slot } : { date };
      const results = await this.db.batch(this.repo.staffNoticeStatements(state === "EMPTY" ? "CREDIT_EMPTY" : "CREDIT_LOW", key, payload, at));
      queued += results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    }
    if (queued) console.log(JSON.stringify({ level: "info", message: "credit_notices_queued", state, available, unitsLeft, queued }));
    return queued;
  }
}

/** Plans in the order shown. */
export const PLANS = CREDIT_PLANS;
