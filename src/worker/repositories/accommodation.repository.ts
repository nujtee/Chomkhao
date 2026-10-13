import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";

export interface UnitRow {
  id: string;
  unit_code: string;
  unit_type: "HOUSE" | "VIP_TENT";
  slug: string;
  base_price_satang: number;
  /** FULL | DEPOSIT_50 (migration 0025). */
  payment_mode: "FULL" | "DEPOSIT_50";
  standard_guests: number;
  max_guests: number;
  max_adults: number | null;
  status: "DRAFT" | "ACTIVE" | "INACTIVE" | "MAINTENANCE" | "DELETED";
  sort_order: number;
  cover_asset_id: string | null;
  cover_key: string | null;
  cover_width: number | null;
  cover_height: number | null;
  created_at: string;
  updated_at: string;
}

export interface UnitTranslationRow {
  unit_id: string;
  language_code: string;
  name: string;
  short_description: string | null;
  description: string | null;
  seo_title: string | null;
  seo_description: string | null;
}

export interface UnitImageRow {
  id: string;
  unit_id: string;
  media_asset_id: string;
  object_key: string;
  width: number | null;
  height: number | null;
  sort_order: number;
  status: "DRAFT" | "PUBLISHED" | "UNPUBLISHED";
}

export interface AmenityRow {
  id: string;
  code: string;
  icon: string | null;
  status: "ACTIVE" | "INACTIVE";
  sort_order: number;
  names: string | null; // JSON {lang: name}
}

const unitSelect = (paymentMode: string) => `
  SELECT u.id, u.unit_code, u.unit_type, u.slug, u.base_price_satang, ${paymentMode} AS payment_mode, u.standard_guests, u.max_guests,
         u.max_adults, u.status, u.sort_order, u.cover_asset_id,
         m.object_key AS cover_key, m.width AS cover_width, m.height AS cover_height,
         u.created_at, u.updated_at
    FROM accommodation_units u
    LEFT JOIN media_assets m ON m.id = u.cover_asset_id AND m.status = 'ACTIVE' AND m.bucket = 'PUBLIC'`;
const UNIT_SELECT = unitSelect("u.payment_mode");
/** Before migration 0025: every unit is paid in full. */
const UNIT_SELECT_LEGACY = unitSelect("'FULL'");

export class AccommodationRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Runs a unit read with the current columns, or the pre-0025 ones while that migration is not applied yet. */
  private units<T>(read: (select: string) => Promise<T>): Promise<T> {
    return withFallback(() => read(UNIT_SELECT), () => read(UNIT_SELECT_LEGACY));
  }

  async listUnits(filter: { type?: "HOUSE" | "VIP_TENT"; publicOnly?: boolean; includeDeleted?: boolean }): Promise<UnitRow[]> {
    return this.units(async (select) => {
      const { results } = await this.db
        .prepare(
          `${select}
            WHERE (?1 IS NULL OR u.unit_type = ?1)
              AND (?2 = 0 OR u.status = 'ACTIVE')
              AND (?3 = 1 OR u.status <> 'DELETED')
            ORDER BY u.unit_type, u.sort_order, u.unit_code`,
        )
        .bind(filter.type ?? null, filter.publicOnly ? 1 : 0, filter.includeDeleted ? 1 : 0)
        .all<UnitRow>();
      return results;
    });
  }

  findUnit(id: string): Promise<UnitRow | null> {
    return this.units((select) => this.db.prepare(`${select} WHERE u.id = ?1`).bind(id).first<UnitRow>());
  }

  findActiveBySlug(slug: string): Promise<UnitRow | null> {
    return this.units((select) => this.db.prepare(`${select} WHERE u.slug = ?1 AND u.status = 'ACTIVE'`).bind(slug).first<UnitRow>());
  }

  async findByCodeOrSlug(code: string, slug: string): Promise<{ id: string; unit_code: string; slug: string }[]> {
    const { results } = await this.db
      .prepare("SELECT id, unit_code, slug FROM accommodation_units WHERE unit_code = ?1 OR slug = ?2")
      .bind(code, slug)
      .all<{ id: string; unit_code: string; slug: string }>();
    return results;
  }

  async translations(unitIds: string[]): Promise<UnitTranslationRow[]> {
    if (!unitIds.length) return [];
    const { results } = await this.db
      .prepare(
        `SELECT unit_id, language_code, name, short_description, description, seo_title, seo_description
           FROM accommodation_translations WHERE unit_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(unitIds))
      .all<UnitTranslationRow>();
    return results;
  }

  async images(unitIds: string[], publishedOnly: boolean): Promise<UnitImageRow[]> {
    if (!unitIds.length) return [];
    const { results } = await this.db
      .prepare(
        `SELECT i.id, i.unit_id, i.media_asset_id, m.object_key, m.width, m.height, i.sort_order, i.status
           FROM accommodation_images i
           JOIN media_assets m ON m.id = i.media_asset_id AND m.status = 'ACTIVE' AND m.bucket = 'PUBLIC'
          WHERE i.unit_id IN (SELECT value FROM json_each(?1)) AND (?2 = 0 OR i.status = 'PUBLISHED')
          ORDER BY i.unit_id, i.sort_order, i.created_at`,
      )
      .bind(JSON.stringify(unitIds), publishedOnly ? 1 : 0)
      .all<UnitImageRow>();
    return results;
  }

  async unitAmenities(unitIds: string[]): Promise<{ unit_id: string; amenity_id: string }[]> {
    if (!unitIds.length) return [];
    const { results } = await this.db
      .prepare(
        `SELECT ua.unit_id, ua.amenity_id FROM accommodation_amenities ua
           JOIN amenities a ON a.id = ua.amenity_id
          WHERE ua.unit_id IN (SELECT value FROM json_each(?1))
          ORDER BY ua.sort_order, a.sort_order`,
      )
      .bind(JSON.stringify(unitIds))
      .all<{ unit_id: string; amenity_id: string }>();
    return results;
  }

  async amenities(activeOnly: boolean): Promise<AmenityRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT a.id, a.code, a.icon, a.status, a.sort_order,
                (SELECT json_group_object(t.language_code, t.name) FROM amenity_translations t WHERE t.amenity_id = a.id) AS names
           FROM amenities a WHERE (?1 = 0 OR a.status = 'ACTIVE') ORDER BY a.sort_order, a.code`,
      )
      .bind(activeOnly ? 1 : 0)
      .all<AmenityRow>();
    return results;
  }

  // ------------------------------------------------------------------ writes

  insertUnitStatement(u: {
    id: string; unitCode: string; unitType: string; slug: string; basePriceSatang: number; paymentMode: string; standardGuests: number;
    maxGuests: number; maxAdults: number | null; status: string; sortOrder: number; createdBy: string; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO accommodation_units (id, unit_code, unit_type, slug, base_price_satang, standard_guests, max_guests,
           max_adults, status, sort_order, created_by, created_at, updated_at, payment_mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13)`,
      )
      .bind(u.id, u.unitCode, u.unitType, u.slug, u.basePriceSatang, u.standardGuests, u.maxGuests, u.maxAdults,
        u.status, u.sortOrder, u.createdBy, u.now, u.paymentMode);
  }

  updateUnitStatement(id: string, f: {
    unitCode: string; slug: string; basePriceSatang: number; paymentMode: string; standardGuests: number; maxGuests: number;
    maxAdults: number | null; status: string; sortOrder: number; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE accommodation_units SET unit_code = ?2, slug = ?3, base_price_satang = ?4, standard_guests = ?5,
                max_guests = ?6, max_adults = ?7, status = ?8, sort_order = ?9, updated_at = ?10, payment_mode = ?11,
                deleted_at = CASE WHEN ?8 = 'DELETED' THEN ?10 ELSE NULL END
          WHERE id = ?1`,
      )
      .bind(id, f.unitCode, f.slug, f.basePriceSatang, f.standardGuests, f.maxGuests, f.maxAdults, f.status, f.sortOrder, f.now, f.paymentMode);
  }

  upsertTranslationStatement(unitId: string, lang: string, t: {
    name: string; shortDescription: string | null; description: string | null; seoTitle: string | null; seoDescription: string | null;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO accommodation_translations (unit_id, language_code, name, short_description, description, seo_title, seo_description)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (unit_id, language_code) DO UPDATE SET name = excluded.name,
           short_description = excluded.short_description, description = excluded.description,
           seo_title = excluded.seo_title, seo_description = excluded.seo_description`,
      )
      .bind(unitId, lang, t.name, t.shortDescription, t.description, t.seoTitle, t.seoDescription);
  }

  deleteTranslationStatement(unitId: string, lang: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM accommodation_translations WHERE unit_id = ?1 AND language_code = ?2").bind(unitId, lang);
  }

  replaceAmenitiesStatements(unitId: string, amenityIds: string[]): D1PreparedStatementLike[] {
    return [
      this.db.prepare("DELETE FROM accommodation_amenities WHERE unit_id = ?1").bind(unitId),
      ...amenityIds.map((amenityId, i) =>
        this.db.prepare("INSERT INTO accommodation_amenities (unit_id, amenity_id, sort_order) VALUES (?1, ?2, ?3)").bind(unitId, amenityId, i)),
    ];
  }

  addImageStatement(id: string, unitId: string, assetId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO accommodation_images (id, unit_id, media_asset_id, sort_order, status, created_at)
         VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM accommodation_images WHERE unit_id = ?2), 'PUBLISHED', ?4)`,
      )
      .bind(id, unitId, assetId, now);
  }

  setImageStatusStatement(unitId: string, imageId: string, status: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE accommodation_images SET status = ?3 WHERE id = ?2 AND unit_id = ?1").bind(unitId, imageId, status);
  }

  setImageOrderStatement(unitId: string, imageId: string, sortOrder: number): D1PreparedStatementLike {
    return this.db.prepare("UPDATE accommodation_images SET sort_order = ?3 WHERE id = ?2 AND unit_id = ?1").bind(unitId, imageId, sortOrder);
  }

  deleteImageStatement(unitId: string, imageId: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM accommodation_images WHERE id = ?2 AND unit_id = ?1").bind(unitId, imageId);
  }

  setCoverStatement(unitId: string, assetId: string | null, now: string): D1PreparedStatementLike {
    return this.db.prepare("UPDATE accommodation_units SET cover_asset_id = ?2, updated_at = ?3 WHERE id = ?1").bind(unitId, assetId, now);
  }

  insertAmenityStatement(a: { id: string; code: string; icon: string | null; sortOrder: number }): D1PreparedStatementLike {
    return this.db
      .prepare("INSERT INTO amenities (id, code, icon, sort_order) VALUES (?1, ?2, ?3, ?4)")
      .bind(a.id, a.code, a.icon, a.sortOrder);
  }

  updateAmenityStatement(id: string, f: { icon: string | null; status: string; sortOrder: number }): D1PreparedStatementLike {
    return this.db.prepare("UPDATE amenities SET icon = ?2, status = ?3, sort_order = ?4 WHERE id = ?1").bind(id, f.icon, f.status, f.sortOrder);
  }

  upsertAmenityNameStatement(amenityId: string, lang: string, name: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO amenity_translations (amenity_id, language_code, name) VALUES (?1, ?2, ?3)
         ON CONFLICT (amenity_id, language_code) DO UPDATE SET name = excluded.name`,
      )
      .bind(amenityId, lang, name);
  }

  async countFutureBookedNights(unitId: string, fromDate: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE unit_id = ?1 AND stay_date >= ?2 AND booking_id IS NOT NULL")
      .bind(unitId, fromDate)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}
