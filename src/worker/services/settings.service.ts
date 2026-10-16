import { CMS_TEXT, isSafeLink } from "../../shared/cms-schema.ts";
import { LOCALE_CODES, DEFAULT_LOCALE_CODE, type LocaleCode } from "../../shared/i18n/locales.ts";
import {
  BRANDING_SLOTS, CTA_ICONS, CTA_PAGES, ROBOTS_VALUES, SEO_PAGE_KEYS,
  type BookingCtaDto, type BrandingDto, type BrandingSlot, type MarketingDto, type SeoEntryDto, type SeoPageDto,
  type SiteTextsDto, type ThemeAdminDto, type ThemeVersionDto, type WebsiteSettingsDto,
} from "../../shared/settings-types.ts";
import { THEME_PRESETS, validateThemeTokens, type ThemePreset, type ThemeTokens } from "../../shared/theme.ts";
import { normalizePhones } from "../../shared/phones.ts";
import type { D1DatabaseLike } from "../env.ts";
import { ConflictError, NotFoundError } from "../http/errors.ts";
import type { SettingsRepository, ThemeVersionRow } from "../repositories/settings.repository.ts";
import { newId } from "../security/tokens.ts";
import { ID_PATTERN, Validator } from "../validation.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import { publicMediaUrl } from "./media-url.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import { ctaPages, fontFaces } from "./site.service.ts";
import type { FontRepository } from "../repositories/font.repository.ts";
import type { PublicFontFaceDto } from "../../shared/media-types.ts";

const GA4_ID = /^G-[A-Z0-9]{4,20}$/;
const PIXEL_ID = /^\d{5,20}$/;
const GSC_TOKEN = /^[A-Za-z0-9_-]{10,100}$/;
const BRANDING_PURPOSE: Record<BrandingSlot, string> = { logoMain: "LOGO", logoMobile: "LOGO", loginLogo: "LOGO", favicon: "FAVICON" };
const MAX_SCHEMA_JSON = 8000;

type Body = Record<string, unknown>;

export interface MarketingSecrets {
  capiToken: boolean;
  testEventCode: boolean;
  /** META_PIXEL_ID secret (a Pixel ID is not sensitive, but it is never echoed back either). */
  pixelId?: string | null;
  /** GA4_SERVICE_ACCOUNT_KEY secret is set and readable (dashboard numbers from the GA4 Data API). */
  ga4Key?: boolean;
}

/**
 * Website settings, branding, floating booking button, marketing IDs, SEO and theme versions
 * (spec §36–39, §42–45). Every change is audited in the same batch as the write.
 * Secrets (Meta CAPI token) are never stored or returned — only whether they are configured.
 */
export class SettingsService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: SettingsRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly mediaBaseUrl: string | undefined,
    private readonly secrets: MarketingSecrets,
    /** Uploaded web fonts a theme may use (Phase 12). */
    private readonly fonts: Pick<FontRepository, "families" | "list"> | null = null,
  ) {}

  // ================================================================ website

  async website(actor: AuthContext, meta: RequestMeta): Promise<WebsiteSettingsDto> {
    await this.authz.requirePermission(actor, "settings.website", meta);
    const [s, texts] = await Promise.all([this.repo.site(), this.repo.siteTexts()]);
    const translations: WebsiteSettingsDto["translations"] = {};
    for (const t of texts) {
      translations[t.language_code as LocaleCode] = { siteName: t.site_name, tagline: t.tagline, address: t.address, footerText: t.footer_text };
    }
    return {
      defaultLanguage: (s?.default_language ?? DEFAULT_LOCALE_CODE) as LocaleCode,
      timezone: s?.timezone ?? "Asia/Bangkok",
      currency: s?.currency ?? "THB",
      contactPhone: s?.contact_phone ?? null,
      contactEmail: s?.contact_email ?? null,
      lineOaUrl: s?.line_oa_url ?? null,
      mapUrl: s?.map_url ?? null,
      latitude: s?.latitude ?? null,
      longitude: s?.longitude ?? null,
      translations,
      updatedAt: s?.updated_at ?? null,
    };
  }

  async saveWebsite(actor: AuthContext, body: Body, meta: RequestMeta): Promise<WebsiteSettingsDto> {
    await this.authz.requirePermission(actor, "settings.website", meta);
    const v = new Validator(body).allowOnly(["contactPhone", "contactEmail", "lineOaUrl", "mapUrl", "latitude", "longitude", "translations"]);
    // Several numbers allowed ("063…, 095…"): each is checked; stored as "a, b".
    let contactPhone: string | null = null;
    const rawPhone = v.string("contactPhone", { max: 200 });
    if (rawPhone) {
      const phones = normalizePhones(rawPhone);
      if (phones === null) v.errors.contactPhone = "INVALID_FORMAT";
      else contactPhone = phones || null;
    }
    const contactEmail = v.email("contactEmail") ?? null;
    const lineOaUrl = httpsUrl(v, "lineOaUrl");
    const mapUrl = httpsUrl(v, "mapUrl");
    const latitude = coordinate(v, body, "latitude", 90);
    const longitude = coordinate(v, body, "longitude", 180);
    const texts = translationsOf<SiteTextsDto & Record<string, string | null>>(v, body.translations, {
      siteName: 80, tagline: 160, address: 300, footerText: 500,
    });
    if ((latitude === null) !== (longitude === null)) v.errors.longitude = "BOTH_OR_NEITHER";
    if (texts && DEFAULT_LOCALE_CODE in texts && !texts[DEFAULT_LOCALE_CODE]?.siteName) {
      v.errors[`translations.${DEFAULT_LOCALE_CODE}.siteName`] = "REQUIRED";
    }
    v.assertValid();
    const before = await this.website(actor, meta);
    const after = { contactPhone, contactEmail, lineOaUrl, mapUrl, latitude, longitude };
    const now = iso(this.clock());
    await this.db.batch([
      this.repo.saveSiteStatement(after, actor.userId, now),
      ...Object.entries(texts ?? {}).map(([lang, t]) => this.repo.saveSiteTextStatement(lang, t)),
      this.log.auditStatement(actor.userId, "UPDATE_WEBSITE", "settings", "site_settings",
        { ...before, updatedAt: undefined }, { ...after, translations: texts }, meta),
    ]);
    return this.website(actor, meta);
  }

  // ================================================================ branding (spec §36)

  async branding(actor: AuthContext, meta: RequestMeta): Promise<BrandingDto> {
    await this.authz.requirePermission(actor, "settings.branding", meta);
    const row = (await this.repo.branding()) ?? {};
    const slot = (idCol: string, n: number) => ({
      assetId: (row[idCol] as string | null) ?? null,
      url: publicMediaUrl(row[`k${n}`] as string | null, this.mediaBaseUrl) ?? null,
      width: (row[`w${n}`] as number | null) ?? null,
      height: (row[`h${n}`] as number | null) ?? null,
    });
    return {
      slots: {
        logoMain: slot("logo_main_asset_id", 1),
        logoMobile: slot("logo_mobile_asset_id", 2),
        favicon: slot("favicon_asset_id", 3),
        loginLogo: slot("login_logo_asset_id", 4),
      },
      updatedAt: (row.updated_at as string | null) ?? null,
    };
  }

  /** Logos change without a deploy: the public site reads them from D1 + R2 on every load. */
  async saveBranding(actor: AuthContext, body: Body, meta: RequestMeta): Promise<BrandingDto> {
    await this.authz.requirePermission(actor, "settings.branding", meta);
    const v = new Validator(body).allowOnly(BRANDING_SLOTS);
    const ids = {} as Record<BrandingSlot, string | null>;
    for (const slot of BRANDING_SLOTS) ids[slot] = body[slot] === null ? null : v.string(slot, { pattern: ID_PATTERN }) ?? null;
    v.assertValid();
    for (const slot of BRANDING_SLOTS) {
      const id = ids[slot];
      if (!id) continue;
      const asset = await this.repo.asset(id);
      // Settings point at originals only (a resized rendition is never a logo / favicon).
      if (!asset || asset.status !== "ACTIVE" || asset.bucket !== "PUBLIC" || asset.parent_asset_id) v.errors[slot] = "MEDIA_NOT_FOUND";
      else if (asset.purpose !== BRANDING_PURPOSE[slot]) v.errors[slot] = "WRONG_MEDIA_PURPOSE";
    }
    v.assertValid();
    const before = await this.branding(actor, meta);
    await this.db.batch([
      this.repo.saveBrandingStatement(ids, actor.userId, iso(this.clock())),
      this.log.auditStatement(actor.userId, "UPDATE_BRANDING", "branding", "branding_settings",
        Object.fromEntries(BRANDING_SLOTS.map((s) => [s, before.slots[s].assetId])), ids, meta),
    ]);
    return this.branding(actor, meta);
  }

  // ================================================================ floating booking button (spec §39)

  async bookingCta(actor: AuthContext, meta: RequestMeta): Promise<BookingCtaDto> {
    await this.authz.requirePermission(actor, "settings.booking_cta", meta);
    const [row, labels] = await Promise.all([this.repo.cta(), this.repo.ctaLabels()]);
    return {
      enabled: row ? row.enabled === 1 : true,
      showOnDesktop: row ? row.show_on_desktop === 1 : true,
      showOnMobile: row ? row.show_on_mobile === 1 : true,
      desktopPosition: (row?.desktop_position ?? "BOTTOM_RIGHT") as BookingCtaDto["desktopPosition"],
      mobilePosition: (row?.mobile_position ?? "BOTTOM_BAR") as BookingCtaDto["mobilePosition"],
      size: (row?.size ?? "MD") as BookingCtaDto["size"],
      icon: (row?.icon ?? "calendar") as BookingCtaDto["icon"],
      color: row?.color ?? null,
      animation: (row?.animation ?? "NONE") as BookingCtaDto["animation"],
      closeable: row ? row.closeable === 1 : false,
      pages: row ? ctaPages(row.pages_json) : ["*"],
      labels: Object.fromEntries(labels.map((l) => [l.language_code, l.label])),
    };
  }

  async saveBookingCta(actor: AuthContext, body: Body, meta: RequestMeta): Promise<BookingCtaDto> {
    await this.authz.requirePermission(actor, "settings.booking_cta", meta);
    const v = new Validator(body).allowOnly(["enabled", "showOnDesktop", "showOnMobile", "desktopPosition", "mobilePosition", "size",
      "icon", "color", "animation", "closeable", "pages", "labels"]);
    const input = {
      enabled: v.boolean("enabled", true),
      showOnDesktop: v.boolean("showOnDesktop", true),
      showOnMobile: v.boolean("showOnMobile", true),
      desktopPosition: v.oneOf("desktopPosition", ["BOTTOM_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER"] as const) ?? "BOTTOM_RIGHT",
      mobilePosition: v.oneOf("mobilePosition", ["BOTTOM_BAR", "BOTTOM_RIGHT", "BOTTOM_LEFT"] as const) ?? "BOTTOM_BAR",
      size: v.oneOf("size", ["SM", "MD", "LG"] as const) ?? "MD",
      icon: v.oneOf("icon", CTA_ICONS) ?? "calendar",
      color: body.color === null ? null : v.string("color", { pattern: CMS_TEXT.color }) ?? null,
      animation: v.oneOf("animation", ["NONE", "PULSE", "BOUNCE", "SLIDE_IN"] as const) ?? "NONE",
      closeable: v.boolean("closeable", false),
      pages: v.stringArray("pages", { max: CTA_PAGES.length }) ?? ["*"],
    };
    if (!input.pages.every((p) => (CTA_PAGES as readonly string[]).includes(p)) || input.pages.length === 0) v.errors.pages = "INVALID_VALUE";
    const labels: Partial<Record<LocaleCode, string | null>> = {};
    if (body.labels !== undefined) {
      if (typeof body.labels !== "object" || body.labels === null || Array.isArray(body.labels)) v.errors.labels = "EXPECTED_OBJECT";
      else {
        for (const [lang, raw] of Object.entries(body.labels as Body)) {
          if (!(LOCALE_CODES as readonly string[]).includes(lang)) { v.errors[`labels.${lang}`] = "UNKNOWN_LANGUAGE"; continue; }
          if (raw === null || raw === "") { labels[lang as LocaleCode] = null; continue; }
          if (typeof raw !== "string" || !CMS_TEXT.singleLine.test(raw) || raw.trim().length === 0 || [...raw.trim()].length > 30) {
            v.errors[`labels.${lang}`] = "INVALID_VALUE";
            continue;
          }
          labels[lang as LocaleCode] = raw.trim();
        }
      }
    }
    v.assertValid();
    const pages = input.pages.includes("*") ? ["*"] : input.pages;
    const before = await this.bookingCta(actor, meta);
    const now = iso(this.clock());
    await this.db.batch([
      this.repo.saveCtaStatement({ ...input, pages }, actor.userId, now),
      ...Object.entries(labels).map(([lang, label]) => this.repo.saveCtaLabelStatement(lang, label)),
      this.log.auditStatement(actor.userId, "UPDATE_BOOKING_CTA", "settings", "booking_cta_settings", before, { ...input, pages, labels }, meta),
    ]);
    return this.bookingCta(actor, meta);
  }

  // ================================================================ marketing (spec §43–45)

  async marketing(actor: AuthContext, meta: RequestMeta): Promise<MarketingDto> {
    await this.authz.requirePermission(actor, "marketing.view", meta);
    const m = await this.repo.marketing();
    return {
      ga4Enabled: m?.ga4_enabled === 1,
      ga4MeasurementId: m?.ga4_measurement_id ?? null,
      metaPixelEnabled: m?.meta_pixel_enabled === 1,
      metaPixelId: m?.meta_pixel_id ?? null,
      metaCapiEnabled: m?.meta_capi_enabled === 1,
      gscVerification: m?.gsc_verification ?? null,
      ga4PropertyId: m?.ga4_property_id ?? null,
      ga4DataKeyConfigured: !!this.secrets.ga4Key,
      ga4DataError: m?.ga4_property_id ? await this.repo.ga4ReportError(m.ga4_property_id) : null,
      capiTokenConfigured: this.secrets.capiToken,
      capiTestEventCodeConfigured: this.secrets.testEventCode,
      capiPixelSource: this.secrets.pixelId ? "SECRET" : m?.meta_pixel_id ? "SETTINGS" : null,
      capiPixelMismatch: !!this.secrets.pixelId && !!m?.meta_pixel_id && this.secrets.pixelId !== m.meta_pixel_id,
      updatedAt: m?.updated_at ?? null,
    };
  }

  async saveMarketing(actor: AuthContext, body: Body, meta: RequestMeta): Promise<MarketingDto> {
    await this.authz.requirePermission(actor, "marketing.edit", meta);
    const v = new Validator(body).allowOnly(["ga4Enabled", "ga4MeasurementId", "ga4PropertyId", "metaPixelEnabled", "metaPixelId", "metaCapiEnabled", "gscVerification"]);
    const input = {
      ga4Enabled: v.boolean("ga4Enabled", false),
      ga4MeasurementId: v.string("ga4MeasurementId", { max: 30 })?.toUpperCase() ?? null,
      ga4PropertyId: v.string("ga4PropertyId", { pattern: PIXEL_ID }) ?? null,
      metaPixelEnabled: v.boolean("metaPixelEnabled", false),
      metaPixelId: v.string("metaPixelId", { pattern: PIXEL_ID }) ?? null,
      metaCapiEnabled: v.boolean("metaCapiEnabled", false),
      gscVerification: v.string("gscVerification", { pattern: GSC_TOKEN }) ?? null,
    };
    if (input.ga4MeasurementId && !GA4_ID.test(input.ga4MeasurementId)) v.errors.ga4MeasurementId = "INVALID_FORMAT";
    if (input.ga4Enabled && !input.ga4MeasurementId) v.errors.ga4MeasurementId = "REQUIRED";
    if (input.metaPixelEnabled && !input.metaPixelId) v.errors.metaPixelId = "REQUIRED";
    if (input.metaCapiEnabled && !input.metaPixelId && !this.secrets.pixelId) v.errors.metaPixelId = "REQUIRED";
    if (input.metaCapiEnabled && !this.secrets.capiToken) v.errors.metaCapiEnabled = "CAPI_TOKEN_MISSING";
    v.assertValid();
    const before = await this.marketing(actor, meta);
    await this.db.batch([
      this.repo.saveMarketingStatement(input, actor.userId, iso(this.clock())),
      this.log.auditStatement(actor.userId, "UPDATE_MARKETING", "marketing", "marketing_settings",
        { ...before, capiTokenConfigured: undefined, capiTestEventCodeConfigured: undefined, capiPixelSource: undefined,
          capiPixelMismatch: undefined, ga4DataKeyConfigured: undefined, ga4DataError: undefined, updatedAt: undefined }, input, meta),
    ]);
    return this.marketing(actor, meta);
  }

  // ================================================================ SEO (spec §42)

  async seo(actor: AuthContext, meta: RequestMeta): Promise<SeoPageDto[]> {
    if (!this.authz.can(actor, "content.view")) await this.authz.requirePermission(actor, "seo.edit", meta);
    const rows = await this.repo.seo();
    return SEO_PAGE_KEYS.map((pageKey) => ({
      pageKey,
      translations: Object.fromEntries(rows.filter((r) => r.page_key === pageKey).map((r) => [r.language_code, {
        seoTitle: r.seo_title,
        metaDescription: r.meta_description,
        canonicalUrl: r.canonical_url,
        ogTitle: r.og_title,
        ogDescription: r.og_description,
        ogImageAssetId: r.og_image_asset_id,
        ogImageUrl: publicMediaUrl(r.og_key, this.mediaBaseUrl) ?? null,
        robots: r.robots as SeoEntryDto["robots"],
        schemaJson: r.schema_json,
      } satisfies SeoEntryDto])),
    }));
  }

  async saveSeo(actor: AuthContext, pageKey: string, body: Body, meta: RequestMeta): Promise<SeoPageDto[]> {
    await this.authz.requirePermission(actor, "seo.edit", meta);
    if (!(SEO_PAGE_KEYS as readonly string[]).includes(pageKey)) throw new NotFoundError("Unknown page", "SEO_PAGE_NOT_FOUND");
    const v = new Validator(body).allowOnly(["translations"]);
    const raw = body.translations;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) v.errors.translations = "EXPECTED_OBJECT";
    v.assertValid();
    const entries: Partial<Record<LocaleCode, Omit<SeoEntryDto, "ogImageUrl"> | null>> = {};
    for (const [lang, value] of Object.entries(raw as Body)) {
      if (!(LOCALE_CODES as readonly string[]).includes(lang)) { v.errors[`translations.${lang}`] = "UNKNOWN_LANGUAGE"; continue; }
      if (value === null) { entries[lang as LocaleCode] = null; continue; }
      if (typeof value !== "object" || Array.isArray(value)) { v.errors[`translations.${lang}`] = "EXPECTED_OBJECT"; continue; }
      const e = new Validator(value as Body).allowOnly(["seoTitle", "metaDescription", "canonicalUrl", "ogTitle", "ogDescription", "ogImageAssetId", "robots", "schemaJson"]);
      const entry = {
        seoTitle: e.string("seoTitle", { max: 70 }) ?? null,
        metaDescription: e.string("metaDescription", { max: 200 }) ?? null,
        canonicalUrl: httpsUrl(e, "canonicalUrl"),
        ogTitle: e.string("ogTitle", { max: 95 }) ?? null,
        ogDescription: e.string("ogDescription", { max: 300 }) ?? null,
        ogImageAssetId: e.string("ogImageAssetId", { pattern: ID_PATTERN }) ?? null,
        robots: e.oneOf("robots", ROBOTS_VALUES) ?? "index,follow",
        schemaJson: schemaJson(e, (value as Body).schemaJson),
      };
      if (entry.ogImageAssetId && !e.errors.ogImageAssetId) {
        const asset = await this.repo.asset(entry.ogImageAssetId);
        if (!asset || asset.status !== "ACTIVE" || asset.bucket !== "PUBLIC" || asset.parent_asset_id) e.errors.ogImageAssetId = "MEDIA_NOT_FOUND";
        else if (asset.purpose !== "OG_IMAGE") e.errors.ogImageAssetId = "WRONG_MEDIA_PURPOSE";
      }
      for (const [k, code] of Object.entries(e.errors)) v.errors[`translations.${lang}.${k}`] = code;
      entries[lang as LocaleCode] = entry;
    }
    v.assertValid();
    const before = (await this.seo(actor, meta)).find((p) => p.pageKey === pageKey)?.translations ?? {};
    const now = iso(this.clock());
    await this.db.batch([
      ...Object.entries(entries).map(([lang, e]) => this.repo.saveSeoStatement(newId(), pageKey, lang, e, actor.userId, now)),
      this.log.auditStatement(actor.userId, "UPDATE_SEO", "seo", pageKey, before, entries, meta),
    ]);
    return this.seo(actor, meta);
  }

  // ================================================================ theme (spec §37–38)

  async theme(actor: AuthContext, meta: RequestMeta): Promise<ThemeAdminDto> {
    await this.authz.requirePermission(actor, "settings.theme", meta);
    const rows = await this.repo.themeVersions(50);
    const versions = rows.map(themeDto);
    return {
      published: versions.find((v) => v.status === "PUBLISHED") ?? null,
      draft: versions.find((v) => v.status === "DRAFT") ?? null,
      history: versions.filter((v) => v.status !== "DRAFT"),
    };
  }

  /** Draft tokens for "preview on the website" (admin session only); falls back to the live theme. */
  async themePreview(actor: AuthContext, meta: RequestMeta): Promise<{ tokens: ThemeTokens; versionNumber: number | null; isDraft: boolean; fonts: PublicFontFaceDto[] }> {
    const t = await this.theme(actor, meta);
    const v = t.draft ?? t.published;
    const tokens = v?.tokens ?? {};
    // Faces the draft uses, so "preview on the live website" shows uploaded fonts too.
    const fonts = this.fonts ? fontFaces(tokens, await this.fonts.list(), this.mediaBaseUrl) : [];
    return { tokens, versionNumber: v?.versionNumber ?? null, isDraft: !!t.draft, fonts };
  }

  async saveThemeDraft(actor: AuthContext, body: Body, meta: RequestMeta): Promise<ThemeAdminDto> {
    await this.authz.requirePermission(actor, "settings.theme", meta);
    const v = new Validator(body).allowOnly(["preset", "tokens", "note"]);
    const preset = v.oneOf("preset", [...THEME_PRESETS, "CUSTOM"] as const, { required: true });
    const note = v.string("note", { max: 200 }) ?? null;
    // Uploaded font families (Phase 12) must exist in the font library.
    const tokenErrors = validateThemeTokens(body.tokens, this.fonts ? await this.fonts.families() : []);
    for (const [k, code] of Object.entries(tokenErrors)) v.errors[k === "tokens" ? "tokens" : `tokens.${k}`] = code;
    v.assertValid();
    const tokens = JSON.stringify(body.tokens);
    const now = iso(this.clock());
    const current = await this.theme(actor, meta);
    if (current.draft) {
      await this.db.batch([
        this.repo.updateThemeDraftStatement(current.draft.id, preset!, tokens, note),
        this.log.auditStatement(actor.userId, "UPDATE_THEME_DRAFT", "theme", current.draft.id,
          { preset: current.draft.preset, tokens: current.draft.tokens }, { preset, tokens: body.tokens }, meta),
      ]);
    } else {
      const id = newId();
      await this.db.batch([
        this.repo.insertThemeDraftStatement(id, preset!, tokens, note, actor.userId, now),
        this.repo.setThemePointersStatement(id, actor.userId, now),
        this.log.auditStatement(actor.userId, "CREATE_THEME_DRAFT", "theme", id, null, { preset, tokens: body.tokens }, meta),
      ]);
    }
    return this.theme(actor, meta);
  }

  async discardThemeDraft(actor: AuthContext, meta: RequestMeta): Promise<ThemeAdminDto> {
    await this.authz.requirePermission(actor, "settings.theme", meta);
    const current = await this.theme(actor, meta);
    if (!current.draft) throw new ConflictError("There is no draft", "NO_THEME_DRAFT");
    const now = iso(this.clock());
    await this.db.batch([
      this.repo.setThemePointersStatement(null, actor.userId, now),
      this.repo.deleteDraftStatement(current.draft.id),
      this.log.auditStatement(actor.userId, "DISCARD_THEME_DRAFT", "theme", current.draft.id, { tokens: current.draft.tokens }, null, meta),
    ]);
    return this.theme(actor, meta);
  }

  /** Draft → live. The previous live version is archived (version history), all in one batch. */
  async publishTheme(actor: AuthContext, meta: RequestMeta): Promise<ThemeAdminDto> {
    await this.authz.requirePermission(actor, "settings.theme", meta);
    const current = await this.theme(actor, meta);
    if (!current.draft) throw new ConflictError("There is no draft to publish", "NO_THEME_DRAFT");
    return this.makeLive(actor, current.draft.id, "DRAFT", "PUBLISH_THEME", current.published, meta);
  }

  /** Rollback: an archived version becomes live again (its tokens are frozen by trigger). */
  async rollbackTheme(actor: AuthContext, versionId: string, meta: RequestMeta): Promise<ThemeAdminDto> {
    await this.authz.requirePermission(actor, "settings.theme", meta);
    const target = ID_PATTERN.test(versionId) ? await this.repo.themeVersion(versionId) : null;
    if (!target) throw new NotFoundError("Theme version not found", "THEME_VERSION_NOT_FOUND");
    if (target.status !== "ARCHIVED") throw new ConflictError("Only an archived version can be restored", "THEME_VERSION_NOT_ARCHIVED");
    const current = await this.theme(actor, meta);
    return this.makeLive(actor, target.id, "ARCHIVED", "ROLLBACK_THEME", current.published, meta);
  }

  private async makeLive(actor: AuthContext, id: string, from: "DRAFT" | "ARCHIVED", action: string,
    previous: ThemeVersionDto | null, meta: RequestMeta): Promise<ThemeAdminDto> {
    const now = iso(this.clock());
    const settings = await this.repo.themeSettings();
    const results = await this.db.batch([
      this.repo.archivePublishedStatement(id, from),
      this.repo.publishVersionStatement(id, from, actor.userId, now),
      this.repo.setThemePointersStatement(from === "DRAFT" ? null : settings?.draft_version_id ?? null, actor.userId, now),
      this.log.auditStatement(actor.userId, action, "theme", id, { publishedVersionId: previous?.id ?? null }, { publishedVersionId: id }, meta),
    ]);
    if (!(results[1]?.results.length)) throw new ConflictError("The theme changed meanwhile, please reload", "THEME_CHANGED");
    return this.theme(actor, meta);
  }
}

// ==================================================================== helpers

function themeDto(r: ThemeVersionRow): ThemeVersionDto {
  let tokens: ThemeTokens = {};
  try {
    tokens = JSON.parse(r.tokens_json) as ThemeTokens;
  } catch {
    tokens = {};
  }
  return {
    id: r.id,
    versionNumber: r.version_number,
    preset: r.preset as ThemePreset,
    status: r.status,
    tokens,
    note: r.note,
    createdAt: r.created_at,
    publishedAt: r.published_at,
    createdByName: r.created_by_name,
    publishedByName: r.published_by_name,
  };
}

function httpsUrl(v: Validator, key: string): string | null {
  const value = v.string(key, { max: 500 });
  if (value === undefined) return null;
  if (!value.startsWith("https://") || !isSafeLink(value)) v.errors[key] = "INVALID_URL";
  return value;
}

function coordinate(v: Validator, body: Body, key: string, limit: number): number | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) {
    v.errors[key] = "OUT_OF_RANGE";
    return null;
  }
  return value;
}

/** Structured data must be a JSON object and must not be able to close the <script> it will live in. */
function schemaJson(v: Validator, raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") { v.errors.schemaJson = "EXPECTED_STRING"; return null; }
  if (raw.length > MAX_SCHEMA_JSON) { v.errors.schemaJson = "TOO_LONG"; return null; }
  if (/<\/?script|<!--/i.test(raw)) { v.errors.schemaJson = "INVALID_CHARACTERS"; return null; }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { v.errors.schemaJson = "EXPECTED_OBJECT"; return null; }
    return JSON.stringify(parsed);
  } catch {
    v.errors.schemaJson = "INVALID_JSON";
    return null;
  }
}

/** { th: {...}, en: {...} } with per-field max lengths; empty language → null (removed). */
function translationsOf<T extends Record<string, string | null>>(
  v: Validator, raw: unknown, limits: Record<keyof T & string, number>,
): Partial<Record<LocaleCode, T | null>> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { v.errors.translations = "EXPECTED_OBJECT"; return undefined; }
  const out: Partial<Record<LocaleCode, T | null>> = {};
  for (const [lang, value] of Object.entries(raw as Body)) {
    if (!(LOCALE_CODES as readonly string[]).includes(lang)) { v.errors[`translations.${lang}`] = "UNKNOWN_LANGUAGE"; continue; }
    if (value === null) { out[lang as LocaleCode] = null; continue; }
    if (typeof value !== "object" || Array.isArray(value)) { v.errors[`translations.${lang}`] = "EXPECTED_OBJECT"; continue; }
    const inner = new Validator(value as Body).allowOnly(Object.keys(limits));
    const entry: Record<string, string | null> = {};
    for (const [key, max] of Object.entries(limits)) entry[key] = inner.string(key, { max }) ?? null;
    for (const [k, code] of Object.entries(inner.errors)) v.errors[`translations.${lang}.${k}`] = code;
    out[lang as LocaleCode] = Object.values(entry).every((x) => x === null) ? null : (entry as T);
  }
  return out;
}
