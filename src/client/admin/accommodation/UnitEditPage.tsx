import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AdminUnitDto, AmenityDto, MediaTextDto, UnitTranslationDto, UnitType } from "../../../shared/accommodation-types.ts";
import { SATANG_PER_BAHT, parseBahtToSatang } from "../../../shared/booking-rules.ts";
import { LOCALES, type LocaleCode } from "../../../shared/i18n/locales.ts";
import { normalizeSlug } from "../../../shared/cms-schema.ts";
import { ApiError, apiGet, apiRequest } from "../../api/client.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { uploadImage } from "../../media/prepareImage.ts";
import { Link } from "../../router/Router.tsx";
import type { PaymentMode } from "../../../shared/booking-rules.ts";
import { PaymentModeField } from "./PaymentModeField.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, errorMessage, Field, fieldErrors } from "../ui.tsx";
import { amenityCode, nextAmenityCode } from "./amenity-code.ts";
import { AvailabilityGrid } from "./AvailabilityGrid.tsx";
import { TYPE_PATH, unitName, UnitStatusBadge } from "./UnitsPage.tsx";

type Msg = { kind: "error" | "success"; text: string } | null;
const STATUSES = ["DRAFT", "ACTIVE", "INACTIVE", "MAINTENANCE"] as const;
const EMPTY_T: UnitTranslationDto = { name: "", shortDescription: null, description: null, seoTitle: null, seoDescription: null };

export function UnitEditPage({ type, unitId }: { type: UnitType; unitId: string | null }) {
  const { t, go, href, can, locale } = useAdmin();
  const [unit, setUnit] = useState<AdminUnitDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<Msg>(null);
  const [gridKey, setGridKey] = useState(0);
  const path = TYPE_PATH[type];
  const canEdit = can("accommodation.edit");

  useEffect(() => {
    if (!unitId) return;
    const controller = new AbortController();
    apiGet<AdminUnitDto>(`/api/admin/accommodations/${encodeURIComponent(unitId)}`, controller.signal)
      .then((u) => (u.unitType === type ? setUnit(u) : setLoadError(t.common.notFound)))
      .catch((err: unknown) => !controller.signal.aborted && setLoadError(errorMessage(t, err)));
    return () => controller.abort();
  }, [unitId, type, t]);

  const onSaved = useCallback((u: AdminUnitDto) => {
    setUnit(u);
    setMessage({ kind: "success", text: t.common.saved });
  }, [t]);
  const onError = useCallback((err: unknown) => setMessage({ kind: "error", text: detailMessage(t, err) }), [t]);

  if (loadError) return <Alert kind="error">{loadError}</Alert>;
  if (unitId && !unit) return <p role="status">{t.common.loading}</p>;

  return (
    <section>
      <p><Link to={href(path)}>← {type === "HOUSE" ? t.acc.housesTitle : t.acc.vipTitle}</Link></p>
      <div className="adm-pagehead">
        <h1 className="adm-h1">{unit ? `${unit.unitCode} — ${unitName(unit, locale.code, t.acc.noName)}` : type === "HOUSE" ? t.acc.newHouse : t.acc.newVip}</h1>
        {unit && <UnitStatusBadge status={unit.status} />}
      </div>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}

      <BasicsForm type={type} unit={unit} canEdit={canEdit}
        onCreated={(u) => go(path, u.id)} onSaved={onSaved} onError={onError} />

      {unit && (
        <>
          <TranslationsForm unit={unit} canEdit={canEdit} onSaved={onSaved} onError={onError} />
          <AmenitiesForm unit={unit} canEdit={canEdit} onSaved={onSaved} onError={onError} />
          <ImagesManager unit={unit} canEdit={canEdit} onSaved={onSaved} onError={onError} />
          {can("accommodation.block") && <BlocksForm unit={unit} onDone={() => { setGridKey((k) => k + 1); setMessage({ kind: "success", text: t.common.saved }); }} onError={onError} />}
          <AvailabilityGrid unitId={unit.id} reloadKey={gridKey} />
          {canEdit && <DeleteUnit unit={unit} onDeleted={() => go(path)} onError={onError} />}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- basics

function BasicsForm({ type, unit, canEdit, onCreated, onSaved, onError }: {
  type: UnitType; unit: AdminUnitDto | null; canEdit: boolean;
  onCreated: (u: AdminUnitDto) => void; onSaved: (u: AdminUnitDto) => void; onError: (e: unknown) => void;
}) {
  const { t, can } = useAdmin();
  const canPrice = can("pricing.edit");
  const [f, setF] = useState(() => ({
    unitCode: unit?.unitCode ?? "",
    slug: unit?.slug ?? "",
    price: unit ? String(unit.basePriceSatang / SATANG_PER_BAHT) : "",
    paymentMode: unit?.paymentMode ?? ("FULL" as PaymentMode),
    standardGuests: String(unit?.standardGuests ?? 2),
    maxGuests: String(unit?.maxGuests ?? 2),
    maxAdults: unit?.maxAdults ? String(unit.maxAdults) : "",
    status: unit?.status === "DELETED" ? "INACTIVE" : unit?.status ?? "DRAFT",
    sortOrder: String(unit?.sortOrder ?? 0),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const price = parseBahtToSatang(f.price);
    if (price === null) {
      setErrors({ basePriceSatang: t.errors.INVALID_PRICE });
      return;
    }
    const body: Record<string, unknown> = {
      unitCode: f.unitCode.trim().toUpperCase(),
      slug: normalizeSlug(f.slug),
      standardGuests: Number(f.standardGuests),
      maxGuests: Number(f.maxGuests),
      maxAdults: f.maxAdults ? Number(f.maxAdults) : null,
      status: f.status,
      sortOrder: Number(f.sortOrder) || 0,
    };
    if (!unit || price !== unit.basePriceSatang) body.basePriceSatang = price;
    if (!unit || f.paymentMode !== unit.paymentMode) body.paymentMode = f.paymentMode;
    setBusy(true);
    setErrors({});
    try {
      if (unit) onSaved(await apiRequest<AdminUnitDto>("PATCH", `/api/admin/accommodations/${encodeURIComponent(unit.id)}`, body));
      else onCreated(await apiRequest<AdminUnitDto>("POST", "/api/admin/accommodations", { ...body, unitType: type }));
    } catch (err) {
      setErrors(fieldErrors(t, err));
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="adm-card" onSubmit={submit} noValidate>
      <h2 className="adm-h2">{t.acc.basics}</h2>
      <fieldset className="adm-fieldset" disabled={!canEdit}>
        <div className="adm-grid2">
          <Field label={t.acc.code} required value={f.unitCode} onChange={set("unitCode")} hint={t.acc.codeHint} error={errors.unitCode} maxLength={20} />
          <Field label={t.acc.slug} required value={f.slug} onChange={set("slug")} hint={t.acc.slugHint} error={errors.slug} maxLength={80} />
          <Field label={t.acc.price} required inputMode="decimal" value={f.price} onChange={set("price")}
            disabled={!canPrice && !!unit} hint={!canPrice ? t.acc.needsPricing : undefined} error={errors.basePriceSatang} />
          <PaymentModeField id="unit-payment-mode" value={f.paymentMode} error={errors.paymentMode} onChange={(paymentMode) => setF({ ...f, paymentMode })} />
          <div className="adm-field">
            <label htmlFor="unit-status">{t.acc.status}</label>
            <select id="unit-status" value={f.status} onChange={set("status")}>
              {STATUSES.map((s) => <option key={s} value={s}>{(t.acc as Record<string, string>)[`status${s}`]}</option>)}
            </select>
            {errors.status && <p className="adm-field__error">{errors.status}</p>}
          </div>
          <Field label={t.acc.standardGuests} type="number" min={1} max={50} required value={f.standardGuests} onChange={set("standardGuests")} error={errors.standardGuests} />
          <Field label={t.acc.maxGuests} type="number" min={1} max={50} required value={f.maxGuests} onChange={set("maxGuests")} error={errors.maxGuests} />
          <Field label={t.acc.maxAdults} type="number" min={1} max={50} value={f.maxAdults} onChange={set("maxAdults")} error={errors.maxAdults} />
          <Field label={t.acc.sortOrder} type="number" min={0} value={f.sortOrder} onChange={set("sortOrder")} error={errors.sortOrder} />
        </div>
        {canEdit && <Button type="submit" busy={busy}>{busy ? t.common.saving : t.common.save}</Button>}
      </fieldset>
    </form>
  );
}

// ---------------------------------------------------------------- translations

function TranslationsForm({ unit, canEdit, onSaved, onError }: {
  unit: AdminUnitDto; canEdit: boolean; onSaved: (u: AdminUnitDto) => void; onError: (e: unknown) => void;
}) {
  const { t } = useAdmin();
  const [lang, setLang] = useState<LocaleCode>("th");
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(LOCALES.map((l) => [l.code, { ...EMPTY_T, ...unit.translations[l.code] }])) as Record<LocaleCode, UnitTranslationDto>);
  const [busy, setBusy] = useState(false);
  const current = draft[lang];
  const set = (k: keyof UnitTranslationDto) => (e: { target: { value: string } }) =>
    setDraft({ ...draft, [lang]: { ...current, [k]: e.target.value } });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const translations = Object.fromEntries(LOCALES.map((l) => {
      const d = draft[l.code];
      const clean = (v: string | null) => (v && v.trim() ? v.trim() : null);
      const empty = !d.name.trim() && !clean(d.shortDescription) && !clean(d.description) && !clean(d.seoTitle) && !clean(d.seoDescription);
      return [l.code, empty ? null : {
        name: d.name.trim(), shortDescription: clean(d.shortDescription), description: clean(d.description),
        seoTitle: clean(d.seoTitle), seoDescription: clean(d.seoDescription),
      }];
    }));
    setBusy(true);
    try {
      onSaved(await apiRequest<AdminUnitDto>("PUT", `/api/admin/accommodations/${encodeURIComponent(unit.id)}/translations`, { translations }));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="adm-card" onSubmit={submit} noValidate>
      <h2 className="adm-h2">{t.acc.translations}</h2>
      <p className="adm-muted adm-small">{t.acc.translationHint}</p>
      <div role="tablist" className="adm-tabs" aria-label={t.common.language}>
        {LOCALES.map((l) => (
          <button key={l.code} type="button" role="tab" aria-selected={lang === l.code} className="adm-tab" onClick={() => setLang(l.code)}>
            {l.label}{draft[l.code].name ? "" : " ○"}
          </button>
        ))}
      </div>
      <fieldset className="adm-fieldset" disabled={!canEdit} lang={lang} style={{ marginTop: 12 }}>
        <Field label={t.acc.name} value={current.name} onChange={set("name")} maxLength={120} required={lang === "th"} />
        <Field label={t.acc.shortDescription} value={current.shortDescription ?? ""} onChange={set("shortDescription")} maxLength={300} />
        <div className="adm-field">
          <label htmlFor="tr-desc">{t.acc.description}</label>
          <textarea id="tr-desc" rows={6} value={current.description ?? ""} onChange={set("description")} maxLength={5000} />
        </div>
        <div className="adm-grid2">
          <Field label={t.acc.seoTitle} value={current.seoTitle ?? ""} onChange={set("seoTitle")} maxLength={120} />
          <Field label={t.acc.seoDescription} value={current.seoDescription ?? ""} onChange={set("seoDescription")} maxLength={320} />
        </div>
        {canEdit && <Button type="submit" busy={busy}>{t.common.save}</Button>}
      </fieldset>
    </form>
  );
}

// ---------------------------------------------------------------- amenities

const NO_AMENITY = { code: "", th: "", en: "", "zh-CN": "" };
type Notice = { kind: "success" | "error"; text: string } | null;

/**
 * Amenities of the unit: tick from the list and Save; or add new ones in a row — each "Add" creates
 * the amenity, ticks it, saves the unit's selection and leaves an empty form for the next one.
 * Messages appear here, next to the form (the page alert is far above on a long page).
 */
function AmenitiesForm({ unit, canEdit, onSaved, onError }: {
  unit: AdminUnitDto; canEdit: boolean; onSaved: (u: AdminUnitDto) => void; onError: (e: unknown) => void;
}) {
  const { t, locale } = useAdmin();
  const [all, setAll] = useState<AmenityDto[]>([]);
  const [selected, setSelected] = useState<string[]>(unit.amenityIds);
  const [adding, setAdding] = useState(false);
  const [nw, setNw] = useState(NO_AMENITY);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [addNotice, setAddNotice] = useState<Notice>(null);
  const [addErrors, setAddErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const returnFocus = useRef(false);
  const titleId = useId();
  const openId = useId();
  const focusFirstField = () => formRef.current?.querySelector<HTMLInputElement>("input")?.focus();

  useEffect(() => {
    void apiGet<AmenityDto[]>("/api/admin/amenities").then(setAll).catch(onError);
  }, [onError]);
  useEffect(() => {
    if (adding) formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    else if (returnFocus.current) document.getElementById(openId)?.focus();
    returnFocus.current = false;
  }, [adding, openId]);

  const saveSelection = (ids: string[]) =>
    apiRequest<AdminUnitDto>("PUT", `/api/admin/accommodations/${encodeURIComponent(unit.id)}/amenities`, { amenityIds: ids });

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      onSaved(await saveSelection(selected));
      setNotice({ kind: "success", text: t.common.saved });
    } catch (err) {
      setNotice({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (creating) return;
    setAddNotice(null);
    const names = Object.fromEntries(
      Object.entries({ th: nw.th, en: nw.en, "zh-CN": nw["zh-CN"] }).map(([k, v]) => [k, v.trim()] as const).filter(([, v]) => v),
    );
    if (!names.th) {
      setAddErrors({ th: t.errors.DEFAULT_LANGUAGE_REQUIRED });
      focusFirstField();
      return;
    }
    setAddErrors({});
    setCreating(true);
    try {
      // An automatic code that is already taken is retried with a suffix (wifi → wifi_2); a typed one is the admin's to change.
      const first = amenityCode(nw.code, nw.en);
      const post = async (): Promise<AmenityDto> => {
        let code = first.code;
        for (let attempt = 1; ; attempt++) {
          try {
            return await apiRequest<AmenityDto>("POST", "/api/admin/amenities", { code, names });
          } catch (err) {
            if (!(first.auto && attempt < 6 && err instanceof ApiError && err.code === "AMENITY_CODE_TAKEN")) throw err;
            code = nextAmenityCode(first.code, attempt);
          }
        }
      };
      const created = await post();
      const ids = [...selected, created.id];
      setAll((a) => [...a, created]);
      setSelected(ids);
      setNw(NO_AMENITY);
      try {
        onSaved(await saveSelection(ids));
        setAddNotice({ kind: "success", text: format(t.acc.amenityAdded, { name: names.th }) });
      } catch {
        setAddNotice({ kind: "error", text: format(t.acc.amenityAddedNotSaved, { name: names.th }) });
      }
      focusFirstField();
    } catch (err) {
      const fields = fieldErrors(t, err);
      const errors: Record<string, string> = {};
      for (const [key, text] of Object.entries(fields)) {
        if (key === "code") errors.code = text;
        else if (key === "names") errors.th = text;
        else if (key.startsWith("names.")) errors[key.slice("names.".length)] = text;
      }
      if (err instanceof ApiError && err.code === "AMENITY_CODE_TAKEN") errors.code = t.errors.AMENITY_CODE_TAKEN;
      setAddErrors(errors);
      if (Object.keys(errors).length === 0) setAddNotice({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setCreating(false);
    }
  }

  const shown = all.filter((a) => a.status === "ACTIVE" || selected.includes(a.id));
  return (
    <div className="adm-card">
      <h2 className="adm-h2">{t.acc.amenities}</h2>
      <fieldset className="adm-fieldset adm-amenities" disabled={!canEdit}>
        <legend className="visually-hidden">{t.acc.amenities}</legend>
        {shown.map((a) => (
          <label key={a.id} className="adm-check">
            <input type="checkbox" checked={selected.includes(a.id)}
              onChange={(e) => setSelected((s) => (e.target.checked ? [...s, a.id] : s.filter((x) => x !== a.id)))} />
            {a.names[locale.code] ?? a.names.th ?? a.code}
          </label>
        ))}
        {shown.length === 0 && <p className="adm-muted adm-small">{t.acc.amenitiesNone}</p>}
      </fieldset>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {canEdit && (
        <div className="adm-row adm-row--wrap">
          <Button onClick={() => void save()} busy={busy}>{t.common.save}</Button>
          {!adding && <Button id={openId} variant="ghost" onClick={() => setAdding(true)}>+ {t.acc.addAmenity}</Button>}
        </div>
      )}
      {canEdit && adding && (
        <form ref={formRef} onSubmit={create} className="adm-subform" noValidate aria-labelledby={titleId}>
          <h3 className="adm-h3 adm-subform__title" id={titleId}>{t.acc.amenityNewTitle}</h3>
          {addNotice && <Alert kind={addNotice.kind}>{addNotice.text}</Alert>}
          <div className="adm-grid2">
            {LOCALES.map((l) => (
              <Field key={l.code} label={`${t.acc.amenityName} (${l.label})`}
                required={l.code === "th"} lang={l.code} value={nw[l.code]} error={addErrors[l.code]} maxLength={80}
                onChange={(e) => setNw({ ...nw, [l.code]: e.target.value })} />
            ))}
            <Field label={t.acc.amenityCode} hint={t.acc.amenityCodeHint} value={nw.code} error={addErrors.code} maxLength={40}
              autoCapitalize="none" spellCheck={false} onChange={(e) => setNw({ ...nw, code: e.target.value })} />
          </div>
          <div className="adm-row adm-row--wrap">
            <Button type="submit" busy={creating}>{t.acc.amenityAdd}</Button>
            <Button variant="ghost" onClick={() => { returnFocus.current = true; setAdding(false); setAddNotice(null); setAddErrors({}); }}>{t.common.close}</Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- images

function ImagesManager({ unit, canEdit, onSaved, onError }: {
  unit: AdminUnitDto; canEdit: boolean; onSaved: (u: AdminUnitDto) => void; onError: (e: unknown) => void;
}) {
  const { t } = useAdmin();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const base = `/api/admin/accommodations/${encodeURIComponent(unit.id)}`;

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      let latest = unit;
      for (const file of Array.from(files)) {
        const asset = await uploadImage(file, "ACCOMMODATION");
        latest = await apiRequest<AdminUnitDto>("POST", `${base}/images`, { mediaAssetId: asset.id });
      }
      onSaved(latest);
    } catch (err) {
      onError(err);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  const act = (fn: () => Promise<AdminUnitDto>) => fn().then(onSaved).catch(onError);
  const move = (index: number, delta: number) => {
    const ids = unit.images.map((i) => i.id);
    const [item] = ids.splice(index, 1);
    ids.splice(index + delta, 0, item!);
    void act(() => apiRequest("PUT", `${base}/images/order`, { imageIds: ids }));
  };

  return (
    <div className="adm-card">
      <div className="adm-pagehead">
        <h2 className="adm-h2">{t.acc.images}</h2>
        {canEdit && (
          <div>
            <input ref={input} id="unit-upload" type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple
              className="visually-hidden" onChange={(e) => void upload(e.target.files)} />
            <label htmlFor="unit-upload" className="adm-btn adm-btn--primary" aria-busy={uploading || undefined}>
              {uploading ? t.acc.uploading : `+ ${t.acc.upload}`}
            </label>
          </div>
        )}
      </div>
      <p className="adm-muted adm-small">{t.acc.uploadHint}</p>
      {unit.images.length === 0 && <div className="adm-empty">{t.acc.noImages}</div>}
      <ul className="adm-images">
        {unit.images.map((img, i) => (
          <li key={img.id} className={`adm-image ${img.status !== "PUBLISHED" ? "adm-image--hidden" : ""}`}>
            <img src={img.url} alt={img.texts.th?.altText ?? ""} loading="lazy" />
            <div className="adm-image__tags">
              {img.isCover && <span className="adm-chip">{t.acc.cover}</span>}
              {img.status !== "PUBLISHED" && <span className="adm-chip adm-chip--muted">{t.acc.hidden}</span>}
            </div>
            {canEdit && (
              <div className="adm-image__actions">
                <button type="button" className="adm-iconbtn" aria-label={t.acc.moveLeft} disabled={i === 0} onClick={() => move(i, -1)}>←</button>
                <button type="button" className="adm-iconbtn" aria-label={t.acc.moveRight} disabled={i === unit.images.length - 1} onClick={() => move(i, 1)}>→</button>
                {!img.isCover && <button type="button" className="adm-linkbtn" onClick={() => void act(() => apiRequest("PUT", `${base}/cover`, { mediaAssetId: img.mediaAssetId }))}>{t.acc.setCover}</button>}
                <button type="button" className="adm-linkbtn"
                  onClick={() => void act(() => apiRequest("PATCH", `${base}/images/${img.id}`, { status: img.status === "PUBLISHED" ? "UNPUBLISHED" : "PUBLISHED" }))}>
                  {img.status === "PUBLISHED" ? t.acc.unpublish : t.acc.publish}
                </button>
                <button type="button" className="adm-linkbtn" aria-expanded={editing === img.id} onClick={() => setEditing(editing === img.id ? null : img.id)}>{t.acc.editTexts}</button>
                <button type="button" className="adm-linkbtn adm-linkbtn--danger" onClick={() => setConfirmRemove(img.id)}>{t.acc.remove}</button>
              </div>
            )}
            {editing === img.id && (
              <ImageTexts assetId={img.mediaAssetId} texts={img.texts}
                onDone={async () => { setEditing(null); onSaved(await apiGet<AdminUnitDto>(base)); }} onError={onError} />
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog open={confirmRemove !== null} message={t.acc.removeImageConfirm} confirmLabel={t.acc.remove} danger
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => { const id = confirmRemove; setConfirmRemove(null); if (id) void act(() => apiRequest("DELETE", `${base}/images/${id}`)); }} />
    </div>
  );
}

function ImageTexts({ assetId, texts, onDone, onError }: {
  assetId: string; texts: Partial<Record<LocaleCode, MediaTextDto>>; onDone: () => void; onError: (e: unknown) => void;
}) {
  const { t } = useAdmin();
  const [draft, setDraft] = useState(() => Object.fromEntries(LOCALES.map((l) => [l.code, {
    altText: texts[l.code]?.altText ?? "", caption: texts[l.code]?.caption ?? "",
  }])) as Record<LocaleCode, { altText: string; caption: string }>);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const body = Object.fromEntries(LOCALES.map((l) => [l.code, {
        altText: draft[l.code].altText.trim() || null, title: null, caption: draft[l.code].caption.trim() || null,
      }]));
      await apiRequest("PUT", `/api/admin/media/${encodeURIComponent(assetId)}/texts`, { texts: body });
      onDone();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <form className="adm-subform" onSubmit={submit} noValidate>
      {LOCALES.map((l) => (
        <div key={l.code} className="adm-grid2" lang={l.code}>
          <Field label={`${t.acc.altText} (${l.shortLabel})`} value={draft[l.code].altText} maxLength={250}
            onChange={(e) => setDraft({ ...draft, [l.code]: { ...draft[l.code], altText: e.target.value } })} />
          <Field label={`${t.acc.caption} (${l.shortLabel})`} value={draft[l.code].caption} maxLength={500}
            onChange={(e) => setDraft({ ...draft, [l.code]: { ...draft[l.code], caption: e.target.value } })} />
        </div>
      ))}
      <Button type="submit">{t.acc.saveTexts}</Button>
    </form>
  );
}

// ---------------------------------------------------------------- blocks & delete

function BlocksForm({ unit, onDone, onError }: { unit: AdminUnitDto; onDone: () => void; onError: (e: unknown) => void }) {
  const { t } = useAdmin();
  const [f, setF] = useState({ startDate: "", endDate: "", reason: "" });
  const base = `/api/admin/accommodations/${encodeURIComponent(unit.id)}/blocks`;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onDone();
    } catch (err) {
      onError(err);
    }
  };
  return (
    <form className="adm-card" onSubmit={(e) => { e.preventDefault(); void run(() => apiRequest("POST", base, f)); }} noValidate>
      <h2 className="adm-h2">{t.acc.blocks}</h2>
      <div className="adm-grid3">
        <Field label={t.acc.startDate} type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: f.endDate || e.target.value })} />
        <Field label={t.acc.endDate} type="date" required min={f.startDate} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        <Field label={t.acc.reason} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={200} />
      </div>
      <div className="adm-row adm-row--wrap">
        <Button type="submit" disabled={!f.startDate || !f.endDate || !f.reason.trim()}>{t.acc.blockDates}</Button>
        <Button variant="secondary" disabled={!f.startDate || !f.endDate}
          onClick={() => void run(() => apiRequest("DELETE", `${base}?startDate=${f.startDate}&endDate=${f.endDate}`))}>
          {t.acc.unblockDates}
        </Button>
      </div>
    </form>
  );
}

function DeleteUnit({ unit, onDeleted, onError }: { unit: AdminUnitDto; onDeleted: () => void; onError: (e: unknown) => void }) {
  const { t } = useAdmin();
  const [open, setOpen] = useState(false);
  return (
    <div className="adm-card">
      <Button variant="danger" onClick={() => setOpen(true)}>{t.acc.deleteUnit}</Button>
      <ConfirmDialog open={open} message={t.acc.deleteUnitConfirm} confirmLabel={t.acc.deleteUnit} danger onCancel={() => setOpen(false)}
        onConfirm={async () => {
          setOpen(false);
          try {
            await apiRequest("DELETE", `/api/admin/accommodations/${encodeURIComponent(unit.id)}`);
            onDeleted();
          } catch (err) {
            onError(err);
          }
        }} />
    </div>
  );
}
