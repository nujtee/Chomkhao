import { getLocale, parseLocale } from "../../shared/i18n/locales.ts";
import type { PaypalCaptureDto, PaypalCheckDto, PaypalOrderDto } from "../../shared/payment-types.ts";
import { bookingLookupPath } from "../../shared/routes.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ConflictError, HttpError, NotFoundError, TooManyRequestsError } from "../http/errors.ts";
import { PAYPAL_ID_PATTERN, type CaptureResult, type PaypalApi } from "../paypal/paypal-api.ts";
import type { PaymentRepository, PaypalOrderRow } from "../repositories/payment.repository.ts";
import { newId } from "../security/tokens.ts";
import { addMs, iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { BookingService } from "./booking.service.ts";
import type { OutboxLike } from "./marketing.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import { dueOnline } from "./booking-money.ts";

export const PAYPAL_LIMITS = {
  ordersPerBookingPerHour: 10,
  capturesPerIpPerHour: 30,
  checksPerUserPerHour: 20,
  /** After a failed capture the guest keeps at least this long to try again. */
  graceMs: 15 * 60_000,
  /** A capture still in flight after this long is settled by the cron. */
  settleAfterMs: 60_000,
  /** PayPal expires an unapproved order after 3 hours. */
  orderLifetimeMs: 3 * 60 * 60_000,
} as const;

const PAYPAL_LOCALE: Record<string, string> = { th: "th-TH", en: "en-US", "zh-CN": "zh-CN" };

/**
 * PayPal Checkout for a booking (Orders v2, intent CAPTURE).
 *
 * Money moves only in `settle`, and only after the booking was claimed in D1 (still PENDING, hold not
 * over → payment_status PENDING_VERIFICATION, which also stops the hold expiring and blocks a slip).
 * A failed capture gives the booking back; an unknown answer leaves the claim for the cron to settle
 * (the capture request id makes the repeat safe). An expired or paid booking is never charged.
 */
export class PaypalService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: PaymentRepository,
    private readonly bookings: BookingService,
    private readonly api: PaypalApi | null,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly outbox: OutboxLike | null,
    private readonly config: { baseUrl: string; siteName: (lang: string) => Promise<string | null> },
  ) {}

  get configured(): boolean {
    return this.api !== null;
  }

  /** Guest (Booking ID + phone) starts a PayPal payment; returns the PayPal page to send them to. */
  async createOrder(code: string, phone: string, meta: RequestMeta): Promise<PaypalOrderDto> {
    if (!this.api) throw new ConflictError("PayPal is not available", "PAYPAL_NOT_CONFIGURED");
    const booking = await this.bookings.guestBooking(code, phone, meta);
    if ((await this.repo.settings()).paypal_enabled !== 1) throw new ConflictError("PayPal is not offered", "PAYPAL_NOT_OFFERED");
    const now = this.clock();
    const at = iso(now);
    if (booking.booking_status !== "PENDING" || (booking.payment_status !== "UNPAID" && booking.payment_status !== "REJECTED")
      || (booking.expires_at !== null && booking.expires_at <= at)) {
      throw new ConflictError("This booking is not waiting for a payment", "BOOKING_NOT_PAYABLE");
    }
    if ((await this.repo.paypalOrdersSince(booking.id, iso(addMs(now, -60 * 60_000)))) >= PAYPAL_LIMITS.ordersPerBookingPerHour) {
      throw new TooManyRequestsError(15 * 60);
    }
    const locale = getLocale(parseLocale(booking.language_code)?.code ?? "th");
    const back = `${this.config.baseUrl}${bookingLookupPath(locale)}`;
    const result = await this.api.createOrder({
      requestId: `order-${newId()}`,
      bookingId: booking.id,
      bookingCode: booking.booking_code,
      // The deposit on a deposit plan, else the whole total.
      amountSatang: dueOnline(booking),
      description: `Booking ${booking.booking_code}`,
      brandName: await this.config.siteName(locale.code).catch(() => null),
      locale: PAYPAL_LOCALE[locale.code] ?? "en-US",
      returnUrl: `${back}?paypal=return&code=${encodeURIComponent(booking.booking_code)}`,
      cancelUrl: `${back}?paypal=cancel&code=${encodeURIComponent(booking.booking_code)}`,
    });
    if (!result.ok) {
      console.error(JSON.stringify({ level: "error", message: "paypal_create_order_failed", bookingCode: booking.booking_code, error: result.error }));
      // PayPal's reason goes to the owner's error log (System status), not to the guest.
      throw new HttpError(502, "PAYPAL_UNAVAILABLE", "PayPal is not available right now. Please try again or choose another way to pay.",
        undefined, `${this.api.environment}: ${result.error}`);
    }
    await this.db.batch([
      this.repo.insertPaypalOrderStatement({ id: result.orderId, bookingId: booking.id, amount: dueOnline(booking), environment: this.api.environment, now: at }),
      this.repo.cancelOtherPaypalOrdersStatement(booking.id, result.orderId, at),
      this.log.eventStatement("PAYPAL_ORDER_CREATED", "INFO", meta, { identifier: booking.booking_code }),
    ]);
    return { orderId: result.orderId, approveUrl: result.approveUrl };
  }

  /**
   * Admin → Payment settings → "Check PayPal connection": the same calls a guest's payment makes (token, then an
   * order for ฿100) so wrong / sandbox-vs-live credentials or an account PayPal refuses show up before a guest
   * meets them. Nobody approves that order, so nothing is ever charged; PayPal drops it after 3 hours.
   * The route requires receiving_accounts.edit.
   */
  async check(actor: AuthContext, meta: RequestMeta): Promise<PaypalCheckDto> {
    const checkedAt = iso(this.clock());
    if (!this.api) return { ok: false, environment: null, error: "PAYPAL_NOT_CONFIGURED", checkedAt };
    if ((await this.log.countRecent(["PAYPAL_CHECK"], 60 * 60_000, { userId: actor.userId })) >= PAYPAL_LIMITS.checksPerUserPerHour) {
      throw new TooManyRequestsError(15 * 60);
    }
    const result = await this.api.createOrder({
      requestId: `check-${newId()}`,
      bookingId: "connection-check",
      bookingCode: "CONNECTION-CHECK",
      amountSatang: 10_000,
      description: "Connection check - not a payment",
      brandName: null,
      locale: "th-TH",
      returnUrl: `${this.config.baseUrl}/`,
      cancelUrl: `${this.config.baseUrl}/`,
    });
    const error = result.ok ? null : result.error;
    await this.log.event("PAYPAL_CHECK", result.ok ? "INFO" : "WARNING", meta,
      { userId: actor.userId, identifier: this.api.environment, ...(error ? { details: { reason: error } } : {}) });
    return { ok: result.ok, environment: this.api.environment, error, checkedAt };
  }

  /**
   * The guest is back from PayPal (return_url carries the order id). Possession of an approved order is the
   * proof here — capturing only moves the money its payer approved — so the answer carries no personal data.
   */
  async capture(orderId: string, meta: RequestMeta): Promise<PaypalCaptureDto> {
    if (!this.api) throw new ConflictError("PayPal is not available", "PAYPAL_NOT_CONFIGURED");
    if (meta.ip && (await this.log.countRecent(["PAYPAL_CAPTURE"], 60 * 60_000, { ip: meta.ip })) >= PAYPAL_LIMITS.capturesPerIpPerHour) {
      throw new TooManyRequestsError(15 * 60);
    }
    const order = PAYPAL_ID_PATTERN.test(orderId) ? await this.repo.paypalOrder(orderId) : null;
    if (!order) throw new NotFoundError("Payment not found", "PAYPAL_ORDER_NOT_FOUND");
    const booking = await this.bookings.guestBookingById(order.booking_id);
    await this.log.event("PAYPAL_CAPTURE", "INFO", meta, { identifier: booking.booking_code });
    const done = (outcome: PaypalCaptureDto["outcome"]): PaypalCaptureDto => ({ outcome, bookingCode: booking.booking_code });

    if (order.status === "CAPTURED") return done("PAID");
    if (order.status === "PENDING") return done("PENDING_REVIEW");
    if (order.status === "FAILED") return done(order.failure_code === "BOOKING_NOT_PAYABLE" ? "NOT_PAYABLE" : "DECLINED");
    if (order.status === "CANCELLED") return done("NOT_PAYABLE");

    if (order.status === "CREATED") {
      const now = iso(this.clock());
      // Both statements hold or neither does (the second is conditional on the first).
      const claimed = dueOnline(booking) === order.amount_satang ? await this.db.batch([
        this.repo.markPaypalCapturingStatement({ id: order.id, bookingId: booking.id, now }),
        this.repo.claimForPaypalStatement({ id: order.id, bookingId: booking.id, now }),
      ]) : null;
      if (!claimed?.[0]?.results.length || !claimed[1]?.results.length) {
        // Expired, cancelled, already paid or a slip is waiting: PayPal is never asked to take the money.
        await this.repo.cancelPaypalOrderStatement(order.id, "BOOKING_NOT_PAYABLE", now).run();
        return done("NOT_PAYABLE");
      }
    }
    const fresh = (await this.repo.paypalOrder(order.id))!;
    return done(await this.settle(fresh));
  }

  /** Guest came back through cancel_url: the unused order is closed (nothing was taken). */
  async cancel(orderId: string): Promise<{ bookingCode: string | null }> {
    const order = PAYPAL_ID_PATTERN.test(orderId) ? await this.repo.paypalOrder(orderId) : null;
    if (!order) return { bookingCode: null };
    await this.repo.cancelPaypalOrderStatement(order.id, "CANCELLED_BY_GUEST", iso(this.clock())).run();
    return { bookingCode: (await this.bookings.guestBookingById(order.booking_id)).booking_code };
  }

  /** Cron: finish captures left in flight, close stale orders. */
  async reconcile(limit = 10): Promise<{ settled: number }> {
    const now = this.clock();
    await this.repo.expireStalePaypalOrdersStatement(iso(addMs(now, -PAYPAL_LIMITS.orderLifetimeMs)), iso(now)).run();
    if (!this.api) return { settled: 0 };
    let settled = 0;
    for (const order of await this.repo.paypalOrdersToSettle(iso(addMs(now, -PAYPAL_LIMITS.settleAfterMs)), limit)) {
      if ((await this.settle(order)) !== "PROCESSING") settled++;
    }
    return { settled };
  }

  /** Order in CAPTURING (booking claimed): capture, then write the outcome. */
  private async settle(order: PaypalOrderRow): Promise<PaypalCaptureDto["outcome"]> {
    const api = this.api!;
    let result: CaptureResult = await api.capture(order.id);
    if (result.kind === "ALREADY_CAPTURED" || result.kind === "ERROR") {
      // Maybe the first capture went through and its answer was lost: ask PayPal what the order looks like.
      const lookup = await api.getOrder(order.id);
      if (lookup.kind === "OK" && lookup.capture) {
        const c = lookup.capture;
        result = c.status === "COMPLETED" ? { kind: "COMPLETED", ...c }
          : c.status === "PENDING" ? { kind: "PENDING", ...c, reason: null }
          : { kind: "DECLINED", code: `CAPTURE_${c.status}`.slice(0, 60) };
      } else if (lookup.kind === "NOT_FOUND") {
        result = { kind: "DECLINED", code: "ORDER_NOT_FOUND" };
      } else if (lookup.kind === "OK" && ["VOIDED", "CREATED", "PAYER_ACTION_REQUIRED", "SAVED"].includes(lookup.status) && result.kind === "ERROR") {
        // Not captured and not capturable as it stands; APPROVED is retried by the next run instead.
        result = { kind: "DECLINED", code: `ORDER_${lookup.status}` };
      }
    }
    const now = iso(this.clock());
    const booking = await this.bookings.guestBookingById(order.booking_id);

    if (result.kind === "COMPLETED" || result.kind === "PENDING") {
      const exact = result.currency === "THB" && result.amountSatang === order.amount_satang && (result.customId === null || result.customId === order.booking_id);
      const paymentId = newId();
      const paid = result.kind === "COMPLETED" && exact;
      const statements: D1PreparedStatementLike[] = [
        this.repo.insertPaypalPaymentStatement({ id: paymentId, bookingId: order.booking_id, amount: order.amount_satang, status: paid ? "PAID" : "PENDING_VERIFICATION", captureId: result.captureId, now }),
        this.repo.settlePaypalOrderStatement({
          id: order.id, status: paid ? "CAPTURED" : "PENDING", captureId: result.captureId, paymentId,
          failure: paid ? null : exact ? `PAYPAL_${result.kind === "PENDING" ? (result.reason ?? "PENDING") : "REVIEW"}`.slice(0, 60) : "AMOUNT_MISMATCH", now,
        }),
      ];
      if (paid) {
        statements.push(this.repo.confirmPaypalStatement(order.booking_id, paymentId, now));
        if (this.outbox) statements.push(...(await this.outbox.bookingConfirmed(order.booking_id, now)));
      } else if (this.outbox) {
        // Staff confirm it by hand (PayPal holds the money, or it does not match): same review queue as slips.
        statements.push(...(await this.outbox.slipSubmitted(paymentId, order.booking_id, now)));
      }
      try {
        await this.db.batch(statements);
      } catch (error) {
        // Money was taken but could not be written (e.g. staff cancelled the booking meanwhile): staff must refund.
        console.error(JSON.stringify({ level: "error", message: "paypal_record_failed", bookingCode: booking.booking_code, orderId: order.id, captureId: result.captureId, error: String(error).slice(0, 200) }));
        await this.repo.settlePaypalOrderStatement({ id: order.id, status: "PENDING", captureId: result.captureId, paymentId: null, failure: "RECORD_FAILED", now }).run().catch(() => undefined);
        return "PENDING_REVIEW";
      }
      await this.log.event(paid ? "PAYPAL_CAPTURED" : "PAYPAL_PENDING", paid ? "INFO" : "WARNING", { ip: null, userAgent: null }, { identifier: booking.booking_code });
      return paid ? "PAID" : "PENDING_REVIEW";
    }

    if (result.kind === "DECLINED") {
      // Nothing was taken: give the booking back (its hold, and at least a short grace period to try again).
      const grace = iso(addMs(this.clock(), PAYPAL_LIMITS.graceMs));
      const hold = order.hold_expires_at && order.hold_expires_at > grace ? order.hold_expires_at : grace;
      await this.db.batch([
        this.repo.settlePaypalOrderStatement({ id: order.id, status: "FAILED", captureId: null, paymentId: null, failure: result.code.slice(0, 60), now }),
        this.repo.releasePaypalClaimStatement(order.booking_id, order.prior_payment_status ?? "UNPAID", hold, now),
      ]);
      await this.log.event("PAYPAL_DECLINED", "WARNING", { ip: null, userAgent: null }, { identifier: booking.booking_code, details: { code: result.code.slice(0, 60) } });
      return "DECLINED";
    }

    // Unknown: keep the claim; the cron asks again (the repeat is idempotent at PayPal).
    console.error(JSON.stringify({ level: "error", message: "paypal_capture_unknown", bookingCode: booking.booking_code, orderId: order.id, error: result.kind === "ERROR" ? result.code : result.kind }));
    await this.repo.touchPaypalOrderStatement(order.id, now).run();
    return "PROCESSING";
  }
}
