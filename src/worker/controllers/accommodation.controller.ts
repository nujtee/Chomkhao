import type { ImageStatus, UnitStatus, UnitTranslationDto, UnitType } from "../../shared/accommodation-types.ts";
import { MAX_PRICE_SATANG, PAYMENT_MODES, type PaymentMode } from "../../shared/booking-rules.ts";
import { DEFAULT_LOCALE, LOCALE_CODES, parseLocale, type LocaleCode } from "../../shared/i18n/locales.ts";
import { requestMeta, withAuth, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { BadRequestError, HttpError, PayloadTooLargeError, ValidationError } from "../http/errors.ts";
import { jsonOk } from "../http/response.ts";
import type { Handler, RequestContext } from "../router.ts";
import { readJsonObject } from "../security/request.ts";
import { MAX_UPLOAD_BYTES, UPLOAD_PERMISSIONS } from "../services/media.service.ts";
import type { MediaPurpose } from "../repositories/media.repository.ts";
import { ID_PATTERN, Validator } from "../validation.ts";

const UNIT_CODE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const AMENITY_CODE = /^[a-z0-9_]{2,40}$/;
const ICON = /^[a-z0-9-]{1,40}$/;
const UNIT_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE", "MAINTENANCE"] as const;
const UNIT_TYPES = ["HOUSE", "VIP_TENT"] as const;
const IMAGE_STATUSES = ["DRAFT", "PUBLISHED", "UNPUBLISHED"] as const;
const LANGS = LOCALE_CODES as readonly string[];

function id(ctx: RequestContext, name = "id"): string {
  const value = ctx.params[name] ?? "";
  if (!ID_PATTERN.test(value)) throw new ValidationError({ [name]: "INVALID_ID" });
  return value;
}

function lang(ctx: RequestContext) {
  const raw = ctx.url.searchParams.get("lang");
  const locale = raw === null ? DEFAULT_LOCALE : parseLocale(raw);
  if (!locale) throw new BadRequestError("Unsupported language", "UNSUPPORTED_LANGUAGE");
  return locale;
}

function int(v: Validator, body: Record<string, unknown>, key: string, min: number, max: number, required: boolean): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) v.errors[key] = "REQUIRED";
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    v.errors[key] = "OUT_OF_RANGE";
    return undefined;
  }
  return value;
}

function nullableInt(v: Validator, body: Record<string, unknown>, key: string, min: number, max: number): number | null | undefined {
  if (body[key] === null) return null;
  return int(v, body, key, min, max, false);
}

/** { th: {...} | null, en: ..., "zh-CN": ... } — plain text only, length-limited. */
function translations<T>(raw: unknown, parseOne: (v: Validator) => T): Partial<Record<LocaleCode, T | null>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError({ translations: "EXPECTED_OBJECT" });
  const out: Partial<Record<LocaleCode, T | null>> = {};
  const errors: Record<string, string> = {};
  for (const [code, value] of Object.entries(raw)) {
    if (!LANGS.includes(code)) {
      errors[code] = "UNSUPPORTED_LANGUAGE";
      continue;
    }
    if (value === null) {
      out[code as LocaleCode] = null;
      continue;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      errors[code] = "EXPECTED_OBJECT";
      continue;
    }
    const v = new Validator(value as Record<string, unknown>);
    const parsed = parseOne(v);
    for (const [k, e] of Object.entries(v.errors)) errors[`${code}.${k}`] = e;
    out[code as LocaleCode] = parsed;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

function unitTranslation(v: Validator): UnitTranslationDto {
  v.allowOnly(["name", "shortDescription", "description", "seoTitle", "seoDescription"]);
  return {
    name: v.string("name", { required: true, max: 120 }),
    shortDescription: v.string("shortDescription", { max: 300 }) ?? null,
    description: v.string("description", { max: 5000, raw: true })?.trim() || null,
    seoTitle: v.string("seoTitle", { max: 120 }) ?? null,
    seoDescription: v.string("seoDescription", { max: 320 }) ?? null,
  };
}

export function accommodationController(services: ServicesFor) {
  return {
    // ------------------------------------------------------------------ public
    /** GET /api/public/accommodations?lang= */
    publicList: (async (ctx) =>
      jsonOk(await services(ctx).accommodation.publicList(lang(ctx)), {
        headers: { "Cache-Control": "public, max-age=60, s-maxage=120" },
      })) satisfies Handler,

    /** GET /api/public/accommodations/:slug?lang= */
    publicDetail: (async (ctx) => {
      const slug = ctx.params.slug ?? "";
      if (!SLUG.test(slug)) throw new ValidationError({ slug: "INVALID_FORMAT" });
      return jsonOk(await services(ctx).accommodation.publicBySlug(slug, lang(ctx)), {
        headers: { "Cache-Control": "public, max-age=60, s-maxage=120" },
      });
    }) satisfies Handler,

    /** GET /api/public/availability?checkIn=&checkOut=&guests=&tents= — always live, never cached. */
    availability: (async (ctx) => {
      const q = ctx.url.searchParams;
      const optionalInt = (name: string, max: number) => {
        const raw = q.get(name);
        if (raw === null || raw === "") return undefined;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > max) throw new ValidationError({ [name]: "OUT_OF_RANGE" });
        return n;
      };
      // Unpaid holds past their time no longer block anything: release them before answering.
      await services(ctx).bookings.expireDue();
      const data = await services(ctx).availability.publicAvailability({
        checkIn: q.get("checkIn") ?? "",
        checkOut: q.get("checkOut") ?? "",
        guests: optionalInt("guests", 100),
        tents: optionalInt("tents", 100),
      });
      return jsonOk(data, { headers: { "Cache-Control": "no-store" } });
    }) satisfies Handler,

    // ------------------------------------------------------------------ admin units
    list: withAuth(services, async (ctx, auth) => {
      const type = ctx.url.searchParams.get("type");
      if (type !== null && !(UNIT_TYPES as readonly string[]).includes(type)) throw new ValidationError({ type: "INVALID_VALUE" });
      return jsonOk(await services(ctx).accommodation.list(auth, (type ?? undefined) as UnitType | undefined, requestMeta(ctx)));
    }),

    get: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).accommodation.get(auth, id(ctx), requestMeta(ctx)))),

    create: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["unitCode", "unitType", "slug", "basePriceSatang", "paymentMode", "standardGuests", "maxGuests", "maxAdults", "status", "sortOrder"]);
      const input = {
        unitCode: v.string("unitCode", { required: true, pattern: UNIT_CODE }),
        unitType: v.oneOf("unitType", UNIT_TYPES, { required: true })!,
        slug: v.string("slug", { required: true, pattern: SLUG }),
        basePriceSatang: int(v, body, "basePriceSatang", 0, MAX_PRICE_SATANG, true)!,
        paymentMode: (v.oneOf("paymentMode", PAYMENT_MODES) ?? "FULL") as PaymentMode,
        standardGuests: int(v, body, "standardGuests", 1, 50, true)!,
        maxGuests: int(v, body, "maxGuests", 1, 50, true)!,
        maxAdults: nullableInt(v, body, "maxAdults", 1, 50) ?? null,
        status: v.oneOf("status", UNIT_STATUSES) ?? "DRAFT",
        sortOrder: int(v, body, "sortOrder", 0, 10_000, false) ?? 0,
      };
      v.assertValid();
      if (input.maxGuests < input.standardGuests) throw new ValidationError({ maxGuests: "LESS_THAN_STANDARD_GUESTS" });
      return jsonOk(await services(ctx).accommodation.create(auth, input, requestMeta(ctx)), { status: 201 });
    }),

    update: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["unitCode", "slug", "basePriceSatang", "paymentMode", "standardGuests", "maxGuests", "maxAdults", "status", "sortOrder"]);
      const patch = {
        unitCode: v.has("unitCode") ? v.string("unitCode", { required: true, pattern: UNIT_CODE }) : undefined,
        slug: v.has("slug") ? v.string("slug", { required: true, pattern: SLUG }) : undefined,
        basePriceSatang: int(v, body, "basePriceSatang", 0, MAX_PRICE_SATANG, false),
        paymentMode: v.oneOf("paymentMode", PAYMENT_MODES) as PaymentMode | undefined,
        standardGuests: int(v, body, "standardGuests", 1, 50, false),
        maxGuests: int(v, body, "maxGuests", 1, 50, false),
        maxAdults: nullableInt(v, body, "maxAdults", 1, 50),
        status: v.oneOf("status", UNIT_STATUSES) as Exclude<UnitStatus, "DELETED"> | undefined,
        sortOrder: int(v, body, "sortOrder", 0, 10_000, false),
      };
      v.assertValid();
      return jsonOk(await services(ctx).accommodation.update(auth, id(ctx), patch, requestMeta(ctx)));
    }),

    remove: withAuth(services, async (ctx, auth) => {
      await services(ctx).accommodation.remove(auth, id(ctx), requestMeta(ctx));
      return jsonOk({ deleted: true });
    }),

    setTranslations: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      new Validator(body).allowOnly(["translations"]).assertValid();
      const t = translations(body.translations, unitTranslation);
      return jsonOk(await services(ctx).accommodation.setTranslations(auth, id(ctx), t, requestMeta(ctx)));
    }),

    setAmenities: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["amenityIds"]);
      const amenityIds = v.stringArray("amenityIds", { required: true, max: 100, pattern: ID_PATTERN });
      v.assertValid();
      return jsonOk(await services(ctx).accommodation.setAmenities(auth, id(ctx), amenityIds ?? [], requestMeta(ctx)));
    }),

    addImage: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["mediaAssetId"]);
      const mediaAssetId = v.string("mediaAssetId", { required: true, pattern: ID_PATTERN });
      v.assertValid();
      return jsonOk(await services(ctx).accommodation.addImage(auth, id(ctx), mediaAssetId, requestMeta(ctx)), { status: 201 });
    }),

    updateImage: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["status"]);
      const status = v.oneOf("status", IMAGE_STATUSES, { required: true }) as ImageStatus;
      v.assertValid();
      return jsonOk(await services(ctx).accommodation.updateImage(auth, id(ctx), id(ctx, "imageId"), status, requestMeta(ctx)));
    }),

    removeImage: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).accommodation.removeImage(auth, id(ctx), id(ctx, "imageId"), requestMeta(ctx)))),

    reorderImages: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["imageIds"]);
      const imageIds = v.stringArray("imageIds", { required: true, max: 200, pattern: ID_PATTERN });
      v.assertValid();
      return jsonOk(await services(ctx).accommodation.reorderImages(auth, id(ctx), imageIds ?? [], requestMeta(ctx)));
    }),

    setCover: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["mediaAssetId"]);
      const mediaAssetId = v.string("mediaAssetId", { required: true, pattern: ID_PATTERN });
      v.assertValid();
      return jsonOk(await services(ctx).accommodation.setCover(auth, id(ctx), mediaAssetId, requestMeta(ctx)));
    }),

    addBlock: withPermission("accommodation.block", services, async (ctx, auth) => {
      const v = new Validator(await readJsonObject(ctx.request)).allowOnly(["startDate", "endDate", "reason"]);
      const startDate = v.string("startDate", { required: true });
      const endDate = v.string("endDate", { required: true });
      const reason = v.string("reason", { required: true, max: 200 });
      v.assertValid();
      await services(ctx).availability.addBlock(auth, id(ctx), startDate, endDate, reason, requestMeta(ctx));
      return jsonOk({ blocked: true }, { status: 201 });
    }),

    removeBlock: withAuth(services, async (ctx, auth) => {
      const q = ctx.url.searchParams;
      await services(ctx).availability.removeBlock(auth, id(ctx), q.get("startDate") ?? "", q.get("endDate") ?? "", requestMeta(ctx));
      return jsonOk({ unblocked: true });
    }),

    /** GET /api/admin/availability?from=YYYY-MM-DD&days=14 */
    grid: withAuth(services, async (ctx, auth) => {
      const q = ctx.url.searchParams;
      const days = Number(q.get("days") ?? "14");
      const s = services(ctx);
      return jsonOk(await s.availability.adminGrid(auth, q.get("from") ?? (await s.availability.today()), days, requestMeta(ctx)));
    }),

    // ------------------------------------------------------------------ amenities
    amenities: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).accommodation.listAmenities(auth, requestMeta(ctx)))),

    createAmenity: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["code", "icon", "sortOrder", "names"]);
      const code = v.string("code", { required: true, pattern: AMENITY_CODE });
      const icon = v.string("icon", { pattern: ICON }) ?? null;
      const sortOrder = int(v, body, "sortOrder", 0, 10_000, false) ?? 0;
      v.assertValid();
      const names = namesMap(body.names, true);
      return jsonOk(await services(ctx).accommodation.createAmenity(auth, { code, icon, sortOrder, names }, requestMeta(ctx)), { status: 201 });
    }),

    updateAmenity: withPermission("accommodation.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["icon", "sortOrder", "names", "status"]);
      const icon = v.has("icon") ? (v.string("icon", { pattern: ICON }) ?? null) : undefined;
      const status = v.oneOf("status", ["ACTIVE", "INACTIVE"] as const);
      const sortOrder = int(v, body, "sortOrder", 0, 10_000, false);
      v.assertValid();
      const names = body.names === undefined ? undefined : namesMap(body.names, false);
      return jsonOk(await services(ctx).accommodation.updateAmenity(auth, id(ctx), { icon, status, sortOrder, names }, requestMeta(ctx)));
    }),

    // ------------------------------------------------------------------ camping
    camping: withAuth(services, async (ctx, auth) => jsonOk(await services(ctx).availability.getCampingSettings(auth, requestMeta(ctx)))),

    updateCamping: withPermission("camping.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly([
        "isEnabled", "maxTentsPerNight", "pricePerAdultNightSatang", "childFreeUnderAge", "maxGuestsPerTent", "coverAssetId", "translations",
        "tarpEnabled", "tarpPricePerNightSatang", "maxTarpsPerNight", "paymentMode",
        // Read-only (what GET returns): accepted so a page may send the settings back as read, and ignored.
        "depositBookings",
      ]);
      const input = {
        isEnabled: v.boolean("isEnabled", false),
        maxTentsPerNight: int(v, body, "maxTentsPerNight", 0, 1000, true)!,
        pricePerAdultNightSatang: int(v, body, "pricePerAdultNightSatang", 0, MAX_PRICE_SATANG, true)!,
        childFreeUnderAge: int(v, body, "childFreeUnderAge", 0, 18, true)!,
        maxGuestsPerTent: nullableInt(v, body, "maxGuestsPerTent", 1, 50) ?? null,
        coverAssetId: body.coverAssetId === null ? null : (v.string("coverAssetId", { pattern: ID_PATTERN }) ?? null),
        // Tarp area add-on; left out = unchanged.
        tarpEnabled: body.tarpEnabled === undefined ? undefined : v.boolean("tarpEnabled", false),
        tarpPricePerNightSatang: int(v, body, "tarpPricePerNightSatang", 0, MAX_PRICE_SATANG, false),
        maxTarpsPerNight: int(v, body, "maxTarpsPerNight", 0, 1000, false),
        // Deposit plan; left out = unchanged.
        paymentMode: v.oneOf("paymentMode", PAYMENT_MODES) as PaymentMode | undefined,
      };
      v.assertValid();
      const t = body.translations === undefined ? undefined : translations(body.translations, (tv) => {
        tv.allowOnly(["name", "description", "seoTitle", "seoDescription"]);
        return {
          name: tv.string("name", { required: true, max: 120 }),
          description: tv.string("description", { max: 5000, raw: true })?.trim() || null,
          seoTitle: tv.string("seoTitle", { max: 120 }) ?? null,
          seoDescription: tv.string("seoDescription", { max: 320 }) ?? null,
        };
      });
      const cleaned = t ? Object.fromEntries(Object.entries(t).filter(([, x]) => x !== null)) : undefined;
      return jsonOk(await services(ctx).availability.updateCampingSettings(auth, { ...input, translations: cleaned }, requestMeta(ctx)));
    }),

    campingIntegrity: withAuth(services, async (ctx, auth) =>
      jsonOk(await services(ctx).availability.campingIntegrity(auth, requestMeta(ctx)), { headers: { "Cache-Control": "no-store" } })),

    recalculateCamping: withPermission("camping.edit", services, async (ctx, auth) => {
      new Validator(await readJsonObject(ctx.request)).allowOnly([]).assertValid();
      return jsonOk(await services(ctx).availability.recalculateCamping(auth, requestMeta(ctx)));
    }),

    setCampingNight: withPermission("camping.edit", services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      const v = new Validator(body).allowOnly(["maxTents"]);
      const maxTents = body.maxTents === null ? null : int(v, body, "maxTents", 0, 1000, true)!;
      v.assertValid();
      return jsonOk(await services(ctx).availability.setCampingNight(auth, ctx.params.date ?? "", maxTents, requestMeta(ctx)));
    }),

    // ------------------------------------------------------------------ media
    /** POST /api/admin/media (multipart/form-data: file, purpose) */
    upload: withPermission(["accommodation.edit", "food.edit", "content.gallery", "content.home", "content.history", "settings.branding", "seo.edit", "receiving_accounts.edit"], services, async (ctx, auth) => {
      const type = ctx.request.headers.get("Content-Type") ?? "";
      if (!/^multipart\/form-data;/i.test(type)) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use multipart/form-data");
      const length = Number(ctx.request.headers.get("Content-Length") ?? "0");
      if (length > MAX_UPLOAD_BYTES + 64 * 1024) throw new PayloadTooLargeError();
      let form: FormData;
      try {
        form = await ctx.request.formData();
      } catch {
        throw new ValidationError({ body: "INVALID_MULTIPART" });
      }
      const unknown = [...form.keys()].filter((k) => k !== "file" && k !== "purpose" && k !== "variant");
      if (unknown.length) throw new ValidationError(Object.fromEntries(unknown.map((k) => [k, "UNKNOWN_FIELD"])));
      const file = form.get("file");
      const purpose = form.get("purpose");
      if (!(file instanceof File)) throw new ValidationError({ file: "REQUIRED" });
      if (typeof purpose !== "string" || !(purpose in UPLOAD_PERMISSIONS)) throw new ValidationError({ purpose: "INVALID_VALUE" });
      // Responsive renditions made in the admin's browser (Phase 12).
      const variants = form.getAll("variant");
      if (!variants.every((v): v is File => v instanceof File)) throw new ValidationError({ variant: "EXPECTED_FILE" });
      return jsonOk(await services(ctx).media.upload(auth, file, purpose as MediaPurpose, requestMeta(ctx), variants), { status: 201 });
    }),

    /** PUT /api/admin/media/:id/texts { texts: { th: {altText,title,caption}, … } } */
    setMediaTexts: withPermission(["accommodation.edit", "food.edit", "content.gallery", "content.home", "content.history", "settings.branding", "seo.edit", "receiving_accounts.edit"], services, async (ctx, auth) => {
      const body = await readJsonObject(ctx.request);
      new Validator(body).allowOnly(["texts"]).assertValid();
      const texts = translations(body.texts, (v) => {
        v.allowOnly(["altText", "title", "caption"]);
        return {
          altText: v.string("altText", { max: 250 }) ?? null,
          title: v.string("title", { max: 200 }) ?? null,
          caption: v.string("caption", { max: 500 }) ?? null,
        };
      });
      const cleaned = Object.fromEntries(Object.entries(texts).map(([k, x]) => [k, x ?? { altText: null, title: null, caption: null }]));
      return jsonOk(await services(ctx).media.setTexts(auth, id(ctx), cleaned, requestMeta(ctx)));
    }),
  };
}

function namesMap(raw: unknown, requireDefault: boolean): Partial<Record<LocaleCode, string>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError({ names: "EXPECTED_OBJECT" });
  const out: Partial<Record<LocaleCode, string>> = {};
  for (const [code, value] of Object.entries(raw)) {
    if (!LANGS.includes(code)) throw new ValidationError({ [`names.${code}`]: "UNSUPPORTED_LANGUAGE" });
    if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\u0000-\u001f]/.test(value)) {
      throw new ValidationError({ [`names.${code}`]: "INVALID_FORMAT" });
    }
    out[code as LocaleCode] = value.trim();
  }
  if (requireDefault && !out[DEFAULT_LOCALE.code]) throw new ValidationError({ names: "DEFAULT_LANGUAGE_REQUIRED" });
  return out;
}
