import type { CmsEntityName, CmsRecord, EntityDef, FieldDef } from "../../shared/cms-schema.ts";
import { CMS_TEXT, ENTITIES, isSafeLink, isSafePath, normalizeCode, normalizeSlug } from "../../shared/cms-schema.ts";
import { MAX_PRICE_SATANG } from "../../shared/booking-rules.ts";
import { DEFAULT_LOCALE_CODE, LOCALE_CODES, type LocaleCode } from "../../shared/i18n/locales.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "../http/errors.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "../services/auth-context.ts";
import type { AuthorizationService } from "../services/authorization.service.ts";
import { publicMediaUrl } from "../services/media-url.ts";
import type { SecurityLogService } from "../services/security-log.service.ts";
import { ID_PATTERN } from "../validation.ts";
import { column, ENTITY_CONFIG, REF_TABLES, type EntityConfig } from "./entity-config.ts";

type Row = Record<string, unknown>;
type Values = Record<string, unknown>;
type TransInput = Partial<Record<LocaleCode, Record<string, string | null> | null>>;

export interface ParsedInput {
  values: Values;
  translations: TransInput | undefined;
}

const RESERVED_REDIRECT_PREFIXES = ["/api", "/media", "/admin", "/assets", "/th/admin", "/en/admin", "/zh-cn/admin"];
const MAX_LIST = 1000;
const MAX_REORDER = 500;

/**
 * Generic back-office record engine (Phase 9): list / create / update / delete /
 * reorder / publish for the entities in `src/shared/cms-schema.ts`.
 *
 * Every write: permission check → strict field allow-list → per-kind validation →
 * reference + media checks → one atomic D1 batch with the audit entry.
 */
export class CmsService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly mediaBaseUrl: string | undefined,
  ) {}

  // ================================================================ reads

  async list(actor: AuthContext, name: CmsEntityName, filter: Record<string, string>, meta: RequestMeta): Promise<CmsRecord[]> {
    const cfg = ENTITY_CONFIG[name];
    await this.authz.requirePermission(actor, cfg.view, meta);
    const where: string[] = [];
    const binds: unknown[] = [];
    if (cfg.deleteMode === "soft") where.push("t.status <> 'DELETED'");
    for (const [key, value] of Object.entries(filter)) {
      const col = cfg.filters?.[key];
      if (!col) throw new ValidationError({ [key]: "UNKNOWN_FIELD" });
      if (value === "none") where.push(`t.${col} IS NULL`);
      else {
        if (!ID_PATTERN.test(value)) throw new ValidationError({ [key]: "INVALID_FORMAT" });
        binds.push(value);
        where.push(`t.${col} = ?${binds.length}`);
      }
    }
    const rows = await this.selectRows(name, where, binds);
    return this.toRecords(name, rows);
  }

  async get(actor: AuthContext, name: CmsEntityName, id: string, meta: RequestMeta): Promise<CmsRecord> {
    await this.authz.requirePermission(actor, ENTITY_CONFIG[name].view, meta);
    return this.recordOr404(name, id);
  }

  // ================================================================ writes

  async create(actor: AuthContext, name: CmsEntityName, body: Row, meta: RequestMeta): Promise<CmsRecord> {
    const def = ENTITIES[name];
    const cfg = ENTITY_CONFIG[name];
    await this.authz.requirePermission(actor, cfg.edit, meta);
    const input = parseInput(def, body, "create");
    const values = this.normalize(name, input.values);
    await this.checkReferences(def, values, Object.keys(values));
    // Codes left empty are made here: unique, from the English name when it has Latin letters.
    for (const f of def.fields) {
      if (f.auto && values[f.key] == null) values[f.key] = await this.autoCode(name, f, input.translations?.en?.name ?? null);
    }
    const translations = this.finalTranslations(def, input.translations ?? {}, {}, true);

    // New records go to the end of the list unless a position was given.
    if (def.fields.some((f) => f.key === "sortOrder") && body.sortOrder === undefined) {
      const max = await this.db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM ${cfg.table}`).first<{ m: number }>();
      values.sortOrder = Math.min(100_000, (max?.m ?? 0) + 10);
    }
    const id = newId();
    const now = iso(this.clock());
    const cols = ["id", ...def.fields.map((f) => column(f.key))];
    const vals: unknown[] = [id, ...def.fields.map((f) => toDb(f, values[f.key]))];
    if (cfg.createdBy) { cols.push(cfg.createdBy); vals.push(actor.userId); }
    if (cfg.updatedBy) { cols.push(cfg.updatedBy); vals.push(actor.userId); }
    if (cfg.hasUpdatedAt) { cols.push("created_at", "updated_at"); vals.push(now, now); }

    await this.run(name, [
      this.db.prepare(`INSERT INTO ${cfg.table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`).bind(...vals),
      ...this.translationStatements(def, cfg, id, translations),
      this.log.auditStatement(actor.userId, "CREATE", cfg.module, id, null, { entity: name, ...values, translations }, meta),
    ]);
    return this.recordOr404(name, id);
  }

  async update(actor: AuthContext, name: CmsEntityName, id: string, body: Row, meta: RequestMeta): Promise<CmsRecord> {
    const def = ENTITIES[name];
    const cfg = ENTITY_CONFIG[name];
    await this.authz.requirePermission(actor, cfg.edit, meta);
    const before = await this.recordOr404(name, id);
    const input = parseInput(def, body, "update");
    const merged = this.normalize(name, { ...pickFields(def, before), ...input.values });
    const changed = def.fields.map((f) => f.key).filter((k) => k in input.values || merged[k] !== before[k]);
    await this.checkReferences(def, merged, changed);
    const translations = input.translations
      ? this.finalTranslations(def, input.translations, before.translations, false)
      : {};

    const now = iso(this.clock());
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const key of changed) {
      const f = def.fields.find((x) => x.key === key)!;
      vals.push(toDb(f, merged[key]));
      sets.push(`${column(key)} = ?${vals.length}`);
    }
    // A slide's stored status follows its schedule when it is live.
    if (name === "homeSlide" && (before.status === "PUBLISHED" || before.status === "SCHEDULED")) {
      vals.push(slideLiveStatus(merged.startAt as string | null, now));
      sets.push(`status = ?${vals.length}`);
    }
    if (cfg.hasUpdatedAt) { vals.push(now); sets.push(`updated_at = ?${vals.length}`); }
    if (cfg.updatedBy) { vals.push(actor.userId); sets.push(`${cfg.updatedBy} = ?${vals.length}`); }

    const statements: D1PreparedStatementLike[] = [];
    if (sets.length > 0) {
      vals.push(id);
      statements.push(this.db.prepare(`UPDATE ${cfg.table} SET ${sets.join(", ")} WHERE id = ?${vals.length}`).bind(...vals));
    }
    // A new default daily limit also applies to future days that still use the old default.
    if (name === "foodCategory" && before.defaultDailyCapacity != null && merged.defaultDailyCapacity != null
      && before.defaultDailyCapacity !== merged.defaultDailyCapacity) {
      statements.push(this.db
        .prepare(`UPDATE food_daily_capacity SET max_quantity = ?3, updated_at = ?5
                   WHERE food_category_id = ?1 AND service_date >= ?4 AND max_quantity = ?2 AND used_quantity <= ?3`)
        .bind(id, before.defaultDailyCapacity, merged.defaultDailyCapacity, now.slice(0, 10), now));
    }
    statements.push(...this.translationStatements(def, cfg, id, translations));
    if (statements.length === 0) return before;
    statements.push(this.log.auditStatement(actor.userId, "UPDATE", cfg.module, id,
      { entity: name, ...pickFields(def, before), translations: before.translations },
      { entity: name, ...merged, ...(input.translations ? { translations: input.translations } : {}) }, meta));
    await this.run(name, statements);
    return this.recordOr404(name, id);
  }

  async remove(actor: AuthContext, name: CmsEntityName, id: string, meta: RequestMeta): Promise<void> {
    const def = ENTITIES[name];
    const cfg = ENTITY_CONFIG[name];
    if (!def.deletable || cfg.deleteMode === "none") throw new HttpError(405, "METHOD_NOT_ALLOWED", "This record cannot be deleted");
    await this.authz.requirePermission(actor, cfg.edit, meta);
    const before = await this.recordOr404(name, id);

    if (name === "galleryCategory") {
      const used = await this.db.prepare("SELECT COUNT(*) AS n FROM gallery_images WHERE category_id = ?1 AND status <> 'DELETED'")
        .bind(id).first<{ n: number }>();
      if ((used?.n ?? 0) > 0) throw new ConflictError("Move or delete the images in this category first", "CATEGORY_NOT_EMPTY");
    }
    if (name === "foodOption") {
      const used = await this.db.prepare("SELECT COUNT(*) AS n FROM included_meals WHERE food_option_id = ?1 AND status = 'ACTIVE'")
        .bind(id).first<{ n: number }>();
      if ((used?.n ?? 0) > 0) throw new ConflictError("This dish is an included meal of an accommodation", "OPTION_IN_USE");
    }

    const now = iso(this.clock());
    const statements: D1PreparedStatementLike[] = [];
    if (cfg.deleteMode === "hard") {
      if (cfg.trans) statements.push(this.db.prepare(`DELETE FROM ${cfg.trans.table} WHERE ${cfg.trans.fk} = ?1`).bind(id));
      statements.push(this.db.prepare(`DELETE FROM ${cfg.table} WHERE id = ?1`).bind(id));
    } else {
      statements.push(this.db.prepare(`UPDATE ${cfg.table} SET status = 'DELETED'${cfg.hasUpdatedAt ? ", updated_at = ?2" : ""} WHERE id = ?1`)
        .bind(...(cfg.hasUpdatedAt ? [id, now] : [id])));
    }
    statements.push(this.log.auditStatement(actor.userId, "DELETE", cfg.module, id,
      { entity: name, ...pickFields(def, before), status: before.status, translations: before.translations }, null, meta));
    await this.run(name, statements);
  }

  async authorizeEdit(actor: AuthContext, name: CmsEntityName, meta: RequestMeta): Promise<void> {
    await this.authz.requirePermission(actor, ENTITY_CONFIG[name].edit, meta);
  }

  async reorder(actor: AuthContext, name: CmsEntityName, ids: string[], meta: RequestMeta): Promise<CmsRecord[]> {
    const cfg = ENTITY_CONFIG[name];
    if (!ENTITIES[name].fields.some((f) => f.key === "sortOrder")) throw new HttpError(405, "METHOD_NOT_ALLOWED", "Not sortable");
    await this.authz.requirePermission(actor, cfg.edit, meta);
    if (ids.length === 0 || ids.length > MAX_REORDER || new Set(ids).size !== ids.length || !ids.every((i) => ID_PATTERN.test(i))) {
      throw new ValidationError({ ids: "INVALID_VALUE" });
    }
    const existing = await this.selectRows(name, cfg.deleteMode === "soft" ? ["t.status <> 'DELETED'"] : [], []);
    const known = new Set(existing.map((r) => r.id as string));
    if (!ids.every((i) => known.has(i))) throw new ValidationError({ ids: "UNKNOWN_ID" });
    const now = iso(this.clock());
    await this.run(name, [
      ...ids.map((rid, i) => this.db
        .prepare(`UPDATE ${cfg.table} SET sort_order = ?2${cfg.hasUpdatedAt ? ", updated_at = ?3" : ""} WHERE id = ?1`)
        .bind(...(cfg.hasUpdatedAt ? [rid, (i + 1) * 10, now] : [rid, (i + 1) * 10]))),
      this.log.auditStatement(actor.userId, "REORDER", cfg.module, null, null, { entity: name, ids }, meta),
    ]);
    return this.list(actor, name, {}, meta);
  }

  async setPublished(actor: AuthContext, name: CmsEntityName, id: string, publish: boolean, meta: RequestMeta): Promise<CmsRecord> {
    const def = ENTITIES[name];
    const cfg = ENTITY_CONFIG[name];
    if (!def.publishable || !cfg.publish || !cfg.publishStatus) throw new HttpError(405, "METHOD_NOT_ALLOWED", "Not publishable");
    await this.authz.requirePermission(actor, cfg.publish, meta);
    const before = await this.recordOr404(name, id);
    const now = iso(this.clock());

    let status = publish ? cfg.publishStatus.published : cfg.publishStatus.unpublished;
    if (publish) {
      if (def.requiredTranslation) {
        const value = before.translations[DEFAULT_LOCALE_CODE]?.[def.requiredTranslation];
        if (!value) throw new ValidationError({ [`translations.${DEFAULT_LOCALE_CODE}.${def.requiredTranslation}`]: "REQUIRED" });
      }
      if (name === "homeSlide") {
        const endAt = before.endAt as string | null;
        if (endAt && endAt <= now) throw new ConflictError("This slide's end date has passed", "SLIDE_ENDED");
        status = slideLiveStatus(before.startAt as string | null, now);
      }
    }
    const sets = ["status = ?2"];
    const vals: unknown[] = [id, status];
    if (cfg.hasUpdatedAt) { vals.push(now); sets.push(`updated_at = ?${vals.length}`); }
    if (publish && cfg.publishedAt) { vals.push(now); sets.push(`${cfg.publishedAt} = COALESCE(${cfg.publishedAt}, ?${vals.length})`); }
    if (cfg.updatedBy) { vals.push(actor.userId); sets.push(`${cfg.updatedBy} = ?${vals.length}`); }
    await this.run(name, [
      this.db.prepare(`UPDATE ${cfg.table} SET ${sets.join(", ")} WHERE id = ?1`).bind(...vals),
      this.log.auditStatement(actor.userId, publish ? "PUBLISH" : "UNPUBLISH", cfg.module, id,
        { entity: name, status: before.status }, { entity: name, status }, meta),
    ]);
    return this.recordOr404(name, id);
  }

  // ================================================================ internals

  private async recordOr404(name: CmsEntityName, id: string): Promise<CmsRecord> {
    const cfg = ENTITY_CONFIG[name];
    if (!ID_PATTERN.test(id)) throw new NotFoundError("Record not found", "RECORD_NOT_FOUND");
    const where = ["t.id = ?1", ...(cfg.deleteMode === "soft" ? ["t.status <> 'DELETED'"] : [])];
    const rows = await this.selectRows(name, where, [id]);
    if (rows.length === 0) throw new NotFoundError("Record not found", "RECORD_NOT_FOUND");
    return (await this.toRecords(name, rows))[0]!;
  }

  private async selectRows(name: CmsEntityName, where: string[], binds: unknown[]): Promise<Row[]> {
    const def = ENTITIES[name];
    const cfg = ENTITY_CONFIG[name];
    const assets = def.fields.filter((f) => f.kind === "asset");
    const joins = assets.map((f, i) =>
      `LEFT JOIN media_assets m${i} ON m${i}.id = t.${column(f.key)} AND m${i}.bucket = 'PUBLIC' AND m${i}.status = 'ACTIVE'`);
    const sql = `SELECT t.*${assets.map((_, i) => `, m${i}.object_key AS __m${i}`).join("")}
                   FROM ${cfg.table} t ${joins.join(" ")}
                  ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                  ORDER BY ${cfg.orderBy} LIMIT ${MAX_LIST}`;
    const { results } = await this.db.prepare(sql).bind(...binds).all<Row>();
    return results;
  }

  private async toRecords(name: CmsEntityName, rows: Row[]): Promise<CmsRecord[]> {
    const def = ENTITIES[name];
    const cfg = ENTITY_CONFIG[name];
    const trans = new Map<string, CmsRecord["translations"]>();
    if (cfg.trans && rows.length > 0) {
      const ids = rows.map((r) => r.id as string);
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        const { results } = await this.db
          .prepare(`SELECT * FROM ${cfg.trans.table} WHERE ${cfg.trans.fk} IN (${chunk.map((_, j) => `?${j + 1}`).join(", ")})`)
          .bind(...chunk).all<Row>();
        for (const tr of results) {
          const owner = tr[cfg.trans.fk] as string;
          const map = trans.get(owner) ?? {};
          map[tr.language_code as LocaleCode] = Object.fromEntries(
            def.translations.map((f) => [f.key, (tr[column(f.key)] as string | null) ?? null]));
          trans.set(owner, map);
        }
      }
    }
    const now = iso(this.clock());
    const assets = def.fields.filter((f) => f.kind === "asset");
    return rows.map((r) => {
      const rec: CmsRecord = {
        id: r.id as string,
        translations: trans.get(r.id as string) ?? {},
        urls: Object.fromEntries(assets.map((f, i) => [f.key, publicMediaUrl(r[`__m${i}`] as string | null, this.mediaBaseUrl) ?? null])),
        updatedAt: (r.updated_at as string | undefined) ?? null,
      };
      for (const f of def.fields) rec[f.key] = fromDb(f, r[column(f.key)]);
      if (typeof r.status === "string") {
        rec.status = r.status;
        rec.effectiveStatus = name === "homeSlide"
          ? slideEffectiveStatus(r.status, rec.startAt as string | null, rec.endAt as string | null, now)
          : r.status;
      }
      if (cfg.publishedAt) rec.publishedAt = r[cfg.publishedAt] ?? null;
      return rec;
    });
  }

  /** Entity rules that involve several fields; also clears values that do not apply. */
  private normalize(name: CmsEntityName, v: Values): Values {
    const out = { ...v };
    const errors: Record<string, string> = {};
    switch (name) {
      case "foodCategory":
        if (out.deadlineType === "DAYS_BEFORE" && out.deadlineDaysBefore == null) errors.deadlineDaysBefore = "REQUIRED";
        if (out.deadlineType === "PREVIOUS_DAY_TIME" && out.deadlineTime == null) errors.deadlineTime = "REQUIRED";
        if (out.deadlineType !== "DAYS_BEFORE") out.deadlineDaysBefore = null;
        if (out.deadlineType !== "PREVIOUS_DAY_TIME") out.deadlineTime = null;
        break;
      case "foodOption":
        if (out.childPricing === "SPECIAL_PRICE" && out.childPriceSatang == null) errors.childPriceSatang = "REQUIRED";
        if (out.childPricing !== "SPECIAL_PRICE") out.childPriceSatang = null;
        if (out.pricingType === "PER_SET" && out.personsPerSet == null) errors.personsPerSet = "REQUIRED";
        if (out.maxQuantity != null && (out.maxQuantity as number) < (out.minQuantity as number)) errors.maxQuantity = "OUT_OF_RANGE";
        break;
      case "includedMeal":
        if (out.targetType === "UNIT" && !out.unitId) errors.unitId = "REQUIRED";
        if (out.targetType === "UNIT_TYPE" && !out.unitType) errors.unitType = "REQUIRED";
        if (out.targetType !== "UNIT") out.unitId = null;
        if (out.targetType !== "UNIT_TYPE") out.unitType = null;
        break;
      case "homeSlide":
        if (out.startAt && out.endAt && (out.endAt as string) <= (out.startAt as string)) errors.endAt = "END_BEFORE_START";
        break;
      case "seoRedirect": {
        const from = (out.fromPath as string).toLowerCase();
        if (RESERVED_REDIRECT_PREFIXES.some((p) => from === p || from.startsWith(`${p}/`))) errors.fromPath = "RESERVED_PATH";
        if (out.fromPath === out.toPath) errors.toPath = "SAME_AS_SOURCE";
        break;
      }
      default:
        break;
    }
    if (Object.keys(errors).length) throw new ValidationError(errors);
    return out;
  }

  /** Referenced records must exist; images must be active public assets of the field's purpose. */
  private async checkReferences(def: EntityDef, values: Values, keys: string[]): Promise<void> {
    const errors: Record<string, string> = {};
    for (const key of keys) {
      const f = def.fields.find((x) => x.key === key);
      const value = values[key];
      if (!f || value == null) continue;
      if (f.kind === "asset") {
        const asset = await this.db.prepare("SELECT purpose, bucket, status, parent_asset_id FROM media_assets WHERE id = ?1").bind(value)
          .first<{ purpose: string; bucket: string; status: string; parent_asset_id: string | null }>();
        // Content points at originals only; renditions are found through their original.
        if (!asset || asset.status !== "ACTIVE" || asset.bucket !== "PUBLIC" || asset.parent_asset_id) errors[key] = "MEDIA_NOT_FOUND";
        else if (asset.purpose !== f.purpose) errors[key] = "WRONG_MEDIA_PURPOSE";
      }
      if (f.kind === "ref" && f.ref) {
        const ref = REF_TABLES[f.ref]!;
        const row = await this.db.prepare(`SELECT 1 AS ok FROM ${ref.table} WHERE id = ?1 AND ${ref.alive}`).bind(value).first();
        if (!row) errors[key] = "NOT_FOUND";
      }
    }
    if (def.name === "includedMeal" && values.foodOptionId && !errors.foodOptionId) {
      const row = await this.db.prepare("SELECT food_category_id FROM food_options WHERE id = ?1").bind(values.foodOptionId)
        .first<{ food_category_id: string }>();
      if (row?.food_category_id !== values.foodCategoryId) errors.foodOptionId = "CATEGORY_MISMATCH";
    }
    if (Object.keys(errors).length) throw new ValidationError(errors);
  }

  /**
   * Translations to write. A language object replaces that language; an empty one removes it.
   * The default language (th) must keep the required field (e.g. name).
   */
  private finalTranslations(def: EntityDef, input: TransInput, existing: CmsRecord["translations"], creating: boolean) {
    const out: Partial<Record<LocaleCode, Record<string, string | null> | null>> = {};
    const errors: Record<string, string> = {};
    for (const lang of LOCALE_CODES) {
      if (!(lang in input)) continue;
      const t = input[lang];
      const empty = !t || Object.values(t).every((x) => x == null || x === "");
      out[lang] = empty ? null : t;
      if (!empty && def.requiredTranslation && !t![def.requiredTranslation]) {
        errors[`translations.${lang}.${def.requiredTranslation}`] = "REQUIRED";
      }
    }
    if (def.requiredTranslation) {
      const th = DEFAULT_LOCALE_CODE in out ? out[DEFAULT_LOCALE_CODE] : existing[DEFAULT_LOCALE_CODE];
      if ((creating || DEFAULT_LOCALE_CODE in out) && !th?.[def.requiredTranslation]) {
        errors[`translations.${DEFAULT_LOCALE_CODE}.${def.requiredTranslation}`] = "REQUIRED";
      }
    }
    if (Object.keys(errors).length) throw new ValidationError(errors);
    return out;
  }

  private translationStatements(def: EntityDef, cfg: EntityConfig, id: string, translations: TransInput): D1PreparedStatementLike[] {
    if (!cfg.trans) return [];
    const { table, fk } = cfg.trans;
    const cols = def.translations.map((f) => column(f.key));
    return Object.entries(translations).map(([lang, t]) => {
      if (!t) return this.db.prepare(`DELETE FROM ${table} WHERE ${fk} = ?1 AND language_code = ?2`).bind(id, lang);
      return this.db
        .prepare(`INSERT INTO ${table} (${fk}, language_code, ${cols.join(", ")})
                  VALUES (?1, ?2, ${cols.map((_, i) => `?${i + 3}`).join(", ")})
                  ON CONFLICT (${fk}, language_code) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`)
        .bind(id, lang, ...def.translations.map((f) => t[f.key] ?? null));
    });
  }

  /** Runs a batch and turns constraint failures into client errors. */
  /** A code nobody uses yet: NAME, NAME_2 (or NAME_B where digits are not allowed), … */
  private async autoCode(name: CmsEntityName, f: FieldDef, englishName: string | null): Promise<string> {
    const max = f.max ?? 40;
    let base = (englishName ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    if (f.lettersOnly) base = base.replace(/[0-9]+/g, "_");
    base = base.replace(/_+/g, "_").replace(/^[_0-9]+|_+$/g, "").slice(0, max - 4).replace(/_+$/, "");
    if (base.length < 2) base = name === "foodCategory" ? "CATEGORY" : "DISH";
    const sql = AUTO_CODE_SQL[name];
    if (!sql) return base;
    const { results } = await this.db.prepare(sql).bind(base, base.length).all<{ code: string }>();
    const taken = new Set(results.map((r) => r.code));
    for (let n = 1; n < 1000; n++) {
      const suffix = n === 1 ? "" : `_${f.lettersOnly ? letters(n) : n}`;
      const candidate = `${base}${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}_${f.lettersOnly ? letters(Date.now() % 100_000) : Date.now() % 100_000}`;
  }

  private async run(name: CmsEntityName, statements: D1PreparedStatementLike[]): Promise<void> {
    try {
      await this.db.batch(statements);
    } catch (error) {
      const message = String(error);
      const unique = /UNIQUE constraint failed: \w+\.(\w+)/.exec(message);
      if (unique) {
        const field = ENTITIES[name].fields.find((f) => column(f.key) === unique[1])?.key ?? unique[1]!;
        throw new HttpError(409, "DUPLICATE", "This value is already used", { [field]: "TAKEN" });
      }
      if (/FOREIGN KEY constraint failed/.test(message)) throw new ValidationError({ body: "INVALID_REFERENCE" });
      if (/CHECK constraint failed/.test(message)) throw new ValidationError({ body: "INVALID_VALUE" });
      throw error;
    }
  }
}

// ==================================================================== parsing

/** Existing codes that start with a given base (static SQL per table). */
const AUTO_CODE_SQL: Partial<Record<CmsEntityName, string>> = {
  foodCategory: "SELECT code FROM food_categories WHERE substr(code, 1, ?2) = ?1",
  foodOption: "SELECT code FROM food_options WHERE substr(code, 1, ?2) = ?1",
};

/** 2 → B, 3 → C, … 27 → AA (suffixes for letters-only codes). */
function letters(n: number): string {
  let out = "";
  for (let x = n - 1; x >= 0; x = Math.floor(x / 26) - 1) out = String.fromCharCode(65 + (x % 26)) + out;
  return out;
}

function pickFields(def: EntityDef, rec: CmsRecord): Values {
  return Object.fromEntries(def.fields.map((f) => [f.key, rec[f.key]]));
}

/** Strict parser: unknown keys rejected, immutable keys rejected on update. */
export function parseInput(def: EntityDef, body: Row, mode: "create" | "update"): ParsedInput {
  const errors: Record<string, string> = {};
  const allowed = new Set([...def.fields.map((f) => f.key), ...(def.translations.length ? ["translations"] : [])]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) errors[key] = "UNKNOWN_FIELD";

  const values: Values = {};
  for (const f of def.fields) {
    const present = Object.prototype.hasOwnProperty.call(body, f.key) && body[f.key] !== undefined;
    if (mode === "update" && present && f.immutable) { errors[f.key] = "IMMUTABLE"; continue; }
    if (!present) {
      if (mode === "create") {
        if (f.default !== undefined) values[f.key] = f.default;
        else if (f.required) errors[f.key] = "REQUIRED";
        else values[f.key] = null;
      }
      continue;
    }
    const result = parseValue(f, body[f.key]);
    if (isError(result)) errors[f.key] = result.error;
    else values[f.key] = result;
  }

  let translations: TransInput | undefined;
  if (body.translations !== undefined) {
    const raw = body.translations;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) errors.translations = "EXPECTED_OBJECT";
    else {
      translations = {};
      for (const [lang, t] of Object.entries(raw as Row)) {
        if (!(LOCALE_CODES as readonly string[]).includes(lang)) { errors[`translations.${lang}`] = "UNKNOWN_LANGUAGE"; continue; }
        if (t === null) { translations[lang as LocaleCode] = null; continue; }
        if (typeof t !== "object" || Array.isArray(t)) { errors[`translations.${lang}`] = "EXPECTED_OBJECT"; continue; }
        const out: Record<string, string | null> = {};
        for (const key of Object.keys(t as Row)) {
          if (!def.translations.some((f) => f.key === key)) errors[`translations.${lang}.${key}`] = "UNKNOWN_FIELD";
        }
        for (const f of def.translations) {
          const v = (t as Row)[f.key];
          if (v === undefined || v === null) { out[f.key] = null; continue; }
          const result = parseValue({ ...f, required: false }, v);
          if (isError(result)) errors[`translations.${lang}.${f.key}`] = result.error;
          else out[f.key] = result as string | null;
        }
        translations[lang as LocaleCode] = out;
      }
    }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { values, translations };
}

type Parsed = unknown | { error: string };

function isError(v: Parsed): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v && typeof (v as { error: unknown }).error === "string";
}

function parseValue(f: FieldDef, raw: unknown): Parsed {
  if (raw === null || raw === "") return f.required ? { error: "REQUIRED" } : null;
  switch (f.kind) {
    case "text":
    case "multiline": {
      if (typeof raw !== "string") return { error: "EXPECTED_STRING" };
      const v = f.kind === "multiline" ? raw.replace(/\r\n?/g, "\n").trim() : raw.trim();
      if (!(f.kind === "multiline" ? CMS_TEXT.multiline : CMS_TEXT.singleLine).test(v)) return { error: "INVALID_CHARACTERS" };
      if (v.length === 0) return f.required ? { error: "REQUIRED" } : null;
      if (f.max !== undefined && [...v].length > f.max) return { error: "TOO_LONG" };
      return v;
    }
    case "int":
    case "money": {
      if (typeof raw !== "number" || !Number.isInteger(raw)) return { error: "EXPECTED_INTEGER" };
      const max = f.kind === "money" ? MAX_PRICE_SATANG : f.max;
      if ((f.min !== undefined && raw < f.min) || (max !== undefined && raw > max)) return { error: "OUT_OF_RANGE" };
      if (f.values && !f.values.includes(raw)) return { error: "INVALID_VALUE" };
      return raw;
    }
    case "enum":
      if (typeof raw !== "string" || !f.values?.includes(raw)) return { error: "INVALID_VALUE" };
      return raw;
    case "bool":
      if (typeof raw !== "boolean") return { error: "EXPECTED_BOOLEAN" };
      return raw;
    case "link": {
      if (typeof raw !== "string") return { error: "EXPECTED_STRING" };
      const v = raw.trim();
      if ((f.max !== undefined && v.length > f.max) || !isSafeLink(v)) return { error: "INVALID_URL" };
      return v;
    }
    case "path": {
      if (typeof raw !== "string") return { error: "EXPECTED_STRING" };
      const v = raw.trim();
      if ((f.max !== undefined && v.length > f.max) || !isSafePath(v)) return { error: "INVALID_PATH" };
      return v;
    }
    case "color":
      return typeof raw === "string" && CMS_TEXT.color.test(raw) ? raw.toLowerCase() : { error: "INVALID_FORMAT" };
    case "time":
      return typeof raw === "string" && CMS_TEXT.time.test(raw) ? raw : { error: "INVALID_FORMAT" };
    case "slug": {
      if (typeof raw !== "string") return { error: "EXPECTED_STRING" };
      const v = normalizeSlug(raw);
      if (v === "") return f.required ? { error: "REQUIRED" } : null;
      return CMS_TEXT.slug.test(v) && (f.max === undefined || v.length <= f.max) ? v : { error: "SLUG_FORMAT" };
    }
    case "code": {
      if (typeof raw !== "string") return { error: "EXPECTED_STRING" };
      const v = normalizeCode(raw);
      if (v === "") return f.required ? { error: "REQUIRED" } : null;
      if (f.lettersOnly && /[0-9]/.test(v)) return { error: "CODE_LETTERS_ONLY" };
      return CMS_TEXT.code.test(v) && (f.max === undefined || v.length <= f.max) ? v : { error: f.lettersOnly ? "CODE_LETTERS_ONLY" : "CODE_FORMAT" };
    }
    case "datetime": {
      if (typeof raw !== "string" || raw.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return { error: "INVALID_FORMAT" };
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? { error: "INVALID_FORMAT" } : d.toISOString();
    }
    case "asset":
    case "ref":
      return typeof raw === "string" && ID_PATTERN.test(raw) ? raw : { error: "INVALID_FORMAT" };
  }
}

function toDb(f: FieldDef, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (f.kind === "bool") return v ? 1 : 0;
  return v;
}

function fromDb(f: FieldDef, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (f.kind === "bool") return v === 1 || v === true;
  return v;
}

// ==================================================================== slides (spec §9)

/** Stored status of a live slide: SCHEDULED until its start time, then PUBLISHED. */
export function slideLiveStatus(startAt: string | null, now: string): "PUBLISHED" | "SCHEDULED" {
  return startAt && startAt > now ? "SCHEDULED" : "PUBLISHED";
}

/** What visitors see right now: a live slide past its end date is EXPIRED. */
export function slideEffectiveStatus(status: string, startAt: string | null, endAt: string | null, now: string): string {
  if (status !== "PUBLISHED" && status !== "SCHEDULED") return status;
  if (endAt && endAt <= now) return "EXPIRED";
  return slideLiveStatus(startAt, now);
}
