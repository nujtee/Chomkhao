/**
 * Field schema for back-office records edited through the generic CMS engine
 * (Phase 9): food menu, home, gallery, history and SEO redirects.
 *
 * The same definitions drive server-side validation (src/worker/cms) and the
 * admin forms (src/client/admin/cms), so the two can never disagree.
 * Table and column names live only in the Worker.
 */
import type { LocaleCode } from "./i18n/locales.ts";

export type MediaPurposeCode =
  | "LOGO" | "FAVICON" | "HOME_SLIDE" | "HOME_SECTION" | "GALLERY" | "HISTORY" | "FOOD" | "OG_IMAGE";

export type FieldKind =
  | "text"       // single line, no control characters
  | "multiline"  // plain text with line breaks (never HTML)
  | "int"
  | "money"      // integer satang
  | "enum"
  | "bool"
  | "link"       // "/relative/path" or "https://…"
  | "path"       // "/relative/path" only
  | "color"      // #RRGGBB
  | "datetime"   // ISO timestamp (stored in UTC)
  | "time"       // HH:MM
  | "slug"       // a-z 0-9 -
  | "code"       // A-Z _
  | "asset"      // public media asset id of an allowed purpose
  | "ref";       // id of another record

export interface FieldDef {
  key: string;
  kind: FieldKind;
  required?: boolean;
  min?: number;
  max?: number;
  values?: readonly (string | number)[];
  purpose?: MediaPurposeCode;
  /** Entity whose id this field holds (kind "ref"). */
  ref?: CmsEntityName | "unit";
  /** Set on create only; cannot be changed afterwards. */
  immutable?: boolean;
  /** kind "code": may be left empty — the server makes one (from the English name, else generic). */
  auto?: boolean;
  /** kind "code": A–Z and _ only, no digits (the database CHECK of that table). */
  lettersOnly?: boolean;
  default?: string | number | boolean | null;
}

export interface EntityDef {
  name: CmsEntityName;
  fields: readonly FieldDef[];
  translations: readonly FieldDef[];
  /** Translation field that must be filled in the default language (th). */
  requiredTranslation?: string;
  /** Has publish / unpublish actions (content). Otherwise `status` is a normal field. */
  publishable: boolean;
  deletable: boolean;
  /** Field shown as the record's title in lists. */
  titleField?: string;
}

export const CMS_ENTITY_NAMES = [
  "foodCategory", "foodOption", "includedMeal",
  "homeSlide", "homeSection",
  "galleryCategory", "galleryImage",
  "historySection", "historyTimeline",
  "seoRedirect",
] as const;
export type CmsEntityName = (typeof CMS_ENTITY_NAMES)[number];

const sortOrder: FieldDef = { key: "sortOrder", kind: "int", min: 0, max: 100_000, default: 0 };

export const DEADLINE_TYPES = ["NONE", "DAYS_BEFORE", "PREVIOUS_DAY_TIME"] as const;
export const FOOD_PRICING_TYPES = ["PER_PERSON", "PER_SET", "PER_ITEM", "PER_NIGHT"] as const;
export const CHILD_PRICING = ["FREE", "FULL", "HALF", "SPECIAL_PRICE"] as const;
export const HOME_SECTION_TYPES = ["INTRODUCTION", "ACCOMMODATION_HIGHLIGHTS", "GALLERY_PREVIEW", "HISTORY_PREVIEW",
  "FOOD_PREVIEW", "BOOKING_CTA", "LOCATION", "CONTACT", "CUSTOM"] as const;
export const HISTORY_SECTION_TYPES = ["HERO", "INTRODUCTION", "STORY", "IMAGE_TEXT", "TIMELINE", "GALLERY", "QUOTE", "CTA"] as const;
export const SLIDE_POSITIONS = ["LEFT", "CENTER", "RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER"] as const;
export const GALLERY_SPANS = ["NORMAL", "WIDE", "TALL", "LARGE"] as const;
export const HISTORY_LAYOUTS = ["DEFAULT", "IMAGE_LEFT", "IMAGE_RIGHT", "FULL_WIDTH"] as const;

export const ENTITIES: Record<CmsEntityName, EntityDef> = {
  foodCategory: {
    name: "foodCategory",
    publishable: false,
    deletable: false,
    titleField: "name",
    requiredTranslation: "name",
    fields: [
      // Food category codes: A–Z and _ only (database CHECK), e.g. DINNER; empty = made by the server.
      { key: "code", kind: "code", max: 32, immutable: true, auto: true, lettersOnly: true },
      { key: "defaultDailyCapacity", kind: "int", min: 0, max: 100_000 },
      { key: "deadlineType", kind: "enum", values: DEADLINE_TYPES, required: true, default: "NONE" },
      { key: "deadlineDaysBefore", kind: "int", min: 0, max: 60 },
      { key: "deadlineTime", kind: "time" },
      { key: "serviceTime", kind: "time" },
      { key: "serviceDayOffset", kind: "int", min: 0, max: 1, values: [0, 1], default: 0 },
      sortOrder,
      { key: "status", kind: "enum", values: ["ACTIVE", "INACTIVE"], required: true, default: "ACTIVE" },
    ],
    translations: [
      { key: "name", kind: "text", max: 80 },
      { key: "description", kind: "multiline", max: 500 },
    ],
  },
  foodOption: {
    name: "foodOption",
    publishable: false,
    deletable: true,
    titleField: "name",
    requiredTranslation: "name",
    fields: [
      { key: "foodCategoryId", kind: "ref", ref: "foodCategory", required: true },
      { key: "code", kind: "code", max: 40, immutable: true, auto: true },
      { key: "pricingType", kind: "enum", values: FOOD_PRICING_TYPES, required: true, default: "PER_PERSON" },
      { key: "priceSatang", kind: "money", required: true, min: 0 },
      { key: "childPricing", kind: "enum", values: CHILD_PRICING, required: true, default: "FULL" },
      { key: "childPriceSatang", kind: "money", min: 0 },
      { key: "personsPerSet", kind: "int", min: 1, max: 50 },
      { key: "minQuantity", kind: "int", min: 1, max: 999, required: true, default: 1 },
      { key: "maxQuantity", kind: "int", min: 1, max: 999 },
      { key: "imageAssetId", kind: "asset", purpose: "FOOD" },
      { key: "status", kind: "enum", values: ["DRAFT", "ACTIVE", "INACTIVE"], required: true, default: "DRAFT" },
      sortOrder,
    ],
    translations: [
      { key: "name", kind: "text", max: 120 },
      { key: "description", kind: "multiline", max: 1000 },
      { key: "allergens", kind: "text", max: 200 },
    ],
  },
  includedMeal: {
    name: "includedMeal",
    publishable: false,
    deletable: false,
    fields: [
      { key: "targetType", kind: "enum", values: ["UNIT", "UNIT_TYPE", "CAMPING"], required: true, default: "UNIT" },
      { key: "unitId", kind: "ref", ref: "unit" },
      { key: "unitType", kind: "enum", values: ["HOUSE", "VIP_TENT"] },
      { key: "foodCategoryId", kind: "ref", ref: "foodCategory", required: true },
      { key: "foodOptionId", kind: "ref", ref: "foodOption" },
      { key: "personsPerNight", kind: "int", min: 1, max: 50, required: true, default: 2 },
      { key: "status", kind: "enum", values: ["ACTIVE", "INACTIVE"], required: true, default: "ACTIVE" },
    ],
    translations: [],
  },
  homeSlide: {
    name: "homeSlide",
    publishable: true,
    deletable: true,
    titleField: "title",
    fields: [
      { key: "desktopAssetId", kind: "asset", purpose: "HOME_SLIDE", required: true },
      { key: "mobileAssetId", kind: "asset", purpose: "HOME_SLIDE" },
      { key: "overlayEnabled", kind: "bool", default: true },
      { key: "overlayColor", kind: "color", required: true, default: "#000000" },
      { key: "overlayOpacity", kind: "int", min: 0, max: 100, required: true, default: 35 },
      { key: "contentPosition", kind: "enum", values: SLIDE_POSITIONS, required: true, default: "CENTER" },
      { key: "button1Url", kind: "link", max: 500 },
      { key: "button2Url", kind: "link", max: 500 },
      { key: "startAt", kind: "datetime" },
      { key: "endAt", kind: "datetime" },
      sortOrder,
    ],
    translations: [
      { key: "title", kind: "text", max: 120 },
      { key: "subtitle", kind: "text", max: 160 },
      { key: "description", kind: "multiline", max: 500 },
      { key: "button1Label", kind: "text", max: 40 },
      { key: "button2Label", kind: "text", max: 40 },
      { key: "imageAlt", kind: "text", max: 160 },
    ],
  },
  homeSection: {
    name: "homeSection",
    publishable: true,
    deletable: true,
    titleField: "title",
    fields: [
      { key: "sectionType", kind: "enum", values: HOME_SECTION_TYPES, required: true, default: "INTRODUCTION" },
      { key: "mediaAssetId", kind: "asset", purpose: "HOME_SECTION" },
      sortOrder,
    ],
    translations: [
      { key: "title", kind: "text", max: 120 },
      { key: "subtitle", kind: "text", max: 200 },
      { key: "body", kind: "multiline", max: 5000 },
      { key: "buttonLabel", kind: "text", max: 40 },
      { key: "buttonUrl", kind: "link", max: 500 },
    ],
  },
  galleryCategory: {
    name: "galleryCategory",
    publishable: true,
    deletable: true,
    titleField: "name",
    requiredTranslation: "name",
    fields: [
      { key: "slug", kind: "slug", required: true, max: 80 },
      sortOrder,
    ],
    translations: [
      { key: "name", kind: "text", max: 80 },
      { key: "description", kind: "multiline", max: 500 },
    ],
  },
  galleryImage: {
    name: "galleryImage",
    publishable: true,
    deletable: true,
    titleField: "title",
    fields: [
      { key: "mediaAssetId", kind: "asset", purpose: "GALLERY", required: true },
      { key: "categoryId", kind: "ref", ref: "galleryCategory" },
      { key: "layoutSpan", kind: "enum", values: GALLERY_SPANS, required: true, default: "NORMAL" },
      sortOrder,
    ],
    translations: [
      { key: "altText", kind: "text", max: 160 },
      { key: "title", kind: "text", max: 120 },
      { key: "caption", kind: "multiline", max: 500 },
    ],
  },
  historySection: {
    name: "historySection",
    publishable: true,
    deletable: true,
    titleField: "title",
    fields: [
      { key: "sectionType", kind: "enum", values: HISTORY_SECTION_TYPES, required: true, default: "STORY" },
      { key: "mediaAssetId", kind: "asset", purpose: "HISTORY" },
      { key: "layout", kind: "enum", values: HISTORY_LAYOUTS, required: true, default: "DEFAULT" },
      sortOrder,
    ],
    translations: [
      { key: "title", kind: "text", max: 160 },
      { key: "subtitle", kind: "text", max: 200 },
      { key: "body", kind: "multiline", max: 8000 },
      { key: "quoteAuthor", kind: "text", max: 120 },
      { key: "buttonLabel", kind: "text", max: 40 },
      { key: "buttonUrl", kind: "link", max: 500 },
      { key: "imageAlt", kind: "text", max: 160 },
    ],
  },
  historyTimeline: {
    name: "historyTimeline",
    publishable: true,
    deletable: true,
    titleField: "title",
    requiredTranslation: "title",
    fields: [
      { key: "year", kind: "int", min: 1000, max: 9999, required: true },
      { key: "mediaAssetId", kind: "asset", purpose: "HISTORY" },
      sortOrder,
    ],
    translations: [
      { key: "title", kind: "text", max: 160 },
      { key: "description", kind: "multiline", max: 2000 },
      { key: "imageAlt", kind: "text", max: 160 },
    ],
  },
  seoRedirect: {
    name: "seoRedirect",
    publishable: false,
    deletable: true,
    titleField: "fromPath",
    fields: [
      { key: "fromPath", kind: "path", required: true, max: 300 },
      { key: "toPath", kind: "path", required: true, max: 300 },
      { key: "statusCode", kind: "int", values: [301, 302, 307, 308], required: true, default: 301 },
      { key: "isActive", kind: "bool", default: true },
    ],
    translations: [],
  },
};

/** One record as returned by the admin API. Field values use the keys above. */
export interface CmsRecord {
  id: string;
  /** Stored status (publishable entities: DRAFT / PUBLISHED / …). */
  status?: string;
  /** Status as visitors see it right now (slides: SCHEDULED / EXPIRED by date). */
  effectiveStatus?: string;
  translations: Partial<Record<LocaleCode, Record<string, string | null>>>;
  /** Public URL for every `asset` field (key → url). */
  urls: Record<string, string | null>;
  updatedAt?: string | null;
  [field: string]: unknown;
}

export const CMS_TEXT = {
  /** Plain text only: line breaks and tabs allowed, other control characters not. */
  multiline: /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/,
  singleLine: /^[^\u0000-\u001f\u007f]*$/,
  color: /^#[0-9A-Fa-f]{6}$/,
  time: /^([01]\d|2[0-3]):[0-5]\d$/,
  slug: /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/,
  code: /^[A-Z][A-Z0-9_]{0,39}$/,
  /** Same-site path: starts with one "/", no "//", no backslash, no spaces or control characters. */
  path: /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/,
} as const;

/** Typed code tidied the same way in the form and on the server: "set a-1" → "SET_A_1" (other characters stay, and are refused). */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/**
 * A slug as it is being typed: letters lower case, spaces / _ / dash look-alikes become "-", invisible characters
 * (zero-width spaces from copy and paste) go. Full-width letters become plain ones (NFKC).
 */
export function typingSlug(raw: string): string {
  return raw.normalize("NFKC").replace(/[\u200b-\u200d\u2060\ufeff]/g, "").trimStart().toLowerCase().replace(/[\s_\u2010-\u2015\u2212]+/g, "-");
}

/**
 * Typed slug tidied the same way in the form (on leaving the field) and on the server: " House 01 " → "house-01".
 * Other characters (Thai letters, punctuation) stay, and are refused with SLUG_FORMAT.
 */
export function normalizeSlug(raw: string): string {
  return typingSlug(raw.trim()).replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

/** Link: same-site path or an https URL. */
export function isSafeLink(value: string): boolean {
  if (CMS_TEXT.path.test(value)) return !value.includes("//") && !value.includes("\\");
  if (!value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isSafePath(value: string): boolean {
  return CMS_TEXT.path.test(value) && !value.includes("//") && !value.includes("\\") && !value.includes("..");
}
