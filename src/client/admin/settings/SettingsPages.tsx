import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { BookingSettingsDto } from "../../../shared/dashboard-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { LOCALES, type LocaleCode } from "../../../shared/i18n/locales.ts";
import {
  BRANDING_SLOTS, CTA_ICONS, CTA_PAGES, ROBOTS_VALUES, SEO_PAGE_KEYS,
  type BookingCtaDto, type BrandingDto, type BrandingSlot, type MarketingDto, type SeoEntryDto, type SeoPageDto, type SeoPageKey,
  type WebsiteSettingsDto,
} from "../../../shared/settings-types.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { CmsManager, ImageField, LangTabs, PageTabs } from "../cms/CmsKit.tsx";
import { CtaButton } from "../../components/FloatingBookingCta.tsx";
import { Alert, Button, detailMessage, Field, fieldErrors } from "../ui.tsx";
import { SearchEnginesCard, SiteSearchCard, TranslationCoverageCard } from "./SeoExtras.tsx";
import { CapiPanel } from "./PrivacySettingsPage.tsx";

type Msg = { kind: "error" | "success"; text: string } | null;

/** Load-once + save helper shared by the settings pages. */
function useSettings<T>(path: string) {
  const { t } = useAdmin();
  const [data, setData] = useState<T | null>(null);
  const [message, setMessage] = useState<Msg>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    apiGet<T>(path, controller.signal).then(setData)
      .catch((err: unknown) => !controller.signal.aborted && setMessage({ kind: "error", text: detailMessage(t, err) }));
    return () => controller.abort();
  }, [path, t]);
  async function save(body: unknown, method: "PUT" | "POST" = "PUT", savePath = path): Promise<T | null> {
    setBusy(true);
    setErrors({});
    setMessage(null);
    try {
      const saved = await apiRequest<T>(method, savePath, body);
      setData(saved);
      setMessage({ kind: "success", text: t.common.saved });
      return saved;
    } catch (err) {
      setErrors(fieldErrors(t, err));
      setMessage({ kind: "error", text: detailMessage(t, err) });
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { data, setData, message, setMessage, errors, busy, save };
}

function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="adm-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Select({ label, value, options, onChange, error, disabled }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; error?: string; disabled?: boolean;
}) {
  const id = `sel-${label.replace(/\W+/g, "-")}`;
  return (
    <div className="adm-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error && <p className="adm-field__error">{error}</p>}
    </div>
  );
}

// ==================================================================== website (spec §37) + booking rules

export function WebsiteSettingsPage() {
  const { t, c, can } = useAdmin();
  const s = useSettings<WebsiteSettingsDto>("/api/admin/settings/website");
  const rules = useSettings<BookingSettingsDto>("/api/admin/booking-settings");
  const [lang, setLang] = useState<LocaleCode>("th");
  const [form, setForm] = useState<Record<string, string>>({});
  const [texts, setTexts] = useState<Partial<Record<LocaleCode, Record<string, string>>>>({});
  const [ruleForm, setRuleForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!s.data) return;
    const d = s.data;
    setForm({
      contactPhone: d.contactPhone ?? "", contactEmail: d.contactEmail ?? "", lineOaUrl: d.lineOaUrl ?? "", mapUrl: d.mapUrl ?? "",
      latitude: d.latitude?.toString() ?? "", longitude: d.longitude?.toString() ?? "",
    });
    setTexts(Object.fromEntries(LOCALES.map((l) => [l.code, {
      siteName: d.translations[l.code]?.siteName ?? "", tagline: d.translations[l.code]?.tagline ?? "",
      address: d.translations[l.code]?.address ?? "", footerText: d.translations[l.code]?.footerText ?? "",
    }])));
  }, [s.data]);
  useEffect(() => {
    if (rules.data) setRuleForm(Object.fromEntries(Object.entries(rules.data).filter(([k]) => k !== "updatedAt").map(([k, v]) => [k, String(v)])));
  }, [rules.data]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    void s.save({
      contactPhone: form.contactPhone || null, contactEmail: form.contactEmail || null, lineOaUrl: form.lineOaUrl || null,
      mapUrl: form.mapUrl || null, latitude: num(form.latitude ?? ""), longitude: num(form.longitude ?? ""),
      translations: Object.fromEntries(LOCALES.map((l) => {
        const tr = texts[l.code] ?? {};
        const empty = Object.values(tr).every((v) => !v.trim());
        return [l.code, empty ? null : Object.fromEntries(Object.entries(tr).map(([k, v]) => [k, v.trim() || null]))];
      })),
    });
  };
  const tr = texts[lang] ?? {};
  const setTr = (key: string, value: string) => setTexts((all) => ({ ...all, [lang]: { ...(all[lang] ?? {}), [key]: value } }));
  const err = (k: string) => s.errors[k];

  return (
    <section>
      <h1 className="adm-h1">{c.site.title}</h1>
      {s.message && <Alert kind={s.message.kind}>{s.message.text}</Alert>}
      {s.data && (
        <form className="adm-card" onSubmit={submit} noValidate>
          <p className="adm-small adm-muted">{format(c.site.fixed, { lang: s.data.defaultLanguage, tz: s.data.timezone, currency: s.data.currency })}</p>
          <fieldset className="adm-fieldset" disabled={s.busy}>
            <div className="adm-toolbar">
              <h2 className="adm-h2">{c.site.general}</h2>
              <LangTabs value={lang} onChange={setLang} filled={(l) => !!texts[l]?.siteName?.trim()} />
            </div>
            <div className="adm-grid2">
              <Field label={c.site.siteName} required={lang === "th"} lang={lang} value={tr.siteName ?? ""} maxLength={80}
                error={err(`translations.${lang}.siteName`)} onChange={(e) => setTr("siteName", e.currentTarget.value)} />
              <Field label={c.site.tagline} lang={lang} value={tr.tagline ?? ""} maxLength={160} error={err(`translations.${lang}.tagline`)}
                onChange={(e) => setTr("tagline", e.currentTarget.value)} />
              <Field label={c.site.address} lang={lang} value={tr.address ?? ""} maxLength={300} onChange={(e) => setTr("address", e.currentTarget.value)} />
              <Field label={c.site.footerText} lang={lang} value={tr.footerText ?? ""} maxLength={500} onChange={(e) => setTr("footerText", e.currentTarget.value)} />
            </div>
            <div className="adm-grid2">
              <Field label={c.site.contactPhone} hint={c.site.contactPhoneHint} type="text" inputMode="tel" maxLength={200} value={form.contactPhone ?? ""} error={err("contactPhone")} onChange={(e) => setForm({ ...form, contactPhone: e.currentTarget.value })} />
              <Field label={c.site.contactEmail} type="email" value={form.contactEmail ?? ""} error={err("contactEmail")} onChange={(e) => setForm({ ...form, contactEmail: e.currentTarget.value })} />
              <Field label={c.site.lineOaUrl} type="url" value={form.lineOaUrl ?? ""} error={err("lineOaUrl")} onChange={(e) => setForm({ ...form, lineOaUrl: e.currentTarget.value })} />
              <Field label={c.site.mapUrl} type="url" value={form.mapUrl ?? ""} error={err("mapUrl")} onChange={(e) => setForm({ ...form, mapUrl: e.currentTarget.value })} />
              <Field label={c.site.latitude} inputMode="decimal" value={form.latitude ?? ""} error={err("latitude")} onChange={(e) => setForm({ ...form, latitude: e.currentTarget.value })} />
              <Field label={c.site.longitude} inputMode="decimal" value={form.longitude ?? ""} error={err("longitude")} onChange={(e) => setForm({ ...form, longitude: e.currentTarget.value })} />
            </div>
            <Button type="submit" busy={s.busy}>{t.common.save}</Button>
          </fieldset>
        </form>
      )}

      <form className="adm-card" onSubmit={(e) => {
        e.preventDefault();
        void rules.save(Object.fromEntries(Object.entries(ruleForm).map(([k, v]) => [k, Number(v)])));
      }}>
        <h2 className="adm-h2">{c.bset.title}</h2>
        <p className="adm-field__hint">{c.bset.note}</p>
        {rules.message && <Alert kind={rules.message.kind}>{rules.message.text}</Alert>}
        {/* Locked until the current rules are in the form: a value typed earlier would be overwritten or saved alone. */}
        <fieldset className="adm-fieldset" disabled={rules.busy || !rules.data || Object.keys(ruleForm).length === 0 || !can("settings.website")}>
          <div className="adm-grid2">
            {(["holdMinutes", "maxNights", "maxAdvanceDays", "maxTentsPerBooking"] as const).map((k) => (
              <Field key={k} label={c.bset[k]} type="number" min={1} value={ruleForm[k] ?? ""} error={rules.errors[k]}
                onChange={(e) => { const v = e.currentTarget.value; setRuleForm((cur) => ({ ...cur, [k]: v })); }} />
            ))}
          </div>
          <Button type="submit" busy={rules.busy}>{t.common.save}</Button>
        </fieldset>
      </form>
    </section>
  );
}

// ==================================================================== branding (spec §36)

export function BrandingPage() {
  const { t, c } = useAdmin();
  const s = useSettings<BrandingDto>("/api/admin/settings/branding");
  const [slots, setSlots] = useState<Record<BrandingSlot, { id: string | null; url: string | null }> | null>(null);
  useEffect(() => {
    if (s.data) setSlots(Object.fromEntries(BRANDING_SLOTS.map((k) => [k, { id: s.data!.slots[k].assetId, url: s.data!.slots[k].url }])) as Record<BrandingSlot, { id: string | null; url: string | null }>);
  }, [s.data]);
  return (
    <section>
      <h1 className="adm-h1">{c.brand.title}</h1>
      <p className="adm-muted">{c.brand.intro}</p>
      {s.message && <Alert kind={s.message.kind}>{s.message.text}</Alert>}
      {slots && (
        <form className="adm-card" onSubmit={(e) => { e.preventDefault(); void s.save(Object.fromEntries(BRANDING_SLOTS.map((k) => [k, slots[k].id]))); }}>
          <div className="adm-grid2">
            {BRANDING_SLOTS.map((k) => (
              <ImageField key={k} label={c.brand[k]} purpose={k === "favicon" ? "FAVICON" : "LOGO"} url={slots[k].url} error={s.errors[k]}
                hint={k === "favicon" ? c.brand.hintFavicon : c.brand.hintLogo}
                onChange={(asset) => setSlots({ ...slots, [k]: { id: asset?.id ?? null, url: asset?.url ?? null } })} />
            ))}
          </div>
          <Button type="submit" busy={s.busy}>{t.common.save}</Button>
        </form>
      )}
    </section>
  );
}

// ==================================================================== floating booking button (spec §39)

export function BookingCtaPage() {
  const { t, c, locale } = useAdmin();
  const s = useSettings<BookingCtaDto>("/api/admin/settings/booking-cta");
  const [f, setF] = useState<BookingCtaDto | null>(null);
  const [lang, setLang] = useState<LocaleCode>("th");
  useEffect(() => { if (s.data) setF(s.data); }, [s.data]);
  if (!f) return <section><h1 className="adm-h1">{c.cta.title}</h1>{s.message ? <Alert kind={s.message.kind}>{s.message.text}</Alert> : <p role="status">{t.common.loading}</p>}</section>;
  const set = <K extends keyof BookingCtaDto>(k: K, v: BookingCtaDto[K]) => setF({ ...f, [k]: v });
  const togglePage = (p: (typeof CTA_PAGES)[number], on: boolean) => {
    const pages = p === "*" ? (on ? ["*"] : ["home"]) : (on ? [...f.pages.filter((x) => x !== "*"), p] : f.pages.filter((x) => x !== p));
    set("pages", (pages.length ? pages : ["*"]) as BookingCtaDto["pages"]);
  };
  const opts = <T extends string>(values: readonly T[], labels: Record<string, string>) => values.map((v) => ({ value: v, label: labels[v] ?? v }));

  return (
    <section>
      <h1 className="adm-h1">{c.cta.title}</h1>
      {s.message && <Alert kind={s.message.kind}>{s.message.text}</Alert>}
      <form className="adm-card" onSubmit={(e) => { e.preventDefault(); void s.save(f); }}>
        <fieldset className="adm-fieldset" disabled={s.busy}>
          <div className="adm-grid2">
            <div>
              <Check label={c.cta.enabled} checked={f.enabled} onChange={(v) => set("enabled", v)} />
              <Check label={c.cta.showOnDesktop} checked={f.showOnDesktop} onChange={(v) => set("showOnDesktop", v)} />
              <Check label={c.cta.showOnMobile} checked={f.showOnMobile} onChange={(v) => set("showOnMobile", v)} />
              <Check label={c.cta.closeable} checked={f.closeable} onChange={(v) => set("closeable", v)} />
            </div>
            <div className="adm-cta-preview" aria-label={c.cta.preview}>
              <span className="adm-label">{c.cta.preview}</span>
              <CtaButton config={{ ...f, label: f.labels[lang] ?? f.labels.th ?? "" }} href="#" preview />
            </div>
            <Select label={c.cta.desktopPosition} value={f.desktopPosition} onChange={(v) => set("desktopPosition", v as BookingCtaDto["desktopPosition"])}
              options={opts(["BOTTOM_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER"] as const, c.cta.pos)} />
            <Select label={c.cta.mobilePosition} value={f.mobilePosition} onChange={(v) => set("mobilePosition", v as BookingCtaDto["mobilePosition"])}
              options={opts(["BOTTOM_BAR", "BOTTOM_RIGHT", "BOTTOM_LEFT"] as const, c.cta.pos)} />
            <Select label={c.cta.size} value={f.size} onChange={(v) => set("size", v as BookingCtaDto["size"])} options={opts(["SM", "MD", "LG"] as const, c.cta.sizes)} />
            <Select label={c.cta.icon} value={f.icon} onChange={(v) => set("icon", v as BookingCtaDto["icon"])} options={opts(CTA_ICONS, c.cta.icons)} />
            <Select label={c.cta.animation} value={f.animation} onChange={(v) => set("animation", v as BookingCtaDto["animation"])}
              options={opts(["NONE", "PULSE", "BOUNCE", "SLIDE_IN"] as const, c.cta.anim)} />
            <div className="adm-field">
              <label htmlFor="cta-color">{c.cta.color}</label>
              <div className="adm-row">
                <input id="cta-color" type="color" value={f.color ?? "#2f5d50"} onChange={(e) => set("color", e.currentTarget.value)} />
                <Button variant="ghost" onClick={() => set("color", null)} disabled={!f.color}>{c.cta.useThemeColor}</Button>
              </div>
              {s.errors.color && <p className="adm-field__error">{s.errors.color}</p>}
            </div>
          </div>
          <fieldset className="adm-fieldset adm-subform">
            <legend>{c.cta.pages}</legend>
            <div className="adm-row adm-row--wrap">
              {CTA_PAGES.map((p) => <Check key={p} label={c.cta.pageNames[p]} checked={f.pages.includes(p)} disabled={p !== "*" && f.pages.includes("*")} onChange={(v) => togglePage(p, v)} />)}
            </div>
            {s.errors.pages && <p className="adm-field__error">{s.errors.pages}</p>}
          </fieldset>
          <div className="adm-subform">
            <div className="adm-toolbar"><span className="adm-label">{c.cta.label}</span><LangTabs value={lang} onChange={setLang} /></div>
            <Field label={`${c.cta.label} (${LOCALES.find((l) => l.code === lang)?.shortLabel})`} lang={lang} maxLength={30} value={f.labels[lang] ?? ""}
              error={s.errors[`labels.${lang}`]} onChange={(e) => set("labels", { ...f.labels, [lang]: e.currentTarget.value })} />
            <p className="adm-field__hint">{c.cta.target.replace("{lang}", locale.path)}</p>
          </div>
          <Button type="submit" busy={s.busy}>{t.common.save}</Button>
        </fieldset>
      </form>
    </section>
  );
}

// ==================================================================== marketing (spec §43–45)

export function MarketingPage({ focus }: { focus: "ga4" | "meta-pixel" | "capi" }) {
  const { t, c, can } = useAdmin();
  const s = useSettings<MarketingDto>("/api/admin/settings/marketing");
  const [f, setF] = useState<MarketingDto | null>(null);
  useEffect(() => { if (s.data) setF(s.data); }, [s.data]);
  useEffect(() => { document.getElementById(`mkt-${focus}`)?.scrollIntoView({ block: "start" }); }, [focus, f === null]);
  const editable = can("marketing.edit");
  if (!f) return <section><h1 className="adm-h1">{c.mkt.title}</h1>{s.message ? <Alert kind={s.message.kind}>{s.message.text}</Alert> : <p role="status">{t.common.loading}</p>}</section>;
  const set = <K extends keyof MarketingDto>(k: K, v: MarketingDto[K]) => setF({ ...f, [k]: v });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void s.save({
      ga4Enabled: f.ga4Enabled, ga4MeasurementId: f.ga4MeasurementId || null, ga4PropertyId: f.ga4PropertyId?.trim() || null, metaPixelEnabled: f.metaPixelEnabled,
      metaPixelId: f.metaPixelId || null, metaCapiEnabled: f.metaCapiEnabled, gscVerification: f.gscVerification || null,
    });
  };
  const box = (id: string, title: string, children: ReactNode) => (
    <div id={`mkt-${id}`} className={`adm-card${focus === id ? " adm-card--focus" : ""}`}><h2 className="adm-h2">{title}</h2>{children}</div>
  );
  return (
    <section>
      <h1 className="adm-h1">{c.mkt.title}</h1>
      <p className="adm-muted">{c.mkt.phaseNote}</p>
      {!editable && <Alert kind="info">{c.mkt.readOnly}</Alert>}
      {s.message && <Alert kind={s.message.kind}>{s.message.text}</Alert>}
      <form onSubmit={submit} noValidate>
        <fieldset className="adm-fieldset" disabled={s.busy || !editable}>
          {box("ga4", c.mkt.ga4, <>
            <Check label={c.mkt.ga4Enabled} checked={f.ga4Enabled} onChange={(v) => set("ga4Enabled", v)} />
            <Field label={c.mkt.ga4Id} value={f.ga4MeasurementId ?? ""} error={s.errors.ga4MeasurementId} spellCheck={false}
              onChange={(e) => set("ga4MeasurementId", e.currentTarget.value)} />
            <fieldset className="adm-fieldset adm-subform">
              <legend>{c.mkt.ga4Data}</legend>
              <Field label={c.mkt.ga4PropertyId} inputMode="numeric" value={f.ga4PropertyId ?? ""} error={s.errors.ga4PropertyId} spellCheck={false}
                onChange={(e) => set("ga4PropertyId", e.currentTarget.value)} />
              <dl className="adm-dl">
                <dt>{c.mkt.ga4DataKey}</dt><dd>{f.ga4DataKeyConfigured ? `✓ ${c.mkt.capiTokenSet}` : c.mkt.ga4DataKeyMissing}</dd>
                {f.ga4DataError && <><dt>{c.mkt.ga4DataError}</dt><dd className="adm-mono adm-small">{f.ga4DataError}</dd></>}
              </dl>
              <p className="adm-field__hint">{c.mkt.ga4DataHelp}</p>
            </fieldset>
          </>)}
          {box("meta-pixel", c.mkt.pixel, <>
            <Check label={c.mkt.pixelEnabled} checked={f.metaPixelEnabled} onChange={(v) => set("metaPixelEnabled", v)} />
            <Field label={c.mkt.pixelId} inputMode="numeric" value={f.metaPixelId ?? ""} error={s.errors.metaPixelId}
              onChange={(e) => set("metaPixelId", e.currentTarget.value)} />
          </>)}
          {box("capi", c.mkt.capi, <>
            <Check label={c.mkt.capiEnabled} checked={f.metaCapiEnabled} onChange={(v) => set("metaCapiEnabled", v)} />
            {s.errors.metaCapiEnabled && <p className="adm-field__error">{s.errors.metaCapiEnabled}</p>}
            <dl className="adm-dl">
              <dt>{c.mkt.capiToken}</dt><dd>{f.capiTokenConfigured ? `✓ ${c.mkt.capiTokenSet}` : c.mkt.capiTokenMissing}</dd>
              <dt>{c.mkt.capiTestCode}</dt><dd>{f.capiTestEventCodeConfigured ? `✓ ${c.mkt.capiTokenSet}` : "—"}</dd>
            </dl>
            <p className="adm-field__hint">{c.mkt.secretNote}</p>
          </>)}
          {box("gsc", c.mkt.gsc, (
            <Field label={c.mkt.gscToken} value={f.gscVerification ?? ""} error={s.errors.gscVerification} spellCheck={false}
              onChange={(e) => set("gscVerification", e.currentTarget.value)} />
          ))}
          {editable && <Button type="submit" busy={s.busy}>{t.common.save}</Button>}
        </fieldset>
      </form>
      {s.data && <CapiPanel marketing={s.data} />}
    </section>
  );
}

// ==================================================================== SEO (spec §42)

const EMPTY_SEO: SeoEntryDto = {
  seoTitle: null, metaDescription: null, canonicalUrl: null, ogTitle: null, ogDescription: null, ogImageAssetId: null, ogImageUrl: null,
  robots: "index,follow", schemaJson: null,
};

export function SeoPage() {
  const { t, c, can } = useAdmin();
  const s = useSettings<SeoPageDto[]>("/api/admin/seo");
  const [page, setPage] = useState<SeoPageKey>("home");
  const [lang, setLang] = useState<LocaleCode>("th");
  const [draft, setDraft] = useState<Partial<Record<LocaleCode, SeoEntryDto>>>({});
  const editable = can("seo.edit");
  useEffect(() => {
    const p = s.data?.find((x) => x.pageKey === page);
    setDraft(Object.fromEntries(LOCALES.map((l) => [l.code, { ...EMPTY_SEO, ...(p?.translations[l.code] ?? {}) }])));
  }, [s.data, page]);
  const e = draft[lang] ?? EMPTY_SEO;
  const set = (k: keyof SeoEntryDto, v: string | null) => setDraft({ ...draft, [lang]: { ...e, [k]: v } });
  const err = (k: string) => s.errors[`translations.${lang}.${k}`];
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void s.save({
      translations: Object.fromEntries(LOCALES.map((l) => {
        const x = draft[l.code] ?? EMPTY_SEO;
        const fields = { seoTitle: x.seoTitle, metaDescription: x.metaDescription, canonicalUrl: x.canonicalUrl, ogTitle: x.ogTitle,
          ogDescription: x.ogDescription, ogImageAssetId: x.ogImageAssetId, robots: x.robots, schemaJson: x.schemaJson };
        const empty = [x.seoTitle, x.metaDescription, x.canonicalUrl, x.ogTitle, x.ogDescription, x.ogImageAssetId, x.schemaJson].every((v) => !v)
          && x.robots === "index,follow";
        return [l.code, empty ? null : Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "string" ? v.trim() || null : v]))];
      })),
    }, "PUT", `/api/admin/seo/${page}`);
  };

  return (
    <section>
      <h1 className="adm-h1">{c.seo.title}</h1>
      <PageTabs label={c.seo.page} value={page} onChange={setPage} tabs={SEO_PAGE_KEYS.map((k) => ({ value: k, label: c.seo.pages[k] }))} />
      {s.message && <Alert kind={s.message.kind}>{s.message.text}</Alert>}
      {s.data && (
        <form className="adm-card" onSubmit={submit} noValidate>
          <fieldset className="adm-fieldset" disabled={s.busy || !editable}>
            <div className="adm-toolbar"><h2 className="adm-h2">{c.seo.pages[page]}</h2><LangTabs value={lang} onChange={setLang} filled={(l) => !!draft[l]?.seoTitle} /></div>
            <p className="adm-field__hint">{c.seo.autoHint}</p>
            <div className="adm-seo-preview" aria-label={c.seo.googlePreview}>
              <span className="adm-seo-preview__title">{e.seoTitle || c.ui.untitled}</span>
              <span className="adm-seo-preview__url">{e.canonicalUrl || ""}</span>
              <span className="adm-seo-preview__desc">{e.metaDescription || ""}</span>
            </div>
            <Field label={c.seo.seoTitle} lang={lang} maxLength={70} value={e.seoTitle ?? ""} error={err("seoTitle")}
              hint={format(c.seo.chars, { n: (e.seoTitle ?? "").length })} onChange={(ev) => set("seoTitle", ev.currentTarget.value)} />
            <div className="adm-field">
              <label htmlFor="seo-desc">{c.seo.metaDescription}</label>
              <textarea id="seo-desc" lang={lang} rows={2} maxLength={200} value={e.metaDescription ?? ""} onChange={(ev) => set("metaDescription", ev.currentTarget.value)} />
              <p className="adm-field__hint">{format(c.seo.chars, { n: (e.metaDescription ?? "").length })}</p>
              {err("metaDescription") && <p className="adm-field__error">{err("metaDescription")}</p>}
            </div>
            <div className="adm-grid2">
              <Field label={c.seo.canonicalUrl} type="url" value={e.canonicalUrl ?? ""} error={err("canonicalUrl")} onChange={(ev) => set("canonicalUrl", ev.currentTarget.value)} />
              <Select label={c.seo.robots} value={e.robots} onChange={(v) => set("robots", v)} options={ROBOTS_VALUES.map((r) => ({ value: r, label: r }))} error={err("robots")} />
              <Field label={c.seo.ogTitle} lang={lang} maxLength={95} value={e.ogTitle ?? ""} error={err("ogTitle")} onChange={(ev) => set("ogTitle", ev.currentTarget.value)} />
              <Field label={c.seo.ogDescription} lang={lang} maxLength={300} value={e.ogDescription ?? ""} error={err("ogDescription")} onChange={(ev) => set("ogDescription", ev.currentTarget.value)} />
            </div>
            <ImageField label={c.seo.ogImage} purpose="OG_IMAGE" url={e.ogImageUrl ?? null} error={err("ogImageAssetId")} disabled={!editable}
              onChange={(asset) => setDraft({ ...draft, [lang]: { ...e, ogImageAssetId: asset?.id ?? null, ogImageUrl: asset?.url ?? null } })} />
            <div className="adm-field">
              <label htmlFor="seo-schema">{c.seo.schemaJson}</label>
              <textarea id="seo-schema" className="adm-mono" rows={5} maxLength={8000} spellCheck={false} value={e.schemaJson ?? ""}
                onChange={(ev) => set("schemaJson", ev.currentTarget.value)} />
              <p className="adm-field__hint">{c.seo.schemaHint}</p>
              {err("schemaJson") && <p className="adm-field__error">{err("schemaJson")}</p>}
            </div>
            {editable && <Button type="submit" busy={s.busy}>{t.common.save}</Button>}
          </fieldset>
        </form>
      )}
      {editable && (
        <div className="adm-card">
          <h2 className="adm-h2">{c.seo.redirects}</h2>
          <p className="adm-field__hint">{c.seo.redirectNote}</p>
          <CmsManager entity="seoRedirect" newLabel={c.seo.newRedirect}
            summary={(r) => `→ ${r.toPath as string} (${r.statusCode as number}) ${r.isActive ? "" : `· ${c.status.INACTIVE}`}`} />
        </div>
      )}
      <SearchEnginesCard />
      {can("content.view") && <TranslationCoverageCard />}
      {editable && <SiteSearchCard />}
    </section>
  );
}
