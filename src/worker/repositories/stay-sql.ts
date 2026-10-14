/**
 * Several stays per booking (migration 0026): SQL snippets that name every stay of booking `b` in admin lists,
 * messages and reports — the stays that count (active ones; all of them once the whole booking ended), in the
 * order the guest chose them.
 */
const STAYS_OF_B = `FROM booking_items i2 JOIN booking_price_snapshots s2 ON s2.booking_item_id = i2.id
   WHERE i2.booking_id = b.id AND (i2.status = 'ACTIVE' OR b.booking_status IN ('CANCELLED', 'EXPIRED'))
   ORDER BY i2.created_at, i2.id`;

/** "House 01 + VIP 02 + Camping" */
export const STAY_NAMES_SQL = `(SELECT group_concat(name, ' + ') FROM (SELECT s2.unit_name_snapshot AS name ${STAYS_OF_B}))`;

/** [{"type":"HOUSE","name":"House 01","quantity":1}, …] */
export const STAYS_JSON_SQL = `(SELECT json_group_array(json_object('type', type, 'name', name, 'quantity', quantity))
   FROM (SELECT i2.item_type AS type, s2.unit_name_snapshot AS name, i2.quantity AS quantity ${STAYS_OF_B}))`;

/** Same, with each stay's price snapshot (reports split a booking's value by stay). */
export const STAYS_MONEY_JSON_SQL = `(SELECT json_group_array(json_object('type', type, 'name', name, 'quantity', quantity, 'subtotal', subtotal))
   FROM (SELECT i2.item_type AS type, s2.unit_name_snapshot AS name, i2.quantity AS quantity, s2.subtotal_satang AS subtotal ${STAYS_OF_B}))`;

export interface StayBriefRow {
  type: "HOUSE" | "VIP_TENT" | "OWN_TENT";
  name: string;
  quantity: number;
  /** STAYS_MONEY_JSON_SQL only. */
  subtotal?: number;
}

/** STAYS_JSON_SQL → rows (an empty list on anything unexpected). */
export function parseStays(json: string | null | undefined): StayBriefRow[] {
  if (!json) return [];
  try {
    const rows = JSON.parse(json) as StayBriefRow[];
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.name === "string") : [];
  } catch {
    return [];
  }
}
