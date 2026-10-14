import { stayNights } from "../../shared/dates.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

/** Kitchen orders past this point are being cooked: the stay can no longer move. */
export const KITCHEN_STARTED = ["PREPARING", "READY", "SERVED"] as const;

export interface MoveFoodOrderRow {
  food_category_id: string;
  service_date: string;
  capacity_reserved: number;
  status: string;
  default_daily_capacity: number | null;
}

/**
 * Admin → booking → Change dates: the reads behind the calendar and the one D1 batch that moves a stay.
 *
 * The batch keeps every guarantee of a new booking: a house / VIP night is a PRIMARY KEY lock (another booking
 * or a block on a new night fails the whole batch), tents / tarp areas / meals go through the same counters
 * whose CHECK (used <= max) rejects overselling. Price snapshots are not touched (the guest keeps the price
 * they booked at); food lines and kitchen orders move by the same number of days as the stay.
 */
export class BookingMoveRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Nights of `unitId` in [from, to) held by another booking or a block. */
  async unitTaken(unitId: string, bookingId: string, from: string, to: string): Promise<Set<string>> {
    const { results } = await this.db
      .prepare(
        `SELECT stay_date FROM booking_unit_nights
          WHERE unit_id = ?1 AND stay_date >= ?2 AND stay_date < ?3 AND (booking_id IS NULL OR booking_id <> ?4)`,
      )
      .bind(unitId, from, to, bookingId)
      .all<{ stay_date: string }>();
    return new Set(results.map((r) => r.stay_date));
  }

  async campingSettings(): Promise<{ is_enabled: number; max_tents_per_night: number; tarp_enabled: number; max_tarps_per_night: number } | null> {
    return this.db
      .prepare("SELECT is_enabled, max_tents_per_night, tarp_enabled, max_tarps_per_night FROM camping_settings WHERE id = 1")
      .first();
  }

  async campingNights(from: string, to: string): Promise<{ stay_date: string; max_tents: number; tents_used: number }[]> {
    const { results } = await this.db
      .prepare("SELECT stay_date, max_tents, tents_used FROM camping_night_inventory WHERE stay_date >= ?1 AND stay_date < ?2")
      .bind(from, to)
      .all<{ stay_date: string; max_tents: number; tents_used: number }>();
    return results;
  }

  async tarpNights(from: string, to: string): Promise<{ stay_date: string; max_tarps: number; tarps_used: number }[]> {
    const { results } = await this.db
      .prepare("SELECT stay_date, max_tarps, tarps_used FROM camping_tarp_night_inventory WHERE stay_date >= ?1 AND stay_date < ?2")
      .bind(from, to)
      .all<{ stay_date: string; max_tarps: number; tarps_used: number }>();
    return results;
  }

  async foodOrders(bookingId: string): Promise<MoveFoodOrderRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT o.food_category_id, o.service_date, o.capacity_reserved, o.status, c.default_daily_capacity
           FROM food_orders o JOIN food_categories c ON c.id = o.food_category_id
          WHERE o.booking_id = ?1`,
      )
      .bind(bookingId)
      .all<MoveFoodOrderRow>();
    return results;
  }

  async foodCapacity(categoryIds: string[], from: string, to: string): Promise<{ food_category_id: string; service_date: string; max_quantity: number; used_quantity: number }[]> {
    if (!categoryIds.length) return [];
    const { results } = await this.db
      .prepare(
        `SELECT food_category_id, service_date, max_quantity, used_quantity FROM food_daily_capacity
          WHERE food_category_id IN (SELECT value FROM json_each(?1)) AND service_date >= ?2 AND service_date < ?3`,
      )
      .bind(JSON.stringify(categoryIds), from, to)
      .all<{ food_category_id: string; service_date: string; max_quantity: number; used_quantity: number }>();
    return results;
  }

  /**
   * The move, in order. Statement 1 changes the dates only if the booking is still as read (dates, live status,
   * no meal being cooked) and RETURNs its id; every later statement runs only if that happened (`moved`).
   */
  moveStatements(p: {
    bookingId: string;
    from: { checkIn: string; checkOut: string };
    to: { checkIn: string; checkOut: string };
    /** Days between the old and the new check-in. */
    offset: number;
    /** The booking's houses / VIP tents (several stays move together). */
    units: { unitId: string; itemId: string }[];
    tents: number;
    tarps: number;
    now: string;
  }): D1PreparedStatementLike[] {
    const db = this.db;
    // ?1 = booking id, ?2 = new check-in, ?3 = now — bound first in every statement below.
    const moved = "EXISTS (SELECT 1 FROM bookings WHERE id = ?1 AND check_in = ?2 AND updated_at = ?3)";
    const head = [p.bookingId, p.to.checkIn, p.now] as const;
    const newNights = stayNights(p.to.checkIn, p.to.checkOut);
    const days = (n: number) => `${n >= 0 ? "+" : ""}${n} days`;
    const statements: D1PreparedStatementLike[] = [
      db
        .prepare(
          `UPDATE bookings SET check_in = ?2, check_out = ?4, updated_at = ?3
            WHERE id = ?1 AND check_in = ?5 AND check_out = ?6 AND booking_status IN ('PENDING', 'CONFIRMED')
              AND NOT EXISTS (SELECT 1 FROM food_orders WHERE booking_id = ?1 AND status IN ('PREPARING', 'READY', 'SERVED'))
            RETURNING id`,
        )
        .bind(...head, p.to.checkOut, p.from.checkIn, p.from.checkOut),
    ];

    if (p.units.length) {
      statements.push(db.prepare(`DELETE FROM booking_unit_nights WHERE booking_id = ?1 AND ${moved}`).bind(...head));
      for (const unit of p.units) {
        for (const night of newNights) {
          // PRIMARY KEY (unit_id, stay_date): a night already held fails the whole batch.
          statements.push(
            db
              .prepare(
                `INSERT INTO booking_unit_nights (unit_id, stay_date, booking_id, booking_item_id, created_at)
                 SELECT ?4, ?5, ?1, ?6, ?3 WHERE ${moved}`,
              )
              .bind(...head, unit.unitId, night, unit.itemId),
          );
        }
      }
    }

    if (p.tents > 0) {
      statements.push(
        db
          .prepare(
            `UPDATE camping_night_inventory SET tents_used = MAX(0, tents_used - ?4), updated_at = ?3
              WHERE stay_date >= ?5 AND stay_date < ?6 AND ${moved}`,
          )
          .bind(...head, p.tents, p.from.checkIn, p.from.checkOut),
      );
      for (const night of newNights) {
        statements.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO camping_night_inventory (stay_date, max_tents, tents_used, is_override, updated_at)
               SELECT ?4, max_tents_per_night, 0, 0, ?3 FROM camping_settings WHERE id = 1 AND ${moved}`,
            )
            .bind(...head, night),
          // CHECK (tents_used <= max_tents) rejects overflow.
          db
            .prepare(`UPDATE camping_night_inventory SET tents_used = tents_used + ?4, updated_at = ?3 WHERE stay_date = ?5 AND ${moved}`)
            .bind(...head, p.tents, night),
        );
      }
    }

    if (p.tarps > 0) {
      statements.push(
        db
          .prepare(
            `UPDATE camping_tarp_night_inventory SET tarps_used = MAX(0, tarps_used - ?4), updated_at = ?3
              WHERE stay_date >= ?5 AND stay_date < ?6 AND ${moved}`,
          )
          .bind(...head, p.tarps, p.from.checkIn, p.from.checkOut),
      );
      for (const night of newNights) {
        statements.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO camping_tarp_night_inventory (stay_date, max_tarps, tarps_used, updated_at)
               SELECT ?4, max_tarps_per_night, 0, ?3 FROM camping_settings WHERE id = 1 AND ${moved}`,
            )
            .bind(...head, night),
          db
            .prepare(`UPDATE camping_tarp_night_inventory SET tarps_used = tarps_used + ?4, updated_at = ?3 WHERE stay_date = ?5 AND ${moved}`)
            .bind(...head, p.tarps, night),
        );
      }
    }

    // Meals: give back the capacity of the old days, move the orders and lines, take the capacity of the new days.
    const ownOrder = `SELECT o.capacity_reserved FROM food_orders o
                       WHERE o.booking_id = ?1 AND o.food_category_id = food_daily_capacity.food_category_id
                         AND o.service_date = food_daily_capacity.service_date`;
    const holdsCapacity = `EXISTS (SELECT 1 FROM food_orders o
                       WHERE o.booking_id = ?1 AND o.food_category_id = food_daily_capacity.food_category_id
                         AND o.service_date = food_daily_capacity.service_date AND o.capacity_reserved > 0)`;
    statements.push(
      db
        .prepare(`UPDATE food_daily_capacity SET used_quantity = MAX(0, used_quantity - (${ownOrder})), updated_at = ?3 WHERE ${holdsCapacity} AND ${moved}`)
        .bind(...head),
      // Two steps through a far-away day: one category on consecutive days would otherwise collide with
      // UNIQUE (booking_id, food_category_id, service_date) half-way through the update.
      db
        .prepare(`UPDATE food_orders SET service_date = date(service_date, ?4), updated_at = ?3 WHERE booking_id = ?1 AND ${moved}`)
        .bind(...head, days(p.offset + 40_000)),
      db
        .prepare(`UPDATE food_orders SET service_date = date(service_date, '-40000 days') WHERE booking_id = ?1 AND ${moved}`)
        .bind(...head),
      db
        .prepare(`UPDATE booking_food_items SET service_date = date(service_date, ?4) WHERE booking_id = ?1 AND ${moved}`)
        .bind(...head, days(p.offset)),
      db
        .prepare(
          `INSERT OR IGNORE INTO food_daily_capacity (food_category_id, service_date, max_quantity, used_quantity, updated_at)
           SELECT o.food_category_id, o.service_date, c.default_daily_capacity, 0, ?3
             FROM food_orders o JOIN food_categories c ON c.id = o.food_category_id
            WHERE o.booking_id = ?1 AND o.capacity_reserved > 0 AND c.default_daily_capacity IS NOT NULL AND ${moved}`,
        )
        .bind(...head),
      // CHECK (used_quantity <= max_quantity) rejects a sold-out day.
      db
        .prepare(`UPDATE food_daily_capacity SET used_quantity = used_quantity + (${ownOrder}), updated_at = ?3 WHERE ${holdsCapacity} AND ${moved}`)
        .bind(...head),
    );
    return statements;
  }
}
