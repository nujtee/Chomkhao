import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { PermissionCode } from "../../../shared/auth-types.ts";
import { formatBaht, parseBahtToSatang } from "../../../shared/booking-rules.ts";
import { ENTITIES, normalizeSlug, typingSlug, type CmsEntityName, type CmsRecord, type FieldDef } from "../../../shared/cms-schema.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import type { AdminCmsMessages } from "../../../shared/i18n/admin-cms-messages.ts";
import { LOCALES, type LocaleCode } from "../../../shared/i18n/locales.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { uploadImage } from "../../media/prepareImage.ts";
import type { ImageProfilePurpose } from "../../../shared/media-types.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, fieldErrors } from "../ui.tsx";

/** Client copy of who may edit / publish each entity — hides buttons only; the Worker decides. */
export const EDIT_PERMISSION: Record<CmsEntityName, PermissionCode> = {
  foodCategory: "food.edit", foodOption: "food.edit", includedMeal: "food.edit",
  homeSlide: "content.home", homeSection: "content.home",
  galleryCategory: "content.gallery", galleryImage: "content.gallery",
  historySection: "content.history", historyTimeline: "content.history",
  seoRedirect: "seo.edit",
};

/** Fields that only apply for some values of another field. */
const VISIBLE_WHEN: Partial<Record<CmsEntityName, Record<string, (v: Record<string, string>) => boolean>>> = {
  foodCategory: {
    deadlineDaysBefore: (v) => v.deadlineType === "DAYS_BEFORE",
    deadlineTime: (v) => v.deadlineType === "PREVIOUS_DAY_TIME",
  },
  foodOption: {
    childPriceSatang: (v) => v.childPricing === "SPECIAL_PRICE",
    personsPerSet: (v) => v.pricingType === "PER_SET",
  },
  includedMeal: {
    unitId: (v) => v.targetType === "UNIT",
    unitType: (v) => v.targetType === "UNIT_TYPE",
  },
  homeSlide: {
    overlayColor: (v) => v.overlayEnabled === "true",
    overlayOpacity: (v) => v.overlayEnabled === "true",
  },
};

export type RefOptions = Record<string, { value: string; label: string }[]>;

export function enumLabel(c: AdminCmsMessages, field: string, value: string | number): string {
  const enums = c.enums as Record<string, string>;
  return enums[`${field}:${value}`] ?? enums[String(value)] ?? String(value);
}

export function statusLabel(c: AdminCmsMessages, status: string | undefined): string {
  return (status && (c.status as Record<string, string>)[status]) || status || "";
}

export function StatusPill({ status }: { status: string | undefined }) {
  const { c } = useAdmin();
  const cls = status === "PUBLISHED" || status === "ACTIVE" ? "active"
    : status === "SCHEDULED" ? "warning" : status === "DRAFT" ? "muted" : "suspended";
  return <span className={`adm-badge adm-badge--${cls}`}>{statusLabel(c, status)}</span>;
}

/** Title of a record in the admin's language, falling back to Thai, then a field value. */
export function recordTitle(rec: CmsRecord, lang: LocaleCode, fallback: string): string {
  const field = ENTITIES[rec.__entity as CmsEntityName]?.titleField;
  if (field) {
    const tr = rec.translations[lang]?.[field] ?? rec.translations.th?.[field];
    if (tr) return tr;
    if (typeof rec[field] === "string" && rec[field]) return rec[field] as string;
  }
  // e.g. a gallery image without a title: show its alt text / caption instead of "(untitled)".
  const any = Object.values(rec.translations[lang] ?? rec.translations.th ?? {}).find((v) => v);
  return any ?? fallback;
}

export function useCmsList(entity: CmsEntityName, query = "") {
  const { t } = useAdmin();
  const [items, setItems] = useState<CmsRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const list = await apiGet<CmsRecord[]>(`/api/admin/cms/${entity}${query ? `?${query}` : ""}`);
      setItems(list.map((r) => ({ ...r, __entity: entity })));
      setError(null);
    } catch (err) {
      setError(detailMessage(t, err));
    }
  }, [entity, query, t]);
  useEffect(() => {
    setItems(null);
    void reload();
  }, [reload]);
  return { items, error, reload, setItems };
}

// ==================================================================== inputs

export function LangTabs({ value, onChange, filled }: { value: LocaleCode; onChange: (l: LocaleCode) => void; filled?: (l: LocaleCode) => boolean }) {
  const { c } = useAdmin();
  return (
    <div role="tablist" aria-label={c.ui.translations} className="adm-tabs adm-tabs--small">
      {LOCALES.map((l) => (
        <button key={l.code} type="button" role="tab" aria-selected={value === l.code} className="adm-tab" onClick={() => onChange(l.code)}>
          {l.shortLabel}{filled && !filled(l.code) ? " ○" : ""}
        </button>
      ))}
    </div>
  );
}

/** Upload a public image for one purpose (byte-checked by the Worker) and show it. */
export function ImageField({
  label, purpose, url, onChange, hint, error, disabled,
}: {
  label: string;
  purpose: string;
  url: string | null;
  onChange: (asset: { id: string; url: string } | null) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
}) {
  const { t, c } = useAdmin();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setUploadError(null);
    try {
      onChange(await uploadImage(file, purpose as ImageProfilePurpose));
    } catch (err) {
      setUploadError(detailMessage(t, err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="adm-field adm-imagefield">
      <span className="adm-label" id={`${id}-label`}>{label}</span>
      <div className="adm-imagefield__body">
        <div className="adm-imagefield__preview">{url ? <img src={url} alt="" /> : <span>{c.ui.noImage}</span>}</div>
        <div className="adm-imagefield__actions">
          <input ref={input} id={id} type="file" accept="image/jpeg,image/png,image/webp,image/avif" hidden disabled={disabled || busy}
            aria-labelledby={`${id}-label`} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void upload(f); }} />
          <Button variant="secondary" busy={busy} disabled={disabled} onClick={() => input.current?.click()}>
            {busy ? c.ui.uploading : url ? c.ui.replace : c.ui.upload}
          </Button>
          {url && !disabled && <Button variant="ghost" onClick={() => onChange(null)}>{c.ui.remove}</Button>}
        </div>
      </div>
      {hint && <p className="adm-field__hint">{hint}</p>}
      {(error || uploadError) && <p className="adm-field__error" role="alert">{error ?? uploadError}</p>}
    </div>
  );
}

function toLocalInput(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function initialValue(f: FieldDef, rec: CmsRecord | null, locale: string): string {
  const v = rec ? rec[f.key] : f.default;
  if (v === null || v === undefined) return "";
  if (f.kind === "money") return formatBaht(v as number, locale).replace(/[^\d.,]/g, "").replace(/,/g, "");
  if (f.kind === "datetime") return toLocalInput(v);
  if (f.kind === "bool") return v ? "true" : "false";
  return String(v);
}

function toPayload(f: FieldDef, raw: string): unknown {
  const v = raw.trim();
  if (f.kind === "bool") return raw === "true";
  if (v === "") return null;
  switch (f.kind) {
    case "int": return Number(v);
    case "money": return parseBahtToSatang(v) ?? Number.NaN;
    case "enum": return f.values?.some((x) => typeof x === "number") ? Number(v) : v;
    case "datetime": return new Date(v).toISOString();
    default: return v;
  }
}

// ==================================================================== form

export function CmsForm({
  entity, record, refOptions = {}, hidden = [], onSaved, onCancel, presets = {},
}: {
  entity: CmsEntityName;
  record: CmsRecord | null;
  refOptions?: RefOptions;
  hidden?: string[];
  presets?: Record<string, string>;
  onSaved: (rec: CmsRecord) => void;
  onCancel: () => void;
}) {
  const { t, c, locale, can } = useAdmin();
  const def = ENTITIES[entity];
  const editable = can(EDIT_PERMISSION[entity]);
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(def.fields.map((f) => [f.key, initialValue(f, record, locale.code)])),
    ...(record ? {} : presets),
  }));
  const [urls, setUrls] = useState<Record<string, string | null>>(record?.urls ?? {});
  const [texts, setTexts] = useState<Partial<Record<LocaleCode, Record<string, string>>>>(() =>
    Object.fromEntries(LOCALES.map((l) => [l.code, Object.fromEntries(def.translations.map((f) => [f.key, record?.translations[l.code]?.[f.key] ?? ""]))])));
  const [lang, setLang] = useState<LocaleCode>("th");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const visible = (f: FieldDef) => !hidden.includes(f.key) && (VISIBLE_WHEN[entity]?.[f.key]?.(values) ?? true);
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));
  const label = (key: string) => (c.fields as Record<string, string>)[key] ?? key;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);
    const body: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (record && f.immutable) continue;
      if (hidden.includes(f.key) && !(f.key in presets)) continue;
      body[f.key] = toPayload(f, values[f.key] ?? "");
    }
    if (def.translations.length) {
      body.translations = Object.fromEntries(LOCALES.map((l) => {
        const tr = texts[l.code] ?? {};
        const empty = Object.values(tr).every((x) => !x.trim());
        return [l.code, empty ? null : Object.fromEntries(def.translations.map((f) => [f.key, tr[f.key]?.trim() || null]))];
      }));
    }
    try {
      const saved = record
        ? await apiRequest<CmsRecord>("PATCH", `/api/admin/cms/${entity}/${encodeURIComponent(record.id)}`, body)
        : await apiRequest<CmsRecord>("POST", `/api/admin/cms/${entity}`, body);
      onSaved({ ...saved, __entity: entity });
    } catch (err) {
      setErrors(fieldErrors(t, err));
      setMessage(detailMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  const fieldInput = (f: FieldDef) => {
    const id = `cms-${entity}-${f.key}`;
    const err = errors[f.key];
    const common = { id, disabled: !editable || (!!record && f.immutable), "aria-invalid": err ? true : undefined };
    if (f.kind === "asset") {
      return (
        <ImageField key={f.key} label={label(f.key)} purpose={f.purpose!} url={urls[f.key] ?? null} error={err} disabled={!editable}
          onChange={(asset) => { set(f.key, asset?.id ?? ""); setUrls((u) => ({ ...u, [f.key]: asset?.url ?? null })); }} />
      );
    }
    if (f.kind === "bool") {
      return (
        <label key={f.key} className="adm-check">
          <input type="checkbox" checked={values[f.key] === "true"} disabled={!editable} onChange={(e) => set(f.key, String(e.currentTarget.checked))} />
          <span>{label(f.key)}</span>
        </label>
      );
    }
    let control: ReactNode;
    if (f.kind === "enum" || f.kind === "ref" || (f.kind === "int" && f.values)) {
      const opts = f.kind === "ref"
        ? refOptions[f.key] ?? []
        : (f.values ?? []).map((v) => ({ value: String(v), label: enumLabel(c, f.key, v) }));
      control = (
        <select {...common} value={values[f.key]} onChange={(e) => set(f.key, e.currentTarget.value)}>
          {(!f.required || f.kind === "ref") && <option value="">{c.ui.none}</option>}
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    } else if (f.kind === "multiline") {
      control = <textarea {...common} rows={4} value={values[f.key]} onChange={(e) => set(f.key, e.currentTarget.value)} />;
    } else {
      const type = f.kind === "int" ? "number" : f.kind === "color" ? "color" : f.kind === "time" ? "time"
        : f.kind === "datetime" ? "datetime-local" : "text";
      control = (
        <input {...common} type={type} inputMode={f.kind === "money" ? "decimal" : undefined} value={values[f.key] || (f.kind === "color" ? "#000000" : "")}
          min={f.kind === "int" ? f.min : undefined} max={f.kind === "int" ? f.max : undefined}
          maxLength={f.kind === "code" || f.kind === "slug" ? f.max : undefined}
          autoCapitalize={f.kind === "code" ? "characters" : f.kind === "slug" ? "none" : undefined}
          spellCheck={f.kind === "code" || f.kind === "slug" ? false : undefined}
          autoComplete={f.kind === "slug" ? "off" : undefined}
          // Codes are upper case with _ between words ("dinner set" reads "DINNER_SET"); slugs lower case with
          // - between words ("House 01" reads "house-01"), tidied at the edges when the field is left.
          onChange={(e) => {
            const v = e.currentTarget.value;
            set(f.key, f.kind === "code" ? v.toUpperCase().replace(/[\s-]+/g, "_") : f.kind === "slug" ? typingSlug(v) : v);
          }}
          onBlur={f.kind === "slug" ? (e) => set(f.key, normalizeSlug(e.currentTarget.value)) : undefined} />
      );
    }
    const hint = f.kind === "link" ? c.hints.link : f.kind === "datetime" ? c.hints.datetime : f.kind === "slug" ? c.hints.slug
      : f.kind === "code" && !record ? (f.lettersOnly ? c.hints.codeLetters : c.hints.code) : undefined;
    return (
      <div key={f.key} className="adm-field">
        <label htmlFor={id}>{label(f.key)}{f.required && <span aria-hidden="true"> *</span>}</label>
        {control}
        {hint && <p className="adm-field__hint">{hint}</p>}
        {err && <p className="adm-field__error">{err}</p>}
      </div>
    );
  };

  const tr = texts[lang] ?? {};
  return (
    <form className="adm-card adm-cmsform" onSubmit={submit} noValidate>
      {message && <Alert kind="error">{message}</Alert>}
      <fieldset className="adm-fieldset" disabled={busy}>
        <div className="adm-grid2">{def.fields.filter(visible).map(fieldInput)}</div>
        {def.translations.length > 0 && (
          <div className="adm-subform">
            <div className="adm-toolbar">
              <h3 className="adm-h3">{c.ui.translations}</h3>
              <LangTabs value={lang} onChange={setLang} filled={(l) => Object.values(texts[l] ?? {}).some((x) => x.trim())} />
            </div>
            <p className="adm-field__hint">{c.ui.defaultLanguageHint}</p>
            {def.translations.map((f) => {
              const id = `cms-${entity}-${lang}-${f.key}`;
              const err = errors[`translations.${lang}.${f.key}`];
              const required = def.requiredTranslation === f.key && lang === "th";
              const props = {
                id, value: tr[f.key] ?? "", disabled: !editable, lang, "aria-invalid": err ? true : undefined,
                onChange: (e: { currentTarget: { value: string } }) => {
                  const value = e.currentTarget.value;
                  setTexts((all) => ({ ...all, [lang]: { ...(all[lang] ?? {}), [f.key]: value } }));
                },
              };
              return (
                <div key={id} className="adm-field">
                  <label htmlFor={id}>{label(f.key)}{required && <span aria-hidden="true"> *</span>}</label>
                  {f.kind === "multiline" ? <textarea {...props} rows={f.max && f.max > 1000 ? 8 : 3} /> : <input {...props} type="text" />}
                  {f.kind === "multiline" && <p className="adm-field__hint">{c.hints.plainText}</p>}
                  {f.kind === "link" && <p className="adm-field__hint">{c.hints.link}</p>}
                  {err && <p className="adm-field__error">{err}</p>}
                </div>
              );
            })}
          </div>
        )}
        <div className="adm-row">
          {editable && <Button type="submit" busy={busy}>{busy ? t.common.saving : t.common.save}</Button>}
          <Button variant="secondary" onClick={onCancel}>{t.common.cancel}</Button>
        </div>
      </fieldset>
    </form>
  );
}

// ==================================================================== list + manager

export function CmsManager({
  entity, newLabel, query = "", refOptions, hidden, presets, summary, toolbar, emptyText,
}: {
  entity: CmsEntityName;
  newLabel: string;
  query?: string;
  refOptions?: RefOptions;
  hidden?: string[];
  presets?: Record<string, string>;
  summary?: (rec: CmsRecord) => ReactNode;
  toolbar?: (reload: () => Promise<void>) => ReactNode;
  emptyText?: string;
}) {
  const { t, c, can, locale } = useAdmin();
  const def = ENTITIES[entity];
  const { items, error, reload } = useCmsList(entity, query);
  const [editing, setEditing] = useState<CmsRecord | "new" | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [deleting, setDeleting] = useState<CmsRecord | null>(null);
  const canEdit = can(EDIT_PERMISSION[entity]);
  const canPublish = def.publishable && can("content.publish");
  const sortable = def.fields.some((f) => f.key === "sortOrder");
  const asset = def.fields.find((f) => f.kind === "asset");

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMessage(null);
    try {
      await fn();
      setMessage({ kind: "success", text: ok });
      await reload();
    } catch (err) {
      setMessage({ kind: "error", text: detailMessage(t, err) });
    }
  }

  function move(index: number, delta: number) {
    if (!items) return;
    const ids = items.map((i) => i.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved!);
    void act(() => apiRequest("PUT", `/api/admin/cms/${entity}/order`, { ids }), t.common.saved);
  }

  if (editing) {
    return (
      <CmsForm key={editing === "new" ? "new" : editing.id} entity={entity} record={editing === "new" ? null : editing}
        refOptions={refOptions} hidden={hidden} presets={presets}
        onCancel={() => setEditing(null)}
        onSaved={() => { setEditing(null); setMessage({ kind: "success", text: t.common.saved }); void reload(); }} />
    );
  }

  return (
    <div className="adm-cms">
      <div className="adm-toolbar">
        <div className="adm-row adm-row--wrap">{toolbar?.(reload)}</div>
        {canEdit && <Button onClick={() => setEditing("new")}>+ {newLabel}</Button>}
      </div>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {!items && !error && <p role="status">{t.common.loading}</p>}
      {items && items.length === 0 && <div className="adm-empty">{emptyText ?? c.ui.empty}</div>}
      {items && items.length > 0 && (
        <ul className="adm-cmslist">
          {items.map((rec, i) => {
            const thumb = asset ? rec.urls[asset.key] : null;
            const title = recordTitle(rec, locale.code, c.ui.untitled);
            return (
              <li key={rec.id} className="adm-cmsitem">
                {asset && <div className="adm-cmsitem__thumb">{thumb ? <img src={thumb} alt="" loading="lazy" /> : <span aria-hidden="true" />}</div>}
                <div className="adm-cmsitem__body">
                  <button type="button" className="adm-linkbtn adm-cmsitem__title" onClick={() => setEditing(rec)}>{title}</button>
                  <div className="adm-small adm-muted">{summary?.(rec)}</div>
                  {rec.status && (
                    <div className="adm-row adm-row--wrap">
                      <StatusPill status={rec.status} />
                      {rec.effectiveStatus && rec.effectiveStatus !== rec.status && (
                        <span className="adm-small">{format(c.content.effective, { status: statusLabel(c, rec.effectiveStatus) })}</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="adm-cmsitem__actions">
                  {sortable && canEdit && (
                    <>
                      <button type="button" className="adm-iconbtn" aria-label={`${c.ui.moveUp}: ${title}`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                      <button type="button" className="adm-iconbtn" aria-label={`${c.ui.moveDown}: ${title}`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
                    </>
                  )}
                  {canPublish && (rec.status === "PUBLISHED" || rec.status === "SCHEDULED"
                    ? <Button variant="secondary" onClick={() => act(() => apiRequest("POST", `/api/admin/cms/${entity}/${rec.id}/unpublish`), c.ui.unpublished)}>{c.ui.unpublish}</Button>
                    : <Button onClick={() => act(() => apiRequest("POST", `/api/admin/cms/${entity}/${rec.id}/publish`), c.ui.published)}>{c.ui.publish}</Button>)}
                  <Button variant="ghost" onClick={() => setEditing(rec)}>{canEdit ? c.ui.edit : t.common.close}</Button>
                  {def.deletable && canEdit && <Button variant="danger" onClick={() => setDeleting(rec)}>{c.ui.delete}</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog open={!!deleting} danger message={c.ui.confirmDelete} confirmLabel={c.ui.delete}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const rec = deleting;
          setDeleting(null);
          if (rec) void act(() => apiRequest("DELETE", `/api/admin/cms/${entity}/${rec.id}`), c.ui.deleted);
        }} />
    </div>
  );
}

/** Tab strip for a page with several managers. */
export function PageTabs<T extends string>({ tabs, value, onChange, label }: { tabs: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="adm-tabs">
      {tabs.map((x) => (
        <button key={x.value} type="button" role="tab" aria-selected={value === x.value} className="adm-tab" onClick={() => onChange(x.value)}>{x.label}</button>
      ))}
    </div>
  );
}
