import type { D1DatabaseLike } from "../env.ts";
import { STAY_NAMES_SQL, STAYS_MONEY_JSON_SQL } from "./stay-sql.ts";

/** Statuses that count as a sale (spec §26) and payment states that count as money received. */
export const SOLD = "('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW')";
export const PAID = "('PAID', 'VERIFIED')";

export interface StayRow {
  booking_id: string;
  booking_code: string;
  payment_status: string;
  check_in: string;
  check_out: string;
  adults: number;
  children: number;
  accommodation_subtotal_satang: number;
  discount_satang: number;
  /** This stay's own price (camping: with the tarp area) — a booking may hold several stays. */
  stay_subtotal_satang: number;
  item_type: "HOUSE" | "VIP_TENT" | "OWN_TENT";
  unit_id: string | null;
  quantity: number;
  unit_name_snapshot: string;
  nightly_prices_json: string | null;
  /** Tarp areas of the booking (camping add-on). */
  tarps: number;
}

export interface FoodLineRow {
  service_date: string;
  category_code_snapshot: string;
  option_name_snapshot: string;
  pricing_type_snapshot: string;
  food_option_id: string;
  quantity: number;
  included_quantity: number;
  subtotal_satang: number;
}

export interface BookingReportRow {
  booking_code: string;
  created_day: string;
  source: string;
  check_in: string;
  check_out: string;
  nights: number;
  adults: number;
  children: number;
  booking_status: string;
  payment_status: string;
  total_satang: number;
  customer_name: string;
  item_type: string;
  item_name: string;
  /** Every stay with its price (STAYS_MONEY_JSON_SQL). */
  stays_json: string | null;
}

export interface PaymentReportRow {
  id: string;
  booking_code: string;
  method: string;
  status: string;
  amount_satang: number;
  refund_amount_satang: number | null;
  verified_by: string | null;
  slip_asset_id: string | null;
  reference: string | null;
  received_day: string | null;
  verified_at: string | null;
  refunded_day: string | null;
  submitted_day: string;
}

export interface KitchenRow {
  order_id: string;
  service_date: string;
  category_id: string;
  category_code: string;
  service_time: string | null;
  status: string;
  kitchen_note: string | null;
  booking_code: string;
  booking_status: string;
  payment_status: string;
  customer_name: string;
  adults: number;
  children: number;
  item_name: string | null;
}

/**
 * Read-only queries for reports (spec §50). D1 is the source of truth; every query is static SQL
 * with bound dates. Business dates of timestamps use the property's UTC offset (`?offset`, e.g. '+420 minutes').
 */
export class ReportRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Sold stays overlapping [from, toExclusive). */
  async soldStays(from: string, toExclusive: string): Promise<StayRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT b.id AS booking_id, b.booking_code, b.payment_status, b.check_in, b.check_out, i.adults, i.children,
                b.accommodation_subtotal_satang, b.discount_satang,
                s.subtotal_satang + CASE WHEN i.item_type = 'OWN_TENT'
                  THEN (SELECT COALESCE(SUM(t.subtotal_satang), 0) FROM booking_tarps t WHERE t.booking_id = b.id AND t.status = 'ACTIVE') ELSE 0 END
                  AS stay_subtotal_satang,
                i.item_type, i.unit_id, i.quantity, s.unit_name_snapshot, s.nightly_prices_json,
                CASE WHEN i.item_type = 'OWN_TENT'
                  THEN (SELECT COALESCE(SUM(t.quantity), 0) FROM booking_tarps t WHERE t.booking_id = b.id AND t.status = 'ACTIVE') ELSE 0 END AS tarps
           FROM bookings b
           JOIN booking_items i ON i.booking_id = b.id AND i.status = 'ACTIVE'
           JOIN booking_price_snapshots s ON s.booking_item_id = i.id
          WHERE b.booking_status IN ${SOLD} AND b.check_in < ?2 AND b.check_out > ?1
          ORDER BY b.check_in, b.booking_code, i.created_at, i.id`,
      )
      .bind(from, toExclusive)
      .all<StayRow>();
    return results;
  }

  /** Food lines of paid, sold bookings served in [from, toExclusive). */
  async paidFood(from: string, toExclusive: string): Promise<FoodLineRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT f.service_date, f.category_code_snapshot, f.option_name_snapshot, f.pricing_type_snapshot, f.food_option_id,
                f.quantity, f.included_quantity, f.subtotal_satang
           FROM booking_food_items f JOIN bookings b ON b.id = f.booking_id
          WHERE f.status = 'ACTIVE' AND b.booking_status IN ${SOLD} AND b.payment_status IN ${PAID}
            AND f.service_date >= ?1 AND f.service_date < ?2
          ORDER BY f.service_date`,
      )
      .bind(from, toExclusive)
      .all<FoodLineRow>();
    return results;
  }

  /** Bookings made (property-local creation date) in [from, to]. */
  async bookingsCreated(from: string, to: string, offset: string, limit: number): Promise<BookingReportRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT b.booking_code, date(b.created_at, ?3) AS created_day, b.source, b.check_in, b.check_out, b.nights, b.adults, b.children,
                b.booking_status, b.payment_status, b.total_satang, b.customer_name, i.item_type,
                COALESCE(${STAY_NAMES_SQL}, s.unit_name_snapshot) AS item_name, ${STAYS_MONEY_JSON_SQL} AS stays_json
           FROM bookings b
           JOIN booking_items i ON i.id = (SELECT id FROM booking_items WHERE booking_id = b.id ORDER BY created_at, id LIMIT 1)
           JOIN booking_price_snapshots s ON s.booking_item_id = i.id
          WHERE date(b.created_at, ?3) >= ?1 AND date(b.created_at, ?3) <= ?2
          ORDER BY b.created_at, b.booking_code LIMIT ?4`,
      )
      .bind(from, to, offset, limit)
      .all<BookingReportRow>();
    return results;
  }

  /** Payments received, refunded or submitted (property-local dates) within [from, to]. */
  async payments(from: string, to: string, offset: string, limit: number): Promise<PaymentReportRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.id, b.booking_code, p.method, p.status, p.amount_satang, p.refund_amount_satang, p.verified_by, p.slip_asset_id,
                p.reference, p.verified_at,
                CASE WHEN p.status IN ('PAID', 'VERIFIED', 'REFUNDED') AND p.verified_at IS NOT NULL THEN date(p.verified_at, ?3) END AS received_day,
                CASE WHEN p.refunded_at IS NOT NULL THEN date(p.refunded_at, ?3) END AS refunded_day,
                date(p.submitted_at, ?3) AS submitted_day
           FROM payments p JOIN bookings b ON b.id = p.booking_id
          WHERE (p.verified_at IS NOT NULL AND date(p.verified_at, ?3) BETWEEN ?1 AND ?2)
             OR (p.refunded_at IS NOT NULL AND date(p.refunded_at, ?3) BETWEEN ?1 AND ?2)
             OR (date(p.submitted_at, ?3) BETWEEN ?1 AND ?2)
          ORDER BY COALESCE(p.verified_at, p.submitted_at), p.id LIMIT ?4`,
      )
      .bind(from, to, offset, limit)
      .all<PaymentReportRow>();
    return results;
  }

  /** Units with their name in `lang` (falls back to Thai, then the unit code). */
  async units(lang: string) {
    const { results } = await this.db
      .prepare(
        `SELECT u.id, u.unit_code, u.unit_type, u.status,
                COALESCE((SELECT name FROM accommodation_translations t WHERE t.unit_id = u.id AND t.language_code = ?1),
                         (SELECT name FROM accommodation_translations t WHERE t.unit_id = u.id AND t.language_code = 'th'), u.unit_code) AS name
           FROM accommodation_units u WHERE u.status <> 'DELETED' ORDER BY u.unit_type, u.sort_order, u.unit_code`,
      )
      .bind(lang)
      .all<{ id: string; unit_code: string; unit_type: "HOUSE" | "VIP_TENT"; status: string; name: string }>();
    return results;
  }

  async blockedNights(from: string, toExclusive: string) {
    const { results } = await this.db
      .prepare("SELECT unit_id, stay_date FROM booking_unit_nights WHERE booking_id IS NULL AND stay_date >= ?1 AND stay_date < ?2")
      .bind(from, toExclusive)
      .all<{ unit_id: string; stay_date: string }>();
    return results;
  }

  async camping(from: string, toExclusive: string) {
    const settings = await this.db
      .prepare("SELECT is_enabled, max_tents_per_night FROM camping_settings WHERE id = 1")
      .first<{ is_enabled: number; max_tents_per_night: number }>();
    const { results } = await this.db
      .prepare("SELECT stay_date, max_tents FROM camping_night_inventory WHERE stay_date >= ?1 AND stay_date < ?2")
      .bind(from, toExclusive)
      .all<{ stay_date: string; max_tents: number }>();
    return { settings, nights: results };
  }

  async kitchenOrders(from: string, toExclusive: string): Promise<KitchenRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT o.id AS order_id, o.service_date, o.food_category_id AS category_id, c.code AS category_code, c.service_time,
                o.status, o.kitchen_note, b.booking_code, b.booking_status, b.payment_status, b.customer_name, b.adults, b.children,
                ${STAY_NAMES_SQL} AS item_name
           FROM food_orders o JOIN bookings b ON b.id = o.booking_id JOIN food_categories c ON c.id = o.food_category_id
          WHERE o.status <> 'CANCELLED' AND o.service_date >= ?1 AND o.service_date < ?2
          ORDER BY o.service_date, c.sort_order, c.code, b.booking_code`,
      )
      .bind(from, toExclusive)
      .all<KitchenRow>();
    return results;
  }

  async kitchenLines(from: string, toExclusive: string) {
    const { results } = await this.db
      .prepare(
        `SELECT f.food_order_id, f.option_name_snapshot, f.quantity, f.included_quantity
           FROM booking_food_items f JOIN food_orders o ON o.id = f.food_order_id
          WHERE f.status = 'ACTIVE' AND o.status <> 'CANCELLED' AND o.service_date >= ?1 AND o.service_date < ?2
          ORDER BY f.option_name_snapshot`,
      )
      .bind(from, toExclusive)
      .all<{ food_order_id: string; option_name_snapshot: string; quantity: number; included_quantity: number }>();
    return results;
  }

  async categoryNames(lang: string) {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.code, COALESCE((SELECT name FROM food_category_translations t WHERE t.food_category_id = c.id AND t.language_code = ?1),
                                       (SELECT name FROM food_category_translations t WHERE t.food_category_id = c.id AND t.language_code = 'th'), c.code) AS name
           FROM food_categories c`,
      )
      .bind(lang)
      .all<{ id: string; code: string; name: string }>();
    return results;
  }
}
