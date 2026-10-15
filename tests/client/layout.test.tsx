import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicSiteDto } from "../../src/shared/api-types.ts";
import { getLocale, type LocaleCode } from "../../src/shared/i18n/index.ts";
import type { PublicPage } from "../../src/shared/routes.ts";
import { Footer } from "../../src/client/components/Footer.tsx";
import { Header } from "../../src/client/components/Header.tsx";
import { I18nProvider } from "../../src/client/i18n/I18nProvider.tsx";
import { RouterProvider } from "../../src/client/router/Router.tsx";
import { SiteContext } from "../../src/client/site/SiteProvider.tsx";

function site(overrides: Partial<PublicSiteDto> = {}): PublicSiteDto {
  return {
    configured: true,
    language: "th",
    defaultLanguage: "th",
    languages: ["th", "en", "zh-CN"],
    siteName: "Site From D1",
    tagline: "Tagline From D1",
    logo: {
      main: { url: "/media/branding/main.webp", alt: "Site From D1", width: 240, height: 80 },
      mobile: { url: "/media/branding/mobile.webp", alt: "Site From D1", width: 80, height: 80 },
    },
    theme: null,
    favicon: null,
    loginLogo: null,
    contact: { phone: null, email: null, lineOaUrl: null, mapUrl: null, address: null, coordinates: null },
    footerText: null,
    bookingCta: null,
    lineButton: null,
    tracking: { ga4MeasurementId: null, metaPixelId: null },
    consent: { enabled: false, version: 1, days: 180, text: null, policyPath: null },
    fonts: [],
    ...overrides,
  };
}

function render(
  node: "header" | "footer",
  opts: { lang?: LocaleCode; page?: PublicPage | null; site?: PublicSiteDto | null; path?: string } = {},
) {
  const locale = getLocale(opts.lang ?? "th");
  const page = opts.page === undefined ? "home" : opts.page;
  const value =
    opts.site === null
      ? { status: "loading" as const, site: null, retry: () => {}, preview: false, exitPreview: () => {} }
      : { status: "ready" as const, site: opts.site ?? site(), retry: () => {}, preview: false, exitPreview: () => {} };
  return renderToStaticMarkup(
    <RouterProvider initialPath={opts.path ?? `/${locale.path}/`}>
      <I18nProvider locale={locale}>
        <SiteContext.Provider value={value}>
          {node === "header" ? <Header currentPage={page} /> : <Footer currentPage={page} />}
        </SiteContext.Provider>
      </I18nProvider>
    </RouterProvider>,
  );
}

describe("Header", () => {
  it("renders the main menu in spec order with localized paths (TH)", () => {
    const html = render("header");
    const order = ["หน้าหลัก", "คลังภาพ", "จองที่พัก", "เกี่ยวกับเรา"].map((label) => html.indexOf(`>${label}</a>`));
    assert.ok(order.every((i) => i > -1), "all menu labels present");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "menu order");
    for (const href of ["/th/", "/th/gallery", "/th/booking", "/th/history"]) {
      assert.ok(html.includes(`href="${href}"`), href);
    }
  });

  it("renders EN and ZH-CN labels and paths", () => {
    const enHtml = render("header", { lang: "en" });
    assert.ok(enHtml.includes('href="/en/booking"'));
    assert.ok(enHtml.includes(">Booking</a>"));
    const zhHtml = render("header", { lang: "zh-CN" });
    assert.ok(zhHtml.includes('href="/zh-cn/booking"'));
    assert.ok(zhHtml.includes(">立即预订</a>"));
  });

  it("marks the current page with aria-current", () => {
    const html = render("header", { page: "gallery" });
    assert.match(html, /href="\/th\/gallery"[^>]*aria-current="page"/);
  });

  it("uses the logo from the API (D1/R2) with a mobile source", () => {
    const html = render("header");
    assert.ok(html.includes('src="/media/branding/main.webp"'));
    assert.ok(html.includes('alt="Site From D1"'));
    assert.match(html, /<source media="\(max-width: 767px\)" srcSet="\/media\/branding\/mobile.webp"/i);
  });

  it("falls back to the site name when no logo is uploaded", () => {
    const html = render("header", { site: site({ logo: { main: null, mobile: null } }) });
    assert.ok(html.includes('class="brand__name">Site From D1<'));
  });

  it("shows a neutral placeholder (no hard-coded brand) while unconfigured", () => {
    const html = render("header", { site: null });
    assert.ok(html.includes("brand__placeholder"));
    assert.ok(html.includes('aria-label="กลับหน้าแรก"'), "home link still has an accessible name");
    assert.ok(!html.includes("<img"));
  });

  it("has an accessible hamburger button controlling a hidden menu", () => {
    const html = render("header");
    const button = /<button[^>]*class="menu-toggle"[^>]*>/.exec(html)?.[0] ?? "";
    assert.match(button, /aria-expanded="false"/);
    assert.match(button, /aria-label="เปิดเมนู"/);
    const controls = /aria-controls="([^"]+)"/.exec(button)?.[1];
    assert.ok(controls);
    assert.match(html, new RegExp(`<div id="${controls}"[^>]*hidden=""`));
  });

  it("language switcher keeps deep paths such as accommodation details", () => {
    const html = render("header", { page: "booking", lang: "th", path: "/th/accommodation/house-sakura" });
    assert.ok(html.includes('href="/zh-cn/accommodation/house-sakura"'));
    assert.ok(html.includes('href="/en/accommodation/house-sakura"'));
  });

  it("language switcher links to the same page in every language", () => {
    const html = render("header", { page: "history", lang: "en", path: "/en/history" });
    for (const [href, lang] of [
      ["/th/history", "th"],
      ["/en/history", "en"],
      ["/zh-cn/history", "zh-CN"],
    ]) {
      assert.match(html, new RegExp(`href="${href}"[^>]*lang="${lang}"[^>]*hrefLang="${lang}"`, "i"));
    }
    assert.match(html, /href="\/en\/history"[^>]*aria-current="true"/);
  });
});

describe("Footer", () => {
  it("renders site name and tagline from the API", () => {
    const html = render("footer");
    assert.ok(html.includes("Site From D1"));
    assert.ok(html.includes("Tagline From D1"));
    assert.ok(html.includes("สงวนลิขสิทธิ์"));
  });

  it("renders no brand text when unconfigured", () => {
    const html = render("footer", { site: null });
    assert.ok(!html.includes("site-footer__name"));
    assert.ok(html.includes('href="/th/gallery"'));
  });

  it("escapes content coming from the database (XSS)", () => {
    const html = render("footer", { site: site({ siteName: '<img src=x onerror="alert(1)">', tagline: null }) });
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;img src=x"));
  });
});

describe("Floating booking button and footer contact (Phase 9)", () => {
  const cta = {
    enabled: true, showOnDesktop: true, showOnMobile: true, desktopPosition: "BOTTOM_RIGHT" as const, mobilePosition: "BOTTOM_BAR" as const,
    size: "MD" as const, icon: "calendar" as const, color: "#aa3355", animation: "NONE" as const, closeable: false,
    pages: ["*" as const], label: "Book Now",
  };

  async function renderCta(page: "home" | "booking" | "gallery", pages: string[] = ["*"]) {
    const { FloatingBookingCta } = await import("../../src/client/components/FloatingBookingCta.tsx");
    const locale = getLocale("en");
    const value = { status: "ready" as const, site: site({ bookingCta: { ...cta, pages: pages as never } }), retry: () => {}, preview: false, exitPreview: () => {} };
    return renderToStaticMarkup(
      <RouterProvider initialPath="/en/">
        <I18nProvider locale={locale}>
          <SiteContext.Provider value={value}><FloatingBookingCta page={page} /></SiteContext.Provider>
        </I18nProvider>
      </RouterProvider>,
    );
  }

  it("links to the booking page in the visitor's language, with the label from D1", async () => {
    const html = await renderCta("home");
    assert.ok(html.includes('href="/en/booking"'));
    assert.ok(html.includes("Book Now"));
    assert.ok(html.includes("cta--m-bottom_bar"));
  });

  it("is never shown on the booking page and respects the page list", async () => {
    assert.equal(await renderCta("booking"), "");
    assert.equal(await renderCta("gallery", ["home"]), "");
    assert.notEqual(await renderCta("home", ["home"]), "");
  });

  it("footer shows contact details and footer text from D1", () => {
    const html = render("footer", { site: site({
      footerText: "Footer from D1",
      contact: { phone: "081-234-5678", email: "hi@example.com", lineOaUrl: "https://line.me/R/ti/p/@x", mapUrl: null, address: "Mountain road", coordinates: null },
    }) });
    assert.ok(html.includes("Footer from D1"));
    assert.ok(html.includes('href="tel:0812345678"'));
    assert.ok(html.includes('href="mailto:hi@example.com"'));
    assert.ok(html.includes('rel="noopener noreferrer"'));
    // Phone and e-mail on one line.
    assert.match(html, /<p class="site-footer__reach"><span>โทร: <a href="tel:0812345678">081-234-5678<\/a><\/span><span>อีเมล: <a href="mailto:hi@example.com">/);
    assert.ok(!html.includes("footer-map"), "no map without a map link or coordinates");
  });

  it("footer map: the link with a small map of the place (site's own tile URLs, attribution), or just the link", () => {
    const contact = { phone: null, email: null, lineOaUrl: null, address: null };
    const withMap = render("footer", { site: site({ contact: { ...contact, mapUrl: "https://maps.app.goo.gl/abc", coordinates: { latitude: 18.6139152, longitude: 98.5062681 } } }) });
    const link = /<a class="footer-map__link" href="https:\/\/maps.app.goo.gl\/abc" rel="noopener noreferrer" target="_blank"><span class="footer-map__label">แผนที่<\/span>/;
    assert.match(withMap, link);
    const tiles = [...withMap.matchAll(/<img src="(\/map-tiles\/15\/\d+\/\d+\.png)" alt="" width="256" height="256" loading="lazy"/g)].map((m) => m[1]);
    assert.ok(tiles.length >= 1 && tiles.length <= 6, `tiles: ${tiles.join(", ")}`);
    assert.ok(tiles.includes("/map-tiles/15/25350/14659.png"), "the tile that holds the place");
    assert.match(withMap, /© <a href="https:\/\/www.openstreetmap.org\/copyright"/);
    assert.ok(!/https?:\/\/tile\./.test(withMap), "no third-party tile server in the page");

    const linkOnly = render("footer", { site: site({ contact: { ...contact, mapUrl: "https://maps.app.goo.gl/abc", coordinates: null } }) });
    assert.match(linkOnly, /<p><a href="https:\/\/maps.app.goo.gl\/abc" rel="noopener noreferrer" target="_blank">แผนที่<\/a><\/p>/);
    assert.ok(!linkOnly.includes("map-tiles"));

    const coordsOnly = render("footer", { site: site({ contact: { ...contact, mapUrl: null, coordinates: { latitude: 18.6139152, longitude: 98.5062681 } } }) });
    assert.match(coordsOnly, /href="https:\/\/www.openstreetmap.org\/\?mlat=18.613915&amp;mlon=98.506268#map=16\/18.613915\/98.506268"/);
  });
});

describe("Floating LINE button (Phase 11)", () => {
  async function renderLine(page: "home" | "booking" | "bookingLookup", url: string | null, code: LocaleCode = "th") {
    const { LineButton } = await import("../../src/client/components/LineButton.tsx");
    const value = { status: "ready" as const, site: site({ lineButton: url ? { url } : null }), retry: () => {}, preview: false, exitPreview: () => {} };
    return renderToStaticMarkup(
      <RouterProvider initialPath={`/${getLocale(code).path}/`}>
        <I18nProvider locale={getLocale(code)}>
          <SiteContext.Provider value={value}><LineButton page={page} /></SiteContext.Provider>
        </I18nProvider>
      </RouterProvider>,
    );
  }

  it("opens the Official Account in a new tab with a localised accessible name", async () => {
    const html = await renderLine("home", "https://line.me/R/ti/p/@phasakura");
    assert.ok(html.includes('href="https://line.me/R/ti/p/@phasakura"'));
    assert.ok(html.includes('rel="noopener noreferrer"'));
    assert.ok(html.includes('aria-label="แชตกับเราทาง LINE"'));
    assert.ok((await renderLine("home", "https://lin.ee/x", "zh-CN")).includes('aria-label="通过 LINE 联系我们"'));
  });

  it("is hidden when off, on the booking pages, and for a non-https link", async () => {
    assert.equal(await renderLine("home", null), "");
    assert.equal(await renderLine("booking", "https://lin.ee/x"), "");
    assert.equal(await renderLine("bookingLookup", "https://lin.ee/x"), "");
    assert.equal(await renderLine("home", "javascript:alert(1)"), "");
  });
});
