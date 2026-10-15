import type {
  AdminBookingDto,
  AdminBookingSummaryDto,
  BookingStatus,
  FoodLineDto,
  NightPriceDto,
  PaymentStatus,
  PublicBookingDto,
  QuoteDto,
  QuoteItemDto,
} from "../../shared/booking-types.ts";
import { BOOKING_CODE_PATTERN, maskPhone, normalizePhone, type BookingMoveOptionsDto, type MoveDayState } from "../../shared/booking-types.ts";
import type { BookingSettingsDto, StayAction } from "../../shared/dashboard-types.ts";
import type { BalanceDueDto, BalanceMethod, PaymentInstructionsDto } from "../../shared/payment-types.ts";
import { parseStays } from "../repositories/stay-sql.ts";
import { currentPaymentMode } from "../repositories/deposit-bookings.ts";
import { depositFor, balanceDue } from "../../shared/booking-rules.ts";
import { dueOnline, paidOf } from "./booking-money.ts";
import { addDays, diffDays, stayNights, todayIn } from "../../shared/dates.ts";
import { BookingMoveRepository, KITCHEN_STARTED } from "../repositories/booking-move.repository.ts";
import { moveDayState, type MoveInputs } from "./booking-move.ts";
import { stayActions } from "../../shared/stay.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ConflictError, HttpError, NotFoundError, TooManyRequestsError, ValidationError } from "../http/errors.ts";
import type { BookingRepository, BookingRow } from "../repositories/booking.repository.ts";
import type { PaymentRepository } from "../repositories/payment.repository.ts";
import { publicMediaUrl } from "./media-url.ts";
import { availableChannels, toPaymentDto } from "./payment.service.ts";
import { promptpayPayload } from "../../shared/promptpay.ts";
import { newId } from "../security/tokens.ts";
import { addMs, iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { PreparedBooking, QuoteInput, QuoteService } from "./quote.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import type { GuestLineDto } from "../../shared/line-types.ts";
import type { AppFeeDto } from "../../shared/credit-types.ts";
import type { OutboxLike } from "./marketing.service.ts";
import type { Attribution, MarketingRepository } from "../repositories/marketing.repository.ts";

export interface CreateBookingInput extends QuoteInput {
  customer: { name: string; phone: string; email: string | null; lineId: string | null; note: string | null };
  expectedTotalSatang: number;
  idempotencyKey: string;
  /** Cookie consent + Meta browser ids at booking time (Phase 14); browser ids only with Marketing consent. */
  attribution?: Attribution | null;
}

/** Abuse limits (security policy, not business configuration). */
export const BOOKING_LIMITS = {
  createPerIpPerHour: 20,
  lookupFailuresPerIp: 10,
  lookupFailuresPerCode: 5,
  lookupWindowMs: 15 * 60_000,
  codeAttempts: 5,
  expiryBatch: 50,
} as const;

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** BK-YYYYMMDD-XXXX, date = today in the property time zone, suffix from a CSPRNG. */
export function generateBookingCode(today: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  // 256 % 36 bias is 4/256 per char — irrelevant for an identifier that also needs the phone to open.
  const suffix = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `BK-${today.replaceAll("-", "")}-${suffix}`;
}

export class BookingService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: BookingRepository,
    private readonly quotes: QuoteService,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly payments: PaymentRepository,
    private readonly mediaBaseUrl: string | undefined,
    /** LINE outbox (Phase 11): kitchen hears about cancelled food orders. */
    private readonly outbox: OutboxLike | null = null,
    /** LINE opt-in state for the guest's booking page (Phase 11). */
    private readonly lineStatus: ((row: BookingRow) => Promise<GuestLineDto>) | null = null,
    /** Marketing attribution + Conversions API Lead (Phase 14). */
    private readonly marketing: MarketingRepository | null = null,
    /** PayPal Checkout can be offered (Cloudflare Secrets present). */
    private readonly paypalReady: boolean = false,
  ) {}

  async quote(input: QuoteInput): Promise<QuoteDto> {
    await this.expireDue();
    return (await this.quotes.prepare(input)).quote;
  }

  // ================================================================ create

  async create(input: CreateBookingInput, meta: RequestMeta): Promise<{ booking: PublicBookingDto; replayed: boolean }> {
    const phoneNormalized = normalizePhone(input.customer.phone);
    if (!phoneNormalized) throw new ValidationError({ "customer.phone": "INVALID_PHONE" });

    // Same idempotency key → same booking (double click / network retry). A different phone means a reused key.
    const replay = await this.replay(input.idempotencyKey, phoneNormalized);
    if (replay) return { booking: replay, replayed: true };

    if (meta.ip) {
      const recent = await this.log.countRecent(["BOOKING_CREATED"], 60 * 60_000, { ip: meta.ip });
      if (recent >= BOOKING_LIMITS.createPerIpPerHour) {
        await this.log.event("BOOKING_RATE_LIMITED", "WARNING", meta);
        throw new TooManyRequestsError(15 * 60);
      }
    }

    await this.expireDue();
    // Never take a booking that cannot be paid.
    if (!(await this.payments.primaryAccount())) {
      throw new ConflictError("Online booking is temporarily unavailable", "PAYMENT_NOT_CONFIGURED");
    }
    const prepared = await this.quotes.prepare(input);
    // Not enough app-usage credit for these units (migration 0027); the insert trigger refuses it too.
    if (prepared.quote.bookingUnavailable) {
      throw new ConflictError("Online booking is temporarily unavailable", "CREDIT_INSUFFICIENT");
    }
    if (prepared.quote.totalSatang !== input.expectedTotalSatang) {
      throw new HttpError(409, "PRICE_CHANGED", "The price has changed. Please review the new total.", {
        totalSatang: String(prepared.quote.totalSatang),
      });
    }

    const now = this.clock();
    const today = todayIn(await this.quotes.timezone(), now);
    for (let attempt = 0; attempt < BOOKING_LIMITS.codeAttempts; attempt++) {
      const code = generateBookingCode(today);
      const bookingId = newId();
      try {
        // Staff notices (LINE / e-mail) are queued in the same batch: only if the booking really exists.
        const notices = this.outbox?.bookingCreated ? await this.outbox.bookingCreated(bookingId, iso(now)) : [];
        await this.db.batch([...this.createStatements(prepared, input, phoneNormalized, code, bookingId, now, meta), ...notices]);
        const row = await this.repo.findByCode(code);
        return { booking: await this.toPublic(row!), replayed: false };
      } catch (error) {
        const message = String(error);
        if (/UNIQUE constraint failed: bookings\.booking_code/.test(message)) continue;
        if (/UNIQUE constraint failed: bookings\.idempotency_key/.test(message)) {
          const winner = await this.replay(input.idempotencyKey, phoneNormalized);
          if (winner) return { booking: winner, replayed: true };
        }
        throw mapInventoryError(error);
      }
    }
    throw new ConflictError("Could not allocate a booking number, please try again", "BOOKING_CODE_EXHAUSTED");
  }

  private async replay(key: string, phoneNormalized: string): Promise<PublicBookingDto | null> {
    const existing = await this.repo.findByIdempotencyKey(key);
    if (!existing) return null;
    if (!safeEqual(existing.customer_phone_normalized, phoneNormalized)) {
      throw new ConflictError("This request key was already used", "IDEMPOTENCY_KEY_REUSED");
    }
    return this.toPublic(existing);
  }

  private createStatements(p: PreparedBooking, input: CreateBookingInput, phoneNormalized: string, code: string, bookingId: string, now: Date, meta: RequestMeta): D1PreparedStatementLike[] {
    const repo = this.repo;
    const at = iso(now);
    const q = p.quote;
    const statements: D1PreparedStatementLike[] = [
      repo.insertBookingStatement({
        id: bookingId,
        code,
        lang: input.lang,
        checkIn: q.checkIn,
        checkOut: q.checkOut,
        nights: q.nights,
        adults: q.adults,
        children: q.children,
        name: input.customer.name,
        phone: input.customer.phone,
        phoneNormalized,
        email: input.customer.email,
        lineId: input.customer.lineId,
        note: input.customer.note,
        accommodationSubtotal: q.accommodationSubtotalSatang,
        foodSubtotal: q.foodSubtotalSatang,
        total: q.totalSatang,
        deposit: q.depositSatang,
        appFeeUnits: q.appFee?.units ?? 0,
        appFeeSatang: q.appFee?.totalSatang ?? 0,
        currency: q.currency,
        expiresAt: iso(addMs(now, p.settings.hold_minutes * 60_000)),
        idempotencyKey: input.idempotencyKey,
        privacyAcceptedAt: at,
        now: at,
      }),
    ];

    // One booking item per stay (houses / VIP tents / camping), in the order chosen.
    const itemIds = p.stays.map(() => newId());
    for (const [i, stay] of p.stays.entries()) {
      const item = stay.item;
      const itemId = itemIds[i]!;
      statements.push(repo.insertItemStatement({
        id: itemId, bookingId, type: item.type, unitId: item.unitId, quantity: item.quantity,
        adults: item.adults, children: item.children, payLater: item.payLaterSatang, now: iso(addMs(now, i)),
      }));

      // Inventory: the database rejects the whole batch if a night or tent is gone.
      if (stay.unit) {
        for (const night of p.nights) statements.push(repo.lockNightStatement(stay.unit.id, night, bookingId, itemId, at));
      } else {
        for (const night of p.nights) statements.push(...repo.reserveTentsStatements(night, stay.tents, at));
        // Tarp area: its own nightly limit (CHECK) and a price snapshot; triggers re-check camping + option offered.
        if (stay.tarp) {
          for (const night of p.nights) statements.push(...repo.reserveTarpStatements(night, stay.tarp.quantity, at));
          statements.push(repo.insertTarpStatement({
            id: newId(), bookingId, quantity: stay.tarp.quantity, pricePerNight: stay.tarp.pricePerNightSatang,
            nights: stay.tarp.nights, subtotal: stay.tarp.subtotalSatang, now: at,
          }));
        }
      }

      // Immutable price snapshot (spec §17), one per stay.
      statements.push(repo.insertPriceSnapshotStatement({
        id: newId(),
        bookingId,
        itemId,
        unitId: item.unitId,
        name: item.name,
        unitType: item.type,
        price: item.nightly[0]?.priceSatang ?? 0,
        pricingType: item.pricingType,
        quantity: item.quantity,
        nights: q.nights,
        adults: item.adults,
        children: item.children,
        nightlyJson: JSON.stringify(item.nightly),
        subtotal: item.subtotalSatang,
        now: at,
      }));

      // Included meals snapshot (spec §20).
      for (const m of stay.included) {
        statements.push(repo.insertIncludedMealStatement({
          id: newId(), bookingId, itemId, includedMealId: m.meal.id, categoryId: m.meal.food_category_id,
          optionId: m.option?.id ?? null, name: m.dto.name, persons: m.dto.personsPerNight, nights: q.nights, now: at,
        }));
      }
    }

    // Kitchen orders: one per category × service date; extra portions take daily capacity.
    const orders = new Map<string, { id: string; categoryId: string; date: string; persons: number; reserved: number; defaultMax: number | null }>();
    for (const line of p.foodLines) {
      const key = `${line.category.id}|${line.dto.serviceDate}`;
      const order = orders.get(key) ?? {
        id: newId(), categoryId: line.category.id, date: line.dto.serviceDate, persons: 0, reserved: 0,
        defaultMax: line.category.default_daily_capacity,
      };
      order.persons += line.persons;
      order.reserved += line.capacityQuantity;
      orders.set(key, order);
    }
    for (const o of orders.values()) {
      if (o.reserved > 0 && o.defaultMax !== null) statements.push(...repo.reserveFoodStatements(o.categoryId, o.date, o.reserved, o.defaultMax, at));
      statements.push(repo.insertFoodOrderStatement({ id: o.id, bookingId, categoryId: o.categoryId, date: o.date, persons: o.persons, reserved: o.reserved, now: at }));
    }
    for (const line of p.foodLines) {
      const d = line.dto;
      statements.push(repo.insertFoodItemStatement({
        id: newId(), bookingId, orderId: orders.get(`${line.category.id}|${d.serviceDate}`)!.id, optionId: d.optionId,
        date: d.serviceDate, name: d.name, categoryCode: d.categoryCode, pricingType: d.pricingType, unitPrice: d.unitPriceSatang,
        childPricing: line.option.child_pricing, childPrice: line.childPriceSatang, adults: d.adults, children: d.children,
        quantity: d.quantity, included: d.includedQuantity, subtotal: d.subtotalSatang,
        itemId: line.stayIndex === undefined ? null : itemIds[line.stayIndex]!, now: at,
      }));
    }

    // No PII in logs: booking code and amount only.
    // Payment account snapshot (spec §25): later account changes never touch this booking.
    statements.push(this.payments.insertSnapshotStatement(bookingId, at));

    // Marketing (Phase 14): consent at booking time; Lead queued only with Marketing consent + CAPI on.
    if (this.marketing && input.attribution) {
      statements.push(this.marketing.attributionStatement(bookingId, input.attribution, at), this.marketing.leadStatement(bookingId, at));
    }

    statements.push(this.log.eventStatement("BOOKING_CREATED", "INFO", meta, { identifier: code }));
    statements.push(this.log.auditStatement(null, "CREATE_BOOKING", "bookings", bookingId, null,
      { bookingCode: code, stays: q.items.map((it) => it.type), checkIn: q.checkIn, checkOut: q.checkOut, totalSatang: q.totalSatang }, meta));
    return statements;
  }

  // ================================================================ lookup (Booking ID + phone)

  async lookup(bookingCode: string, phone: string, meta: RequestMeta): Promise<PublicBookingDto> {
    return this.toPublic(await this.guestBooking(bookingCode, phone, meta));
  }

  /**
   * The guest's own booking, proven by Booking ID + phone. Shared by lookup and slip upload,
   * with the same enumeration throttle (failures per code and per IP).
   */
  async guestBooking(bookingCode: string, phone: string, meta: RequestMeta): Promise<BookingRow> {
    const code = bookingCode.trim().toUpperCase();
    const windowMs = BOOKING_LIMITS.lookupWindowMs;
    const [ipFailures, codeFailures] = await Promise.all([
      meta.ip ? this.log.countRecent(["BOOKING_LOOKUP_FAILED"], windowMs, { ip: meta.ip }) : 0,
      BOOKING_CODE_PATTERN.test(code) ? this.log.countRecent(["BOOKING_LOOKUP_FAILED"], windowMs, { identifier: code }) : 0,
    ]);
    if (ipFailures >= BOOKING_LIMITS.lookupFailuresPerIp || codeFailures >= BOOKING_LIMITS.lookupFailuresPerCode) {
      await this.log.event("BOOKING_LOOKUP_THROTTLED", "WARNING", meta, { identifier: BOOKING_CODE_PATTERN.test(code) ? code : null });
      throw new TooManyRequestsError(windowMs / 1000);
    }

    const phoneNormalized = normalizePhone(phone);
    const row = BOOKING_CODE_PATTERN.test(code) ? await this.repo.findByCode(code) : null;
    // One answer for "no such booking" and "wrong phone": no enumeration.
    if (!row || !phoneNormalized || !safeEqual(row.customer_phone_normalized, phoneNormalized)) {
      await this.log.event("BOOKING_LOOKUP_FAILED", "WARNING", meta, { identifier: BOOKING_CODE_PATTERN.test(code) ? code : null });
      throw new NotFoundError("No booking matches this Booking ID and phone number", "BOOKING_NOT_FOUND");
    }
    return this.expireIfDue(row);
  }

  /** Re-reads a booking the guest has already proven access to. */
  async guestBookingById(id: string): Promise<BookingRow> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundError("Booking not found", "BOOKING_NOT_FOUND");
    return row;
  }

  /** Public view of a booking row (from snapshots). */
  publicView(row: BookingRow): Promise<PublicBookingDto> {
    return this.toPublic(row);
  }

  // ================================================================ expiry (cron + opportunistic)

  /** Expires unpaid holds past their deadline and releases their inventory. Returns how many expired. */
  async expireDue(limit: number = BOOKING_LIMITS.expiryBatch): Promise<number> {
    const now = iso(this.clock());
    const due = await this.repo.dueForExpiry(now, limit);
    let expired = 0;
    for (const b of due) {
      try {
        if (await this.expireOne(b.id, b.booking_code, b.check_in, b.check_out, now)) expired++;
      } catch (error) {
        console.error(JSON.stringify({ level: "error", message: "booking_expiry_failed", bookingCode: b.booking_code, error: String(error) }));
      }
    }
    return expired;
  }

  private async expireIfDue(row: BookingRow): Promise<BookingRow> {
    const now = iso(this.clock());
    if (row.booking_status === "PENDING" && (row.payment_status === "UNPAID" || row.payment_status === "REJECTED") && row.expires_at && row.expires_at <= now) {
      await this.expireOne(row.id, row.booking_code, row.check_in, row.check_out, now);
      return (await this.repo.findByCode(row.booking_code)) ?? row;
    }
    return row;
  }

  private async expireOne(id: string, code: string, checkIn: string, checkOut: string, now: string): Promise<boolean> {
    const results = await this.db.batch([
      this.repo.expireStatement(id, now),
      ...this.repo.releaseStatements(id, checkIn, checkOut, now),
    ]);
    const changed = (results[0]?.results.length ?? 0) > 0;
    if (changed) {
      await this.log.event("BOOKING_EXPIRED", "INFO", { ip: null, userAgent: null }, { identifier: code });
    }
    return changed;
  }

  // ================================================================ admin

  async adminList(
    actor: AuthContext,
    filter: { status?: BookingStatus; payment?: PaymentStatus; from?: string; to?: string; q?: string; before?: string; limit: number; due?: boolean },
    meta: RequestMeta,
  ): Promise<{ items: AdminBookingSummaryDto[]; nextCursor: string | null }> {
    await this.authz.requirePermission(actor, "bookings.view", meta);
    const q = filter.q?.trim();
    const rows = await this.repo.list({
      ...filter,
      q: q ? q.toUpperCase().startsWith("BK-") ? q.toUpperCase() : q : undefined,
      qPhone: q ? normalizePhone(q) : null,
      limit: filter.limit + 1,
    });
    const page = rows.slice(0, filter.limit);
    const today = todayIn(await this.quotes.timezone(), this.clock());
    return {
      items: page.map((r) => ({
        id: r.id,
        bookingCode: r.booking_code,
        status: r.booking_status as BookingStatus,
        paymentStatus: r.payment_status as PaymentStatus,
        checkIn: r.check_in,
        checkOut: r.check_out,
        nights: r.nights,
        adults: r.adults,
        children: r.children,
        itemType: r.item_type,
        itemName: r.item_name,
        quantity: r.quantity,
        stays: parseStays(r.stays_json),
        tarps: r.tarps,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        totalSatang: r.total_satang,
        depositSatang: r.deposit_satang,
        balanceSatang: balanceDue(r.total_satang, r.paid_satang),
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        stayActions: stayActions(r.booking_status, r.check_in, r.check_out, today),
      })),
      nextCursor: rows.length > filter.limit ? page[page.length - 1]!.created_at : null,
    };
  }

  async adminGet(actor: AuthContext, code: string, meta: RequestMeta): Promise<AdminBookingDto> {
    await this.authz.requirePermission(actor, "bookings.view", meta);
    const row = await this.findOr404(code);
    return this.toAdmin(await this.expireIfDue(row));
  }

  async adminCancel(actor: AuthContext, code: string, reason: string, meta: RequestMeta): Promise<AdminBookingDto> {
    await this.authz.requirePermission(actor, "bookings.cancel", meta);
    const row = await this.expireIfDue(await this.findOr404(code));
    if (row.booking_status !== "PENDING" && row.booking_status !== "CONFIRMED") {
      throw new ConflictError("Only pending or confirmed bookings can be cancelled", "BOOKING_NOT_CANCELLABLE");
    }
    const now = iso(this.clock());
    const results = await this.db.batch(await this.cancelStatements(row, actor.userId, reason, now));
    if (!(results[0]?.results.length)) throw new ConflictError("The booking changed meanwhile, please reload", "BOOKING_NOT_CANCELLABLE");
    await this.log.auditStatement(actor.userId, "CANCEL_BOOKING", "bookings", row.id,
      { status: row.booking_status, paymentStatus: row.payment_status }, { status: "CANCELLED", reason }, meta).run();
    return this.toAdmin((await this.repo.findByCode(row.booking_code))!);
  }

  /**
   * Cancels ONE stay of a booking that holds several (the booking goes on): its nights / tents / tarp area and the
   * meals that came with it are given back, and the booking's money is worked out again from the stays left —
   * accommodation, total and, on a deposit plan, the deposit (what each stay left for check-in). Money already paid
   * beyond the new total is shown as overpaid, for staff to refund (payments → refund).
   */
  async cancelStay(actor: AuthContext, code: string, itemId: string, reason: string, meta: RequestMeta): Promise<AdminBookingDto> {
    await this.authz.requirePermission(actor, "bookings.cancel", meta);
    const row = await this.expireIfDue(await this.findOr404(code));
    if (row.booking_status !== "PENDING" && row.booking_status !== "CONFIRMED") {
      throw new ConflictError("Only pending or confirmed bookings can change", "BOOKING_NOT_CANCELLABLE");
    }
    const [items, tarp, payments] = await Promise.all([this.repo.items(row.id), this.repo.tarp(row.id), this.payments.payments(row.id)]);
    const target = items.find((i) => i.id === itemId);
    if (!target) throw new NotFoundError("This stay is not part of the booking", "STAY_NOT_FOUND");
    if (target.status !== "ACTIVE") throw new ConflictError("This stay is already cancelled", "STAY_ALREADY_CANCELLED");
    const left = items.filter((i) => i.status === "ACTIVE" && i.id !== itemId);
    if (!left.length) throw new ConflictError("This is the booking's only stay: cancel the booking instead", "LAST_STAY");
    // A payment being checked was for the old amount: settle it first.
    if (payments.some((p) => p.status === "PENDING_VERIFICATION")) {
      throw new ConflictError("A payment for this booking is being checked", "SLIP_PENDING");
    }
    const adults = row.adults - target.adults;
    const children = row.children - target.children;
    if (adults < 1) throw new ConflictError("The stays left would have no adult", "NO_ADULT_LEFT");

    const camping = target.item_type === "OWN_TENT";
    const tarpMoney = camping && tarp?.status === "ACTIVE" ? tarp.subtotal_satang : 0;
    const accommodation = row.accommodation_subtotal_satang - target.snapshot_subtotal_satang - tarpMoney;
    // App fee (migration 0027): an unpaid booking stops paying for the stay's units (its credit hold shrinks with it,
    // trigger); once paid the fee was earned and stays.
    const unpaid = row.booking_status === "PENDING" && row.app_fee_units > 0;
    const feeUnits = unpaid ? row.app_fee_units - target.quantity : row.app_fee_units;
    const appFeeSatang = unpaid ? Math.round(row.app_fee_satang / row.app_fee_units) * feeUnits : row.app_fee_satang;
    const total = accommodation + row.food_subtotal_satang + appFeeSatang - row.discount_satang;
    const deposit = depositFor(total, left.reduce((acc, i) => acc + i.pay_later_satang, 0));
    const now = iso(this.clock());
    const results = await this.db.batch(this.repo.cancelStayStatements({
      bookingId: row.id, itemId, readAt: row.updated_at, reason, now, checkIn: row.check_in, checkOut: row.check_out,
      tents: camping ? target.quantity : 0, tarp: tarpMoney > 0,
      booking: { accommodation, total, deposit, adults, children, appFeeSatang, appFeeUnits: feeUnits, feeChanged: unpaid },
    }));
    if (!results[0]?.results.length) throw new ConflictError("The booking changed meanwhile, please reload", "BOOKING_CHANGED");
    await this.log.auditStatement(actor.userId, "CANCEL_STAY", "bookings", row.id,
      { stay: target.unit_name_snapshot, totalSatang: row.total_satang, depositSatang: row.deposit_satang },
      { bookingCode: row.booking_code, itemId, reason, totalSatang: total, depositSatang: deposit, paidSatang: paidOf(payments) }, meta).run();
    return this.toAdmin((await this.repo.findByCode(row.booking_code))!);
  }

  /**
   * Cancels a PENDING / CONFIRMED booking and gives back what it held; the guest (LINE / e-mail) and the
   * kitchen are told in the same batch. The first statement RETURNs the id when the cancel happened.
   */
  async cancelStatements(row: BookingRow, actorId: string, reason: string, now: string): Promise<D1PreparedStatementLike[]> {
    return [
      this.repo.cancelStatement(row.id, actorId, reason, now),
      ...this.repo.releaseStatements(row.id, row.check_in, row.check_out, now),
      ...(this.outbox ? await this.outbox.bookingCancelled(row.id, row.booking_status === "CONFIRMED", now) : []),
    ];
  }

  /**
   * Stay lifecycle (spec §13): check-in (CONFIRMED, from the check-in date), check-out (CHECKED_IN),
   * no-show (CONFIRMED, from the check-in date). Nights stay reserved — the stay was sold.
   * The DB trigger trg_bookings_status_transition rejects any other move.
   */
  async adminStay(actor: AuthContext, code: string, action: StayAction, meta: RequestMeta): Promise<AdminBookingDto> {
    await this.authz.requirePermission(actor, "bookings.edit", meta);
    const row = await this.expireIfDue(await this.findOr404(code));
    const today = todayIn(await this.quotes.timezone(), this.clock());
    const plan = {
      "check-in": { from: "CONFIRMED", to: "CHECKED_IN", audit: "CHECK_IN", gate: "checkIn" },
      "check-out": { from: "CHECKED_IN", to: "CHECKED_OUT", audit: "CHECK_OUT", gate: "checkOut" },
      "no-show": { from: "CONFIRMED", to: "NO_SHOW", audit: "NO_SHOW", gate: "noShow" },
    } as const;
    const step = plan[action];
    // The same rules the admin shows its buttons by (shared/stay.ts).
    const gate = stayActions(row.booking_status, row.check_in, row.check_out, today)[step.gate];
    if (gate === null) throw new ConflictError(`Booking must be ${step.from} for this action`, "BOOKING_STATUS_INVALID");
    if (gate === "NOT_YET") throw new ConflictError("The stay has not started yet", "STAY_NOT_STARTED");
    if (gate === "ENDED") throw new ConflictError("The stay has already ended", "STAY_ENDED");
    // Deposit plan: the rest is taken at reception first (POST …/balance with checkIn), never skipped.
    if (action === "check-in" && row.deposit_satang !== null && balanceDue(row.total_satang, paidOf(await this.payments.payments(row.id))) > 0) {
      throw new ConflictError("Take the rest of the payment before check-in", "BALANCE_DUE");
    }
    const now = iso(this.clock());
    let results;
    try {
      results = await this.db.batch([
        this.repo.transitionStatement(row.id, step.from, step.to, now),
        this.log.auditStatement(actor.userId, step.audit, "bookings", row.id, { status: step.from }, { status: step.to }, meta),
      ]);
    } catch (error) {
      if (/BALANCE_DUE/.test(String(error))) throw new ConflictError("Take the rest of the payment before check-in", "BALANCE_DUE");
      throw error;
    }
    if (!(results[0]?.results.length)) throw new ConflictError("The booking changed meanwhile, please reload", "BOOKING_STATUS_INVALID");
    return this.toAdmin((await this.repo.findByCode(row.booking_code))!);
  }

  // ================================================================ admin: the rest of a deposit, at reception

  /** What a deposit booking still owes, and the account / PromptPay QR to show the guest. */
  async balance(actor: AuthContext, code: string, meta: RequestMeta): Promise<BalanceDueDto> {
    await this.authz.requirePermission(actor, "bookings.edit", meta);
    const row = await this.expireIfDue(await this.findOr404(code));
    const [payments, primary, snapshot] = await Promise.all([this.payments.payments(row.id), this.payments.primaryAccount(), this.payments.snapshot(row.id)]);
    const paidSatang = paidOf(payments);
    const balanceSatang = balanceDue(row.total_satang, paidSatang);
    const waiting = payments.find((p) => p.status === "PENDING_VERIFICATION");
    // Money taken today goes to today's primary account; the one copied at booking time if there is none.
    const account = primary ? {
      bankName: primary.bank_name, accountName: primary.account_name, accountNumber: primary.account_number,
      promptpayNumber: primary.promptpay_number, qrUrl: publicMediaUrl(primary.qr_key, this.mediaBaseUrl),
    } : snapshot ? {
      bankName: snapshot.bank_name_snapshot, accountName: snapshot.account_name_snapshot, accountNumber: snapshot.account_number_snapshot,
      promptpayNumber: snapshot.promptpay_number_snapshot, qrUrl: publicMediaUrl(snapshot.payment_qr_snapshot, this.mediaBaseUrl),
    } : null;
    return {
      bookingCode: row.booking_code, totalSatang: row.total_satang, paidSatang, balanceSatang, account,
      promptpayPayload: account?.promptpayNumber && balanceSatang > 0 ? promptpayPayload(account.promptpayNumber, balanceSatang) : null,
      pendingSlip: waiting ? { paymentId: waiting.id, amountSatang: waiting.amount_satang, submittedAt: waiting.submitted_at } : null,
    };
  }

  /**
   * Staff took the rest at reception (cash, or a PromptPay / bank transfer they saw arrive) — and, usually, check the
   * guest in. One batch: the payment is inserted only if the booking still owes exactly that amount, and the
   * database refuses the check-in of a deposit booking that is not fully paid (trigger, migration 0025).
   */
  async payBalance(
    actor: AuthContext,
    code: string,
    input: { method: BalanceMethod; reference: string | null; checkIn: boolean },
    meta: RequestMeta,
  ): Promise<AdminBookingDto> {
    await this.authz.requirePermission(actor, "payments.verify", meta);
    if (input.checkIn) await this.authz.requirePermission(actor, "bookings.edit", meta);
    const row = await this.expireIfDue(await this.findOr404(code));
    if (row.booking_status !== "CONFIRMED") throw new ConflictError("Only a confirmed booking can be paid at reception", "BOOKING_STATUS_INVALID");
    const payments = await this.payments.payments(row.id);
    const paidBefore = paidOf(payments);
    const amount = balanceDue(row.total_satang, paidBefore);
    if (amount === 0) throw new ConflictError("Nothing is due on this booking", "NOTHING_DUE");
    // The guest already transferred the rest (slip waiting): verify or reject that first, never take it twice.
    if (payments.some((p) => p.status === "PENDING_VERIFICATION")) {
      throw new ConflictError("A transfer slip for this booking waits for review", "BALANCE_SLIP_PENDING");
    }
    if (input.checkIn) {
      const gate = stayActions(row.booking_status, row.check_in, row.check_out, todayIn(await this.quotes.timezone(), this.clock())).checkIn;
      if (gate === "NOT_YET") throw new ConflictError("The stay has not started yet", "STAY_NOT_STARTED");
      if (gate === "ENDED") throw new ConflictError("The stay has already ended", "STAY_ENDED");
    }
    const now = iso(this.clock());
    const paymentId = newId();
    const results = await this.db.batch([
      this.payments.insertBalancePaymentStatement({ id: paymentId, bookingId: row.id, amount, method: input.method, reference: input.reference, by: actor.userId, now }),
      // Sees the payment above (same transaction); does nothing if the booking moved on meanwhile.
      ...(input.checkIn ? [this.repo.transitionStatement(row.id, "CONFIRMED", "CHECKED_IN", now)] : []),
      // Staff who want payment news hear that the rest came in (only if the payment above was inserted).
      ...(this.outbox?.balancePaid ? await this.outbox.balancePaid(paymentId, row.id, now) : []),
    ]);
    if (!results[0]?.results.length) throw new ConflictError("The booking changed meanwhile, please reload", "BOOKING_CHANGED");
    await this.db.batch([
      this.log.auditStatement(actor.userId, "RECORD_BALANCE_PAYMENT", "payments", paymentId, { paidSatang: paidBefore },
        { bookingCode: row.booking_code, amountSatang: amount, method: input.method, reference: input.reference }, meta),
      ...(input.checkIn && results[1]?.results.length
        ? [this.log.auditStatement(actor.userId, "CHECK_IN", "bookings", row.id, { status: "CONFIRMED" }, { status: "CHECKED_IN" }, meta)] : []),
    ]);
    return this.toAdmin((await this.repo.findByCode(row.booking_code))!);
  }

  async getSettings(actor: AuthContext, meta: RequestMeta): Promise<BookingSettingsDto> {
    if (!this.authz.can(actor, "bookings.view")) await this.authz.requirePermission(actor, "settings.website", meta);
    const s = await this.repo.settings();
    return {
      holdMinutes: s?.hold_minutes ?? 60,
      maxNights: s?.max_nights ?? 30,
      maxAdvanceDays: s?.max_advance_days ?? 365,
      maxTentsPerBooking: s?.max_tents_per_booking ?? 10,
      updatedAt: s?.updated_at ?? null,
    };
  }

  /** Changes apply to new bookings only; existing holds keep their deadline. */
  async saveSettings(
    actor: AuthContext,
    input: { holdMinutes: number; maxNights: number; maxAdvanceDays: number; maxTentsPerBooking: number },
    meta: RequestMeta,
  ): Promise<BookingSettingsDto> {
    await this.authz.requirePermission(actor, "settings.website", meta);
    const before = await this.getSettings(actor, meta);
    await this.db.batch([
      this.repo.saveSettingsStatement(input, actor.userId, iso(this.clock())),
      this.log.auditStatement(actor.userId, "UPDATE_BOOKING_SETTINGS", "settings", "booking_settings",
        { ...before, updatedAt: undefined }, input, meta),
    ]);
    return this.getSettings(actor, meta);
  }

  // ================================================================ admin: change the stay dates

  private get moves(): BookingMoveRepository {
    return new BookingMoveRepository(this.db);
  }

  /** A stay that may move: still to come or waiting for payment, nothing cooked yet. */
  private async movable(row: BookingRow) {
    if (row.booking_status !== "PENDING" && row.booking_status !== "CONFIRMED") {
      throw new ConflictError("Only bookings waiting for payment or confirmed can change dates", "BOOKING_STATUS_INVALID");
    }
    const [items, orders, tarp] = await Promise.all([this.repo.items(row.id), this.moves.foodOrders(row.id), this.repo.tarp(row.id)]);
    if (orders.some((o) => (KITCHEN_STARTED as readonly string[]).includes(o.status))) {
      throw new ConflictError("The kitchen has started on a meal of this booking", "KITCHEN_STARTED");
    }
    // Every stay still on moves together (same dates for all the stays of a booking).
    const live = items.filter((i) => i.status === "ACTIVE");
    if (!live.length) throw new ConflictError("This booking has nothing to move", "BOOKING_STATUS_INVALID");
    const units = live.filter((i) => i.unit_id).map((i) => ({ unitId: i.unit_id!, itemId: i.id }));
    const tents = live.filter((i) => !i.unit_id).reduce((acc, i) => acc + i.quantity, 0);
    return { units, tents, orders: orders.filter((o) => o.status !== "CANCELLED" && o.capacity_reserved > 0), tarps: tarp?.status === "ACTIVE" ? tarp.quantity : 0 };
  }

  /** Everything the day check needs for new check-in days in [from, to), read once. */
  private async moveInputs(row: BookingRow, today: string, from: string, to: string): Promise<{ inputs: MoveInputs; plan: Awaited<ReturnType<BookingService["movable"]>> }> {
    const plan = await this.movable(row);
    const until = addDays(to, row.nights);
    const own = new Set(stayNights(row.check_in, row.check_out));
    let unitTaken: Set<string> | null = null;
    let tents: MoveInputs["tents"] = null;
    let tarps: MoveInputs["tarps"] = null;
    if (plan.units.length) {
      // A night is taken when any of the booking's houses / VIP tents is held by someone else (or blocked).
      unitTaken = new Set((await Promise.all(plan.units.map((u) => this.moves.unitTaken(u.unitId, row.id, from, until)))).flatMap((t) => [...t]));
    }
    if (plan.tents > 0) {
      const [settings, nights, tarpNights] = await Promise.all([
        this.moves.campingSettings(), this.moves.campingNights(from, until),
        plan.tarps > 0 ? this.moves.tarpNights(from, until) : Promise.resolve([]),
      ]);
      const byDate = new Map(nights.map((n) => [n.stay_date, n]));
      const tarpByDate = new Map(tarpNights.map((n) => [n.stay_date, n]));
      const need = plan.tents;
      tents = {
        need,
        free: (d) => (settings?.is_enabled !== 1 ? 0
          : (byDate.get(d)?.max_tents ?? settings.max_tents_per_night) - (byDate.get(d)?.tents_used ?? 0) + (own.has(d) ? need : 0)),
      };
      if (plan.tarps > 0) {
        tarps = {
          need: plan.tarps,
          free: (d) => (tarpByDate.get(d)?.max_tarps ?? settings?.max_tarps_per_night ?? 0) - (tarpByDate.get(d)?.tarps_used ?? 0) + (own.has(d) ? plan.tarps : 0),
        };
      }
    }
    const food = plan.orders.map((o) => ({ offset: diffDays(row.check_in, o.service_date), categoryId: o.food_category_id, need: o.capacity_reserved }));
    const offsets = food.map((f) => f.offset);
    const capacity = await this.moves.foodCapacity(
      [...new Set(food.map((f) => f.categoryId))],
      addDays(from, Math.min(0, ...offsets)), addDays(to, Math.max(0, ...offsets) + 1),
    );
    const capKey = (c: string, d: string) => `${c}|${d}`;
    const capByKey = new Map(capacity.map((c) => [capKey(c.food_category_id, c.service_date), c]));
    const ownFood = new Map(plan.orders.map((o) => [capKey(o.food_category_id, o.service_date), o.capacity_reserved]));
    const defaults = new Map(plan.orders.map((o) => [o.food_category_id, o.default_daily_capacity]));
    const foodFree = (c: string, d: string) => {
      const cap = capByKey.get(capKey(c, d));
      const max = cap ? cap.max_quantity : defaults.get(c) ?? null;
      return max === null ? Number.POSITIVE_INFINITY : max - (cap?.used_quantity ?? 0) + (ownFood.get(capKey(c, d)) ?? 0);
    };
    return { inputs: { checkIn: row.check_in, nights: row.nights, today, unitTaken, tents, tarps, food, foodFree }, plan };
  }

  /** The calendar: for each day in [from, from + days), could the stay start there (same nights)? */
  async moveOptions(actor: AuthContext, code: string, from: string, days: number, meta: RequestMeta): Promise<BookingMoveOptionsDto> {
    await this.authz.requirePermission(actor, "bookings.edit", meta);
    const row = await this.expireIfDue(await this.findOr404(code));
    const today = todayIn(await this.quotes.timezone(), this.clock());
    const { inputs } = await this.moveInputs(row, today, from, addDays(from, days));
    return {
      checkIn: row.check_in, checkOut: row.check_out, nights: row.nights, today,
      days: Array.from({ length: days }, (_, i) => addDays(from, i)).map((date) => ({ date, state: moveDayState(date, inputs) })),
    };
  }

  /**
   * Moves the stay to start on `checkIn` (same number of nights). One D1 batch: dates, night locks or tent / tarp
   * counters, meals and their kitchen capacity — the database refuses anything that no longer fits. The price
   * the guest booked at stays (snapshots are never re-priced).
   */
  async moveDates(actor: AuthContext, code: string, checkIn: string, meta: RequestMeta) {
    await this.authz.requirePermission(actor, "bookings.edit", meta);
    const row = await this.expireIfDue(await this.findOr404(code));
    const today = todayIn(await this.quotes.timezone(), this.clock());
    const { inputs, plan } = await this.moveInputs(row, today, checkIn, addDays(checkIn, 1));
    const refused: Partial<Record<MoveDayState, [number, string, string]>> = {
      CURRENT: [422, "SAME_DATES", "The booking already starts on that day"],
      PAST: [422, "DATE_IN_PAST", "That day has passed"],
      TOO_FAR: [422, "DATE_TOO_FAR", "That day is too far ahead"],
      TAKEN: [409, "DATES_UNAVAILABLE", "Those nights are not free"],
      TARP_FULL: [409, "TARP_FULL", "No tarp area is left on those nights"],
      FOOD_FULL: [409, "FOOD_UNAVAILABLE", "A meal of this booking is sold out on its new day"],
    };
    const no = refused[moveDayState(checkIn, inputs)];
    if (no) throw new HttpError(no[0], no[1], no[2]);

    const checkOut = addDays(checkIn, row.nights);
    const now = iso(this.clock());
    let results;
    try {
      results = await this.db.batch(this.moves.moveStatements({
        bookingId: row.id,
        from: { checkIn: row.check_in, checkOut: row.check_out },
        to: { checkIn, checkOut },
        offset: diffDays(row.check_in, checkIn),
        units: plan.units,
        tents: plan.tents,
        tarps: plan.tarps,
        now,
      }));
    } catch (error) {
      // Taken between the calendar and the click: the whole batch rolled back, nothing moved.
      const text = String(error);
      if (/booking_unit_nights|tents_used/.test(text)) throw new ConflictError("Those nights are not free", "DATES_UNAVAILABLE");
      if (/tarps_used/.test(text)) throw new ConflictError("No tarp area is left on those nights", "TARP_FULL");
      if (/used_quantity/.test(text)) throw new ConflictError("A meal of this booking is sold out on its new day", "FOOD_UNAVAILABLE");
      throw error;
    }
    if (!results[0]?.results.length) throw new ConflictError("The booking changed meanwhile, please reload", "BOOKING_CHANGED");
    await this.log.auditStatement(actor.userId, "MOVE_BOOKING", "bookings", row.id,
      { checkIn: row.check_in, checkOut: row.check_out }, { checkIn, checkOut }, meta).run();
    return this.toAdmin((await this.repo.findByCode(row.booking_code))!);
  }

  private async findOr404(code: string): Promise<BookingRow> {
    const row = BOOKING_CODE_PATTERN.test(code) ? await this.repo.findByCode(code) : null;
    if (!row) throw new NotFoundError("Booking not found", "BOOKING_NOT_FOUND");
    return row;
  }

  // ================================================================ DTOs (from snapshots, never from current prices)

  private async toPublic(row: BookingRow): Promise<PublicBookingDto> {
    // Payment details only while the booking is still waiting for money…
    const awaitingPayment = row.booking_status === "PENDING" && (row.payment_status === "UNPAID" || row.payment_status === "REJECTED");
    // …or, on a deposit plan, while the confirmed booking still owes the rest (the guest may transfer it before the stay).
    const owing = row.booking_status === "CONFIRMED" && row.deposit_satang !== null;
    const [items, included, food, snapshot, lineUpdates, tarp, paySettings, payments] = await Promise.all([
      this.repo.items(row.id),
      this.repo.includedMeals(row.id),
      this.repo.food(row.id),
      this.payments.snapshot(row.id),
      this.lineStatus ? this.lineStatus(row) : Promise.resolve({ available: false, linked: false }),
      this.repo.tarp(row.id),
      awaitingPayment || owing ? this.payments.settings() : Promise.resolve(null),
      this.payments.payments(row.id),
    ]);
    const rejected = payments.filter((p) => p.status === "REJECTED").at(-1);
    const paidSatang = paidOf(payments);
    const balanceSatang = balanceDue(row.total_satang, paidSatang);
    // Asked online: the deposit on a deposit plan, else the whole total.
    const dueNow = dueOnline(row);
    // Always the account copied onto the booking: the slip check compares the receiver with it.
    const instructions = (amount: number, paypal: boolean): PaymentInstructionsDto | null => snapshot && paySettings ? {
      bankName: snapshot.bank_name_snapshot,
      accountName: snapshot.account_name_snapshot,
      accountNumber: snapshot.account_number_snapshot,
      promptpayNumber: snapshot.promptpay_number_snapshot,
      qrUrl: publicMediaUrl(snapshot.payment_qr_snapshot, this.mediaBaseUrl),
      amountDueSatang: amount,
      channels: availableChannels(paySettings, {
        promptpay: snapshot.promptpay_number_snapshot, accountNumber: snapshot.account_number_snapshot, qr: snapshot.payment_qr_snapshot,
      }, paypal),
      promptpayPayload: snapshot.promptpay_number_snapshot && amount > 0 ? promptpayPayload(snapshot.promptpay_number_snapshot, amount) : null,
    } : null;
    // Payments sent after the booking was confirmed: the rest of the deposit.
    const later = row.confirmed_at ? payments.filter((p) => p.submitted_at > row.confirmed_at!) : [];
    const reviewing = payments.some((p) => p.status === "PENDING_VERIFICATION");
    const lastLater = later.at(-1);
    // Stays in the order chosen; one cancelled alone by staff (the booking goes on) is marked so.
    const stays = items.map((i): QuoteItemDto => ({
      id: i.id,
      status: i.cancelled_at ? "CANCELLED" : "ACTIVE",
      cancelReason: i.cancel_reason,
      type: i.item_type,
      unitId: i.unit_id,
      slug: i.slug,
      name: i.unit_name_snapshot,
      quantity: i.quantity,
      pricingType: i.pricing_type,
      nightly: i.nightly_prices_json ? (JSON.parse(i.nightly_prices_json) as NightPriceDto[]) : [],
      subtotalSatang: i.snapshot_subtotal_satang,
      adults: i.adults,
      children: i.children,
      payLaterSatang: i.pay_later_satang,
    }));
    const cancelledAlone = new Set(items.filter((i) => i.cancelled_at).map((i) => i.id));
    const live = stays.filter((x) => x.status === "ACTIVE");
    const ended = row.booking_status === "CANCELLED" || row.booking_status === "EXPIRED";
    return {
      bookingCode: row.booking_code,
      status: row.booking_status as BookingStatus,
      paymentStatus: row.payment_status as PaymentStatus,
      customerName: row.customer_name,
      customerPhoneMasked: maskPhone(row.customer_phone),
      expiresAt: row.booking_status === "PENDING" ? row.expires_at : null,
      createdAt: row.created_at,
      lineUpdates,
      paymentInstructions: awaitingPayment ? instructions(dueNow, this.paypalReady) : null,
      // The rest by transfer + slip only (no PayPal): staff or the verification service check it like the deposit.
      balancePayment: owing && balanceSatang > 0 && snapshot && paySettings ? {
        instructions: reviewing ? null : instructions(balanceSatang, false),
        reviewing,
        rejectedReason: !reviewing && lastLater?.status === "REJECTED" ? lastLater.rejected_reason ?? "" : null,
      } : null,
      paymentRejectedReason: rejected?.rejected_reason ?? null,
      cancelReason: row.booking_status === "CANCELLED" ? row.cancel_reason : null,
      checkIn: row.check_in,
      checkOut: row.check_out,
      nights: row.nights,
      adults: row.adults,
      children: row.children,
      items: stays,
      item: live[0] ?? stays[0]!,
      // The tarp area belongs to the camping stay: gone with it when staff cancelled that stay alone.
      tarp: tarp && (tarp.status === "ACTIVE" || ended) ? {
        quantity: tarp.quantity, pricePerNightSatang: tarp.price_per_night_satang, nights: tarp.number_of_nights, subtotalSatang: tarp.subtotal_satang,
      } : null,
      // Meals of a stay cancelled alone went with it; with several stays, each meal says which stay it comes with.
      includedMeals: included.filter((m) => !cancelledAlone.has(m.booking_item_id)).map((m) => ({
        categoryCode: m.category_code, name: m.meal_name_snapshot, personsPerNight: m.persons_per_night_snapshot, nights: m.number_of_nights,
        ...(live.length > 1 ? { stayName: m.stay_name } : {}),
      })),
      food: food.filter((f) => ended || f.status !== "CANCELLED").map((f): FoodLineDto => ({
        optionId: f.food_option_id,
        categoryCode: f.category_code_snapshot,
        name: f.option_name_snapshot,
        serviceDate: f.service_date,
        pricingType: f.pricing_type_snapshot,
        adults: f.adults,
        children: f.children,
        quantity: f.quantity,
        includedQuantity: f.included_quantity,
        unitPriceSatang: f.unit_price_snapshot_satang,
        subtotalSatang: f.subtotal_satang,
      })),
      accommodationSubtotalSatang: row.accommodation_subtotal_satang,
      foodSubtotalSatang: row.food_subtotal_satang,
      discountSatang: row.discount_satang,
      totalSatang: row.total_satang,
      currency: row.currency,
      depositSatang: row.deposit_satang,
      appFee: appFeeOf(row),
      paidSatang,
      balanceSatang,
    };
  }

  private async toAdmin(row: BookingRow): Promise<AdminBookingDto> {
    const [snapshot, payments, modeToday] = await Promise.all([
      this.payments.snapshot(row.id), this.payments.payments(row.id),
      row.deposit_satang !== null ? currentPaymentMode(this.db, row.id) : Promise.resolve(null),
    ]);
    return {
      ...(await this.toPublic(row)),
      // The deposit was fixed at booking time: a later switch of the stay to full payment does not change this booking.
      depositPlanKept: modeToday === "FULL",
      // A stay cancelled after payment: money received beyond the new total, for staff to refund.
      overpaidSatang: row.booking_status === "CANCELLED" || row.booking_status === "EXPIRED" ? 0 : Math.max(0, paidOf(payments) - row.total_satang),
      paymentAccount: snapshot ? {
        receivingAccountId: snapshot.receiving_account_id,
        bankName: snapshot.bank_name_snapshot,
        accountName: snapshot.account_name_snapshot,
        accountNumber: snapshot.account_number_snapshot,
        promptpayNumber: snapshot.promptpay_number_snapshot,
        qrUrl: publicMediaUrl(snapshot.payment_qr_snapshot, this.mediaBaseUrl),
        capturedAt: snapshot.captured_at,
      } : null,
      payments: payments.map(toPaymentDto),
      expiresAt: row.expires_at,
      id: row.id,
      source: row.source,
      languageCode: row.language_code,
      customerPhone: row.customer_phone,
      customerEmail: row.customer_email,
      customerLineId: row.customer_line_id,
      customerNote: row.customer_note,
      privacyAcceptedAt: row.privacy_accepted_at,
      cancelledAt: row.cancelled_at,
      cancelReason: row.cancel_reason,
      updatedAt: row.updated_at,
      stayActions: stayActions(row.booking_status, row.check_in, row.check_out, todayIn(await this.quotes.timezone(), this.clock())),
    };
  }
}

/** Maps database constraint failures from the booking batch to business errors. */
/** App fee of a booking (migration 0027): units × per unit; null when it has none. */
export function appFeeOf(row: Pick<BookingRow, "app_fee_units" | "app_fee_satang">): AppFeeDto | null {
  if (!row.app_fee_units || !row.app_fee_satang) return null;
  return { units: row.app_fee_units, perUnitSatang: Math.round(row.app_fee_satang / row.app_fee_units), totalSatang: row.app_fee_satang };
}

export function mapInventoryError(error: unknown): unknown {
  const message = String(error);
  if (/CREDIT_INSUFFICIENT/.test(message)) {
    return new ConflictError("Online booking is temporarily unavailable", "CREDIT_INSUFFICIENT");
  }
  if (/UNIQUE constraint failed: booking_unit_nights/.test(message)) {
    return new ConflictError("This accommodation was just booked by someone else", "UNIT_UNAVAILABLE");
  }
  if (/CHECK constraint failed: .*tents_used/.test(message)) {
    return new ConflictError("Not enough camping space for these nights", "CAMPING_FULL");
  }
  if (/CHECK constraint failed: .*tarps_used/.test(message)) {
    return new ConflictError("No tarp area left for these nights", "TARP_FULL");
  }
  if (/TARP_DISABLED/.test(message)) {
    return new ConflictError("The tarp area option is not offered", "TARP_UNAVAILABLE");
  }
  if (/NOT NULL constraint failed: payment_account_snapshots/.test(message)) {
    return new ConflictError("Online booking is temporarily unavailable", "PAYMENT_NOT_CONFIGURED");
  }
  if (/CAMPING_DISABLED/.test(message)) {
    return new NotFoundError("Camping is not available", "CAMPING_UNAVAILABLE");
  }
  if (/UNIT_NOT_BOOKABLE/.test(message)) {
    return new NotFoundError("Accommodation not found", "ACCOMMODATION_NOT_FOUND");
  }
  if (/CHECK constraint failed: .*used_quantity/.test(message)) {
    return new ConflictError("Not enough portions left for this meal", "FOOD_CAPACITY_EXCEEDED");
  }
  return error;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
