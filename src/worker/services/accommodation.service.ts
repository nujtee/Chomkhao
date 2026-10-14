import type { ImageResolver, Rendition } from "../media/image-resolver.ts";
import type {
  AdminUnitDto,
  AmenityDto,
  ImageStatus,
  PublicAccommodationsDto,
  PublicImageDto,
  PublicUnitDto,
  UnitStatus,
  UnitTranslationDto,
  UnitType,
} from "../../shared/accommodation-types.ts";
import type { PaymentMode } from "../../shared/booking-rules.ts";
import { DEFAULT_TIMEZONE, todayIn } from "../../shared/dates.ts";
import { DEFAULT_LOCALE_CODE, parseLocale, type Locale, type LocaleCode } from "../../shared/i18n/locales.ts";
import type { D1DatabaseLike, D1PreparedStatementLike, R2BucketLike } from "../env.ts";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors.ts";
import { openDepositBookings } from "../repositories/deposit-bookings.ts";
import type { AccommodationRepository, UnitImageRow, UnitRow, UnitTranslationRow } from "../repositories/accommodation.repository.ts";
import type { InventoryRepository } from "../repositories/inventory.repository.ts";
import type { MediaRepository } from "../repositories/media.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import { groupTexts } from "./media.service.ts";
import { publicMediaUrl } from "./media-url.ts";
import type { SecurityLogService } from "./security-log.service.ts";

const MODULE = "accommodation";

export interface UnitInput {
  unitCode: string;
  unitType: UnitType;
  slug: string;
  basePriceSatang: number;
  paymentMode: PaymentMode;
  standardGuests: number;
  maxGuests: number;
  maxAdults: number | null;
  status: Exclude<UnitStatus, "DELETED">;
  sortOrder: number;
}

/** Pick the requested language, then the default language, then any. */
export function pickTranslation<T>(byLang: Partial<Record<string, T>>, lang: string): T | undefined {
  return byLang[lang] ?? byLang[DEFAULT_LOCALE_CODE] ?? Object.values(byLang)[0];
}

export class AccommodationService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: AccommodationRepository,
    private readonly inventory: InventoryRepository,
    private readonly media: MediaRepository,
    private readonly bucket: R2BucketLike,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly mediaBaseUrl: string | undefined,
    private readonly clock: Clock,
    /** Responsive renditions (Phase 12). */
    private readonly images: ImageResolver | null = null,
  ) {}

  // ================================================================ public

  async publicList(locale: Locale): Promise<PublicAccommodationsDto> {
    const units = await this.repo.listUnits({ publicOnly: true });
    const dtos = await this.toPublic(units, locale.code);
    const camping = await this.inventory.campingSettings();
    const campingTexts = Object.fromEntries((await this.inventory.campingTranslations()).map((t) => [t.language_code, t]));
    const ct = pickTranslation(campingTexts, locale.code);
    const coverUrl = camping?.cover_key ? publicMediaUrl(camping.cover_key, this.mediaBaseUrl) : null;
    const coverRenditions = this.images && camping?.cover_asset_id ? await this.images.renditions([camping.cover_asset_id]) : null;
    const coverSrcset = coverRenditions && camping?.cover_asset_id
      ? this.images!.srcset(coverRenditions.get(camping.cover_asset_id), { key: camping.cover_key, width: camping.cover_width }) : null;
    return {
      language: locale.code,
      houses: dtos.filter((u) => u.unitType === "HOUSE"),
      vipTents: dtos.filter((u) => u.unitType === "VIP_TENT"),
      camping: {
        enabled: camping?.is_enabled === 1,
        name: ct?.name ?? null,
        description: ct?.description ?? null,
        pricePerAdultNightSatang: camping?.price_per_adult_night_satang ?? 0,
        childFreeUnderAge: camping?.child_free_under_age ?? 12,
        maxGuestsPerTent: camping?.max_guests_per_tent ?? null,
        maxTentsPerNight: camping?.max_tents_per_night ?? 0,
        cover: coverUrl ? { url: coverUrl, alt: ct?.name ?? "", caption: null, width: camping?.cover_width ?? null, height: camping?.cover_height ?? null, srcset: coverSrcset } : null,
        tarp: camping?.tarp_enabled === 1 && camping.max_tarps_per_night > 0 ? { pricePerNightSatang: camping.tarp_price_per_night_satang } : null,
      },
    };
  }

  async publicBySlug(slug: string, locale: Locale): Promise<PublicUnitDto> {
    const unit = await this.repo.findActiveBySlug(slug);
    if (!unit) throw new NotFoundError("Accommodation not found", "ACCOMMODATION_NOT_FOUND");
    const [dto] = await this.toPublic([unit], locale.code);
    if (!dto) throw new NotFoundError("Accommodation not found", "ACCOMMODATION_NOT_FOUND");
    return dto;
  }

  private async toPublic(units: UnitRow[], lang: LocaleCode): Promise<PublicUnitDto[]> {
    const ids = units.map((u) => u.id);
    const [translations, images, links, amenities] = await Promise.all([
      this.repo.translations(ids), this.repo.images(ids, true), this.repo.unitAmenities(ids), this.repo.amenities(true),
    ]);
    const texts = groupTexts(await this.media.translationsFor(images.map((i) => i.media_asset_id)));
    const renditions = this.images
      ? await this.images.renditions([...images.map((i) => i.media_asset_id), ...units.map((u) => u.cover_asset_id)])
      : new Map<string, Rendition[]>();
    const tByUnit = groupBy(translations, (t) => t.unit_id);
    const amenityById = new Map(amenities.map((a) => [a.id, a]));

    return units.flatMap((u) => {
      const t = pickTranslation(Object.fromEntries((tByUnit.get(u.id) ?? []).map((x) => [x.language_code, x])), lang);
      if (!t) return []; // never publish a unit without any name
      const toImage = (key: string, assetId: string, w: number | null, h: number | null): PublicImageDto => {
        const mt = pickTranslation(texts[assetId] ?? {}, lang);
        return {
          url: publicMediaUrl(key, this.mediaBaseUrl) ?? "", alt: mt?.altText ?? t.name, caption: mt?.caption ?? null, width: w, height: h,
          srcset: this.images?.srcset(renditions.get(assetId), { key, width: w }) ?? null,
        };
      };
      const unitImages = images.filter((i) => i.unit_id === u.id);
      return [{
        id: u.id,
        slug: u.slug,
        unitCode: u.unit_code,
        unitType: u.unit_type,
        name: t.name,
        shortDescription: t.short_description,
        description: t.description,
        seoTitle: t.seo_title,
        seoDescription: t.seo_description,
        priceSatang: u.base_price_satang,
        standardGuests: u.standard_guests,
        maxGuests: u.max_guests,
        maxAdults: u.max_adults,
        cover: u.cover_key && u.cover_asset_id ? toImage(u.cover_key, u.cover_asset_id, u.cover_width, u.cover_height) : null,
        images: unitImages.map((i) => toImage(i.object_key, i.media_asset_id, i.width, i.height)),
        amenities: links
          .filter((l) => l.unit_id === u.id)
          .flatMap((l) => {
            const a = amenityById.get(l.amenity_id);
            if (!a) return [];
            const names = JSON.parse(a.names ?? "{}") as Record<string, string>;
            return [{ code: a.code, icon: a.icon, name: pickTranslation(names, lang) ?? a.code }];
          }),
      }];
    });
  }

  // ================================================================ admin reads

  async list(actor: AuthContext, type: UnitType | undefined, meta: RequestMeta): Promise<AdminUnitDto[]> {
    await this.authz.requirePermission(actor, "accommodation.view", meta);
    return this.toAdmin(await this.repo.listUnits({ type }));
  }

  async get(actor: AuthContext, id: string, meta: RequestMeta): Promise<AdminUnitDto> {
    await this.authz.requirePermission(actor, "accommodation.view", meta);
    return this.getAdmin(id);
  }

  private async getAdmin(id: string): Promise<AdminUnitDto> {
    const unit = await this.repo.findUnit(id);
    if (!unit || unit.status === "DELETED") throw new NotFoundError("Accommodation not found", "ACCOMMODATION_NOT_FOUND");
    const [dto] = await this.toAdmin([unit]);
    // Open deposit bookings keep their plan whatever this unit takes today: the owner sees how many there are.
    return { ...dto!, depositBookings: await openDepositBookings(this.db, id, this.now()) };
  }

  private async toAdmin(units: UnitRow[]): Promise<AdminUnitDto[]> {
    const ids = units.map((u) => u.id);
    const [translations, images, links] = await Promise.all([
      this.repo.translations(ids), this.repo.images(ids, false), this.repo.unitAmenities(ids),
    ]);
    const texts = groupTexts(await this.media.translationsFor(images.map((i) => i.media_asset_id)));
    return units.map((u) => ({
      id: u.id,
      unitCode: u.unit_code,
      unitType: u.unit_type,
      slug: u.slug,
      basePriceSatang: u.base_price_satang,
      paymentMode: u.payment_mode ?? "FULL",
      standardGuests: u.standard_guests,
      maxGuests: u.max_guests,
      maxAdults: u.max_adults,
      status: u.status,
      sortOrder: u.sort_order,
      coverAssetId: u.cover_asset_id,
      coverUrl: u.cover_key ? publicMediaUrl(u.cover_key, this.mediaBaseUrl) : null,
      translations: Object.fromEntries(
        translations.filter((t) => t.unit_id === u.id).map((t) => [t.language_code, toTranslationDto(t)]),
      ),
      amenityIds: links.filter((l) => l.unit_id === u.id).map((l) => l.amenity_id),
      images: images.filter((i) => i.unit_id === u.id).map((i) => ({
        id: i.id,
        mediaAssetId: i.media_asset_id,
        url: publicMediaUrl(i.object_key, this.mediaBaseUrl) ?? "",
        width: i.width,
        height: i.height,
        sortOrder: i.sort_order,
        status: i.status,
        isCover: i.media_asset_id === u.cover_asset_id,
        texts: texts[i.media_asset_id] ?? {},
      })),
      createdAt: u.created_at,
      updatedAt: u.updated_at,
    }));
  }

  // ================================================================ admin writes

  async create(actor: AuthContext, input: UnitInput, meta: RequestMeta): Promise<AdminUnitDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    await this.authz.requirePermission(actor, "pricing.edit", meta);
    if (input.status === "ACTIVE") throw new ValidationError({ status: "ADD_TRANSLATION_BEFORE_ACTIVATING" });
    await this.assertUnique(input.unitCode, input.slug, null);

    const id = newId();
    const now = this.now();
    await this.commit([
      this.repo.insertUnitStatement({ id, ...input, createdBy: actor.userId, now }),
      this.priceHistory(id, null, input.basePriceSatang, actor.userId),
      this.log.auditStatement(actor.userId, "CREATE", MODULE, id, null, input, meta),
    ]);
    return this.getAdmin(id);
  }

  async update(actor: AuthContext, id: string, patch: Partial<UnitInput>, meta: RequestMeta): Promise<AdminUnitDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const current = await this.getAdmin(id);
    if (patch.unitType && patch.unitType !== current.unitType) throw new ValidationError({ unitType: "IMMUTABLE" });

    const next = {
      unitCode: patch.unitCode ?? current.unitCode,
      slug: patch.slug ?? current.slug,
      basePriceSatang: patch.basePriceSatang ?? current.basePriceSatang,
      paymentMode: patch.paymentMode ?? current.paymentMode,
      standardGuests: patch.standardGuests ?? current.standardGuests,
      maxGuests: patch.maxGuests ?? current.maxGuests,
      maxAdults: patch.maxAdults === undefined ? current.maxAdults : patch.maxAdults,
      status: (patch.status ?? current.status) as UnitStatus,
      sortOrder: patch.sortOrder ?? current.sortOrder,
    };
    if (next.maxGuests < next.standardGuests) throw new ValidationError({ maxGuests: "LESS_THAN_STANDARD_GUESTS" });
    if (next.maxAdults !== null && next.maxAdults > next.maxGuests) throw new ValidationError({ maxAdults: "MORE_THAN_MAX_GUESTS" });
    if (next.status === "ACTIVE" && !current.translations[DEFAULT_LOCALE_CODE]?.name) {
      throw new ValidationError({ status: "ADD_TRANSLATION_BEFORE_ACTIVATING" });
    }
    // How guests pay is a money decision too: the same permission as the price.
    const priceChanged = next.basePriceSatang !== current.basePriceSatang;
    if (next.paymentMode !== current.paymentMode) await this.authz.requirePermission(actor, "pricing.edit", meta);
    if (priceChanged) await this.authz.requirePermission(actor, "pricing.edit", meta);
    await this.assertUnique(next.unitCode, next.slug, id);

    const statements: D1PreparedStatementLike[] = [
      this.repo.updateUnitStatement(id, { ...next, now: this.now() }),
      this.log.auditStatement(actor.userId, "UPDATE", MODULE, id, pickUnitFields(current), {
        ...next,
        // Deposit ↔ full payment: open deposit bookings keep the plan agreed at booking time (deposit frozen).
        ...(next.paymentMode !== current.paymentMode ? { keptDepositBookings: current.depositBookings } : {}),
      }, meta),
    ];
    if (priceChanged) statements.push(this.priceHistory(id, current.basePriceSatang, next.basePriceSatang, actor.userId));
    await this.commit(statements);
    return this.getAdmin(id);
  }

  async setTranslations(
    actor: AuthContext,
    id: string,
    translations: Partial<Record<LocaleCode, UnitTranslationDto | null>>,
    meta: RequestMeta,
  ): Promise<AdminUnitDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const current = await this.getAdmin(id);
    if (current.status === "ACTIVE" && translations[DEFAULT_LOCALE_CODE] === null) {
      throw new ValidationError({ [DEFAULT_LOCALE_CODE]: "DEFAULT_LANGUAGE_REQUIRED" });
    }
    const statements = Object.entries(translations).map(([lang, t]) =>
      t ? this.repo.upsertTranslationStatement(id, lang, t) : this.repo.deleteTranslationStatement(id, lang));
    statements.push(this.log.auditStatement(actor.userId, "UPDATE_TRANSLATIONS", MODULE, id, current.translations, translations, meta));
    await this.commit(statements);
    return this.getAdmin(id);
  }

  async setAmenities(actor: AuthContext, id: string, amenityIds: string[], meta: RequestMeta): Promise<AdminUnitDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const current = await this.getAdmin(id);
    const known = new Set((await this.repo.amenities(false)).map((a) => a.id));
    if (amenityIds.some((a) => !known.has(a))) throw new ValidationError({ amenityIds: "UNKNOWN_AMENITY" });
    await this.commit([
      ...this.repo.replaceAmenitiesStatements(id, amenityIds),
      this.log.auditStatement(actor.userId, "UPDATE_AMENITIES", MODULE, id, { amenityIds: current.amenityIds }, { amenityIds }, meta),
    ]);
    return this.getAdmin(id);
  }

  async addImage(actor: AuthContext, id: string, mediaAssetId: string, meta: RequestMeta): Promise<AdminUnitDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const current = await this.getAdmin(id);
    const asset = await this.media.findById(mediaAssetId);
    if (!asset || asset.status !== "ACTIVE" || asset.bucket !== "PUBLIC" || asset.purpose !== "ACCOMMODATION" || asset.parent_asset_id) {
      throw new ValidationError({ mediaAssetId: "INVALID_IMAGE" });
    }
    if (current.images.some((i) => i.mediaAssetId === mediaAssetId)) throw new ConflictError("Image already added", "IMAGE_ALREADY_ADDED");
    const now = this.now();
    const statements = [
      this.repo.addImageStatement(newId(), id, mediaAssetId, now),
      this.log.auditStatement(actor.userId, "ADD_IMAGE", MODULE, id, null, { mediaAssetId }, meta),
    ];
    if (!current.coverAssetId) statements.push(this.repo.setCoverStatement(id, mediaAssetId, now));
    await this.commit(statements);
    return this.getAdmin(id);
  }

  async updateImage(actor: AuthContext, id: string, imageId: string, status: ImageStatus, meta: RequestMeta): Promise<AdminUnitDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const current = await this.getAdmin(id);
    const image = current.images.find((i) => i.id === imageId);
    if (!image) throw new NotFoundError("Image not found", "IMAGE_NOT_FOUND");
    await this.commit([
      this.repo.setImageStatusStatement(id, imageId, status),
      this.log.auditStatement(actor.userId, "UPDATE_IMAGE", MODULE, id, { imageId, status: image.status }, { imageId, status }, meta),
    ]);
    return this.getAdmin(id);
  }

  async reorderImages(actor: AuthContext, id: string, imageIds: string[], meta: RequestMeta): Promise<AdminUnitDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const current = await this.getAdmin(id);
    const existing = current.images.map((i) => i.id);
    if (imageIds.length !== existing.length || !existing.every((x) => imageIds.includes(x))) {
      throw new ValidationError({ imageIds: "MUST_LIST_ALL_IMAGES" });
    }
    await this.commit([
      ...imageIds.map((imageId, i) => this.repo.setImageOrderStatement(id, imageId, i)),
      this.log.auditStatement(actor.userId, "REORDER_IMAGES", MODULE, id, { order: existing }, { order: imageIds }, meta),
    ]);
    return this.getAdmin(id);
  }

  async setCover(actor: AuthContext, id: string, mediaAssetId: string, meta: RequestMeta): Promise<AdminUnitDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const current = await this.getAdmin(id);
    if (!current.images.some((i) => i.mediaAssetId === mediaAssetId)) throw new ValidationError({ mediaAssetId: "NOT_A_UNIT_IMAGE" });
    await this.commit([
      this.repo.setCoverStatement(id, mediaAssetId, this.now()),
      this.log.auditStatement(actor.userId, "SET_COVER", MODULE, id, { cover: current.coverAssetId }, { cover: mediaAssetId }, meta),
    ]);
    return this.getAdmin(id);
  }

  /** Unlinks the image and retires the asset (served no more; object removed from R2). */
  async removeImage(actor: AuthContext, id: string, imageId: string, meta: RequestMeta): Promise<AdminUnitDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const current = await this.getAdmin(id);
    const image = current.images.find((i) => i.id === imageId);
    if (!image) throw new NotFoundError("Image not found", "IMAGE_NOT_FOUND");
    const objects = await this.media.objectKeys(image.mediaAssetId); // original + responsive renditions
    const now = this.now();
    const statements: D1PreparedStatementLike[] = [
      this.repo.deleteImageStatement(id, imageId),
      this.media.markDeletedStatement(image.mediaAssetId, now),
      this.log.auditStatement(actor.userId, "REMOVE_IMAGE", MODULE, id, { imageId, mediaAssetId: image.mediaAssetId }, null, meta),
    ];
    if (image.isCover) {
      const next = current.images.find((i) => i.id !== imageId);
      statements.push(this.repo.setCoverStatement(id, next?.mediaAssetId ?? null, now));
    }
    await this.commit(statements);
    for (const o of objects) if (o.bucket === "PUBLIC") await this.bucket.delete(o.object_key).catch(() => undefined);
    return this.getAdmin(id);
  }

  /** Soft delete. Refused while the unit still has upcoming bookings. */
  async remove(actor: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const current = await this.getAdmin(id);
    const today = todayIn((await this.inventory.siteTimezone()) ?? DEFAULT_TIMEZONE, this.clock());
    if ((await this.repo.countFutureBookedNights(id, today)) > 0) {
      throw new ConflictError("This accommodation has upcoming bookings", "UNIT_HAS_FUTURE_BOOKINGS");
    }
    await this.commit([
      this.repo.updateUnitStatement(id, { ...pickUnitFields(current), status: "DELETED", now: this.now() }),
      this.log.auditStatement(actor.userId, "DELETE", MODULE, id, { status: current.status }, { status: "DELETED" }, meta),
    ]);
  }

  // ================================================================ amenities

  async listAmenities(actor: AuthContext, meta: RequestMeta): Promise<AmenityDto[]> {
    await this.authz.requirePermission(actor, "accommodation.view", meta);
    return (await this.repo.amenities(false)).map(toAmenityDto);
  }

  async createAmenity(
    actor: AuthContext,
    input: { code: string; icon: string | null; sortOrder: number; names: Partial<Record<LocaleCode, string>> },
    meta: RequestMeta,
  ): Promise<AmenityDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    if (!input.names[DEFAULT_LOCALE_CODE]) throw new ValidationError({ names: "DEFAULT_LANGUAGE_REQUIRED" });
    const id = newId();
    await this.commit([
      this.repo.insertAmenityStatement({ id, code: input.code, icon: input.icon, sortOrder: input.sortOrder }),
      ...Object.entries(input.names).flatMap(([lang, name]) => (name ? [this.repo.upsertAmenityNameStatement(id, lang, name)] : [])),
      this.log.auditStatement(actor.userId, "CREATE_AMENITY", MODULE, id, null, input, meta),
    ]);
    return toAmenityDto((await this.repo.amenities(false)).find((a) => a.id === id)!);
  }

  async updateAmenity(
    actor: AuthContext,
    id: string,
    patch: { icon?: string | null; status?: "ACTIVE" | "INACTIVE"; sortOrder?: number; names?: Partial<Record<LocaleCode, string>> },
    meta: RequestMeta,
  ): Promise<AmenityDto> {
    await this.authz.requirePermission(actor, "accommodation.edit", meta);
    const current = (await this.repo.amenities(false)).find((a) => a.id === id);
    if (!current) throw new NotFoundError("Amenity not found", "AMENITY_NOT_FOUND");
    await this.commit([
      this.repo.updateAmenityStatement(id, {
        icon: patch.icon === undefined ? current.icon : patch.icon,
        status: patch.status ?? current.status,
        sortOrder: patch.sortOrder ?? current.sort_order,
      }),
      ...Object.entries(patch.names ?? {}).flatMap(([lang, name]) => (name ? [this.repo.upsertAmenityNameStatement(id, lang, name)] : [])),
      this.log.auditStatement(actor.userId, "UPDATE_AMENITY", MODULE, id, toAmenityDto(current), patch, meta),
    ]);
    return toAmenityDto((await this.repo.amenities(false)).find((a) => a.id === id)!);
  }

  // ================================================================ helpers

  private priceHistory(unitId: string, oldPrice: number | null, newPrice: number, userId: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO price_history (id, entity_type, entity_id, old_price_satang, new_price_satang, changed_by, changed_at)
         VALUES (?1, 'UNIT', ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(newId(), unitId, oldPrice, newPrice, userId, this.now());
  }

  private async assertUnique(code: string, slug: string, selfId: string | null) {
    for (const row of await this.repo.findByCodeOrSlug(code, slug)) {
      if (row.id === selfId) continue;
      if (row.unit_code === code) throw new ConflictError("Unit code already in use", "UNIT_CODE_TAKEN");
      if (row.slug === slug) throw new ConflictError("Slug already in use", "SLUG_TAKEN");
    }
  }

  private async commit(statements: D1PreparedStatementLike[]) {
    try {
      await this.db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint failed: accommodation_units\.unit_code/.test(message)) throw new ConflictError("Unit code already in use", "UNIT_CODE_TAKEN");
      if (/UNIQUE constraint failed: accommodation_units\.slug/.test(message)) throw new ConflictError("Slug already in use", "SLUG_TAKEN");
      if (/UNIQUE constraint failed: amenities\.code/.test(message)) throw new ConflictError("Amenity code already in use", "AMENITY_CODE_TAKEN");
      throw error;
    }
  }

  private now(): string {
    return iso(this.clock());
  }
}

function toTranslationDto(t: UnitTranslationRow): UnitTranslationDto {
  return {
    name: t.name,
    shortDescription: t.short_description,
    description: t.description,
    seoTitle: t.seo_title,
    seoDescription: t.seo_description,
  };
}

function pickUnitFields(u: AdminUnitDto) {
  return {
    unitCode: u.unitCode, slug: u.slug, basePriceSatang: u.basePriceSatang, paymentMode: u.paymentMode, standardGuests: u.standardGuests,
    maxGuests: u.maxGuests, maxAdults: u.maxAdults, status: u.status, sortOrder: u.sortOrder,
  };
}

function toAmenityDto(a: { id: string; code: string; icon: string | null; status: "ACTIVE" | "INACTIVE"; sort_order: number; names: string | null }): AmenityDto {
  const names = JSON.parse(a.names ?? "{}") as Record<string, string>;
  return {
    id: a.id,
    code: a.code,
    icon: a.icon,
    status: a.status,
    sortOrder: a.sort_order,
    names: Object.fromEntries(Object.entries(names).filter(([k]) => parseLocale(k))),
  };
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

export type { UnitImageRow };
