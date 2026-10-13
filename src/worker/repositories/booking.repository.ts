import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";
import { containsPattern } from "./sql-like.ts";

export interface BookingRow {
  id: string;
  booking_code: string;
  language_code: string;
  source: string;
  check_in: string;
  check_out: string;
  nights: number;
  adults: number;
  children: number;
  customer_name: string;
  customer_phone: string;
  customer_phone_normalized: string;
  customer_email: string | null;
  customer_line_id: string | null;
  customer_note: string | null;
  booking_status: string;
  payment_status: string;
  accommodation_subtotal_satang: number;
  food_subtotal_satang: number;
  subtotal_satang: number;
  discount_satang: number;
  total_satang: number;
  /** Deposit plan: amount asked online; null = full payment (migration 0025). */
  deposit_satang: number | null;
  currency: string;
  expires_at: string | null;
  /** When the booking was confirmed (payment in); later payments are the rest of a deposit. */
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  idempotency_key: string | null;
  privacy_accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BookingItemRow {
  id: string;
  item_type: "HOUSE" | "VIP_TENT" | "OWN_TENT";
  unit_id: string | null;
  quantity: number;
  status: string;
  slug: string | null;
  unit_name_snapshot: string;
  pricing_type: "PER_UNIT_NIGHT" | "PER_ADULT_NIGHT";
  nightly_prices_json: string | null;
  snapshot_subtotal_satang: number;
}

export interface BookingIncludedRow {
  meal_name_snapshot: string;
  persons_per_night_snapshot: number;
  number_of_nights: number;
  category_code: string;
}

export interface BookingFoodRow {
  food_option_id: string;
  service_date: string;
  option_name_snapshot: string;
  category_code_snapshot: string;
  pricing_type_snapshot: "PER_PERSON" | "PER_SET" | "PER_ITEM" | "PER_NIGHT";
  unit_price_snapshot_satang: number;
  adults: number;
  children: number;
  quantity: number;
  included_quantity: number;
  subtotal_satang: number;
  status: string;
}

export interface AdminBookingListRow {
  id: string;
  booking_code: string;
  booking_status: string;
  payment_status: string;
  check_in: string;
  check_out: string;
  nights: number;
  adults: number;
  children: number;
  customer_name: string;
  customer_phone: string;
  total_satang: number;
  deposit_satang: number | null;
  /** Money received: verified / paid payments. */
  paid_satang: number;
  expires_at: string | null;
  created_at: string;
  item_type: "HOUSE" | "VIP_TENT" | "OWN_TENT";
  item_name: string;
  quantity: number;
  tarps: number;
}

export interface BookingTarpRow {
  quantity: number;
  price_per_night_satang: number;
  number_of_nights: number;
  subtotal_satang: number;
  status: string;
}

const bookingColumns = (deposit: string) => `id, booking_code, language_code, source, check_in, check_out, nights, adults, children, customer_name,
  customer_phone, customer_phone_normalized, customer_email, customer_line_id, customer_note, booking_status, payment_status,
  accommodation_subtotal_satang, food_subtotal_satang, subtotal_satang, discount_satang, total_satang, ${deposit} AS deposit_satang, currency, expires_at,
  confirmed_at, cancelled_at, cancel_reason, idempotency_key, privacy_accepted_at, created_at, updated_at`;
const BOOKING_COLUMNS = bookingColumns("deposit_satang");
/** Before migration 0025: no booking has a deposit. */
const BOOKING_COLUMNS_LEGACY = bookingColumns("NULL");

/** Money received for booking `b` (verified / paid payments). What is still due = total_satang − this. */
export const PAID_SQL = `(SELECT COALESCE(SUM(p.amount_satang), 0) FROM payments p WHERE p.booking_id = b.id AND p.status IN ('VERIFIED', 'PAID'))`;

/** SQL for bookings. The service composes these statements into one atomic batch. */
export class BookingRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  findByCode(code: string): Promise<BookingRow | null> {
    return withFallback(
      () => this.db.prepare(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE booking_code = ?1`).bind(code).first<BookingRow>(),
      () => this.db.prepare(`SELECT ${BOOKING_COLUMNS_LEGACY} FROM bookings WHERE booking_code = ?1`).bind(code).first<BookingRow>(),
    );
  }

  findById(id: string): Promise<BookingRow | null> {
    return withFallback(
      () => this.db.prepare(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = ?1`).bind(id).first<BookingRow>(),
      () => this.db.prepare(`SELECT ${BOOKING_COLUMNS_LEGACY} FROM bookings WHERE id = ?1`).bind(id).first<BookingRow>(),
    );
  }

  findByIdempotencyKey(key: string): Promise<BookingRow | null> {
    return withFallback(
      () => this.db.prepare(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE idempotency_key = ?1`).bind(key).first<BookingRow>(),
      () => this.db.prepare(`SELECT ${BOOKING_COLUMNS_LEGACY} FROM bookings WHERE idempotency_key = ?1`).bind(key).first<BookingRow>(),
    );
  }

  async items(bookingId: string): Promise<BookingItemRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT i.id, i.item_type, i.unit_id, i.quantity, i.status, u.slug, s.unit_name_snapshot, s.pricing_type,
                s.nightly_prices_json, s.subtotal_satang AS snapshot_subtotal_satang
           FROM booking_items i
           JOIN booking_price_snapshots s ON s.booking_item_id = i.id
           LEFT JOIN accommodation_units u ON u.id = i.unit_id
          WHERE i.booking_id = ?1 ORDER BY i.created_at, i.id`,
      )
      .bind(bookingId)
      .all<BookingItemRow>();
    return results;
  }

  /** Tarp area snapshot of a booking (camping add-on), if it has one. */
  async tarp(bookingId: string): Promise<BookingTarpRow | null> {
    try {
      return await this.db
        .prepare("SELECT quantity, price_per_night_satang, number_of_nights, subtotal_satang, status FROM booking_tarps WHERE booking_id = ?1")
        .bind(bookingId)
        .first<BookingTarpRow>();
    } catch (error) {
      if (/no such table/i.test(String(error))) return null; // before migration 0021
      throw error;
    }
  }

  async includedMeals(bookingId: string): Promise<BookingIncludedRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT m.meal_name_snapshot, m.persons_per_night_snapshot, m.number_of_nights, c.code AS category_code
           FROM booking_included_meals m JOIN food_categories c ON c.id = m.food_category_id
          WHERE m.booking_id = ?1 ORDER BY c.sort_order, m.id`,
      )
      .bind(bookingId)
      .all<BookingIncludedRow>();
    return results;
  }

  async food(bookingId: string): Promise<BookingFoodRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT food_option_id, service_date, option_name_snapshot, category_code_snapshot, pricing_type_snapshot,
                unit_price_snapshot_satang, adults, children, quantity, included_quantity, subtotal_satang, status
           FROM booking_food_items WHERE booking_id = ?1
          ORDER BY service_date, category_code_snapshot, included_quantity DESC, option_name_snapshot`,
      )
      .bind(bookingId)
      .all<BookingFoodRow>();
    return results;
  }

  async list(filter: {
    status?: string; payment?: string; from?: string; to?: string; q?: string; qPhone?: string | null; before?: string; limit: number;
    /** Only confirmed deposit bookings that still owe money (taken at check-in or transferred before). */
    due?: boolean;
  }): Promise<AdminBookingListRow[]> {
    return withFallback(() => this.listWith(filter, "b.deposit_satang"), () => this.listWith(filter, "NULL"));
  }

  private async listWith(filter: {
    status?: string; payment?: string; from?: string; to?: string; q?: string; qPhone?: string | null; before?: string; limit: number;
    /** Only confirmed deposit bookings that still owe money (taken at check-in or transferred before). */
    due?: boolean;
  }, deposit: string): Promise<AdminBookingListRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT b.id, b.booking_code, b.booking_status, b.payment_status, b.check_in, b.check_out, b.nights, b.adults, b.children,
                b.customer_name, b.customer_phone, b.total_satang, ${deposit} AS deposit_satang, ${PAID_SQL} AS paid_satang, b.expires_at, b.created_at,
                i.item_type, s.unit_name_snapshot AS item_name, i.quantity,
                (SELECT COALESCE(SUM(t.quantity), 0) FROM booking_tarps t WHERE t.booking_id = b.id) AS tarps
           FROM bookings b
           JOIN booking_items i ON i.id = (SELECT id FROM booking_items WHERE booking_id = b.id ORDER BY created_at, id LIMIT 1)
           JOIN booking_price_snapshots s ON s.booking_item_id = i.id
          WHERE (?1 IS NULL OR b.booking_status = ?1)
            AND (?2 IS NULL OR b.check_out > ?2)
            AND (?3 IS NULL OR b.check_in <= ?3)
            AND (?4 IS NULL OR b.booking_code = ?4 OR b.customer_phone_normalized = ?5 OR b.customer_name LIKE ?6 ESCAPE '\\')
            AND (?7 IS NULL OR b.created_at < ?7)
            AND (?9 IS NULL OR b.payment_status = ?9)
            AND (?10 = 0 OR (b.booking_status = 'CONFIRMED' AND ${deposit} IS NOT NULL AND b.total_satang > ${PAID_SQL}))
          ORDER BY b.created_at DESC, b.id DESC LIMIT ?8`,
      )
      .bind(
        filter.status ?? null,
        filter.from ?? null,
        filter.to ?? null,
        filter.q ?? null,
        filter.qPhone ?? null,
        filter.q ? containsPattern(filter.q) : null,
        filter.before ?? null,
        filter.limit,
        filter.payment ?? null,
        filter.due ? 1 : 0,
      )
      .all<AdminBookingListRow>();
    return results;
  }

  async dueForExpiry(now: string, limit: number): Promise<{ id: string; booking_code: string; check_in: string; check_out: string }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, booking_code, check_in, check_out FROM bookings
          WHERE booking_status = 'PENDING' AND payment_status IN ('UNPAID', 'REJECTED') AND expires_at IS NOT NULL AND expires_at <= ?1
          ORDER BY expires_at LIMIT ?2`,
      )
      .bind(now, limit)
      .all<{ id: string; booking_code: string; check_in: string; check_out: string }>();
    return results;
  }

  // ================================================================ create (one atomic batch)

  insertBookingStatement(b: {
    id: string; code: string; lang: string; checkIn: string; checkOut: string; nights: number; adults: number; children: number;
    name: string; phone: string; phoneNormalized: string; email: string | null; lineId: string | null; note: string | null;
    accommodationSubtotal: number; foodSubtotal: number; total: number; deposit: number | null; currency: string; expiresAt: string;
    idempotencyKey: string; privacyAcceptedAt: string; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO bookings (id, booking_code, language_code, source, check_in, check_out, nights, adults, children,
           customer_name, customer_phone, customer_phone_normalized, customer_email, customer_line_id, customer_note,
           booking_status, payment_status, accommodation_subtotal_satang, food_subtotal_satang, subtotal_satang,
           discount_satang, total_satang, currency, expires_at, idempotency_key, privacy_accepted_at, created_at, updated_at,
           deposit_satang)
         VALUES (?1, ?2, ?3, 'WEB', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'PENDING', 'UNPAID', ?15, ?16, ?17, 0, ?17,
           ?18, ?19, ?20, ?21, ?22, ?22, ?23)`,
      )
      .bind(b.id, b.code, b.lang, b.checkIn, b.checkOut, b.nights, b.adults, b.children, b.name, b.phone, b.phoneNormalized,
        b.email, b.lineId, b.note, b.accommodationSubtotal, b.foodSubtotal, b.accommodationSubtotal + b.foodSubtotal,
        b.currency, b.expiresAt, b.idempotencyKey, b.privacyAcceptedAt, b.now, b.deposit);
  }

  insertItemStatement(i: {
    id: string; bookingId: string; type: string; unitId: string | null; quantity: number; adults: number; children: number; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_items (id, booking_id, item_type, unit_id, quantity, adults, children, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(i.id, i.bookingId, i.type, i.unitId, i.quantity, i.adults, i.children, i.now);
  }

  /** PK (unit_id, stay_date) makes a second booking of the same night fail the whole batch. */
  lockNightStatement(unitId: string, date: string, bookingId: string, itemId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_unit_nights (unit_id, stay_date, booking_id, booking_item_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(unitId, date, bookingId, itemId, now);
  }

  /**
   * Camping: create the night row at the *current* default capacity (read inside the
   * transaction, never a value cached at quote time), then take tents.
   * CHECK (tents_used <= max_tents) rejects overflow and rolls back the whole booking.
   */
  reserveTentsStatements(date: string, tents: number, now: string): D1PreparedStatementLike[] {
    return [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO camping_night_inventory (stay_date, max_tents, tents_used, is_override, updated_at)
           SELECT ?1, max_tents_per_night, 0, 0, ?2 FROM camping_settings WHERE id = 1`,
        )
        .bind(date, now),
      this.db
        .prepare("UPDATE camping_night_inventory SET tents_used = tents_used + ?2, updated_at = ?3 WHERE stay_date = ?1")
        .bind(date, tents, now),
    ];
  }

  /** Tarp areas: same pattern as tents — night row at the current default, then take; CHECK rejects overflow. */
  reserveTarpStatements(date: string, quantity: number, now: string): D1PreparedStatementLike[] {
    return [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO camping_tarp_night_inventory (stay_date, max_tarps, tarps_used, updated_at)
           SELECT ?1, max_tarps_per_night, 0, ?2 FROM camping_settings WHERE id = 1`,
        )
        .bind(date, now),
      this.db
        .prepare("UPDATE camping_tarp_night_inventory SET tarps_used = tarps_used + ?2, updated_at = ?3 WHERE stay_date = ?1")
        .bind(date, quantity, now),
    ];
  }

  /** Tarp price snapshot (immutable money fields; triggers check camping + option offered). */
  insertTarpStatement(t: {
    id: string; bookingId: string; quantity: number; pricePerNight: number; nights: number; subtotal: number; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_tarps (id, booking_id, quantity, price_per_night_satang, number_of_nights, subtotal_satang, status, captured_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ACTIVE', ?7)`,
      )
      .bind(t.id, t.bookingId, t.quantity, t.pricePerNight, t.nights, t.subtotal, t.now);
  }

  insertPriceSnapshotStatement(s: {
    id: string; bookingId: string; itemId: string; unitId: string | null; name: string; unitType: string; price: number;
    pricingType: string; quantity: number; nights: number; adults: number; children: number; nightlyJson: string;
    subtotal: number; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_price_snapshots (id, booking_id, booking_item_id, unit_id, unit_name_snapshot, unit_type,
           price_snapshot_satang, pricing_type, quantity, number_of_nights, adult_count, child_count, nightly_prices_json,
           subtotal_satang, discount_satang, total_satang, captured_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, ?14, ?15)`,
      )
      .bind(s.id, s.bookingId, s.itemId, s.unitId, s.name, s.unitType, s.price, s.pricingType, s.quantity, s.nights,
        s.adults, s.children, s.nightlyJson, s.subtotal, s.now);
  }

  insertIncludedMealStatement(m: {
    id: string; bookingId: string; itemId: string; includedMealId: string; categoryId: string; optionId: string | null;
    name: string; persons: number; nights: number; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_included_meals (id, booking_id, booking_item_id, included_meal_id, food_category_id, food_option_id,
           meal_name_snapshot, persons_per_night_snapshot, number_of_nights, captured_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(m.id, m.bookingId, m.itemId, m.includedMealId, m.categoryId, m.optionId, m.name, m.persons, m.nights, m.now);
  }

  /** Same pattern as camping: CHECK(used_quantity <= max_quantity) rejects overflow atomically. */
  reserveFoodStatements(categoryId: string, date: string, quantity: number, defaultMax: number, now: string): D1PreparedStatementLike[] {
    return [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO food_daily_capacity (food_category_id, service_date, max_quantity, used_quantity, updated_at)
           VALUES (?1, ?2, ?3, 0, ?4)`,
        )
        .bind(categoryId, date, defaultMax, now),
      this.db
        .prepare(
          `UPDATE food_daily_capacity SET used_quantity = used_quantity + ?3, updated_at = ?4
            WHERE food_category_id = ?1 AND service_date = ?2`,
        )
        .bind(categoryId, date, quantity, now),
    ];
  }

  insertFoodOrderStatement(o: {
    id: string; bookingId: string; categoryId: string; date: string; persons: number; reserved: number; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO food_orders (id, booking_id, food_category_id, service_date, status, total_persons, capacity_reserved,
           created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'PENDING', ?5, ?6, ?7, ?7)`,
      )
      .bind(o.id, o.bookingId, o.categoryId, o.date, o.persons, o.reserved, o.now);
  }

  insertFoodItemStatement(f: {
    id: string; bookingId: string; orderId: string; optionId: string; date: string; name: string; categoryCode: string;
    pricingType: string; unitPrice: number; childPricing: string; childPrice: number | null; adults: number; children: number;
    quantity: number; included: number; subtotal: number; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_food_items (id, booking_id, food_order_id, food_option_id, service_date, option_name_snapshot,
           category_code_snapshot, pricing_type_snapshot, unit_price_snapshot_satang, child_pricing_snapshot,
           child_price_snapshot_satang, adults, children, quantity, included_quantity, subtotal_satang, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
      )
      .bind(f.id, f.bookingId, f.orderId, f.optionId, f.date, f.name, f.categoryCode, f.pricingType, f.unitPrice,
        f.childPricing, f.childPrice, f.adults, f.children, f.quantity, f.included, f.subtotal, f.now);
  }

  // ================================================================ end of a hold (cancel / expire)

  /** PENDING + UNPAID + past expiry → EXPIRED. RETURNING tells the caller whether this call made the change. */
  expireStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE bookings SET booking_status = 'EXPIRED', updated_at = ?2
          WHERE id = ?1 AND booking_status = 'PENDING' AND payment_status IN ('UNPAID', 'REJECTED') AND expires_at <= ?2
          RETURNING id`,
      )
      .bind(bookingId, now);
  }

  /** Stay lifecycle step (check-in / check-out / no-show). Only from the expected status. */
  transitionStatement(bookingId: string, from: string, to: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(`UPDATE bookings SET booking_status = ?3, updated_at = ?4 WHERE id = ?1 AND booking_status = ?2 RETURNING id`)
      .bind(bookingId, from, to, now);
  }

  async settings(): Promise<{ hold_minutes: number; max_nights: number; max_advance_days: number; max_tents_per_booking: number; updated_at: string } | null> {
    return this.db
      .prepare("SELECT hold_minutes, max_nights, max_advance_days, max_tents_per_booking, updated_at FROM booking_settings WHERE id = 1")
      .first();
  }

  saveSettingsStatement(s: { holdMinutes: number; maxNights: number; maxAdvanceDays: number; maxTentsPerBooking: number }, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_settings (id, hold_minutes, max_nights, max_advance_days, max_tents_per_booking, updated_at, updated_by)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (id) DO UPDATE SET hold_minutes = excluded.hold_minutes, max_nights = excluded.max_nights,
           max_advance_days = excluded.max_advance_days, max_tents_per_booking = excluded.max_tents_per_booking,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(s.holdMinutes, s.maxNights, s.maxAdvanceDays, s.maxTentsPerBooking, now, actorId);
  }

  cancelStatement(bookingId: string, actorId: string, reason: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE bookings SET booking_status = 'CANCELLED', cancelled_at = ?3, cancelled_by = ?2, cancel_reason = ?4, updated_at = ?3
          WHERE id = ?1 AND booking_status IN ('PENDING', 'CONFIRMED')
          RETURNING id`,
      )
      .bind(bookingId, actorId, now, reason);
  }

  /**
   * Gives back nights, tents and kitchen portions. Every statement only acts when the
   * booking is already CANCELLED/EXPIRED *and* the resource is still held (item ACTIVE,
   * capacity_reserved > 0), so running it twice can never release twice.
   * Must follow the status change inside the same batch.
   */
  releaseStatements(bookingId: string, checkIn: string, checkOut: string, now: string): D1PreparedStatementLike[] {
    const ended = `EXISTS (SELECT 1 FROM bookings WHERE id = ?1 AND booking_status IN ('CANCELLED', 'EXPIRED'))`;
    return [
      this.db.prepare(`DELETE FROM booking_unit_nights WHERE booking_id = ?1 AND ${ended}`).bind(bookingId),
      this.db
        .prepare(
          `UPDATE camping_night_inventory
              SET tents_used = MAX(0, tents_used - (SELECT COALESCE(SUM(quantity), 0) FROM booking_items
                                                    WHERE booking_id = ?1 AND item_type = 'OWN_TENT' AND status = 'ACTIVE')),
                  updated_at = ?4
            WHERE stay_date >= ?2 AND stay_date < ?3 AND ${ended}
              AND EXISTS (SELECT 1 FROM booking_items WHERE booking_id = ?1 AND item_type = 'OWN_TENT' AND status = 'ACTIVE')`,
        )
        .bind(bookingId, checkIn, checkOut, now),
      this.db
        .prepare(
          `UPDATE food_daily_capacity
              SET used_quantity = MAX(0, used_quantity - (SELECT o.capacity_reserved FROM food_orders o
                                                          WHERE o.booking_id = ?1 AND o.food_category_id = food_daily_capacity.food_category_id
                                                            AND o.service_date = food_daily_capacity.service_date)),
                  updated_at = ?2
            WHERE ${ended}
              AND EXISTS (SELECT 1 FROM food_orders o
                           WHERE o.booking_id = ?1 AND o.food_category_id = food_daily_capacity.food_category_id
                             AND o.service_date = food_daily_capacity.service_date AND o.capacity_reserved > 0)`,
        )
        .bind(bookingId, now),
      this.db
        .prepare(`UPDATE food_orders SET capacity_reserved = 0, status = 'CANCELLED', updated_at = ?2 WHERE booking_id = ?1 AND ${ended}`)
        .bind(bookingId, now),
      this.db.prepare(`UPDATE booking_food_items SET status = 'CANCELLED' WHERE booking_id = ?1 AND status = 'ACTIVE' AND ${ended}`).bind(bookingId),
      // Tarp areas: give the nights back, then mark the snapshot cancelled (counter first: it reads the ACTIVE rows).
      this.db
        .prepare(
          `UPDATE camping_tarp_night_inventory
              SET tarps_used = MAX(0, tarps_used - (SELECT COALESCE(SUM(quantity), 0) FROM booking_tarps
                                                    WHERE booking_id = ?1 AND status = 'ACTIVE')),
                  updated_at = ?4
            WHERE stay_date >= ?2 AND stay_date < ?3 AND ${ended}
              AND EXISTS (SELECT 1 FROM booking_tarps WHERE booking_id = ?1 AND status = 'ACTIVE')`,
        )
        .bind(bookingId, checkIn, checkOut, now),
      this.db.prepare(`UPDATE booking_tarps SET status = 'CANCELLED' WHERE booking_id = ?1 AND status = 'ACTIVE' AND ${ended}`).bind(bookingId),
      this.db.prepare(`UPDATE booking_items SET status = 'CANCELLED' WHERE booking_id = ?1 AND status = 'ACTIVE' AND ${ended}`).bind(bookingId),
    ];
  }
}
