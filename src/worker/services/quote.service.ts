import type {
  FoodCatalogueDto,
  FoodCategoryDto,
  FoodLineDto,
  FoodMenuDto,
  FoodOptionDto,
  FoodSelection,
  IncludedMealDto,
  NightPriceDto,
  QuoteDto,
  QuoteItemDto,
  TarpLineDto,
} from "../../shared/booking-types.ts";
import { MAX_STAYS_PER_BOOKING } from "../../shared/booking-types.ts";
import { depositFor, payLaterOf } from "../../shared/booking-rules.ts";
import { DEFAULT_TIMEZONE, addDays, dayOfWeek, localDateTimeIn, todayIn } from "../../shared/dates.ts";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "../http/errors.ts";
import type { AccommodationRepository, UnitRow } from "../repositories/accommodation.repository.ts";
import type { CampingSettingsRow, InventoryRepository } from "../repositories/inventory.repository.ts";
import type {
  BookingSettingsRow,
  FoodCategoryRow,
  FoodOptionRow,
  IncludedMealRow,
  NamedTranslationRow,
  PricingRepository,
  PricingRuleRow,
} from "../repositories/pricing.repository.ts";
import type { Clock } from "./auth-context.ts";
import type { ImageResolver } from "../media/image-resolver.ts";
import { publicMediaUrl } from "./media-url.ts";
import { pickTranslation } from "./accommodation.service.ts";
import type { AvailabilityService } from "./availability.service.ts";

/** One stay of the request, with its own guests (the parser fills them in for a legacy single `stay`). */
export type StayInput =
  | { kind: "UNIT"; unitId: string; adults: number; children: number }
  | { kind: "CAMPING"; tents: number; tarp: boolean; adults: number; children: number };

export interface QuoteInput {
  checkIn: string;
  checkOut: string;
  /** All guests: the sum of the stays' guests. */
  adults: number;
  children: number;
  /** One or more stays on the same dates (same check-in / check-out for all). */
  stays: StayInput[];
  /** The request used the single `stay` field (older pages): errors keep their old keys (guests, tents …). */
  legacy?: boolean;
  food: FoodSelection[];
  lang: string;
}

export interface PreparedFoodLine {
  dto: FoodLineDto;
  option: FoodOptionRow;
  category: FoodCategoryRow;
  childPriceSatang: number | null;
  /** Portions taken from the daily kitchen capacity (0 for included meals). */
  capacityQuantity: number;
  /** Persons the kitchen prepares for. */
  persons: number;
  /** Included meal: index of the stay it comes with (in PreparedBooking.stays). */
  stayIndex?: number;
}

export interface PreparedIncludedMeal {
  meal: IncludedMealRow;
  option: FoodOptionRow | null;
  dto: IncludedMealDto;
}

/** One stay of the booking, priced. */
export interface PreparedStay {
  item: QuoteItemDto;
  /** The house / VIP tent; null for own-tent camping. */
  unit: UnitRow | null;
  /** Own-tent camping: tents taken each night. */
  tents: number;
  /** Tarp area of the camping stay. */
  tarp: TarpLineDto | null;
  /** Meals that come with this stay. */
  included: PreparedIncludedMeal[];
}

/** Everything booking creation needs — computed once, from D1, on the server. */
export interface PreparedBooking {
  quote: QuoteDto;
  nights: string[];
  stays: PreparedStay[];
  camping: CampingSettingsRow | null;
  /** Tarp area add-on (the camping stay's, if any). */
  tarp: TarpLineDto | null;
  /** Included lines (with `stayIndex`) then extra food. */
  foodLines: PreparedFoodLine[];
  settings: BookingSettingsRow;
}

const SPECIFICITY: Record<PricingRuleRow["target_type"], number> = { UNIT: 2, UNIT_TYPE: 1, CAMPING: 0 };
export const MAX_FOOD_LINES = 60;
export const MAX_GUESTS_PER_BOOKING = 50;

/**
 * The price engine. The browser never supplies a price: every amount here comes
 * from D1 (unit base price, pricing rules, camping settings, food menu).
 */
export class QuoteService {
  constructor(
    private readonly pricing: PricingRepository,
    private readonly units: AccommodationRepository,
    private readonly inventory: InventoryRepository,
    private readonly availability: AvailabilityService,
    private readonly clock: Clock,
    /** Responsive dish photos (Phase 12). */
    private readonly images: ImageResolver | null = null,
    private readonly mediaBaseUrl: string | undefined = undefined,
  ) {}

  /** Dish → public DTO (shared by the stay catalogue and the public menu). */
  private async optionDtos(menu: Awaited<ReturnType<QuoteService["menu"]>>): Promise<Map<string, FoodOptionDto>> {
    const ids = menu.options.map((o) => o.image_asset_id);
    const [renditions, alts] = this.images
      ? await Promise.all([this.images.renditions(ids), this.images.altTexts(ids, menu.lang)])
      : [new Map(), new Map<string, string>()];
    return new Map(menu.options.map((o) => {
      const name = menu.optionName(o.id) ?? o.code;
      const url = publicMediaUrl(o.image_key, this.mediaBaseUrl);
      return [o.id, {
        id: o.id,
        code: o.code,
        name,
        description: menu.optionText(o.id, "description"),
        allergens: menu.optionText(o.id, "allergens"),
        pricingType: o.pricing_type,
        priceSatang: o.price_satang,
        childPricing: o.child_pricing,
        childPriceSatang: childUnitPrice(o),
        personsPerSet: o.persons_per_set,
        minQuantity: o.min_quantity,
        maxQuantity: o.max_quantity,
        image: url ? {
          // The photo's own alt text (Media texts), else the dish name.
          url, alt: alts.get(o.image_asset_id!) ?? name, width: o.image_width ?? null, height: o.image_height ?? null,
          srcset: this.images?.srcset(renditions.get(o.image_asset_id!), { key: o.image_key, width: o.image_width }) ?? null,
        } : null,
      }];
    }));
  }

  /** Public menu without dates (home "food preview"). */
  async publicMenu(lang: string): Promise<FoodMenuDto> {
    const menu = await this.menu(lang);
    const options = await this.optionDtos(menu);
    return {
      categories: menu.categories
        .map((c) => ({
          id: c.id, code: c.code, name: menu.categoryName(c.id) ?? c.code, description: menu.categoryDescription(c.id), serviceTime: c.service_time,
          options: menu.options.filter((o) => o.food_category_id === c.id).map((o) => options.get(o.id)!),
        }))
        .filter((c) => c.options.length > 0),
    };
  }

  async timezone(): Promise<string> {
    return (await this.inventory.siteTimezone()) ?? DEFAULT_TIMEZONE;
  }

  async prepare(input: QuoteInput): Promise<PreparedBooking> {
    const settings = await this.pricing.bookingSettings();
    const nights = await this.availability.validateStay(input.checkIn, input.checkOut, {
      maxNights: settings.max_nights,
      maxAdvanceDays: settings.max_advance_days,
    });
    if (!input.stays.length) throw new ValidationError({ stays: "REQUIRED" });
    if (input.stays.length > MAX_STAYS_PER_BOOKING) throw new ValidationError({ stays: "TOO_MANY" });
    // Each house / VIP tent once; camping once (its tents and tarp area are counted in it).
    const units = input.stays.flatMap((s, i) => (s.kind === "UNIT" ? [[s.unitId, i] as const] : []));
    const seen = new Map<string, number>();
    for (const [unitId, i] of units) {
      if (seen.has(unitId)) throw new ValidationError({ [`stays.${i}.unitId`]: "DUPLICATE" });
      seen.set(unitId, i);
    }
    if (input.stays.filter((s) => s.kind === "CAMPING").length > 1) throw new ValidationError({ stays: "ONE_CAMPING" });
    if (input.adults < 1) throw new ValidationError({ adults: "OUT_OF_RANGE" });

    const several = input.stays.length > 1;
    const lastNight = nights[nights.length - 1]!;
    let camping: CampingSettingsRow | null = null;
    const stays: PreparedStay[] = [];
    for (const [i, stay] of input.stays.entries()) {
      const key = (k: string) => (input.legacy ? k : `stays.${i}.${k}`);
      const guests = stay.adults + stay.children;
      if (guests < 1) throw new ValidationError({ [key("guests")]: "REQUIRED" });

      if (stay.kind === "UNIT") {
        const unit = await this.units.findUnit(stay.unitId);
        if (!unit || unit.status !== "ACTIVE") throw new NotFoundError("Accommodation not found", "ACCOMMODATION_NOT_FOUND");
        const errors: Record<string, string> = {};
        if (guests > unit.max_guests) errors[key("guests")] = "EXCEEDS_MAX_GUESTS";
        if (unit.max_adults !== null && stay.adults > unit.max_adults) errors[key("adults")] = "EXCEEDS_MAX_ADULTS";
        if (Object.keys(errors).length) throw new ValidationError(errors);
        const locks = await this.inventory.nightLocks(input.checkIn, input.checkOut, unit.id);
        // Which one, when the booking holds several stays.
        if (locks.length) throw new HttpError(409, "UNIT_UNAVAILABLE", "This accommodation is not available for the selected dates", { unitId: unit.id });

        const rules = await this.pricing.activeRules({ unitId: unit.id, unitType: unit.unit_type }, nights[0]!, lastNight);
        const nightly = nights.map((date) => ({ date, priceSatang: nightPrice(rules, date, unit.base_price_satang) }));
        const names = Object.fromEntries((await this.units.translations([unit.id])).map((t) => [t.language_code, t.name]));
        const subtotalSatang = sum(nightly);
        stays.push({
          item: {
            type: unit.unit_type,
            unitId: unit.id,
            slug: unit.slug,
            name: pickTranslation(names, input.lang) ?? unit.unit_code,
            quantity: 1,
            pricingType: "PER_UNIT_NIGHT",
            nightly,
            subtotalSatang,
            adults: stay.adults,
            children: stay.children,
            // Deposit plan of this house / VIP tent (migration 0025): half of its stay left for check-in.
            payLaterSatang: payLaterOf(unit.payment_mode ?? "FULL", subtotalSatang),
          },
          unit,
          tents: 0,
          tarp: null,
          included: [],
        });
      } else {
        camping = await this.inventory.campingSettings();
        if (!camping || camping.is_enabled !== 1) throw new NotFoundError("Camping is not available", "CAMPING_UNAVAILABLE");
        const tents = stay.tents;
        const errors: Record<string, string> = {};
        if (!Number.isInteger(tents) || tents < 1 || tents > settings.max_tents_per_booking) errors[key("tents")] = "OUT_OF_RANGE";
        else if (camping.max_guests_per_tent !== null && guests > tents * camping.max_guests_per_tent) errors[key("guests")] = "TOO_MANY_PER_TENT";
        // Camping is priced per adult: someone has to be an adult.
        if (stay.adults < 1) errors[key("adults")] = "OUT_OF_RANGE";
        if (Object.keys(errors).length) throw new ValidationError(errors);
        const capacity = await this.availability.campingNights(nights);
        if (capacity.some((n) => n.remaining < tents)) throw new ConflictError("Not enough camping space for these nights", "CAMPING_FULL");

        const rules = await this.pricing.activeRules("CAMPING", nights[0]!, lastNight);
        const nightly = nights.map((date) => ({ date, priceSatang: nightPrice(rules, date, camping!.price_per_adult_night_satang) }));
        const names = Object.fromEntries((await this.inventory.campingTranslations()).map((t) => [t.language_code, t.name]));

        // Tarp area: one per booking, a fixed price per night, its own nightly limit.
        let tarp: TarpLineDto | null = null;
        if (stay.tarp) {
          if (camping.tarp_enabled !== 1) throw new ConflictError("The tarp area option is not offered", "TARP_UNAVAILABLE");
          const areas = await this.availability.tarpNights(nights);
          if (areas.some((n) => n.remaining < 1)) throw new ConflictError("No tarp area left for these nights", "TARP_FULL");
          tarp = {
            quantity: 1,
            pricePerNightSatang: camping.tarp_price_per_night_satang,
            nights: nights.length,
            subtotalSatang: camping.tarp_price_per_night_satang * nights.length,
          };
        }
        // Per adult per night; children under the free age stay free (spec §14).
        const subtotalSatang = sum(nightly) * stay.adults;
        stays.push({
          item: {
            type: "OWN_TENT",
            unitId: null,
            slug: null,
            name: pickTranslation(names, input.lang) ?? "Camping",
            quantity: tents,
            pricingType: "PER_ADULT_NIGHT",
            nightly,
            subtotalSatang,
            adults: stay.adults,
            children: stay.children,
            // The tarp area is part of the camping stay (and of its deposit).
            payLaterSatang: payLaterOf(camping.payment_mode ?? "FULL", subtotalSatang + (tarp?.subtotalSatang ?? 0)),
          },
          unit: null,
          tents,
          tarp,
          included: [],
        });
      }
    }

    const menu = await this.menu(input.lang);
    const includedLines: PreparedFoodLine[] = [];
    for (const [i, stay] of stays.entries()) {
      const target = stay.unit ? { unitId: stay.unit.id, unitType: stay.unit.unit_type } : ("CAMPING" as const);
      const included = this.includedMeals(await this.pricing.includedMeals(target), menu, nights, stay.item, several ? stay.item.name : null);
      stay.included = included.meals;
      includedLines.push(...included.lines.map((l) => ({ ...l, stayIndex: i })));
    }
    const extra = await this.extraFood(input, nights, menu);

    const foodLines = [...includedLines, ...extra];
    const tarp = stays.find((st) => st.tarp)?.tarp ?? null;
    const accommodationSubtotalSatang = stays.reduce((acc, st) => acc + st.item.subtotalSatang + (st.tarp?.subtotalSatang ?? 0), 0);
    const foodSubtotalSatang = foodLines.reduce((acc, l) => acc + l.dto.subtotalSatang, 0);
    const totalSatang = accommodationSubtotalSatang + foodSubtotalSatang;
    const items = stays.map((st) => st.item);
    return {
      quote: {
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        nights: nights.length,
        adults: input.adults,
        children: input.children,
        items,
        item: items[0]!,
        tarp,
        includedMeals: stays.flatMap((st) => st.included.map((m) => m.dto)),
        food: foodLines.map((l) => l.dto),
        accommodationSubtotalSatang,
        foodSubtotalSatang,
        discountSatang: 0,
        totalSatang,
        currency: "THB",
        // Deposit plan (migration 0025), per stay: what each DEPOSIT_50 stay leaves for check-in; food is paid now.
        depositSatang: depositFor(totalSatang, items.reduce((acc, it) => acc + it.payLaterSatang, 0)),
      },
      nights,
      stays,
      camping,
      tarp,
      foodLines,
      settings,
    };
  }

  // ================================================================ food

  /** Food menu for a stay: which dates each category serves, deadlines, remaining capacity. */
  async catalogue(checkIn: string, checkOut: string, lang: string): Promise<FoodCatalogueDto> {
    const settings = await this.pricing.bookingSettings();
    const nights = await this.availability.validateStay(checkIn, checkOut, {
      maxNights: settings.max_nights,
      maxAdvanceDays: settings.max_advance_days,
    });
    const menu = await this.menu(lang);
    const serviceDates = [...new Set(menu.categories.flatMap((c) => this.serviceDates(c, nights)))].sort();
    const capacity = serviceDates.length ? await this.pricing.foodCapacity(serviceDates[0]!, serviceDates[serviceDates.length - 1]!) : [];
    const deadline = await this.deadlineChecker();
    const optionDtos = await this.optionDtos(menu);
    const categories: FoodCategoryDto[] = menu.categories
      .map((c) => ({
        id: c.id,
        code: c.code,
        name: menu.categoryName(c.id) ?? c.code,
        description: menu.categoryDescription(c.id),
        serviceTime: c.service_time,
        serviceDayOffset: c.service_day_offset,
        dates: this.serviceDates(c, nights).map((date) => ({
          date,
          orderable: deadline(c, date),
          remaining: remainingFor(c, date, capacity),
        })),
        options: menu.options
          .filter((o) => o.food_category_id === c.id)
          .map((o) => optionDtos.get(o.id)!),
      }))
      .filter((c) => c.options.length > 0);
    return { checkIn, checkOut, categories };
  }

  /** Night n is served on n + offset (breakfast the morning after). */
  private serviceDates(category: FoodCategoryRow, nights: string[]): string[] {
    return nights.map((n) => addDays(n, category.service_day_offset));
  }

  private async deadlineChecker(): Promise<(c: FoodCategoryRow, serviceDate: string) => boolean> {
    const tz = await this.timezone();
    const now = this.clock();
    const today = todayIn(tz, now);
    const localNow = localDateTimeIn(tz, now);
    return (c, serviceDate) => {
      if (serviceDate < today) return false;
      if (c.deadline_type === "DAYS_BEFORE") return today <= addDays(serviceDate, -(c.deadline_days_before ?? 0));
      if (c.deadline_type === "PREVIOUS_DAY_TIME") return localNow < `${addDays(serviceDate, -1)}T${c.deadline_time ?? "00:00"}`;
      return true;
    };
  }

  private async menu(lang: string) {
    const [categories, options, catT, optT] = await Promise.all([
      this.pricing.activeFoodCategories(),
      this.pricing.activeFoodOptions(),
      this.pricing.foodCategoryTranslations(),
      this.pricing.foodOptionTranslations(),
    ]);
    const byId = (rows: NamedTranslationRow[]) => {
      const map = new Map<string, Record<string, NamedTranslationRow>>();
      for (const r of rows) map.set(r.id, { ...map.get(r.id), [r.language_code]: r });
      return map;
    };
    const catMap = byId(catT);
    const optMap = byId(optT);
    return {
      lang,
      categories,
      options,
      categoryName: (id: string) => pickTranslation(catMap.get(id) ?? {}, lang)?.name,
      categoryDescription: (id: string) => pickTranslation(catMap.get(id) ?? {}, lang)?.description ?? null,
      optionName: (id: string) => pickTranslation(optMap.get(id) ?? {}, lang)?.name,
      optionText: (id: string, key: "description" | "allergens") => pickTranslation(optMap.get(id) ?? {}, lang)?.[key] ?? null,
    };
  }

  /**
   * Included meals: one zero-priced line per service date, adults first.
   * They never consume kitchen capacity or order deadlines — they come with the room.
   */
  private includedMeals(rows: IncludedMealRow[], menu: Awaited<ReturnType<QuoteService["menu"]>>, nights: string[],
    input: { adults: number; children: number }, stayName: string | null) {
    const meals: PreparedIncludedMeal[] = [];
    const lines: PreparedFoodLine[] = [];
    const guests = input.adults + input.children;
    for (const meal of rows) {
      const category = menu.categories.find((c) => c.id === meal.food_category_id);
      if (!category) continue;
      const option = meal.food_option_id
        ? menu.options.find((o) => o.id === meal.food_option_id) ?? null
        : menu.options.find((o) => o.food_category_id === category.id) ?? null;
      const persons = Math.min(meal.persons_per_night, guests);
      meals.push({
        meal,
        option,
        dto: {
          categoryCode: category.code,
          name: (option ? menu.optionName(option.id) : undefined) ?? menu.categoryName(category.id) ?? category.code,
          personsPerNight: persons,
          nights: nights.length,
          ...(stayName ? { stayName } : {}),
        },
      });
      if (!option) continue;
      const adults = Math.min(persons, input.adults);
      const children = persons - adults;
      for (const serviceDate of this.serviceDates(category, nights)) {
        lines.push({
          dto: {
            optionId: option.id,
            categoryCode: category.code,
            name: menu.optionName(option.id) ?? option.code,
            serviceDate,
            pricingType: option.pricing_type,
            adults,
            children,
            quantity: persons,
            includedQuantity: persons,
            unitPriceSatang: option.price_satang,
            subtotalSatang: 0,
          },
          option,
          category,
          childPriceSatang: childUnitPrice(option),
          capacityQuantity: 0,
          persons,
        });
      }
    }
    return { meals, lines };
  }

  private async extraFood(input: QuoteInput, nights: string[], menu: Awaited<ReturnType<QuoteService["menu"]>>): Promise<PreparedFoodLine[]> {
    if (!input.food.length) return [];
    if (input.food.length > MAX_FOOD_LINES) throw new ValidationError({ food: "TOO_MANY" });
    const deadline = await this.deadlineChecker();
    const errors: Record<string, string> = {};
    const seen = new Set<string>();
    const lines: PreparedFoodLine[] = [];

    input.food.forEach((sel, i) => {
      const key = `food.${i}`;
      const option = menu.options.find((o) => o.id === sel.optionId);
      const category = option && menu.categories.find((c) => c.id === option.food_category_id);
      if (!option || !category) {
        errors[key] = "OPTION_UNAVAILABLE";
        return;
      }
      if (!this.serviceDates(category, nights).includes(sel.serviceDate)) {
        errors[key] = "DATE_OUTSIDE_STAY";
        return;
      }
      if (!deadline(category, sel.serviceDate)) {
        errors[key] = "DEADLINE_PASSED";
        return;
      }
      const dup = `${option.id}|${sel.serviceDate}`;
      if (seen.has(dup)) {
        errors[key] = "DUPLICATE";
        return;
      }
      seen.add(dup);

      let adults = 0;
      let children = 0;
      let quantity: number;
      let subtotal: number;
      const childPrice = childUnitPrice(option);
      if (option.pricing_type === "PER_PERSON") {
        adults = sel.adults ?? 0;
        children = sel.children ?? 0;
        if (adults > input.adults || children > input.children) {
          errors[key] = "MORE_THAN_GUESTS";
          return;
        }
        quantity = adults + children;
        subtotal = adults * option.price_satang + children * (childPrice ?? option.price_satang);
      } else {
        quantity = sel.quantity ?? 0;
        subtotal = quantity * option.price_satang;
      }
      if (quantity < 1 || quantity < option.min_quantity || (option.max_quantity !== null && quantity > option.max_quantity)) {
        errors[key] = "QUANTITY_OUT_OF_RANGE";
        return;
      }
      lines.push({
        dto: {
          optionId: option.id,
          categoryCode: category.code,
          name: menu.optionName(option.id) ?? option.code,
          serviceDate: sel.serviceDate,
          pricingType: option.pricing_type,
          adults,
          children,
          quantity,
          includedQuantity: 0,
          unitPriceSatang: option.price_satang,
          subtotalSatang: subtotal,
        },
        option,
        category,
        childPriceSatang: childPrice,
        capacityQuantity: category.default_daily_capacity === null ? 0 : quantity,
        persons: option.pricing_type === "PER_PERSON" ? quantity : option.pricing_type === "PER_SET" ? quantity * (option.persons_per_set ?? 1) : 0,
      });
    });
    if (Object.keys(errors).length) throw new ValidationError(errors);

    // Early, friendly capacity check. The authoritative check is the CHECK constraint in the booking batch.
    const needed = new Map<string, { category: FoodCategoryRow; date: string; qty: number }>();
    for (const l of lines) {
      if (!l.capacityQuantity) continue;
      const k = `${l.category.id}|${l.dto.serviceDate}`;
      const cur = needed.get(k) ?? { category: l.category, date: l.dto.serviceDate, qty: 0 };
      cur.qty += l.capacityQuantity;
      needed.set(k, cur);
    }
    if (needed.size) {
      const dates = [...needed.values()].map((n) => n.date).sort();
      const capacity = await this.pricing.foodCapacity(dates[0]!, dates[dates.length - 1]!);
      for (const n of needed.values()) {
        const remaining = remainingFor(n.category, n.date, capacity);
        if (remaining !== null && n.qty > remaining) {
          throw new ConflictError("Not enough portions left for this meal", "FOOD_CAPACITY_EXCEEDED");
        }
      }
    }
    return lines;
  }
}

/** Highest priority wins; ties go to the more specific rule (unit > unit type), then the newest. */
export function nightPrice(rules: PricingRuleRow[], date: string, base: number): number {
  const dow = String(dayOfWeek(date));
  const matching = rules.filter((r) => r.date_from <= date && r.date_to >= date && r.days_of_week.includes(dow));
  matching.sort((a, b) =>
    b.priority - a.priority
    || SPECIFICITY[b.target_type] - SPECIFICITY[a.target_type]
    || b.updated_at.localeCompare(a.updated_at)
    || a.id.localeCompare(b.id));
  return matching[0]?.price_satang ?? base;
}

/** Price per child portion; null when children pay the adult price. */
export function childUnitPrice(o: Pick<FoodOptionRow, "child_pricing" | "price_satang" | "child_price_satang">): number | null {
  switch (o.child_pricing) {
    case "FREE": return 0;
    case "HALF": return Math.round(o.price_satang / 2);
    case "SPECIAL_PRICE": return o.child_price_satang ?? o.price_satang;
    default: return null;
  }
}

function remainingFor(c: FoodCategoryRow, date: string, rows: { food_category_id: string; service_date: string; max_quantity: number; used_quantity: number }[]): number | null {
  if (c.default_daily_capacity === null) return null; // unlimited
  const row = rows.find((r) => r.food_category_id === c.id && r.service_date === date);
  if (row) return Math.max(0, row.max_quantity - row.used_quantity);
  return c.default_daily_capacity;
}

function sum(nightly: NightPriceDto[]): number {
  return nightly.reduce((acc, n) => acc + n.priceSatang, 0);
}
