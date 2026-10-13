import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export interface CampingSettingsRow {
  is_enabled: number;
  max_tents_per_night: number;
  price_per_adult_night_satang: number;
  child_free_under_age: number;
  max_guests_per_tent: number | null;
  cover_asset_id: string | null;
  cover_key: string | null;
  cover_width: number | null;
  cover_height: number | null;
  tarp_enabled: number;
  tarp_price_per_night_satang: number;
  max_tarps_per_night: number;
  /** FULL | DEPOSIT_50 (migration 0025). */
  payment_mode: "FULL" | "DEPOSIT_50";
}

export interface CampingTranslationRow {
  language_code: string;
  name: string;
  description: string | null;
  seo_title: string | null;
  seo_description: string | null;
}

export interface NightLockRow {
  unit_id: string;
  stay_date: string;
  booking_id: string | null;
  booking_code: string | null;
  booking_status: string | null;
  block_reason: string | null;
}

export interface CampingNightRow {
  stay_date: string;
  max_tents: number;
  tents_used: number;
  is_override: number;
}

export interface CampingDriftRow {
  stay_date: string;
  expected: number;
  actual: number;
  max_tents: number | null;
}

export interface TarpNightRow {
  stay_date: string;
  max_tarps: number;
  tarps_used: number;
}

export interface TarpDriftRow {
  stay_date: string;
  expected: number;
  actual: number;
  max_tarps: number | null;
}

/** Tarp areas actually held per night = Σ quantity of ACTIVE booking_tarps whose stay covers the night. */
const HELD_TARPS_CTE = `
  WITH RECURSIVE held(qty, d, check_out) AS (
    SELECT t.quantity, MAX(b.check_in, ?1), b.check_out
      FROM booking_tarps t JOIN bookings b ON b.id = t.booking_id
     WHERE t.status = 'ACTIVE' AND b.check_out > ?1
    UNION ALL
    SELECT qty, date(d, '+1 day'), check_out FROM held WHERE date(d, '+1 day') < check_out
  ),
  expected AS (SELECT d AS stay_date, SUM(qty) AS tarps FROM held GROUP BY d)`;

/**
 * Tents actually held per night = Σ quantity of ACTIVE own-tent items whose stay covers
 * the night. This is the truth the `tents_used` counter must always equal.
 */
const HELD_TENTS_CTE = `
  WITH RECURSIVE held(qty, d, check_out) AS (
    SELECT i.quantity, MAX(b.check_in, ?1), b.check_out
      FROM booking_items i JOIN bookings b ON b.id = i.booking_id
     WHERE i.item_type = 'OWN_TENT' AND i.status = 'ACTIVE' AND b.check_out > ?1
    UNION ALL
    SELECT qty, date(d, '+1 day'), check_out FROM held WHERE date(d, '+1 day') < check_out
  ),
  expected AS (SELECT d AS stay_date, SUM(qty) AS tents FROM held GROUP BY d)`;

/** A table / column of a newer migration that this database does not have yet. */
export function isMissingSchema(error: unknown): boolean {
  return /no such (table|column)/i.test(String(error));
}

/** Camping settings + inventory reads, and date-range lookups used by AvailabilityService. */
export class InventoryRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async campingSettings(): Promise<CampingSettingsRow | null> {
    try {
      return await this.db
        .prepare(
          `SELECT c.is_enabled, c.max_tents_per_night, c.price_per_adult_night_satang, c.child_free_under_age,
                  c.max_guests_per_tent, c.cover_asset_id, m.object_key AS cover_key, m.width AS cover_width, m.height AS cover_height,
                  c.tarp_enabled, c.tarp_price_per_night_satang, c.max_tarps_per_night, c.payment_mode
             FROM camping_settings c
             LEFT JOIN media_assets m ON m.id = c.cover_asset_id AND m.status = 'ACTIVE' AND m.bucket = 'PUBLIC'
            WHERE c.id = 1`,
        )
        .first<CampingSettingsRow>();
    } catch (error) {
      // Deployed before migration 0021: camping keeps working, without the tarp option.
      if (!isMissingSchema(error)) throw error;
      return this.db
        .prepare(
          `SELECT c.is_enabled, c.max_tents_per_night, c.price_per_adult_night_satang, c.child_free_under_age,
                  c.max_guests_per_tent, c.cover_asset_id, m.object_key AS cover_key, m.width AS cover_width, m.height AS cover_height,
                  0 AS tarp_enabled, 0 AS tarp_price_per_night_satang, 0 AS max_tarps_per_night, 'FULL' AS payment_mode
             FROM camping_settings c
             LEFT JOIN media_assets m ON m.id = c.cover_asset_id AND m.status = 'ACTIVE' AND m.bucket = 'PUBLIC'
            WHERE c.id = 1`,
        )
        .first<CampingSettingsRow>();
    }
  }

  async campingTranslations(): Promise<CampingTranslationRow[]> {
    const { results } = await this.db
      .prepare("SELECT language_code, name, description, seo_title, seo_description FROM camping_setting_translations")
      .all<CampingTranslationRow>();
    return results;
  }

  upsertCampingSettingsStatement(s: {
    isEnabled: boolean; maxTentsPerNight: number; pricePerAdultNightSatang: number; childFreeUnderAge: number;
    maxGuestsPerTent: number | null; coverAssetId: string | null; tarpEnabled: boolean; tarpPricePerNightSatang: number;
    maxTarpsPerNight: number; paymentMode: string; updatedBy: string; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO camping_settings (id, is_enabled, max_tents_per_night, price_per_adult_night_satang, child_free_under_age,
           max_guests_per_tent, cover_asset_id, updated_at, updated_by, tarp_enabled, tarp_price_per_night_satang, max_tarps_per_night,
           payment_mode)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (id) DO UPDATE SET is_enabled = excluded.is_enabled, max_tents_per_night = excluded.max_tents_per_night,
           price_per_adult_night_satang = excluded.price_per_adult_night_satang, child_free_under_age = excluded.child_free_under_age,
           max_guests_per_tent = excluded.max_guests_per_tent, cover_asset_id = excluded.cover_asset_id,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by, tarp_enabled = excluded.tarp_enabled,
           tarp_price_per_night_satang = excluded.tarp_price_per_night_satang, max_tarps_per_night = excluded.max_tarps_per_night,
           payment_mode = excluded.payment_mode`,
      )
      .bind(s.isEnabled ? 1 : 0, s.maxTentsPerNight, s.pricePerAdultNightSatang, s.childFreeUnderAge, s.maxGuestsPerTent,
        s.coverAssetId, s.now, s.updatedBy, s.tarpEnabled ? 1 : 0, s.tarpPricePerNightSatang, s.maxTarpsPerNight, s.paymentMode);
  }

  /** New tarp-area capacity for every night from `fromDate` (no per-night overrides); CHECK aborts if below areas sold. */
  applyDefaultTarpCapacityStatement(maxTarps: number, fromDate: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE camping_tarp_night_inventory SET max_tarps = ?1, updated_at = ?3 WHERE stay_date >= ?2")
      .bind(maxTarps, fromDate, now);
  }

  async tarpNights(from: string, toExclusive: string): Promise<TarpNightRow[]> {
    try {
      const { results } = await this.db
        .prepare(
          `SELECT stay_date, max_tarps, tarps_used FROM camping_tarp_night_inventory
            WHERE stay_date >= ?1 AND stay_date < ?2 ORDER BY stay_date`,
        )
        .bind(from, toExclusive)
        .all<TarpNightRow>();
      return results;
    } catch (error) {
      if (isMissingSchema(error)) return []; // before migration 0021
      throw error;
    }
  }

  /** Nights from `fromDate` where the tarp counter disagrees with the bookings. Empty = consistent. */
  async tarpDrift(fromDate: string): Promise<TarpDriftRow[]> {
    try {
      return await this.tarpDriftRows(fromDate);
    } catch (error) {
      if (isMissingSchema(error)) return []; // before migration 0021
      throw error;
    }
  }

  private async tarpDriftRows(fromDate: string): Promise<TarpDriftRow[]> {
    const { results } = await this.db
      .prepare(
        `${HELD_TARPS_CTE},
         actual AS (SELECT stay_date, tarps_used, max_tarps FROM camping_tarp_night_inventory WHERE stay_date >= ?1),
         dates AS (SELECT stay_date FROM expected UNION SELECT stay_date FROM actual)
         SELECT dates.stay_date, COALESCE(e.tarps, 0) AS expected, COALESCE(a.tarps_used, 0) AS actual, a.max_tarps
           FROM dates
           LEFT JOIN expected e ON e.stay_date = dates.stay_date
           LEFT JOIN actual a ON a.stay_date = dates.stay_date
          WHERE COALESCE(e.tarps, 0) <> COALESCE(a.tarps_used, 0)
          ORDER BY dates.stay_date
          LIMIT 400`,
      )
      .bind(fromDate)
      .all<TarpDriftRow>();
    return results;
  }

  /** Resets the tarp counters from `fromDate` to the bookings' truth (one batch with the tents; CHECK guards overselling). */
  recalculateTarpStatements(fromDate: string, now: string): D1PreparedStatementLike[] {
    return [
      this.db
        .prepare(
          `${HELD_TARPS_CTE}
           INSERT OR IGNORE INTO camping_tarp_night_inventory (stay_date, max_tarps, tarps_used, updated_at)
           SELECT e.stay_date, s.max_tarps_per_night, 0, ?2 FROM expected e, camping_settings s WHERE s.id = 1`,
        )
        .bind(fromDate, now),
      this.db
        .prepare(
          `UPDATE camping_tarp_night_inventory
              SET tarps_used = (SELECT COALESCE(SUM(t.quantity), 0)
                                  FROM booking_tarps t JOIN bookings b ON b.id = t.booking_id
                                 WHERE t.status = 'ACTIVE'
                                   AND b.check_in <= camping_tarp_night_inventory.stay_date
                                   AND b.check_out > camping_tarp_night_inventory.stay_date),
                  updated_at = ?2
            WHERE stay_date >= ?1`,
        )
        .bind(fromDate, now),
    ];
  }

  upsertCampingTranslationStatement(lang: string, t: { name: string; description: string | null; seoTitle: string | null; seoDescription: string | null }) {
    return this.db
      .prepare(
        `INSERT INTO camping_setting_translations (language_code, name, description, seo_title, seo_description)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (language_code) DO UPDATE SET name = excluded.name, description = excluded.description,
           seo_title = excluded.seo_title, seo_description = excluded.seo_description`,
      )
      .bind(lang, t.name, t.description, t.seoTitle, t.seoDescription);
  }

  /** New default capacity flows to non-overridden future nights; CHECK aborts if below tents sold. */
  applyDefaultCapacityStatement(maxTents: number, fromDate: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE camping_night_inventory SET max_tents = ?1 WHERE is_override = 0 AND stay_date >= ?2")
      .bind(maxTents, fromDate);
  }

  /** Per-date override (maxTents) or back to default (maxTents = null). */
  setNightCapacityStatements(date: string, maxTents: number | null, defaultMax: number, now: string): D1PreparedStatementLike[] {
    return [
      this.db
        .prepare(
          `INSERT INTO camping_night_inventory (stay_date, max_tents, tents_used, is_override, updated_at)
           VALUES (?1, ?2, 0, ?3, ?4)
           ON CONFLICT (stay_date) DO UPDATE SET max_tents = excluded.max_tents, is_override = excluded.is_override,
             updated_at = excluded.updated_at`,
        )
        .bind(date, maxTents ?? defaultMax, maxTents === null ? 0 : 1, now),
    ];
  }

  async campingNights(from: string, toExclusive: string): Promise<CampingNightRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT stay_date, max_tents, tents_used, is_override FROM camping_night_inventory
          WHERE stay_date >= ?1 AND stay_date < ?2 ORDER BY stay_date`,
      )
      .bind(from, toExclusive)
      .all<CampingNightRow>();
    return results;
  }

  /** Night-locks (bookings + admin blocks) in [from, toExclusive), optionally for one unit. */
  async nightLocks(from: string, toExclusive: string, unitId: string | null = null): Promise<NightLockRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT n.unit_id, n.stay_date, n.booking_id, b.booking_code, b.booking_status, n.block_reason
           FROM booking_unit_nights n LEFT JOIN bookings b ON b.id = n.booking_id
          WHERE n.stay_date >= ?1 AND n.stay_date < ?2 AND (?3 IS NULL OR n.unit_id = ?3)
          ORDER BY n.unit_id, n.stay_date`,
      )
      .bind(from, toExclusive, unitId)
      .all<NightLockRow>();
    return results;
  }

  insertBlockStatement(unitId: string, date: string, reason: string, createdBy: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(unitId, date, reason, createdBy, now);
  }

  /** Removes admin blocks only — never a booking's night-lock. */
  deleteBlocksStatement(unitId: string, from: string, toInclusive: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `DELETE FROM booking_unit_nights
          WHERE unit_id = ?1 AND stay_date >= ?2 AND stay_date <= ?3 AND booking_id IS NULL`,
      )
      .bind(unitId, from, toInclusive);
  }

  /** Nights from `fromDate` where the counter disagrees with the bookings. Empty = consistent. */
  async campingDrift(fromDate: string): Promise<CampingDriftRow[]> {
    const { results } = await this.db
      .prepare(
        `${HELD_TENTS_CTE},
         actual AS (SELECT stay_date, tents_used, max_tents FROM camping_night_inventory WHERE stay_date >= ?1),
         dates AS (SELECT stay_date FROM expected UNION SELECT stay_date FROM actual)
         SELECT dates.stay_date, COALESCE(e.tents, 0) AS expected, COALESCE(a.tents_used, 0) AS actual, a.max_tents
           FROM dates
           LEFT JOIN expected e ON e.stay_date = dates.stay_date
           LEFT JOIN actual a ON a.stay_date = dates.stay_date
          WHERE COALESCE(e.tents, 0) <> COALESCE(a.tents_used, 0)
          ORDER BY dates.stay_date
          LIMIT 400`,
      )
      .bind(fromDate)
      .all<CampingDriftRow>();
    return results;
  }

  /**
   * Resets every counter from `fromDate` to the true total. Runs as one batch: if any
   * night is truly oversold (bookings > capacity) the CHECK aborts and nothing changes.
   */
  recalculateCampingStatements(fromDate: string, now: string): D1PreparedStatementLike[] {
    return [
      this.db
        .prepare(
          `${HELD_TENTS_CTE}
           INSERT OR IGNORE INTO camping_night_inventory (stay_date, max_tents, tents_used, is_override, updated_at)
           SELECT e.stay_date, s.max_tents_per_night, 0, 0, ?2 FROM expected e, camping_settings s WHERE s.id = 1`,
        )
        .bind(fromDate, now),
      this.db
        .prepare(
          `UPDATE camping_night_inventory
              SET tents_used = (SELECT COALESCE(SUM(i.quantity), 0)
                                  FROM booking_items i JOIN bookings b ON b.id = i.booking_id
                                 WHERE i.item_type = 'OWN_TENT' AND i.status = 'ACTIVE'
                                   AND b.check_in <= camping_night_inventory.stay_date
                                   AND b.check_out > camping_night_inventory.stay_date),
                  updated_at = ?2
            WHERE stay_date >= ?1`,
        )
        .bind(fromDate, now),
    ];
  }

  async siteTimezone(): Promise<string | null> {
    try {
      const row = await this.db.prepare("SELECT timezone FROM site_settings WHERE id = 1").first<{ timezone: string }>();
      return row?.timezone ?? null;
    } catch {
      return null;
    }
  }
}
