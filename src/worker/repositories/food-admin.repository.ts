import { STAY_NAMES_SQL } from "./stay-sql.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export interface FoodOrderRow {
  id: string;
  booking_id: string;
  booking_code: string;
  booking_status: string;
  payment_status: string;
  customer_name: string;
  item_name: string | null;
  food_category_id: string;
  category_code: string;
  service_date: string;
  service_time: string | null;
  status: string;
  total_persons: number;
  kitchen_note: string | null;
  updated_at: string;
}

export interface FoodOrderLineRow {
  food_order_id: string;
  option_name_snapshot: string;
  quantity: number;
  included_quantity: number;
  adults: number;
  children: number;
  pricing_type_snapshot: string;
  status: string;
}

/** Kitchen orders (spec §24) and per-day food capacity (spec §22) for the back office. */
export class FoodAdminRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async categories() {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.code, c.default_daily_capacity, c.service_time, c.status, t.language_code, t.name
           FROM food_categories c LEFT JOIN food_category_translations t ON t.food_category_id = c.id
          ORDER BY c.sort_order, c.code`,
      )
      .all<{ id: string; code: string; default_daily_capacity: number | null; service_time: string | null; status: string; language_code: string | null; name: string | null }>();
    return results;
  }

  category(id: string) {
    return this.db.prepare("SELECT id, code, default_daily_capacity FROM food_categories WHERE id = ?1").bind(id)
      .first<{ id: string; code: string; default_daily_capacity: number | null }>();
  }

  async capacityRows(from: string, to: string) {
    const { results } = await this.db
      .prepare("SELECT food_category_id, service_date, max_quantity, used_quantity FROM food_daily_capacity WHERE service_date >= ?1 AND service_date < ?2")
      .bind(from, to)
      .all<{ food_category_id: string; service_date: string; max_quantity: number; used_quantity: number }>();
    return results;
  }

  capacityRow(categoryId: string, date: string) {
    return this.db.prepare("SELECT max_quantity, used_quantity FROM food_daily_capacity WHERE food_category_id = ?1 AND service_date = ?2")
      .bind(categoryId, date).first<{ max_quantity: number; used_quantity: number }>();
  }

  setCapacityStatement(categoryId: string, date: string, max: number, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO food_daily_capacity (food_category_id, service_date, max_quantity, used_quantity, updated_at) VALUES (?1, ?2, ?3, 0, ?4)
         ON CONFLICT (food_category_id, service_date) DO UPDATE SET max_quantity = excluded.max_quantity, updated_at = excluded.updated_at`,
      )
      .bind(categoryId, date, max, now);
  }

  async orders(f: { from: string; to: string; categoryId: string | null; status: string | null }) {
    const { results } = await this.db
      .prepare(
        `SELECT o.id, o.booking_id, b.booking_code, b.booking_status, b.payment_status, b.customer_name,
                ${STAY_NAMES_SQL} AS item_name,
                o.food_category_id, c.code AS category_code, o.service_date, c.service_time, o.status, o.total_persons,
                o.kitchen_note, o.updated_at
           FROM food_orders o
           JOIN bookings b ON b.id = o.booking_id
           JOIN food_categories c ON c.id = o.food_category_id
          WHERE o.service_date >= ?1 AND o.service_date < ?2
            AND (?3 IS NULL OR o.food_category_id = ?3) AND (?4 IS NULL OR o.status = ?4)
          ORDER BY o.service_date, c.sort_order, c.code, b.booking_code LIMIT 1000`,
      )
      .bind(f.from, f.to, f.categoryId, f.status)
      .all<FoodOrderRow>();
    return results;
  }

  async lines(orderIds: string[]): Promise<FoodOrderLineRow[]> {
    const out: FoodOrderLineRow[] = [];
    for (let i = 0; i < orderIds.length; i += 90) {
      const chunk = orderIds.slice(i, i + 90);
      const { results } = await this.db
        .prepare(
          `SELECT food_order_id, option_name_snapshot, quantity, included_quantity, adults, children, pricing_type_snapshot, status
             FROM booking_food_items WHERE food_order_id IN (${chunk.map((_, j) => `?${j + 1}`).join(", ")})
            ORDER BY option_name_snapshot`,
        )
        .bind(...chunk)
        .all<FoodOrderLineRow>();
      out.push(...results);
    }
    return out;
  }

  order(id: string) {
    return this.db
      .prepare(
        `SELECT o.id, o.status, o.kitchen_note, b.booking_status, b.booking_code
           FROM food_orders o JOIN bookings b ON b.id = o.booking_id WHERE o.id = ?1`,
      )
      .bind(id)
      .first<{ id: string; status: string; kitchen_note: string | null; booking_status: string; booking_code: string }>();
  }

  /** Optimistic: only from the status the user saw. */
  updateOrderStatement(id: string, from: string, to: string, note: string | null, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE food_orders SET status = ?3, kitchen_note = ?4, status_changed_at = CASE WHEN ?3 <> ?2 THEN ?6 ELSE status_changed_at END,
                status_changed_by = CASE WHEN ?3 <> ?2 THEN ?5 ELSE status_changed_by END, updated_at = ?6
          WHERE id = ?1 AND status = ?2 RETURNING id`,
      )
      .bind(id, from, to, note, actorId, now);
  }
}
