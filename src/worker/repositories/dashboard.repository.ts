import type { D1DatabaseLike } from "../env.ts";
import { PAID_SQL } from "./booking.repository.ts";
import { withFallback } from "./schema-fallback.ts";

/** Statuses that count as a sale once paid (spec §26). */
const SOLD = "('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW')";
const PAID = "('PAID', 'VERIFIED')";

/** One booking with its (first) item, as used by dashboard lists and the calendar. */
const bookingWithItem = (deposit: string) => `
  SELECT b.booking_code, b.customer_name, b.check_in, b.check_out, b.nights, b.adults, b.children,
         b.booking_status, b.payment_status, b.total_satang, ${deposit} AS deposit_satang, ${PAID_SQL} AS paid_satang,
         i.item_type, i.unit_id, i.quantity, s.unit_name_snapshot AS item_name,
         (SELECT COALESCE(SUM(t.quantity), 0) FROM booking_tarps t WHERE t.booking_id = b.id) AS tarps
    FROM bookings b
    JOIN booking_items i ON i.id = (SELECT id FROM booking_items WHERE booking_id = b.id ORDER BY created_at, id LIMIT 1)
    JOIN booking_price_snapshots s ON s.booking_item_id = i.id`;
const BOOKING_WITH_ITEM = bookingWithItem("b.deposit_satang");
/** Before migration 0025: no booking has a deposit. */
const BOOKING_WITH_ITEM_LEGACY = bookingWithItem("NULL");

export interface BookingItemListRow {
  booking_code: string;
  customer_name: string;
  check_in: string;
  check_out: string;
  nights: number;
  adults: number;
  children: number;
  booking_status: string;
  payment_status: string;
  total_satang: number;
  deposit_satang: number | null;
  paid_satang: number;
  item_type: "HOUSE" | "VIP_TENT" | "OWN_TENT";
  unit_id: string | null;
  quantity: number;
  item_name: string;
  tarps: number;
}

export interface RevenueRow {
  bookings: number;
  accommodation: number;
  food: number;
  total: number;
}

/** Read-only aggregates for the dashboard and calendar. Every value comes from D1 (source of truth). */
export class DashboardRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Booking-with-item reads, with the pre-0025 columns while that migration is not applied yet. */
  private async withItems(tail: string, ...binds: unknown[]): Promise<BookingItemListRow[]> {
    const read = async (select: string) => (await this.db.prepare(`${select}\n${tail}`).bind(...binds).all<BookingItemListRow>()).results;
    return withFallback(() => read(BOOKING_WITH_ITEM), () => read(BOOKING_WITH_ITEM_LEGACY));
  }

  async arrivals(today: string): Promise<BookingItemListRow[]> {
    return this.withItems(`WHERE b.check_in = ?1 AND b.booking_status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'NO_SHOW')
         ORDER BY b.booking_status = 'CHECKED_IN', b.booking_code LIMIT 100`, today);
  }

  async departures(today: string): Promise<BookingItemListRow[]> {
    return this.withItems(`WHERE b.check_out = ?1 AND b.booking_status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT')
         ORDER BY b.booking_status = 'CHECKED_OUT', b.booking_code LIMIT 100`, today);
  }

  async counts(today: string, monthStart: string, offset: string) {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM bookings WHERE check_in = ?1 AND booking_status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')) AS check_ins,
           (SELECT COUNT(*) FROM bookings WHERE check_out = ?1 AND booking_status IN ('CONFIRMED', 'CHECKED_IN')) AS check_outs,
           (SELECT COUNT(*) FROM bookings WHERE booking_status = 'CHECKED_IN') AS in_house,
           (SELECT COUNT(*) FROM bookings WHERE date(created_at, ?3) = ?1) AS created_today,
           (SELECT COUNT(*) FROM bookings WHERE date(created_at, ?3) >= ?2) AS created_month,
           (SELECT COUNT(*) FROM bookings WHERE booking_status = 'PENDING' AND payment_status IN ('UNPAID', 'REJECTED')) AS pending_payment,
           (SELECT COALESCE(SUM(total_satang), 0) FROM bookings WHERE booking_status = 'PENDING' AND payment_status IN ('UNPAID', 'REJECTED')) AS pending_satang,
           (SELECT COUNT(*) FROM bookings WHERE booking_status = 'PENDING' AND payment_status = 'PENDING_VERIFICATION') AS slips`,
      )
      .bind(today, monthStart, offset)
      .first<{
        check_ins: number; check_outs: number; in_house: number; created_today: number; created_month: number;
        pending_payment: number; pending_satang: number; slips: number;
      }>();
    return row!;
  }

  async inventoryTonight(today: string) {
    const units = await this.db
      .prepare(
        `SELECT u.unit_type, COUNT(*) AS total,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM booking_unit_nights n WHERE n.unit_id = u.id AND n.stay_date = ?1) THEN 0 ELSE 1 END) AS available
           FROM accommodation_units u WHERE u.status = 'ACTIVE' GROUP BY u.unit_type`,
      )
      .bind(today)
      .all<{ unit_type: string; total: number; available: number }>();
    const camping = await this.db
      .prepare(
        `SELECT c.is_enabled, COALESCE(n.max_tents, c.max_tents_per_night) AS max_tents, COALESCE(n.tents_used, 0) AS used
           FROM camping_settings c LEFT JOIN camping_night_inventory n ON n.stay_date = ?1 WHERE c.id = 1`,
      )
      .bind(today)
      .first<{ is_enabled: number; max_tents: number; used: number }>();
    return { units: units.results, camping };
  }

  async revenue(from: string, toExclusive: string): Promise<RevenueRow> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS bookings,
                COALESCE(SUM(accommodation_subtotal_satang - discount_satang), 0) AS accommodation,
                COALESCE(SUM(food_subtotal_satang), 0) AS food,
                COALESCE(SUM(total_satang), 0) AS total
           FROM bookings
          WHERE check_in >= ?1 AND check_in < ?2 AND booking_status IN ${SOLD} AND payment_status IN ${PAID}`,
      )
      .bind(from, toExclusive)
      .first<RevenueRow>();
    return row!;
  }

  async trend(fromDate: string, offset: string) {
    const { results } = await this.db
      .prepare(
        `SELECT date(created_at, ?2) AS day, COUNT(*) AS bookings,
                COALESCE(SUM(CASE WHEN booking_status IN ${SOLD} AND payment_status IN ${PAID} THEN total_satang ELSE 0 END), 0) AS revenue
           FROM bookings WHERE date(created_at, ?2) >= ?1
          GROUP BY day ORDER BY day`,
      )
      .bind(fromDate, offset)
      .all<{ day: string; bookings: number; revenue: number }>();
    return results;
  }

  async analytics(fromDate: string, offset: string) {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(search_count), 0) FROM search_analytics WHERE search_date >= ?1) AS searches,
           (SELECT COUNT(*) FROM bookings WHERE date(created_at, ?2) >= ?1) AS created,
           (SELECT COUNT(*) FROM payments WHERE slip_asset_id IS NOT NULL AND date(submitted_at, ?2) >= ?1) AS slips,
           (SELECT COUNT(*) FROM bookings WHERE confirmed_at IS NOT NULL AND date(confirmed_at, ?2) >= ?1) AS confirmed,
           (SELECT COALESCE(SUM(total_satang), 0) FROM bookings
             WHERE confirmed_at IS NOT NULL AND date(confirmed_at, ?2) >= ?1
               AND booking_status IN ${SOLD} AND payment_status IN ${PAID}) AS revenue,
           (SELECT COUNT(*) FROM food_orders WHERE status <> 'CANCELLED' AND date(created_at, ?2) >= ?1) AS food_orders`,
      )
      .bind(fromDate, offset)
      .first<{ searches: number; created: number; slips: number; confirmed: number; revenue: number; food_orders: number }>();
    return row!;
  }

  // ================================================================ calendar

  async calendarUnits() {
    const { results } = await this.db
      .prepare(
        `SELECT u.id, u.unit_type, u.unit_code, u.status, t.language_code, t.name
           FROM accommodation_units u LEFT JOIN accommodation_translations t ON t.unit_id = u.id
          WHERE u.status <> 'DELETED'
          ORDER BY u.unit_type, u.sort_order, u.unit_code`,
      )
      .all<{ id: string; unit_type: "HOUSE" | "VIP_TENT"; unit_code: string; status: string; language_code: string | null; name: string | null }>();
    return results;
  }

  async calendarNights(from: string, to: string) {
    const { results } = await this.db
      .prepare(
        `SELECT n.unit_id, n.stay_date, b.booking_code, n.block_reason
           FROM booking_unit_nights n LEFT JOIN bookings b ON b.id = n.booking_id
          WHERE n.stay_date >= ?1 AND n.stay_date < ?2
          ORDER BY n.unit_id, n.stay_date`,
      )
      .bind(from, to)
      .all<{ unit_id: string; stay_date: string; booking_code: string | null; block_reason: string | null }>();
    return results;
  }

  async calendarBookings(from: string, to: string): Promise<BookingItemListRow[]> {
    return this.withItems(`WHERE b.check_in < ?2 AND b.check_out > ?1 AND b.booking_status NOT IN ('CANCELLED', 'EXPIRED')
         ORDER BY b.check_in, b.booking_code LIMIT 2000`, from, to);
  }

  async calendarCamping(from: string, to: string) {
    const settings = await this.db
      .prepare("SELECT is_enabled, max_tents_per_night FROM camping_settings WHERE id = 1")
      .first<{ is_enabled: number; max_tents_per_night: number }>();
    const { results } = await this.db
      .prepare("SELECT stay_date, max_tents, tents_used FROM camping_night_inventory WHERE stay_date >= ?1 AND stay_date < ?2")
      .bind(from, to)
      .all<{ stay_date: string; max_tents: number; tents_used: number }>();
    return { settings, nights: results };
  }
}
