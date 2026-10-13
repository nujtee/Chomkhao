import type { PublicBookingDto } from "../../shared/booking-types.ts";
import type {
  PaymentChannel, SlipChannel, SlipQueueDto, SlipQueueItemDto, SlipRejectInput, SlipUploadResultDto, SlipVerificationDto,
} from "../../shared/payment-types.ts";
import type { D1DatabaseLike, R2BucketLike } from "../env.ts";
import { ConflictError, HttpError, NotFoundError, TooManyRequestsError, ValidationError } from "../http/errors.ts";
import { sniffImage } from "../media/image-sniff.ts";
import type { PaymentRepository, SlipPaymentRow, VerificationRow } from "../repositories/payment.repository.ts";
import type { PricingRepository } from "../repositories/pricing.repository.ts";
import { newId } from "../security/tokens.ts";
import { evaluateSlip, type SlipVerifier } from "../slip/slip-verifier.ts";
import { addMs, iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { BookingService } from "./booking.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import { balanceDue } from "../../shared/booking-rules.ts";
import { dueOnline, paidOf } from "./booking-money.ts";
import type { OutboxLike } from "./marketing.service.ts";

export const SLIP_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxDimension: 10_000,
  perBookingPerDay: 5,
  perIpPerHour: 20,
} as const;

const SLIP_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toVerificationDto(v: VerificationRow): SlipVerificationDto {
  return {
    method: v.method,
    provider: v.provider,
    result: v.result,
    failureCode: v.failure_code,
    amountSatang: v.amount_satang,
    transferredAt: v.transferred_at,
    senderBank: v.sender_bank,
    receiverBank: v.receiver_bank,
    receiverAccountMasked: v.receiver_account_masked,
    transactionRef: v.transaction_ref,
    verifiedByName: v.verified_by_name,
    createdAt: v.created_at,
  };
}

/**
 * Payment slips (spec §27). Slips are private: stored in the PRIVATE R2 bucket, never
 * reachable through /media, streamed only to staff holding `slips.view`.
 */
export class SlipService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: PaymentRepository,
    private readonly bookings: BookingService,
    private readonly pricing: PricingRepository,
    private readonly bucket: R2BucketLike,
    private readonly verifier: SlipVerifier | null,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly outbox: OutboxLike | null = null,
  ) {}

  // ================================================================ guest upload

  async submit(code: string, phone: string, file: File, meta: RequestMeta, channel: SlipChannel = "BANK_TRANSFER"): Promise<{ booking: PublicBookingDto } & SlipUploadResultDto> {
    const booking = await this.bookings.guestBooking(code, phone, meta);
    // Deposit plan: once confirmed, the guest may transfer the rest before the stay (the booking stays CONFIRMED).
    const forBalance = booking.booking_status === "CONFIRMED" && booking.deposit_satang !== null;
    let amount = dueOnline(booking);
    if (forBalance) {
      const payments = await this.repo.payments(booking.id);
      if (payments.some((p) => p.status === "PENDING_VERIFICATION")) {
        throw new ConflictError("A payment for this booking is already being checked", "SLIP_PENDING");
      }
      amount = balanceDue(booking.total_satang, paidOf(payments));
      if (amount === 0) throw new ConflictError("Nothing is due on this booking", "NOTHING_DUE");
    } else if (booking.booking_status !== "PENDING" || (booking.payment_status !== "UNPAID" && booking.payment_status !== "REJECTED")) {
      throw new ConflictError("This booking is not waiting for a payment slip", "SLIP_NOT_ACCEPTED");
    }

    const now = this.clock();
    if (meta.ip && (await this.log.countRecent(["SLIP_UPLOADED"], 60 * 60_000, { ip: meta.ip })) >= SLIP_LIMITS.perIpPerHour) {
      throw new TooManyRequestsError(15 * 60);
    }
    if ((await this.repo.paymentsSince(booking.id, iso(addMs(now, -24 * 60 * 60_000)))) >= SLIP_LIMITS.perBookingPerDay) {
      throw new TooManyRequestsError(60 * 60, "Too many slips for this booking. Please contact us.");
    }

    if (file.size <= 0) throw new ValidationError({ file: "REQUIRED" });
    if (file.size > SLIP_LIMITS.maxBytes) throw new HttpError(413, "FILE_TOO_LARGE", "Slip image must be 10 MB or smaller");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = sniffImage(bytes);
    if (!image || !SLIP_MIMES.has(image.mime)) {
      await this.log.event("UPLOAD_REJECTED", "WARNING", meta, { identifier: booking.booking_code, details: { reason: "slip_not_an_image", size: file.size } });
      throw new ValidationError({ file: "UNSUPPORTED_IMAGE" }, "Only JPEG, PNG or WebP images are allowed");
    }
    if (image.width > SLIP_LIMITS.maxDimension || image.height > SLIP_LIMITS.maxDimension) throw new ValidationError({ file: "IMAGE_TOO_LARGE_DIMENSIONS" });

    const sha256 = await sha256Hex(bytes);
    if (await this.repo.liveSlipExists(sha256)) {
      await this.log.event("DUPLICATE_SLIP", "WARNING", meta, { identifier: booking.booking_code });
      throw new ConflictError("This slip has already been submitted", "DUPLICATE_SLIP");
    }

    const at = iso(now);
    const assetId = newId();
    const paymentId = newId();
    // Server-generated key; the guest's file name is never used.
    const key = `slips/${at.slice(0, 4)}/${at.slice(5, 7)}/${assetId}.${image.extension}`;
    await this.bucket.put(key, bytes, { httpMetadata: { contentType: image.mime, cacheControl: "private, no-store" } });
    const asset = { id: assetId, bookingId: booking.id, key, mime: image.mime, size: bytes.length, width: image.width, height: image.height, sha256, now: at };
    try {
      const notices = [
        this.log.eventStatement("SLIP_UPLOADED", "INFO", meta, { identifier: booking.booking_code }),
        ...(this.outbox ? await this.outbox.slipSubmitted(paymentId, booking.id, at) : []),
      ];
      if (forBalance) {
        // The rest of a deposit: stored only while exactly this amount is still due (nothing taken at reception meanwhile).
        const results = await this.db.batch([
          this.repo.insertBalanceSlipAssetStatement({ ...asset, amount }),
          this.repo.insertBalanceSlipPaymentStatement({ id: paymentId, bookingId: booking.id, amount, assetId, sha256, channel, now: at }),
          ...notices,
        ]);
        if (!results[1]?.results.length) throw new ConflictError("This booking is not waiting for a payment slip", "SLIP_NOT_ACCEPTED");
      } else {
        const results = await this.db.batch([
          this.repo.claimForSlipStatement(booking.id, at),
          this.repo.insertSlipAssetStatement(asset),
          // The deposit on a deposit plan, else the whole total: what the slip must show.
          this.repo.insertSlipPaymentStatement({ id: paymentId, bookingId: booking.id, amount, assetId, sha256, channel, now: at }),
          ...notices,
        ]);
        if (!results[0]?.results.length) throw new ConflictError("This booking is not waiting for a payment slip", "SLIP_NOT_ACCEPTED");
      }
    } catch (error) {
      await this.bucket.delete(key).catch(() => undefined); // no orphan objects
      if (/UNIQUE constraint failed: payments\.slip_sha256/.test(String(error))) {
        throw new ConflictError("This slip has already been submitted", "DUPLICATE_SLIP");
      }
      throw error;
    }

    const outcome = this.verifier ? await this.autoVerify(paymentId, bytes, image.mime) : "PENDING_REVIEW";
    const fresh = await this.bookings.guestBookingById(booking.id);
    return { booking: await this.bookings.publicView(fresh), outcome };
  }

  /**
   * Asks the real verification service. In AUTO mode the booking is confirmed only when every check
   * passes; in MANUAL mode (and on any failure) the result is recorded for staff, who are notified.
   * Never throws to the guest.
   */
  private async autoVerify(paymentId: string, bytes: Uint8Array, mime: string): Promise<SlipUploadResultDto["outcome"]> {
    const verifier = this.verifier!;
    const payment = await this.repo.findSlipPayment(paymentId);
    if (!payment) return "PENDING_REVIEW";
    const mode = (await this.repo.settings()).approval_mode;
    const now = iso(this.clock());
    const base = { id: newId(), paymentId, method: "AUTO" as const, provider: verifier.provider, verifiedBy: null, now };
    try {
      const answer = await verifier.verify(bytes, mime);
      if (answer.kind !== "OK") {
        await this.repo.insertVerificationStatement({
          ...base, result: answer.kind === "NOT_A_SLIP" ? "FAILED" : "ERROR", failureCode: answer.code, amount: null, transferredAt: null,
          senderBank: null, receiverBank: null, receiverMasked: null, transactionRef: null, redacted: null,
        }).run();
        return "PENDING_REVIEW";
      }
      const slip = answer.slip;
      const snapshot = await this.repo.snapshot(payment.booking_id);
      const failure = evaluateSlip(slip, {
        amountSatang: payment.amount_satang,
        notBefore: payment.booking_created_at,
        now,
        accountNumber: snapshot?.account_number_snapshot ?? null,
        promptpayNumber: snapshot?.promptpay_number_snapshot ?? null,
        transactionAlreadyUsed: await this.repo.transactionRefUsed(slip.transactionRef),
      });
      const record = {
        ...base, amount: slip.amountSatang, transferredAt: slip.transferredAt, senderBank: slip.senderBank,
        receiverBank: slip.receiverBank, receiverMasked: slip.receiverAccountMasked ?? slip.receiverProxyMasked,
        redacted: slip, // already reduced to non-personal fields (no names, masked accounts only)
      };
      if (failure) {
        await this.repo.insertVerificationStatement({ ...record, result: "FAILED", failureCode: failure, transactionRef: slip.transactionRef }).run();
        return "PENDING_REVIEW";
      }
      if (mode === "MANUAL") {
        // Correct slip, but staff approve: the PASSED row also reserves the bank transaction (no second use).
        try {
          await this.repo.insertVerificationStatement({ ...record, result: "PASSED", failureCode: null, transactionRef: slip.transactionRef }).run();
        } catch (error) {
          if (!/UNIQUE constraint failed: slip_verifications\.transaction_ref/.test(String(error))) throw error;
          await this.repo.insertVerificationStatement({ ...record, id: newId(), result: "FAILED", failureCode: "DUPLICATE_TRANSACTION", transactionRef: slip.transactionRef }).run();
        }
        return "PENDING_REVIEW";
      }
      try {
        await this.db.batch([
          this.repo.insertVerificationStatement({ ...record, result: "PASSED", failureCode: null, transactionRef: slip.transactionRef }),
          this.repo.markVerifiedStatement(paymentId, slip.transferredAt, null, now),
          ...(await this.settledStatements(payment, now)),
        ]);
        return "VERIFIED";
      } catch (error) {
        if (/UNIQUE constraint failed: slip_verifications\.transaction_ref/.test(String(error))) {
          await this.repo.insertVerificationStatement({ ...record, id: newId(), result: "FAILED", failureCode: "DUPLICATE_TRANSACTION", transactionRef: slip.transactionRef }).run();
          return "PENDING_REVIEW";
        }
        throw error;
      }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "slip_auto_verify_failed", paymentId, error: String(error).slice(0, 200) }));
      await this.repo.insertVerificationStatement({
        ...base, id: newId(), result: "ERROR", failureCode: "INTERNAL", amount: null, transferredAt: null, senderBank: null,
        receiverBank: null, receiverMasked: null, transactionRef: null, redacted: null,
      }).run().catch(() => undefined);
      return "PENDING_REVIEW";
    }
  }

  // ================================================================ staff

  async queue(actor: AuthContext, status: string, before: string | null, limit: number, meta: RequestMeta): Promise<SlipQueueDto> {
    await this.authz.requirePermission(actor, "slips.view", meta);
    const [rows, settings] = await Promise.all([this.repo.slipQueue(status, limit + 1, before), this.repo.settings()]);
    const page = rows.slice(0, limit);
    const checks = await this.repo.verifications(page.map((r) => r.id));
    return {
      items: page.map((r) => toQueueItem(r, checks.filter((c) => c.payment_id === r.id))),
      nextCursor: status !== "PENDING_VERIFICATION" && rows.length > limit ? page[page.length - 1]!.submitted_at : null,
      approvalMode: settings.approval_mode,
      verifierConfigured: this.verifier !== null,
    };
  }

  /** Streams a private slip to authorised staff; every view is audited (slips contain personal data). */
  async slipImage(actor: AuthContext, paymentId: string, meta: RequestMeta): Promise<Response> {
    await this.authz.requirePermission(actor, "slips.view", meta);
    const payment = await this.repo.findSlipPayment(paymentId);
    if (!payment?.slip_key || !payment.slip_mime) throw new NotFoundError("Slip not found", "SLIP_NOT_FOUND");
    const object = await this.bucket.get(payment.slip_key);
    if (!object) throw new NotFoundError("Slip not found", "SLIP_NOT_FOUND");
    await this.log.auditStatement(actor.userId, "VIEW_SLIP", "payments", paymentId, null, { bookingCode: payment.booking_code }, meta).run();
    return new Response(object.body, {
      headers: {
        "Content-Type": payment.slip_mime,
        "Content-Length": String(object.size),
        "Cache-Control": "private, no-store",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  }

  async verify(actor: AuthContext, paymentId: string, input: { transactionRef: string | null }, meta: RequestMeta): Promise<SlipQueueItemDto> {
    await this.authz.requirePermission(actor, "payments.verify", meta);
    const payment = await this.pending(paymentId);
    if (input.transactionRef && (await this.repo.transactionRefUsed(input.transactionRef, paymentId))) {
      throw new ConflictError("This bank transaction was already used for another payment", "DUPLICATE_TRANSACTION");
    }
    // The automatic check of this same slip may already hold this reference (MANUAL mode): don't record it twice.
    const own = input.transactionRef ? (await this.repo.verifications([paymentId])).some((v) => v.result === "PASSED" && v.transaction_ref === input.transactionRef) : false;
    const now = iso(this.clock());
    try {
      const results = await this.db.batch([
        this.repo.markVerifiedStatement(paymentId, null, actor.userId, now),
        this.repo.insertVerificationStatement({
          id: newId(), paymentId, method: "MANUAL", provider: null, result: "PASSED", failureCode: null, amount: payment.amount_satang,
          transferredAt: null, senderBank: null, receiverBank: null, receiverMasked: null, transactionRef: own ? null : input.transactionRef,
          redacted: null, verifiedBy: actor.userId, now,
        }),
        ...(await this.settledStatements(payment, now)),
      ]);
      if (!results[0]?.results.length) throw new ConflictError("This slip was already handled", "SLIP_ALREADY_HANDLED");
    } catch (error) {
      if (/UNIQUE constraint failed: slip_verifications\.transaction_ref/.test(String(error))) {
        throw new ConflictError("This bank transaction was already used for another payment", "DUPLICATE_TRANSACTION");
      }
      throw error;
    }
    await this.log.auditStatement(actor.userId, "VERIFY_SLIP", "payments", paymentId, { status: "PENDING_VERIFICATION" },
      { status: "VERIFIED", bookingCode: payment.booking_code, transactionRef: input.transactionRef }, meta).run();
    return this.item(paymentId);
  }

  /**
   * Staff turn a payment down with a reason the guest will read (LINE / e-mail). Either the guest gets a
   * fresh hold to pay again, or (cancelBooking) the booking is cancelled and its nights / tents / food released.
   */
  async reject(actor: AuthContext, paymentId: string, input: SlipRejectInput, meta: RequestMeta): Promise<SlipQueueItemDto> {
    await this.authz.requirePermission(actor, "payments.verify", meta);
    if (input.cancelBooking) await this.authz.requirePermission(actor, "bookings.cancel", meta);
    const payment = await this.pending(paymentId);
    // The rest of a deposit: the booking is already confirmed and stays so (the guest pays at check-in instead).
    if (input.cancelBooking && (payment.is_balance === 1 || payment.booking_status === "CONFIRMED")) {
      throw new ConflictError("This booking is already confirmed; cancel it from the booking page", "BOOKING_ALREADY_CONFIRMED");
    }
    const now = this.clock();
    const hold = (await this.pricing.bookingSettings()).hold_minutes;
    const at = iso(now);
    const reasonText = input.reason;
    const statements = [
      this.repo.markRejectedStatement(paymentId, reasonText, actor.userId, at),
      this.repo.insertVerificationStatement({
        id: newId(), paymentId, method: "MANUAL", provider: null, result: "FAILED", failureCode: "REJECTED_BY_STAFF", amount: null,
        transferredAt: null, senderBank: null, receiverBank: null, receiverMasked: null, transactionRef: null, redacted: null,
        verifiedBy: actor.userId, now: at,
      }),
      // The guest gets a fresh hold to pay or upload a correct slip…
      this.repo.bookingRejectedStatement(payment.booking_id, iso(addMs(now, hold * 60_000)), at),
    ];
    if (input.cancelBooking) {
      // …or the booking ends here (cancel + release + guest / kitchen notices, same batch).
      const row = await this.bookings.guestBookingById(payment.booking_id);
      statements.push(...(await this.bookings.cancelStatements({ ...row, booking_status: "PENDING" }, actor.userId, reasonText, at)));
    } else if (this.outbox?.paymentRejected) {
      statements.push(...(await this.outbox.paymentRejected(paymentId, payment.booking_id, at)));
    }
    const results = await this.db.batch(statements);
    if (!results[0]?.results.length) throw new ConflictError("This slip was already handled", "SLIP_ALREADY_HANDLED");
    await this.log.auditStatement(actor.userId, input.cancelBooking ? "REJECT_SLIP_CANCEL_BOOKING" : "REJECT_SLIP", "payments", paymentId,
      { status: "PENDING_VERIFICATION" }, { status: "REJECTED", bookingCode: payment.booking_code, reason: reasonText, cancelBooking: input.cancelBooking }, meta).run();
    return this.item(paymentId);
  }

  /**
   * After a payment was marked verified (same batch): a waiting booking is confirmed (+ its notices); for the rest of
   * a deposit the booking is already confirmed, so staff only hear that the rest came in.
   */
  private async settledStatements(payment: SlipPaymentRow, now: string) {
    if (payment.is_balance === 1) {
      return this.outbox?.balancePaid ? await this.outbox.balancePaid(payment.id, payment.booking_id, now) : [];
    }
    return [
      this.repo.confirmVerifiedStatement(payment.booking_id, now),
      ...(this.outbox ? await this.outbox.bookingConfirmed(payment.booking_id, now) : []),
    ];
  }

  private async pending(paymentId: string): Promise<SlipPaymentRow> {
    const payment = await this.repo.findSlipPayment(paymentId);
    // A slip, or a PayPal payment that PayPal holds for review (no slip image).
    if (!payment || (!payment.slip_key && payment.channel !== "PAYPAL")) throw new NotFoundError("Slip not found", "SLIP_NOT_FOUND");
    if (payment.status !== "PENDING_VERIFICATION") throw new ConflictError("This slip was already handled", "SLIP_ALREADY_HANDLED");
    return payment;
  }

  private async item(paymentId: string): Promise<SlipQueueItemDto> {
    const r = (await this.repo.findSlipPayment(paymentId))!;
    return toQueueItem(r, await this.repo.verifications([paymentId]));
  }
}

function toQueueItem(r: SlipPaymentRow, checks: VerificationRow[]): SlipQueueItemDto {
  return {
    paymentId: r.id,
    channel: (r.channel as PaymentChannel | null) ?? null,
    bookingCode: r.booking_code,
    bookingStatus: r.booking_status,
    customerName: r.customer_name,
    checkIn: r.check_in,
    checkOut: r.check_out,
    totalSatang: r.total_satang,
    amountSatang: r.amount_satang,
    status: r.status as SlipQueueItemDto["status"],
    submittedAt: r.submitted_at,
    slipUrl: r.slip_key ? `/api/admin/payments/${r.id}/slip` : null,
    reference: r.reference,
    balance: r.is_balance === 1,
    rejectedReason: r.rejected_reason,
    verifications: checks.map(toVerificationDto),
  };
}
