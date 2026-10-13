import type {
  ApprovalMode, PaymentChannel, PaymentDto, PaymentMethod, PaymentSettingsDto, PaymentSettingsInput, ReceivingAccountDto, ReceivingAccountInput,
} from "../../shared/payment-types.ts";
import { BOOKING_CODE_PATTERN, type PaymentStatus } from "../../shared/booking-types.ts";
import type { AdminPaymentListItemDto } from "../../shared/dashboard-types.ts";
import type { D1DatabaseLike } from "../env.ts";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors.ts";
import type { BookingRepository, BookingRow } from "../repositories/booking.repository.ts";
import type { MediaRepository } from "../repositories/media.repository.ts";
import type { PaymentRepository, PaymentRow, PaymentSettingsRow, ReceivingAccountRow } from "../repositories/payment.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import { publicMediaUrl } from "./media-url.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import { dueOnline } from "./booking-money.ts";
import type { OutboxLike } from "./marketing.service.ts";

export function toPaymentDto(p: PaymentRow): PaymentDto {
  return {
    id: p.id,
    amountSatang: p.amount_satang,
    method: p.method,
    channel: p.channel ?? null,
    status: p.status,
    reference: p.reference,
    note: p.note,
    paidAt: p.paid_at,
    submittedAt: p.submitted_at,
    verifiedAt: p.verified_at,
    verifiedByName: p.verified_by_name,
    refundedAt: p.refunded_at,
    refundAmountSatang: p.refund_amount_satang,
    refundReason: p.refund_reason,
    slipUrl: p.slip_asset_id ? `/api/admin/payments/${p.id}/slip` : null,
  };
}

/**
 * Channels a guest can use for one booking: offered by the owner AND possible with the booking's account
 * snapshot (PromptPay number, account number, QR image) / a configured PayPal app. If the owner's choice
 * leaves nothing possible, every possible slip channel is shown — a booking must always be payable.
 */
export function availableChannels(
  settings: PaymentSettingsRow,
  account: { promptpay: string | null; accountNumber: string | null; qr: string | null },
  paypalReady: boolean,
): PaymentChannel[] {
  const possible: [PaymentChannel, boolean, number][] = [
    ["PROMPTPAY", !!account.promptpay, settings.promptpay_enabled],
    ["BANK_TRANSFER", !!account.accountNumber, settings.bank_transfer_enabled],
    ["QR_CODE", !!account.qr, settings.qr_enabled],
    ["PAYPAL", paypalReady, settings.paypal_enabled],
  ];
  const chosen = possible.filter(([, ok, on]) => ok && on === 1).map(([c]) => c);
  return chosen.length ? chosen : possible.filter(([c, ok]) => ok && c !== "PAYPAL").map(([c]) => c);
}

export interface PaymentFeatures {
  /** Slip verification service configured (Cloudflare Secret present). */
  verifier: { configured: boolean; provider: string | null };
  paypal: { configured: boolean; environment: "sandbox" | "live" };
}

/**
 * Receiving accounts (spec §25) and payment status (spec §26).
 * Booking ↔ payment transitions are conditional SQL in one batch, so they can never
 * race with hold expiry or with each other.
 */
export class PaymentService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: PaymentRepository,
    private readonly bookings: BookingRepository,
    private readonly media: MediaRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly mediaBaseUrl: string | undefined,
    private readonly clock: Clock,
    private readonly outbox: OutboxLike | null = null,
    private readonly features: PaymentFeatures = { verifier: { configured: false, provider: null }, paypal: { configured: false, environment: "sandbox" } },
  ) {}

  // ================================================================ settings (channels, approval mode)

  async getSettings(actor: AuthContext, meta: RequestMeta): Promise<PaymentSettingsDto> {
    await this.authz.requirePermission(actor, "receiving_accounts.view", meta);
    return this.settingsDto();
  }

  async saveSettings(actor: AuthContext, input: PaymentSettingsInput, meta: RequestMeta): Promise<PaymentSettingsDto> {
    await this.authz.requirePermission(actor, "receiving_accounts.edit", meta);
    const c = input.channels;
    if (!c.PROMPTPAY && !c.BANK_TRANSFER && !c.QR_CODE && !c.PAYPAL) throw new ValidationError({ channels: "AT_LEAST_ONE" });
    // PayPal can only be offered once its Cloudflare Secrets are set; turning it off is always allowed.
    if (c.PAYPAL && !this.features.paypal.configured) throw new ValidationError({ "channels.PAYPAL": "PAYPAL_NOT_CONFIGURED" });
    const before = await this.repo.settings();
    const now = iso(this.clock());
    await this.db.batch([
      this.repo.saveSettingsStatement({ approvalMode: input.approvalMode, promptpay: c.PROMPTPAY, bankTransfer: c.BANK_TRANSFER, qr: c.QR_CODE, paypal: c.PAYPAL }, actor.userId, now),
      this.log.auditStatement(actor.userId, "UPDATE_PAYMENT_SETTINGS", "settings", "payment_settings", settingsAudit(before), input, meta),
    ]);
    return this.settingsDto();
  }

  private async settingsDto(): Promise<PaymentSettingsDto> {
    const [s, primary] = await Promise.all([this.repo.settings(), this.repo.primaryAccount()]);
    return {
      approvalMode: s.approval_mode as ApprovalMode,
      channels: { PROMPTPAY: s.promptpay_enabled === 1, BANK_TRANSFER: s.bank_transfer_enabled === 1, QR_CODE: s.qr_enabled === 1, PAYPAL: s.paypal_enabled === 1 },
      slipVerifier: this.features.verifier,
      paypal: this.features.paypal,
      account: primary ? { promptpay: !!primary.promptpay_number, bankAccount: !!primary.account_number, qr: !!primary.qr_key } : null,
      updatedAt: s.updated_at,
    };
  }

  // ================================================================ payments list

  async listPayments(
    actor: AuthContext,
    f: { status: string | null; method: string | null; code: string | null; from: string | null; to: string | null; before: string | null; limit: number },
    meta: RequestMeta,
  ): Promise<{ items: AdminPaymentListItemDto[]; nextCursor: string | null }> {
    await this.authz.requirePermission(actor, "payments.view", meta);
    const rows = await this.repo.listAll({ ...f, limit: f.limit + 1 });
    const page = rows.slice(0, f.limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        bookingCode: r.booking_code,
        amountSatang: r.amount_satang,
        method: r.method,
        channel: (r.channel as PaymentChannel | null) ?? null,
        status: r.status as PaymentStatus,
        hasSlip: r.slip_asset_id !== null,
        reference: r.reference,
        submittedAt: r.submitted_at,
        paidAt: r.paid_at,
        verifiedAt: r.verified_at,
        refundAmountSatang: r.refund_amount_satang,
        refundedAt: r.refunded_at,
      })),
      nextCursor: rows.length > f.limit ? page[page.length - 1]!.submitted_at : null,
    };
  }

  // ================================================================ receiving accounts

  async listAccounts(actor: AuthContext, meta: RequestMeta): Promise<ReceivingAccountDto[]> {
    await this.authz.requirePermission(actor, "receiving_accounts.view", meta);
    return (await this.repo.listAccounts()).map((a) => this.toAccountDto(a));
  }

  async createAccount(actor: AuthContext, input: ReceivingAccountInput, meta: RequestMeta): Promise<ReceivingAccountDto> {
    await this.authz.requirePermission(actor, "receiving_accounts.edit", meta);
    await this.checkQr(input.qrAssetId);
    const id = newId();
    const now = iso(this.clock());
    const hasPrimary = (await this.repo.primaryAccount()) !== null;
    await this.db.batch([
      this.repo.insertAccountStatement({ id, ...input, createdBy: actor.userId, now }),
      // The first ACTIVE account becomes primary automatically, so bookings can be paid right away.
      ...(!hasPrimary && input.status === "ACTIVE" ? this.repo.setPrimaryStatements(id, now) : []),
      this.log.auditStatement(actor.userId, "CREATE_RECEIVING_ACCOUNT", "receiving_accounts", id, null, input, meta),
    ]);
    return this.toAccountDto((await this.repo.findAccount(id))!);
  }

  async updateAccount(actor: AuthContext, id: string, patch: Partial<ReceivingAccountInput>, meta: RequestMeta): Promise<ReceivingAccountDto> {
    await this.authz.requirePermission(actor, "receiving_accounts.edit", meta);
    const current = await this.findAccountOr404(id);
    const merged: ReceivingAccountInput = {
      bankName: patch.bankName ?? current.bank_name,
      accountName: patch.accountName ?? current.account_name,
      accountNumber: patch.accountNumber !== undefined ? patch.accountNumber : current.account_number,
      promptpayNumber: patch.promptpayNumber !== undefined ? patch.promptpayNumber : current.promptpay_number,
      qrAssetId: patch.qrAssetId !== undefined ? patch.qrAssetId : current.qr_asset_id,
      status: patch.status ?? (current.status === "INACTIVE" ? "INACTIVE" : "ACTIVE"),
      sortOrder: patch.sortOrder ?? current.sort_order,
    };
    if (!merged.accountNumber && !merged.promptpayNumber) throw new ValidationError({ accountNumber: "ACCOUNT_OR_PROMPTPAY_REQUIRED" });
    if (current.is_primary === 1 && merged.status !== "ACTIVE") throw new ConflictError("Choose another primary account first", "PRIMARY_MUST_BE_ACTIVE");
    if (patch.qrAssetId !== undefined) await this.checkQr(merged.qrAssetId);
    const now = iso(this.clock());
    // Old bookings are not affected: they keep their payment_account_snapshots row.
    await this.db.batch([
      this.repo.updateAccountStatement({ id, ...merged, now }),
      this.log.auditStatement(actor.userId, "UPDATE_RECEIVING_ACCOUNT", "receiving_accounts", id, accountAudit(current), merged, meta),
    ]);
    return this.toAccountDto((await this.repo.findAccount(id))!);
  }

  async setPrimary(actor: AuthContext, id: string, meta: RequestMeta): Promise<ReceivingAccountDto[]> {
    await this.authz.requirePermission(actor, "receiving_accounts.edit", meta);
    const account = await this.findAccountOr404(id);
    if (account.status !== "ACTIVE") throw new ConflictError("Only an active account can be primary", "PRIMARY_MUST_BE_ACTIVE");
    const before = await this.repo.primaryAccount();
    await this.db.batch([
      ...this.repo.setPrimaryStatements(id, iso(this.clock())),
      this.log.auditStatement(actor.userId, "SET_PRIMARY_RECEIVING_ACCOUNT", "receiving_accounts", id, { primary: before?.id ?? null }, { primary: id }, meta),
    ]);
    return (await this.repo.listAccounts()).map((a) => this.toAccountDto(a));
  }

  async deleteAccount(actor: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.authz.requirePermission(actor, "receiving_accounts.edit", meta);
    const account = await this.findAccountOr404(id);
    if (account.is_primary === 1) throw new ConflictError("Choose another primary account first", "PRIMARY_ACCOUNT_LOCKED");
    await this.db.batch([
      this.repo.softDeleteAccountStatement(id, iso(this.clock())),
      this.log.auditStatement(actor.userId, "DELETE_RECEIVING_ACCOUNT", "receiving_accounts", id, accountAudit(account), null, meta),
    ]);
  }

  private async findAccountOr404(id: string): Promise<ReceivingAccountRow> {
    const account = await this.repo.findAccount(id);
    if (!account || account.status === "DELETED") throw new NotFoundError("Receiving account not found", "RECEIVING_ACCOUNT_NOT_FOUND");
    return account;
  }

  private async checkQr(assetId: string | null): Promise<void> {
    if (!assetId) return;
    const asset = await this.media.findById(assetId);
    if (!asset || asset.status !== "ACTIVE" || asset.purpose !== "PAYMENT_QR" || asset.parent_asset_id) throw new ValidationError({ qrAssetId: "INVALID_IMAGE" });
  }

  private toAccountDto(a: ReceivingAccountRow): ReceivingAccountDto {
    return {
      id: a.id,
      bankName: a.bank_name,
      accountName: a.account_name,
      accountNumber: a.account_number,
      promptpayNumber: a.promptpay_number,
      qrAssetId: a.qr_asset_id,
      qrUrl: publicMediaUrl(a.qr_key, this.mediaBaseUrl),
      status: a.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      isPrimary: a.is_primary === 1,
      sortOrder: a.sort_order,
      updatedAt: a.updated_at,
    };
  }

  // ================================================================ payment status

  /**
   * Staff record money received in full (transfer seen in the bank app, cash at reception…):
   * PENDING → CONFIRMED, payment status → PAID. Slip upload & verification: Phase 8.
   */
  async recordPayment(
    actor: AuthContext,
    code: string,
    input: { amountSatang: number; method: PaymentMethod; paidAt: string; reference: string | null; note: string | null },
    meta: RequestMeta,
  ): Promise<PaymentDto[]> {
    await this.authz.requirePermission(actor, "payments.verify", meta);
    const booking = await this.findBooking(code);
    if (booking.payment_status === "PENDING_VERIFICATION") {
      // A slip is waiting: verify (or reject) it instead, so the money is never counted twice.
      throw new ConflictError("A payment slip is waiting for review", "SLIP_PENDING_REVIEW");
    }
    if (booking.booking_status !== "PENDING" || !["UNPAID", "REJECTED"].includes(booking.payment_status)) {
      throw new ConflictError("This booking is not awaiting payment", "BOOKING_NOT_PAYABLE");
    }
    const now = this.clock();
    if (booking.expires_at && booking.expires_at <= iso(now) && booking.payment_status === "UNPAID") {
      throw new ConflictError("The payment time for this booking has expired", "BOOKING_NOT_PAYABLE");
    }
    // Online-stage payment: the deposit on a deposit plan (the rest is taken at check-in), else the whole total.
    if (input.amountSatang !== dueOnline(booking)) {
      throw new ValidationError({ amountSatang: booking.deposit_satang === null ? "MUST_EQUAL_TOTAL" : "MUST_EQUAL_DEPOSIT" });
    }
    if (input.paidAt > iso(now)) throw new ValidationError({ paidAt: "IN_THE_FUTURE" });
    const at = iso(now);
    const paymentId = newId();
    const results = await this.db.batch([
      this.repo.confirmPaidStatement(booking.id, at),
      this.repo.insertRecordedPaymentStatement({
        id: paymentId, bookingId: booking.id, amount: input.amountSatang, method: input.method,
        reference: input.reference, note: input.note, paidAt: input.paidAt, by: actor.userId, now: at,
      }),
      // LINE (Phase 11): queued only if the confirmation above happened — same transaction.
      ...(this.outbox ? await this.outbox.bookingConfirmed(booking.id, at) : []),
    ]);
    if (!results[0]?.results.length) throw new ConflictError("The booking changed meanwhile, please reload", "BOOKING_NOT_PAYABLE");
    await this.log.auditStatement(actor.userId, "RECORD_PAYMENT", "payments", paymentId,
      { bookingStatus: booking.booking_status, paymentStatus: booking.payment_status },
      { bookingCode: booking.booking_code, amountSatang: input.amountSatang, method: input.method, reference: input.reference }, meta).run();
    return (await this.repo.payments(booking.id)).map(toPaymentDto);
  }

  /** Refund a paid payment of a cancelled / no-show booking (amount ≤ paid). */
  async refund(
    actor: AuthContext,
    code: string,
    paymentId: string,
    input: { amountSatang: number; reason: string },
    meta: RequestMeta,
  ): Promise<PaymentDto[]> {
    await this.authz.requirePermission(actor, "payments.refund", meta);
    const booking = await this.findBooking(code);
    if (booking.booking_status !== "CANCELLED" && booking.booking_status !== "NO_SHOW") {
      throw new ConflictError("Cancel the booking before refunding", "CANCEL_BEFORE_REFUND");
    }
    const payment = (await this.repo.payments(booking.id)).find((p) => p.id === paymentId);
    if (!payment) throw new NotFoundError("Payment not found", "PAYMENT_NOT_FOUND");
    if (payment.status !== "PAID" && payment.status !== "VERIFIED") throw new ConflictError("Only a paid payment can be refunded", "PAYMENT_NOT_REFUNDABLE");
    if (input.amountSatang > payment.amount_satang) throw new ValidationError({ amountSatang: "MORE_THAN_PAID" });
    const now = iso(this.clock());
    const results = await this.db.batch([
      this.repo.refundStatement(paymentId, booking.id, input.amountSatang, input.reason, actor.userId, now),
      this.repo.bookingRefundedStatement(booking.id, now),
    ]);
    if (!results[0]?.results.length) throw new ConflictError("The payment changed meanwhile, please reload", "PAYMENT_NOT_REFUNDABLE");
    await this.log.auditStatement(actor.userId, "REFUND_PAYMENT", "payments", paymentId, { status: payment.status },
      { bookingCode: booking.booking_code, refundAmountSatang: input.amountSatang, reason: input.reason }, meta).run();
    return (await this.repo.payments(booking.id)).map(toPaymentDto);
  }

  private async findBooking(code: string): Promise<BookingRow> {
    const row = BOOKING_CODE_PATTERN.test(code) ? await this.bookings.findByCode(code) : null;
    if (!row) throw new NotFoundError("Booking not found", "BOOKING_NOT_FOUND");
    return row;
  }
}

function settingsAudit(s: PaymentSettingsRow) {
  return {
    approvalMode: s.approval_mode,
    channels: { PROMPTPAY: s.promptpay_enabled === 1, BANK_TRANSFER: s.bank_transfer_enabled === 1, QR_CODE: s.qr_enabled === 1, PAYPAL: s.paypal_enabled === 1 },
  };
}

function accountAudit(a: ReceivingAccountRow) {
  return {
    bankName: a.bank_name, accountName: a.account_name, accountNumber: a.account_number, promptpayNumber: a.promptpay_number,
    qrAssetId: a.qr_asset_id, status: a.status, isPrimary: a.is_primary === 1,
  };
}
