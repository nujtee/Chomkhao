import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicSiteDto } from "../../src/shared/api-types.ts";
import type { BookingCtaDto, BrandingDto, MarketingDto, SeoPageDto, ThemeAdminDto, WebsiteSettingsDto } from "../../src/shared/settings-types.ts";
import { PRESET_TOKENS, validateThemeTokens } from "../../src/shared/theme.ts";
import { Harness } from "../helpers/harness.ts";
import { pngBytes } from "../helpers/images.ts";

let seq = 0;
async function staff(h: Harness, perms: string[]) {
  const id = `set_staff_${++seq}`;
  const email = await h.user({ id });
  for (const p of perms) h.grant(id, p);
  return h.login(email);
}

const site = async (h: Harness, lang = "th") => (await h.api<PublicSiteDto>("GET", `/api/public/site?lang=${lang}`)).data;

async function image(h: Harness, token: string, purpose: string) {
  const res = await h.upload<{ id: string; url: string }>(token, { bytes: pngBytes(512, 512), name: "x.png", type: "image/png" }, purpose);
  assert.equal(res.status, 201, JSON.stringify(res));
  return res.data;
}

describe("website settings & branding (spec §36–37)", () => {
  it("changes name, contact and logos without a deploy; logos must be LOGO / FAVICON images", async () => {
    const h = new Harness();          // fresh production-like database: no settings rows yet
    assert.equal((await site(h)).configured, false);
    const web = await staff(h, ["settings.website"]);
    const noName = await h.api("PUT", "/api/admin/settings/website", { token: web, body: { translations: { th: { tagline: "x" } } } });
    assert.equal(noName.error?.details?.["translations.th.siteName"], "REQUIRED");
    const badUrl = await h.api("PUT", "/api/admin/settings/website", { token: web, body: { lineOaUrl: "javascript:alert(1)" } });
    assert.equal(badUrl.error?.details?.lineOaUrl, "INVALID_URL");
    const saved = await h.api<WebsiteSettingsDto>("PUT", "/api/admin/settings/website", {
      token: web,
      body: {
        contactPhone: "081-234-5678", contactEmail: "Hello@Example.com", lineOaUrl: "https://line.me/R/ti/p/@example",
        translations: { th: { siteName: "บ้านทดสอบ", footerText: "ข้อความท้ายเว็บ" }, en: { siteName: "Test House" } },
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.data.contactEmail, "hello@example.com");
    const pub = await site(h, "en");
    assert.equal(pub.configured, true);
    assert.equal(pub.siteName, "Test House");
    assert.equal(pub.footerText, "ข้อความท้ายเว็บ", "falls back to the default language");
    assert.equal(pub.contact.phone, "081-234-5678");

    // Several numbers: each is checked, stored as "a, b".
    const two = await h.api<WebsiteSettingsDto>("PUT", "/api/admin/settings/website", {
      token: web, body: { contactPhone: " 0637951218,0955790679 ", translations: { th: { siteName: "บ้านทดสอบ" } } },
    });
    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.equal(two.data.contactPhone, "0637951218, 0955790679");
    const badOne = await h.api("PUT", "/api/admin/settings/website", {
      token: web, body: { contactPhone: "0637951218, call me", translations: { th: { siteName: "บ้านทดสอบ" } } },
    });
    assert.equal(badOne.error?.details?.contactPhone, "INVALID_FORMAT");
    const tooMany = await h.api("PUT", "/api/admin/settings/website", {
      token: web, body: { contactPhone: "0811111111, 0822222222, 0833333333, 0844444444, 0855555555, 0866666666", translations: { th: { siteName: "บ้านทดสอบ" } } },
    });
    assert.equal(tooMany.error?.details?.contactPhone, "INVALID_FORMAT");
    await h.api("PUT", "/api/admin/settings/website", {
      token: web, body: { contactPhone: "081-234-5678", translations: { th: { siteName: "บ้านทดสอบ", footerText: "ข้อความท้ายเว็บ" }, en: { siteName: "Test House" } } },
    });

    const brand = await staff(h, ["settings.branding"]);
    assert.equal((await h.api("PUT", "/api/admin/settings/branding", { token: web, body: { logoMain: null } })).status, 403);
    const logo = await image(h, brand, "LOGO");
    const icon = await image(h, brand, "FAVICON");
    const wrong = await h.api("PUT", "/api/admin/settings/branding", { token: brand, body: { favicon: logo.id } });
    assert.equal(wrong.error?.details?.favicon, "WRONG_MEDIA_PURPOSE");
    const ok = await h.api<BrandingDto>("PUT", "/api/admin/settings/branding", {
      token: brand, body: { logoMain: logo.id, logoMobile: logo.id, favicon: icon.id, loginLogo: null },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.data.slots.logoMain.url, logo.url);
    const after = await site(h);
    assert.equal(after.logo.main?.url, logo.url);
    assert.equal(after.favicon, icon.url);
    assert.equal(after.loginLogo, null);
    assert.equal(h.audits("UPDATE_BRANDING").length, 1);
  });
});

describe("theme (spec §37–38): draft → preview → publish → rollback", () => {
  it("validates every token, keeps version history and never lets an archived version change", async () => {
    const h = new Harness({ seed: true });
    const designer = await staff(h, ["settings.theme"]);
    const initial = (await site(h)).theme;
    assert.equal(initial?.["--color-primary"], "#2f5d50", "seeded published theme");

    for (const [token, value, code] of [
      ["--color-primary", "red; background:url(https://evil)", "INVALID_COLOR"],
      ["--font-body", "Comic Sans; } body { display:none", "INVALID_FONT"],
      ["--radius-md", "100px", "INVALID_RADIUS"],
      ["--shadow-md", "0 0 0 9999px red", "INVALID_SHADOW"],
      ["--evil", "#000000", "UNKNOWN_TOKEN"],
    ] as const) {
      const res = await h.api("PUT", "/api/admin/theme/draft", { token: designer, body: { preset: "CUSTOM", tokens: { [token]: value } } });
      assert.equal(res.error?.details?.[`tokens.${token}`], code, token);
    }
    for (const preset of Object.values(PRESET_TOKENS)) assert.deepEqual(validateThemeTokens(preset), {}, "every preset is valid");

    const sakura = PRESET_TOKENS.SAKURA;
    const draft = await h.api<ThemeAdminDto>("PUT", "/api/admin/theme/draft", { token: designer, body: { preset: "SAKURA", tokens: sakura, note: "spring" } });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.equal(draft.data.draft?.versionNumber, 2);
    assert.equal((await site(h)).theme?.["--color-primary"], "#2f5d50", "a draft is not live");
    const preview = await h.api<{ tokens: Record<string, string>; isDraft: boolean }>("GET", "/api/admin/theme/preview", { token: designer });
    assert.equal(preview.data.tokens["--color-primary"], sakura["--color-primary"]);
    assert.equal(preview.data.isDraft, true);
    assert.equal((await h.api("GET", "/api/admin/theme/preview")).status, 401, "preview needs an admin session");

    const published = await h.api<ThemeAdminDto>("POST", "/api/admin/theme/publish", { token: designer });
    assert.equal(published.data.published?.versionNumber, 2);
    assert.equal(published.data.draft, null);
    assert.equal((await site(h)).theme?.["--color-primary"], sakura["--color-primary"]);
    assert.equal((await h.api("POST", "/api/admin/theme/publish", { token: designer })).error?.code, "NO_THEME_DRAFT");

    const v1 = published.data.history.find((v) => v.versionNumber === 1)!;
    assert.equal(v1.status, "ARCHIVED");
    assert.throws(() => h.db.run("UPDATE theme_versions SET tokens_json = '{}' WHERE id = ?", v1.id), /THEME_VERSION_IMMUTABLE/);
    assert.throws(() => h.db.run("UPDATE theme_versions SET status = 'PUBLISHED' WHERE id = ?", v1.id), /UNIQUE/, "one published version");

    const rolled = await h.api<ThemeAdminDto>("POST", `/api/admin/theme/versions/${v1.id}/rollback`, { token: designer });
    assert.equal(rolled.data.published?.versionNumber, 1);
    assert.equal((await site(h)).theme?.["--color-primary"], "#2f5d50");
    assert.equal((await h.api("POST", `/api/admin/theme/versions/${v1.id}/rollback`, { token: designer })).error?.code, "THEME_VERSION_NOT_ARCHIVED");
    assert.deepEqual(h.audits("PUBLISH_THEME").length + h.audits("ROLLBACK_THEME").length, 2);

    await h.api("PUT", "/api/admin/theme/draft", { token: designer, body: { preset: "DARK", tokens: PRESET_TOKENS.DARK } });
    const discarded = await h.api<ThemeAdminDto>("DELETE", "/api/admin/theme/draft", { token: designer });
    assert.equal(discarded.data.draft, null);
    const other = await staff(h, ["settings.branding"]);
    assert.equal((await h.api("GET", "/api/admin/theme", { token: other })).status, 403);
  });
});

describe("floating booking button (spec §39)", () => {
  it("is configured in D1 and served with the site settings", async () => {
    const h = new Harness({ seed: true });
    const cta = await staff(h, ["settings.booking_cta"]);
    const current = await h.api<BookingCtaDto>("GET", "/api/admin/settings/booking-cta", { token: cta });
    assert.equal(current.data.labels.en, "Book Now");
    const bad = await h.api("PUT", "/api/admin/settings/booking-cta", { token: cta, body: { ...current.data, pages: ["admin"], color: "red" } });
    assert.equal(bad.error?.details?.pages, "INVALID_VALUE");
    assert.equal(bad.error?.details?.color, "INVALID_FORMAT");
    const saved = await h.api<BookingCtaDto>("PUT", "/api/admin/settings/booking-cta", {
      token: cta, body: { ...current.data, pages: ["home", "gallery"], color: "#AA3355", closeable: true, labels: { en: "Reserve", th: "จองเลย" } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const pub = await site(h, "en");
    assert.equal(pub.bookingCta?.label, "Reserve");
    assert.deepEqual(pub.bookingCta?.pages, ["home", "gallery"]);
    assert.equal(pub.bookingCta?.closeable, true);
    await h.api("PUT", "/api/admin/settings/booking-cta", { token: cta, body: { ...saved.data, enabled: false } });
    assert.equal((await site(h)).bookingCta, null);
  });
});

describe("marketing IDs (spec §43–45)", () => {
  it("stores IDs only; CAPI needs the Cloudflare secret, whose value is never returned", async () => {
    const h = new Harness({ seed: true });
    const viewer = await staff(h, ["marketing.view"]);
    const editor = await staff(h, ["marketing.view", "marketing.edit"]);
    assert.equal((await h.api("PUT", "/api/admin/settings/marketing", { token: viewer, body: {} })).status, 403);
    const badId = await h.api("PUT", "/api/admin/settings/marketing", { token: editor, body: { ga4Enabled: true, ga4MeasurementId: "UA-1234" } });
    assert.equal(badId.error?.details?.ga4MeasurementId, "INVALID_FORMAT");
    const missing = await h.api("PUT", "/api/admin/settings/marketing", { token: editor, body: { metaPixelEnabled: true } });
    assert.equal(missing.error?.details?.metaPixelId, "REQUIRED");
    const token = await h.api("PUT", "/api/admin/settings/marketing", { token: editor, body: { metaCapiEnabled: true, metaPixelId: "123456789012" } });
    assert.equal(token.error?.details?.metaCapiEnabled, "CAPI_TOKEN_MISSING");
    const smuggle = await h.api("PUT", "/api/admin/settings/marketing", { token: editor, body: { metaCapiAccessToken: "EAAB-secret" } });
    assert.equal(smuggle.error?.details?.metaCapiAccessToken, "UNKNOWN_FIELD", "the token can never be sent to D1");

    (h.env as unknown as Record<string, string>).META_CAPI_ACCESS_TOKEN = "EAAB-super-secret-token";
    const ok = await h.api<MarketingDto>("PUT", "/api/admin/settings/marketing", {
      token: editor, body: { ga4Enabled: true, ga4MeasurementId: "g-abc123xyz", metaPixelEnabled: true, metaPixelId: "123456789012", metaCapiEnabled: true },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.data.ga4MeasurementId, "G-ABC123XYZ");
    assert.equal(ok.data.capiTokenConfigured, true);
    assert.doesNotMatch(JSON.stringify(ok.body), /super-secret/);
    const audit = h.audits("UPDATE_MARKETING")[0]!;
    assert.doesNotMatch(`${audit.old_value}${audit.new_value}`, /super-secret/);
    assert.equal(JSON.stringify(h.db.all("SELECT * FROM marketing_settings")).includes("super-secret"), false);
  });
});

describe("SEO settings (spec §42)", () => {
  it("saves per page and language, validates canonical, OG image and structured data", async () => {
    const h = new Harness({ seed: true });
    const seo = await staff(h, ["seo.edit"]);
    const og = await image(h, seo, "OG_IMAGE");
    const bad = await h.api("PUT", "/api/admin/seo/home", {
      token: seo,
      body: { translations: { en: { canonicalUrl: "http://x.example", schemaJson: '{"a":"</script><script>alert(1)</script>"}', robots: "all" } } },
    });
    assert.equal(bad.error?.details?.["translations.en.canonicalUrl"], "INVALID_URL");
    assert.equal(bad.error?.details?.["translations.en.schemaJson"], "INVALID_CHARACTERS");
    assert.equal(bad.error?.details?.["translations.en.robots"], "INVALID_VALUE");
    const notObj = await h.api("PUT", "/api/admin/seo/home", { token: seo, body: { translations: { en: { schemaJson: "[1,2]" } } } });
    assert.equal(notObj.error?.details?.["translations.en.schemaJson"], "EXPECTED_OBJECT");
    assert.equal((await h.api("PUT", "/api/admin/seo/admin", { token: seo, body: { translations: {} } })).status, 404);

    const saved = await h.api<SeoPageDto[]>("PUT", "/api/admin/seo/gallery", {
      token: seo,
      body: { translations: { en: {
        seoTitle: "Gallery", metaDescription: "Photos", canonicalUrl: "https://example.com/en/gallery", ogImageAssetId: og.id,
        robots: "index,follow", schemaJson: '{"@context":"https://schema.org","@type":"ImageGallery"}',
      } } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const gallery = saved.data.find((p) => p.pageKey === "gallery")!;
    assert.equal(gallery.translations.en?.ogImageUrl, og.url);
    assert.equal(saved.data.find((p) => p.pageKey === "home")?.translations.th?.seoTitle, "Phasakura (ตัวอย่าง)");
    const viewer = await staff(h, ["content.view"]);
    assert.equal((await h.api("GET", "/api/admin/seo", { token: viewer })).status, 200);
    assert.equal((await h.api("PUT", "/api/admin/seo/home", { token: viewer, body: { translations: {} } })).status, 403);
  });
});
