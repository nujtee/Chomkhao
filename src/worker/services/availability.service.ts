import type {
  AdminAvailabilityDto,
  AvailabilityDto,
  CampingIntegrityDto,
  CampingNightDto,
  CampingSettingsDto,
  NightState,
  TarpNightDto,
} from "../../shared/accommodation-types.ts";
import { STAY_RULES } from "../../shared/booking-rules.ts";
import { DEFAULT_TIMEZONE, addDays, diffDays, isIsoDate, stayNights, todayIn } from "../../shared/dates.ts";
import { DEFAULT_LOCALE_CODE, type LocaleCode } from "../../shared/i18n/locales.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "../http/errors.ts";
import type { AccommodationRepository } from "../repositories/accommodation.repository.ts";
import { openDepositBookings } from "../repositories/deposit-bookings.ts";
import type { InventoryRepository } from "../repositories/inventory.repository.ts";
import type { MediaRepository } from "../repositories/media.repository.ts";
import type { PricingRepository } from "../repositories/pricing.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import { pickTranslation } from "./accommodation.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";

/**
 * Availability is computed from the source of truth (D1 night-locks and camping
 * inventory) on every request — never from a cache or search index (spec §4, §41).
 * Booking creation (Phase 5) re-checks atomically in the database.
 */
export class AvailabilityService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly units: AccommodationRepository,
    private readonly inventory: InventoryRepository,
    private readonly media: MediaRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly pricing: PricingRepository,
  ) {}

  async today(): Promise<string> {
    return todayIn((await this.inventory.siteTimezone()) ?? DEFAULT_TIMEZONE, this.clock());
  }

  /** Validates a guest stay window; returns the stay nights. */
  async validateStay(
    checkIn: string,
    checkOut: string,
    limits: { maxNights: number; maxAdvanceDays: number } = STAY_RULES,
  ): Promise<string[]> {
    const errors: Record<string, string> = {};
    if (!isIsoDate(checkIn)) errors.checkIn = "INVALID_DATE";
    if (!isIsoDate(checkOut)) errors.checkOut = "INVALID_DATE";
    if (Object.keys(errors).length) throw new ValidationError(errors);

    const today = await this.today();
    const nights = diffDays(checkIn, checkOut);
    if (checkIn < today) errors.checkIn = "IN_THE_PAST";
    else if (diffDays(today, checkIn) > limits.maxAdvanceDays) errors.checkIn = "TOO_FAR_AHEAD";
    if (nights < 1) errors.checkOut = "MUST_BE_AFTER_CHECK_IN";
    else if (nights > limits.maxNights) errors.checkOut = "STAY_TOO_LONG";
    if (Object.keys(errors).length) throw new ValidationError(errors);
    return stayNights(checkIn, checkOut);
  }

  /** Public availability — reveals only yes/no per unit, never who booked. */
  async publicAvailability(input: { checkIn: string; checkOut: string; guests?: number; tents?: number }): Promise<AvailabilityDto> {
    const nights = await this.validateStay(input.checkIn, input.checkOut);
    const [units, locks, camping] = await Promise.all([
      this.units.listUnits({ publicOnly: true }),
      this.inventory.nightLocks(input.checkIn, input.checkOut),
      this.campingNights(nights),
    ]);
    const lockedUnits = new Set(locks.map((l) => l.unit_id));
    const [settings, limits] = await Promise.all([this.inventory.campingSettings(), this.pricing.bookingSettings()]);
    const enabled = settings?.is_enabled === 1;
    const remaining = enabled && camping.length ? Math.min(...camping.map((n) => n.remaining)) : 0;
    const perTent = settings?.max_guests_per_tent ?? null;
    const minTents = input.guests && perTent ? Math.ceil(input.guests / perTent) : 1;
    const maxTentsPerBooking = limits.max_tents_per_booking;
    const shortNights = input.tents === undefined ? [] : camping.filter((n) => !enabled || n.remaining < input.tents!).map((n) => n.date);
    const reason = input.tents === undefined ? null
      : input.tents > maxTentsPerBooking ? "TOO_MANY_TENTS"
        : input.tents < minTents ? "TOO_FEW_TENTS"
          : shortNights.length || !enabled ? "FULL" : null;
    const tarpOffered = enabled && settings?.tarp_enabled === 1;
    const tarps = tarpOffered ? await this.tarpNights(nights) : [];
    return {
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      nights: nights.length,
      units: units.map((u) => ({
        unitId: u.id,
        slug: u.slug,
        unitType: u.unit_type,
        available: !lockedUnits.has(u.id),
        fitsGuests: input.guests === undefined || input.guests <= u.max_guests,
      })),
      camping: {
        enabled,
        remaining,
        nights: camping.map((n) => ({ date: n.date, remaining: enabled ? n.remaining : 0 })),
        fitsTents: input.tents === undefined ? null : enabled && reason === null,
        reason,
        shortNights,
        minTents,
        maxTentsPerBooking,
        tarp: {
          offered: tarpOffered,
          remaining: tarps.length ? Math.min(...tarps.map((n) => n.remaining)) : 0,
          shortNights: tarps.filter((n) => n.remaining < 1).map((n) => n.date),
        },
      },
    };
  }

  /** Tarp areas per night: inventory row if it exists, else the current default (no per-night overrides). */
  async tarpNights(nights: string[]): Promise<TarpNightDto[]> {
    if (!nights.length) return [];
    const [settings, rows] = await Promise.all([
      this.inventory.campingSettings(),
      this.inventory.tarpNights(nights[0]!, addDays(nights[nights.length - 1]!, 1)),
    ]);
    const byDate = new Map(rows.map((r) => [r.stay_date, r]));
    const defaultMax = settings?.max_tarps_per_night ?? 0;
    return nights.map((date) => {
      const row = byDate.get(date);
      const capacity = row?.max_tarps ?? defaultMax;
      const used = row?.tarps_used ?? 0;
      return { date, capacity, used, remaining: Math.max(0, capacity - used) };
    });
  }

  /** Camping capacity per night: inventory row if it exists, else the current default. */
  async campingNights(nights: string[]): Promise<CampingNightDto[]> {
    if (!nights.length) return [];
    const [settings, rows] = await Promise.all([
      this.inventory.campingSettings(),
      this.inventory.campingNights(nights[0]!, addDays(nights[nights.length - 1]!, 1)),
    ]);
    const byDate = new Map(rows.map((r) => [r.stay_date, r]));
    const defaultMax = settings?.max_tents_per_night ?? 0;
    return nights.map((date) => {
      const row = byDate.get(date);
      const capacity = row?.max_tents ?? defaultMax;
      const used = row?.tents_used ?? 0;
      return { date, capacity, used, remaining: Math.max(0, capacity - used), isOverride: row?.is_override === 1 };
    });
  }

  // ================================================================ admin

  async adminGrid(actor: AuthContext, from: string, days: number, meta: RequestMeta): Promise<AdminAvailabilityDto> {
    await this.authz.requirePermission(actor, "accommodation.view", meta);
    if (!isIsoDate(from)) throw new ValidationError({ from: "INVALID_DATE" });
    if (!Number.isInteger(days) || days < 1 || days > STAY_RULES.maxGridDays) throw new ValidationError({ days: "OUT_OF_RANGE" });
    const to = addDays(from, days);
    const dates = stayNights(from, to);
    const [units, locks] = await Promise.all([this.units.listUnits({}), this.inventory.nightLocks(from, to)]);
    const translations = await this.units.translations(units.map((u) => u.id));
    const canSeeBookings = this.authz.can(actor, "bookings.view");
    return {
      from,
      to,
      dates,
      units: units.map((u) => {
        const names = Object.fromEntries(translations.filter((t) => t.unit_id === u.id).map((t) => [t.language_code, t.name]));
        const nights: AdminAvailabilityDto["units"][number]["nights"] = {};
        for (const date of dates) nights[date] = { state: "FREE" };
        for (const lock of locks.filter((l) => l.unit_id === u.id)) {
          const state: NightState = lock.booking_id ? "BOOKED" : "BLOCKED";
          nights[lock.stay_date] = {
            state,
            ...(state === "BOOKED" && canSeeBookings && lock.booking_code ? { bookingCode: lock.booking_code } : {}),
            ...(state === "BLOCKED" && lock.block_reason ? { blockReason: lock.block_reason } : {}),
          };
        }
        return {
          id: u.id,
          unitCode: u.unit_code,
          unitType: u.unit_type,
          name: pickTranslation(names, DEFAULT_LOCALE_CODE) ?? u.unit_code,
          status: u.status,
          nights,
        };
      }),
      camping: this.authz.can(actor, "camping.view") ? await this.campingNights(dates) : [],
      tarps: this.authz.can(actor, "camping.view") ? await this.tarpNights(dates) : [],
    };
  }

  /** Blocks dates (inclusive) for maintenance/private use. Fails if any night is taken. */
  async addBlock(actor: AuthContext, unitId: string, startDate: string, endDate: string, reason: string, meta: RequestMeta): Promise<void> {
    await this.authz.requirePermission(actor, "accommodation.block", meta);
    const dates = await this.adminRange(startDate, endDate);
    const unit = await this.units.findUnit(unitId);
    if (!unit || unit.status === "DELETED") throw new NotFoundError("Accommodation not found", "ACCOMMODATION_NOT_FOUND");
    const now = iso(this.clock());
    try {
      await this.db.batch([
        ...dates.map((d) => this.inventory.insertBlockStatement(unitId, d, reason, actor.userId, now)),
        this.log.auditStatement(actor.userId, "BLOCK_DATES", "accommodation", unitId, null, { startDate, endDate, reason }, meta),
      ]);
    } catch (error) {
      if (/UNIQUE constraint failed: booking_unit_nights/.test(String(error))) {
        throw new ConflictError("Some of these dates are already booked or blocked", "DATES_UNAVAILABLE");
      }
      throw error;
    }
  }

  async removeBlock(actor: AuthContext, unitId: string, startDate: string, endDate: string, meta: RequestMeta): Promise<void> {
    await this.authz.requirePermission(actor, "accommodation.block", meta);
    await this.adminRange(startDate, endDate, true);
    await this.db.batch([
      this.inventory.deleteBlocksStatement(unitId, startDate, endDate),
      this.log.auditStatement(actor.userId, "UNBLOCK_DATES", "accommodation", unitId, { startDate, endDate }, null, meta),
    ]);
  }

  private async adminRange(start: string, end: string, allowPast = false): Promise<string[]> {
    if (!isIsoDate(start) || !isIsoDate(end)) throw new ValidationError({ dates: "INVALID_DATE" });
    if (end < start) throw new ValidationError({ endDate: "BEFORE_START" });
    if (!allowPast && start < (await this.today())) throw new ValidationError({ startDate: "IN_THE_PAST" });
    const dates = stayNights(start, addDays(end, 1));
    if (dates.length > STAY_RULES.maxAdvanceDays) throw new ValidationError({ endDate: "RANGE_TOO_LONG" });
    return dates;
  }

  // ================================================================ camping integrity

  /** Compares every tents_used counter (today onward) with the bookings that hold tents. */
  async campingIntegrity(actor: AuthContext, meta: RequestMeta): Promise<CampingIntegrityDto> {
    await this.authz.requirePermission(actor, "camping.view", meta);
    return this.readIntegrity();
  }

  private async readIntegrity(): Promise<CampingIntegrityDto> {
    const from = await this.today();
    const [drift, tarpDrift] = await Promise.all([this.inventory.campingDrift(from), this.inventory.tarpDrift(from)]);
    return {
      checkedFrom: from,
      consistent: drift.length === 0 && tarpDrift.length === 0,
      drift: drift.map((d) => ({ date: d.stay_date, expected: d.expected, actual: d.actual, maxTents: d.max_tents })),
      tarpDrift: tarpDrift.map((d) => ({ date: d.stay_date, expected: d.expected, actual: d.actual, maxTarps: d.max_tarps })),
    };
  }

  /** Sets the counters back to the bookings' truth (audited). Refuses if a night is truly oversold. */
  async recalculateCamping(actor: AuthContext, meta: RequestMeta): Promise<CampingIntegrityDto> {
    await this.authz.requirePermission(actor, "camping.edit", meta);
    const before = await this.readIntegrity();
    if (before.consistent) return before;
    const now = iso(this.clock());
    try {
      await this.db.batch([
        ...this.inventory.recalculateCampingStatements(before.checkedFrom, now),
        ...this.inventory.recalculateTarpStatements(before.checkedFrom, now),
        this.log.auditStatement(actor.userId, "RECALCULATE_CAMPING", "camping", "camping",
          { drift: before.drift, tarpDrift: before.tarpDrift }, { recalculatedFrom: before.checkedFrom }, meta),
      ]);
    } catch (error) {
      if (/CHECK constraint failed/.test(String(error))) {
        throw new ConflictError("Some nights have more tents or tarp areas booked than their capacity", "OVERSOLD_NIGHTS");
      }
      throw error;
    }
    return this.readIntegrity();
  }

  /**
   * Scheduled check (no actor). Never changes data: a mismatch means a bug or a manual DB
   * edit, so a human decides. Raises at most one CRITICAL event per interval.
   */
  async detectCampingDrift(): Promise<number> {
    const result = await this.readIntegrity();
    if (result.consistent) return 0;
    const recent = await this.log.countRecent(["CAMPING_INVENTORY_DRIFT"], INTEGRITY_ALERT_INTERVAL_MS);
    if (recent === 0) {
      await this.log.event("CAMPING_INVENTORY_DRIFT", "CRITICAL", { ip: null, userAgent: null }, {
        details: { nights: result.drift.length, tarpNights: result.tarpDrift.length, first: result.drift[0]?.date ?? result.tarpDrift[0]?.date ?? null },
      });
    }
    return result.drift.length + result.tarpDrift.length;
  }

  // ================================================================ camping settings

  async getCampingSettings(actor: AuthContext, meta: RequestMeta): Promise<CampingSettingsDto> {
    await this.authz.requirePermission(actor, "camping.view", meta);
    return this.withDepositBookings(await this.readCampingSettings());
  }

  /** Admin view: the open deposit bookings, which keep their plan whatever the camping takes today. */
  private async withDepositBookings(settings: CampingSettingsDto): Promise<CampingSettingsDto> {
    return { ...settings, depositBookings: await openDepositBookings(this.db, null, iso(this.clock())) };
  }

  private async readCampingSettings(): Promise<CampingSettingsDto> {
    const [s, translations] = await Promise.all([this.inventory.campingSettings(), this.inventory.campingTranslations()]);
    return {
      isEnabled: s?.is_enabled === 1,
      maxTentsPerNight: s?.max_tents_per_night ?? 0,
      pricePerAdultNightSatang: s?.price_per_adult_night_satang ?? 0,
      childFreeUnderAge: s?.child_free_under_age ?? 12,
      maxGuestsPerTent: s?.max_guests_per_tent ?? null,
      coverAssetId: s?.cover_asset_id ?? null,
      tarpEnabled: s?.tarp_enabled === 1,
      tarpPricePerNightSatang: s?.tarp_price_per_night_satang ?? 0,
      maxTarpsPerNight: s?.max_tarps_per_night ?? 0,
      paymentMode: s?.payment_mode ?? "FULL",
      translations: Object.fromEntries(translations.map((t) => [t.language_code, {
        name: t.name, description: t.description, seoTitle: t.seo_title, seoDescription: t.seo_description,
      }])),
    };
  }

  async updateCampingSettings(
    actor: AuthContext,
    patch: Omit<CampingSettingsDto, "translations" | "tarpEnabled" | "tarpPricePerNightSatang" | "maxTarpsPerNight" | "paymentMode">
      & Partial<Pick<CampingSettingsDto, "tarpEnabled" | "tarpPricePerNightSatang" | "maxTarpsPerNight" | "paymentMode">>
      & { translations?: CampingSettingsDto["translations"] },
    meta: RequestMeta,
  ): Promise<CampingSettingsDto> {
    await this.authz.requirePermission(actor, "camping.edit", meta);
    const current = await this.readCampingSettings();
    // Tarp fields left out (an older admin page) keep their current values.
    const input = {
      ...patch,
      tarpEnabled: patch.tarpEnabled ?? current.tarpEnabled,
      tarpPricePerNightSatang: patch.tarpPricePerNightSatang ?? current.tarpPricePerNightSatang,
      maxTarpsPerNight: patch.maxTarpsPerNight ?? current.maxTarpsPerNight,
      paymentMode: patch.paymentMode ?? current.paymentMode,
    };
    if (input.pricePerAdultNightSatang !== current.pricePerAdultNightSatang || input.tarpPricePerNightSatang !== current.tarpPricePerNightSatang
      || input.paymentMode !== current.paymentMode) {
      await this.authz.requirePermission(actor, "pricing.edit", meta);
    }
    if (input.tarpEnabled && input.maxTarpsPerNight < 1) throw new ValidationError({ maxTarpsPerNight: "TARP_CAPACITY_REQUIRED" });
    const translations = { ...current.translations, ...(input.translations ?? {}) };
    if (input.isEnabled && !translations[DEFAULT_LOCALE_CODE]?.name) {
      throw new ValidationError({ isEnabled: "ADD_TRANSLATION_BEFORE_ACTIVATING" });
    }
    if (input.coverAssetId) {
      const asset = await this.media.findById(input.coverAssetId);
      if (!asset || asset.status !== "ACTIVE" || asset.purpose !== "ACCOMMODATION" || asset.parent_asset_id) {
        throw new ValidationError({ coverAssetId: "INVALID_IMAGE" });
      }
    }

    const now = iso(this.clock());
    const statements: D1PreparedStatementLike[] = [
      this.inventory.upsertCampingSettingsStatement({ ...input, updatedBy: actor.userId, now }),
      ...Object.entries(input.translations ?? {}).flatMap(([lang, t]) => (t ? [this.inventory.upsertCampingTranslationStatement(lang, t)] : [])),
      this.inventory.applyDefaultCapacityStatement(input.maxTentsPerNight, await this.today()),
      this.inventory.applyDefaultTarpCapacityStatement(input.maxTarpsPerNight, await this.today(), now),
      this.log.auditStatement(actor.userId, "UPDATE_SETTINGS", "camping", "camping", omitTranslations(current), {
        ...omitTranslations(input),
        // Deposit → full payment: how many open deposit bookings keep their deposit plan (frozen at booking time).
        ...(input.paymentMode !== current.paymentMode ? { keptDepositBookings: await openDepositBookings(this.db, null, now) } : {}),
      }, meta),
    ];
    if (input.pricePerAdultNightSatang !== current.pricePerAdultNightSatang) {
      statements.push(this.db
        .prepare(
          `INSERT INTO price_history (id, entity_type, entity_id, old_price_satang, new_price_satang, changed_by, changed_at)
           VALUES (?1, 'CAMPING', 'camping', ?2, ?3, ?4, ?5)`,
        )
        .bind(newId(), current.pricePerAdultNightSatang, input.pricePerAdultNightSatang, actor.userId, now));
    }
    try {
      await this.db.batch(statements);
    } catch (error) {
      if (/CHECK constraint failed: tarps_used/.test(String(error))) {
        throw new HttpError(409, "BELOW_TARPS_SOLD", "Some upcoming nights already have more tarp areas booked than the new limit",
          { maxTarpsPerNight: "BELOW_TARPS_SOLD" });
      }
      if (/CHECK constraint failed/.test(String(error))) {
        throw new ConflictError("Some upcoming nights already have more tents booked than the new capacity", "BELOW_TENTS_SOLD");
      }
      throw error;
    }
    return this.withDepositBookings(await this.readCampingSettings());
  }

  /** Override one night's capacity (maxTents) or return it to the default (null). */
  async setCampingNight(actor: AuthContext, date: string, maxTents: number | null, meta: RequestMeta): Promise<CampingNightDto> {
    await this.authz.requirePermission(actor, "camping.edit", meta);
    if (!isIsoDate(date)) throw new ValidationError({ date: "INVALID_DATE" });
    if (date < (await this.today())) throw new ValidationError({ date: "IN_THE_PAST" });
    const settings = await this.inventory.campingSettings();
    const [before] = await this.campingNights([date]);
    try {
      await this.db.batch([
        ...this.inventory.setNightCapacityStatements(date, maxTents, settings?.max_tents_per_night ?? 0, iso(this.clock())),
        this.log.auditStatement(actor.userId, "SET_NIGHT_CAPACITY", "camping", date,
          { capacity: before?.capacity, override: before?.isOverride }, { capacity: maxTents, override: maxTents !== null }, meta),
      ]);
    } catch (error) {
      if (/CHECK constraint failed/.test(String(error))) {
        throw new ConflictError("More tents are already booked for this night", "BELOW_TENTS_SOLD");
      }
      throw error;
    }
    return (await this.campingNights([date]))[0]!;
  }
}

export const INTEGRITY_ALERT_INTERVAL_MS = 6 * 60 * 60_000;

function omitTranslations<T extends { translations?: unknown }>(value: T): Omit<T, "translations"> {
  const { translations: _translations, ...rest } = value;
  return rest;
}

export type { LocaleCode };
