import type { PublicSiteDto } from "../../shared/api-types.ts";
import { splitPhones } from "../../shared/phones.ts";
import type { PublicUnitDto } from "../../shared/accommodation-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import { getMessages } from "../../shared/i18n/index.ts";
import { DEFAULT_LOCALE, LOCALES, type Locale, type LocaleCode } from "../../shared/i18n/locales.ts";
import { getSeoMessages } from "../../shared/i18n/seo-messages.ts";
import { accommodationPath, bookingLookupPath, pagePath, privacyPath, PUBLIC_PAGES, type PublicPage, type ResolvedRoute } from "../../shared/routes.ts";
import type { PublicPrivacyDto } from "../../shared/settings-types.ts";
import { HREFLANG, OG_LOCALE, type MetaImageDto, type PageMetaDto, type RobotsDirective } from "../../shared/seo-types.ts";
import { HttpError } from "../http/errors.ts";
import type { SeoRepository, SeoRow } from "../repositories/seo.repository.ts";
import type { AccommodationService } from "./accommodation.service.ts";
import { publicMediaUrl } from "./media-url.ts";
import type { PublicContentService } from "./public-content.service.ts";
import type { SiteService } from "./site.service.ts";

export type MetaRoute = Extract<ResolvedRoute, { kind: "page" | "notFound" }>;

const ROBOTS = new Set<RobotsDirective>(["index,follow", "noindex,follow", "index,nofollow", "noindex,nofollow"]);
const DESCRIPTION_MAX = 160;
const SITEMAP_IMAGES_PER_URL = 50;

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
}

function clean(text: string | null | undefined, max = DESCRIPTION_MAX): string | null {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Drops null / undefined / empty arrays so JSON-LD stays minimal and valid. */
function compact<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)));
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function w3cDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const latest = (...dates: (string | null | undefined)[]) => dates.filter((d): d is string => !!d).sort().at(-1) ?? null;

/**
 * Page metadata, sitemap and robots (spec §42, Phase 13).
 * Visibility comes from the content services (published / active only); this service only
 * describes what they return. Admin texts (Website → SEO) win over generated defaults.
 */
export class SeoService {
  constructor(
    private readonly repo: SeoRepository,
    private readonly site: SiteService,
    private readonly accommodation: AccommodationService,
    private readonly content: PublicContentService,
    /** Absolute site origin (APP_BASE_URL, else the request origin). */
    private readonly baseUrl: string,
    private readonly mediaBaseUrl: string | undefined,
    /** Non-production deployments are never indexed. */
    private readonly production: boolean,
    /** Privacy policy text (Phase 14): the page exists only when it has text. */
    private readonly privacyPolicy: ((locale: Locale) => Promise<PublicPrivacyDto>) | null = null,
  ) {}

  private abs(url: string | null | undefined): string | null {
    if (!url) return null;
    return /^https?:\/\//.test(url) ? url : `${this.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  private mediaImage(key: string | null, width: number | null, height: number | null, alt: string): MetaImageDto | null {
    const url = this.abs(publicMediaUrl(key, this.mediaBaseUrl));
    return url ? { url, width, height, alt } : null;
  }

  private image(i: { url: string; width: number | null; height: number | null; alt?: string | null } | null | undefined, alt: string): MetaImageDto | null {
    const url = i ? this.abs(i.url) : null;
    return url && i ? { url, width: i.width, height: i.height, alt: i.alt || alt } : null;
  }

  /** Metadata for a public page route (also unknown pages and accommodation slugs → 404). */
  async meta(route: MetaRoute, path: string): Promise<PageMetaDto> {
    const locale = route.locale;
    const lang = locale.code;
    const t = getMessages(lang);
    const sm = getSeoMessages(lang).description;
    const [site, extras] = await Promise.all([this.site.getPublicSite(locale), this.repo.extras()]);
    const siteName = site.siteName;
    const withSite = (title: string) => [title, siteName].filter(Boolean).join(" | ");
    const base = {
      lang,
      googleSiteVerification: extras.gsc,
      favicon: site.favicon ? this.abs(site.favicon) : null,
    };

    let page = route.kind === "page" ? route.page : null;
    const policy = page === "privacy" && this.privacyPolicy ? await this.privacyPolicy(locale) : null;
    if (page === "privacy" && !policy?.body) page = null;
    let unit: PublicUnitDto | null = null;
    if (page === "accommodation" && route.kind === "page") {
      unit = await this.accommodation.publicBySlug(route.slug!, locale).catch((e: unknown) => {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      });
    }

    // Not indexed at all: unknown pages, unknown / inactive accommodation, the private booking lookup.
    if (!page || (page === "accommodation" && !unit) || page === "bookingLookup") {
      const notFound = page !== "bookingLookup";
      const title = withSite(notFound ? t.pages.notFound.title : t.pages.bookingLookup.title);
      const description = notFound ? sm.notFound : sm.bookingLookup;
      return {
        ...base, path, status: notFound ? 404 : 200, title, description, canonical: null, robots: "noindex,nofollow", alternates: [],
        og: { type: "website", title, description, url: null, siteName, locale: OG_LOCALE[lang], localeAlternates: [], image: null },
        jsonLd: [],
      };
    }

    const pageKey: PublicPage | null = (PUBLIC_PAGES as readonly string[]).includes(page) ? (page as PublicPage) : null;
    const rows = pageKey ? await this.repo.page(pageKey) : [];
    const row: SeoRow | undefined = rows.find((r) => r.language_code === lang);
    const thRow: SeoRow | undefined = rows.find((r) => r.language_code === DEFAULT_LOCALE.code);
    const pathFor = (l: Locale) => (unit ? accommodationPath(l, unit.slug) : page === "privacy" ? privacyPath(l) : pagePath(l, pageKey!));
    const ownUrl = `${this.baseUrl}${pathFor(locale)}`;

    const pageRobots = (r: SeoRow | undefined): RobotsDirective => (r && ROBOTS.has(r.robots as RobotsDirective) ? (r.robots as RobotsDirective) : "index,follow");
    const indexable = pageRobots(row).startsWith("index");
    const robots: RobotsDirective = this.production ? pageRobots(row) : "noindex,nofollow";
    const canonical = indexable ? (row?.canonical_url ?? ownUrl) : null;
    // hreflang only between indexable language versions (each must point back).
    const alternates = indexable
      ? [
          ...LOCALES.filter((l) => pageRobots(rows.find((r) => r.language_code === l.code)).startsWith("index"))
            .map((l) => ({ hreflang: HREFLANG[l.code], href: `${this.baseUrl}${pathFor(l)}` })),
          ...(pageRobots(thRow).startsWith("index") ? [{ hreflang: "x-default", href: `${this.baseUrl}${pathFor(DEFAULT_LOCALE)}` }] : []),
        ]
      : [];

    let title: string;
    let description: string | null;
    let fallbackImage: MetaImageDto | null = null;
    const jsonLd: Record<string, unknown>[] = [];
    const homeUrl = `${this.baseUrl}${pagePath(locale, "home")}`;
    const crumbs = (items: { name: string; url: string }[]) => ({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: items.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.url })),
    });

    if (unit) {
      title = withSite(unit.seoTitle ?? unit.name);
      description = clean(unit.seoDescription) ?? clean(unit.shortDescription) ?? clean(fill(sm.accommodation, {
        name: unit.name, site: siteName ?? "", guests: unit.maxGuests, price: formatBaht(unit.priceSatang, lang),
      }));
      const images = [unit.cover, ...unit.images].filter(Boolean) as NonNullable<PublicUnitDto["cover"]>[];
      fallbackImage = this.image(images[0], unit.name);
      jsonLd.push(crumbs([
        { name: t.nav.home, url: homeUrl },
        { name: t.nav.booking, url: `${this.baseUrl}${pagePath(locale, "booking")}` },
        { name: unit.name, url: ownUrl },
      ]));
      jsonLd.push(compact({
        "@context": "https://schema.org",
        "@type": "Accommodation",
        "@id": `${ownUrl}#accommodation`,
        name: unit.name,
        description,
        url: ownUrl,
        image: [...new Set(images.map((i) => this.abs(i.url)).filter((u): u is string => !!u))].slice(0, 10),
        occupancy: { "@type": "QuantitativeValue", maxValue: unit.maxGuests },
        amenityFeature: unit.amenities.map((a) => ({ "@type": "LocationFeatureSpecification", name: a.name, value: true })),
        containedInPlace: siteName ? { "@type": "LodgingBusiness", "@id": `${this.baseUrl}/#lodging`, name: siteName, url: homeUrl } : null,
      }));
    } else if (page === "privacy" && policy) {
      const pageTitle = policy.title ?? t.pages.privacy.title;
      title = withSite(pageTitle);
      description = clean(policy.body?.split(/\n\s*\n/)[0]);
      jsonLd.push(crumbs([{ name: t.nav.home, url: homeUrl }, { name: pageTitle, url: ownUrl }]));
      jsonLd.push(compact({ "@context": "https://schema.org", "@type": "WebPage", name: title, url: ownUrl, inLanguage: HREFLANG[lang] }));
    } else if (pageKey === "home") {
      title = siteName ? (site.tagline ? `${siteName} | ${site.tagline}` : siteName) : t.pages.home.title;
      description = siteName ? clean(fill(sm.home, { site: siteName })) : clean(site.tagline);
      const home = await this.content.home(lang);
      const slide = home.slides[0]?.desktop ?? home.sections.find((s) => s.image)?.image ?? null;
      fallbackImage = this.image(slide, title);
      if (siteName) jsonLd.push(await this.lodging(site, locale, homeUrl, description, extras));
    } else {
      const pageTitle = t.pages[pageKey!].title;
      title = withSite(pageTitle);
      description = siteName ? clean(fill(sm[pageKey!], { site: siteName })) : null;
      if (pageKey === "gallery") {
        const g = await this.content.gallery(lang);
        fallbackImage = this.image(g.images[0]?.image, pageTitle);
      } else if (pageKey === "history") {
        const h = await this.content.history(lang);
        fallbackImage = this.image(h.sections.find((s) => s.image)?.image ?? h.timeline.find((i) => i.image)?.image, pageTitle);
      } else if (pageKey === "booking") {
        const list = await this.accommodation.publicList(locale);
        fallbackImage = this.image([...list.houses, ...list.vipTents].find((u) => u.cover)?.cover, pageTitle);
      }
      jsonLd.push(crumbs([{ name: t.nav.home, url: homeUrl }, { name: pageTitle, url: ownUrl }]));
      const pageType = pageKey === "gallery" ? "CollectionPage" : pageKey === "history" ? "AboutPage" : "WebPage";
      jsonLd.push(compact({
        "@context": "https://schema.org", "@type": pageType, name: title, description, url: ownUrl, inLanguage: HREFLANG[lang],
        isPartOf: siteName ? { "@type": "WebSite", "@id": `${this.baseUrl}/#website`, name: siteName, url: homeUrl } : null,
      }));
    }

    title = clean(row?.seo_title, 120) ?? title;
    description = clean(row?.meta_description, 300) ?? description;
    const ogImage = this.mediaImage(row?.og_key ?? null, row?.og_width ?? null, row?.og_height ?? null, title)
      ?? this.mediaImage(thRow?.og_key ?? null, thRow?.og_width ?? null, thRow?.og_height ?? null, title)
      ?? fallbackImage
      ?? this.image(site.logo.main, siteName ?? title);

    // The administrator's own structured data for this page and language (validated on save).
    if (row?.schema_json) {
      try {
        const custom = JSON.parse(row.schema_json) as unknown;
        if (custom && typeof custom === "object" && !Array.isArray(custom)) jsonLd.push(custom as Record<string, unknown>);
      } catch {
        // stored JSON is validated on save; ignore anything unreadable
      }
    }

    return {
      ...base,
      path,
      status: 200,
      title,
      description,
      canonical,
      robots,
      alternates,
      og: {
        type: "website",
        title: clean(row?.og_title, 120) ?? title,
        description: clean(row?.og_description, 300) ?? description,
        url: canonical,
        siteName,
        locale: OG_LOCALE[lang],
        localeAlternates: alternates.filter((a) => a.hreflang !== "x-default" && a.hreflang !== HREFLANG[lang])
          .map((a) => OG_LOCALE[(Object.keys(HREFLANG) as LocaleCode[]).find((c) => HREFLANG[c] === a.hreflang)!]),
        image: ogImage,
      },
      jsonLd,
    };
  }

  /** WebSite + LodgingBusiness for the home page (contact details, map, price range from live prices). */
  private async lodging(site: PublicSiteDto, locale: Locale, homeUrl: string, description: string | null,
    extras: { latitude: number | null; longitude: number | null }): Promise<Record<string, unknown>> {
    const list = await this.accommodation.publicList(locale);
    const prices = [...list.houses, ...list.vipTents].map((u) => u.priceSatang)
      .concat(list.camping.enabled ? [list.camping.pricePerAdultNightSatang] : []).filter((p) => p > 0);
    const min = prices.length ? Math.min(...prices) : null;
    const max = prices.length ? Math.max(...prices) : null;
    const lang = locale.code;
    return {
      "@context": "https://schema.org",
      "@graph": [
        compact({ "@type": "WebSite", "@id": `${this.baseUrl}/#website`, name: site.siteName, url: homeUrl, inLanguage: HREFLANG[lang] }),
        compact({
          "@type": "LodgingBusiness",
          "@id": `${this.baseUrl}/#lodging`,
          name: site.siteName,
          description,
          url: homeUrl,
          logo: this.abs(site.logo.main?.url),
          image: this.abs(site.logo.main?.url),
          telephone: splitPhones(site.contact.phone)[0] ?? null, // Google takes one number: the first
          email: site.contact.email,
          address: site.contact.address ? { "@type": "PostalAddress", streetAddress: site.contact.address } : null,
          geo: extras.latitude !== null && extras.longitude !== null
            ? { "@type": "GeoCoordinates", latitude: extras.latitude, longitude: extras.longitude } : null,
          hasMap: site.contact.mapUrl,
          sameAs: site.contact.lineOaUrl ? [site.contact.lineOaUrl] : null,
          priceRange: min !== null && max !== null
            ? (min === max ? formatBaht(min, lang) : `${formatBaht(min, lang)} – ${formatBaht(max, lang)}`) : null,
          availableLanguage: LOCALES.map((l) => HREFLANG[l.code]),
        }),
      ],
    };
  }

  /** robots.txt: private areas excluded; a non-production deployment blocks everything. */
  robotsTxt(): string {
    if (!this.production) {
      return ["# Not the production site: nothing here should be indexed.", "User-agent: *", "Disallow: /", ""].join("\n");
    }
    const lines = ["User-agent: *", "Disallow: /api/", "Disallow: /admin"];
    for (const l of LOCALES) lines.push(`Disallow: /${l.path}/admin`);
    for (const l of LOCALES) lines.push(`Disallow: ${bookingLookupPath(l)}`);
    lines.push("Disallow: /customer", "Disallow: /payment", "", `Sitemap: ${this.baseUrl}/sitemap.xml`, "");
    return lines.join("\n");
  }

  /**
   * sitemap.xml: every indexable public page in every language with hreflang alternates,
   * last change and its public images (spec §42, §56). Private pages are never listed.
   */
  async sitemapXml(): Promise<string> {
    const th = DEFAULT_LOCALE;
    const [robots, pageDates, unitDates, seoDates, list, home, gallery, history] = await Promise.all([
      this.repo.robots(), this.repo.pageDates(), this.repo.unitDates(), this.repo.seoDates(),
      this.accommodation.publicList(th), this.content.home(th.code), this.content.gallery(th.code), this.content.history(th.code),
    ]);
    const rule = (page: string, lang: string) => robots.find((r) => r.page_key === page && r.language_code === lang);
    const listed = (page: PublicPage, l: Locale) => {
      const r = rule(page, l.code);
      if (r && !String(r.robots).startsWith("index")) return false;
      // A page whose canonical points elsewhere is represented by that other URL.
      return !r?.canonical_url || r.canonical_url === `${this.baseUrl}${pagePath(l, page)}`;
    };
    const imgs = (urls: (string | null | undefined)[]) => [...new Set(urls.map((u) => this.abs(u)).filter((u): u is string => !!u))]
      .slice(0, SITEMAP_IMAGES_PER_URL);

    const entries: string[] = [];
    const add = (pathFor: (l: Locale) => string, include: (l: Locale) => boolean, lastmod: string | null, images: string[]) => {
      const langs = LOCALES.filter(include);
      const links = [
        ...langs.map((l) => `    <xhtml:link rel="alternate" hreflang="${HREFLANG[l.code]}" href="${xml(`${this.baseUrl}${pathFor(l)}`)}"/>`),
        ...(langs.some((l) => l.code === th.code) ? [`    <xhtml:link rel="alternate" hreflang="x-default" href="${xml(`${this.baseUrl}${pathFor(th)}`)}"/>`] : []),
      ];
      for (const l of langs) {
        entries.push([
          "  <url>",
          `    <loc>${xml(`${this.baseUrl}${pathFor(l)}`)}</loc>`,
          ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
          ...links,
          ...images.map((u) => `    <image:image><image:loc>${xml(u)}</image:loc></image:image>`),
          "  </url>",
        ].join("\n"));
      }
    };

    const units = [...list.houses, ...list.vipTents];
    const pageImages: Record<PublicPage, string[]> = {
      home: imgs([...home.slides.map((s) => s.desktop.url), ...home.sections.map((s) => s.image?.url)]),
      gallery: imgs(gallery.images.map((g) => g.image.url)),
      booking: imgs([...units.map((u) => u.cover?.url), list.camping.cover?.url]),
      history: imgs([...history.sections.map((s) => s.image?.url), ...history.timeline.map((i) => i.image?.url)]),
    };
    for (const page of PUBLIC_PAGES) {
      add((l) => pagePath(l, page), (l) => listed(page, l), w3cDate(latest(pageDates[page], seoDates.get(page))), pageImages[page]);
    }
    for (const u of units) {
      add((l) => accommodationPath(l, u.slug), () => true, w3cDate(unitDates.get(u.slug)),
        imgs([u.cover?.url, ...u.images.map((i) => i.url)]));
    }
    const policy = this.privacyPolicy ? await this.privacyPolicy(th) : null;
    if (policy?.body) add((l) => privacyPath(l), () => true, w3cDate(policy.updatedAt), []);
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
      ...entries,
      "</urlset>",
      "",
    ].join("\n");
  }

  /** Website → SEO → Redirects (exact path). Counting a hit never blocks the redirect. */
  async redirectFor(path: string): Promise<{ to: string; status: number } | null> {
    const r = await this.repo.redirect(path);
    if (!r) return null;
    await this.repo.countRedirectHit(r.id).catch(() => undefined);
    return { to: r.to_path, status: r.status_code };
  }
}
