import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AdminAvailabilityDto, CampingIntegrityDto, CampingNightDto, CampingSettingsDto, TarpNightDto } from "../../../shared/accommodation-types.ts";
import { SATANG_PER_BAHT, parseBahtToSatang } from "../../../shared/booking-rules.ts";
import { addDays, todayIn, DEFAULT_TIMEZONE } from "../../../shared/dates.ts";
import { LOCALES, type LocaleCode } from "../../../shared/i18n/locales.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import type { PaymentMode } from "../../../shared/booking-rules.ts";
import { PaymentModeField } from "./PaymentModeField.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, ConfirmDialog, detailMessage, errorMessage, Field, fieldErrors } from "../ui.tsx";

const DAYS = 21;

/** Camping (bring your own tent): settings, translations, per-night capacity (spec §12.3, §18). */
export function CampingPage() {
  const { t, can } = useAdmin();
  const [settings, setSettings] = useState<CampingSettingsDto | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    apiGet<CampingSettingsDto>("/api/admin/camping").then(setSettings)
      .catch((err: unknown) => setMessage({ kind: "error", text: errorMessage(t, err) }));
  }, [t]);

  if (!settings) return message ? <Alert kind="error">{message.text}</Alert> : <p role="status">{t.common.loading}</p>;
  const canEdit = can("camping.edit");

  return (
    <section>
      <h1 className="adm-h1">{t.acc.campingTitle}</h1>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      <SettingsForm settings={settings} canEdit={canEdit}
        onSaved={(s) => { setSettings(s); setReload((r) => r + 1); setMessage({ kind: "success", text: t.common.saved }); }}
        onError={(err) => setMessage({ kind: "error", text: detailMessage(t, err) })} />
      <IntegrityPanel canEdit={canEdit} reload={reload}
        onChanged={() => setReload((r) => r + 1)}
        onError={(err) => setMessage({ kind: "error", text: detailMessage(t, err) })}
        onDone={(text) => setMessage({ kind: "success", text })} />
      <NightlyCapacity canEdit={canEdit} reload={reload} showTarps={settings.tarpEnabled}
        onError={(err) => setMessage({ kind: "error", text: detailMessage(t, err) })}
        onSaved={() => setMessage({ kind: "success", text: t.common.saved })} />
    </section>
  );
}

function SettingsForm({ settings, canEdit, onSaved, onError }: {
  settings: CampingSettingsDto; canEdit: boolean; onSaved: (s: CampingSettingsDto) => void; onError: (e: unknown) => void;
}) {
  const { t, can } = useAdmin();
  const [f, setF] = useState({
    isEnabled: settings.isEnabled,
    maxTentsPerNight: String(settings.maxTentsPerNight),
    price: String(settings.pricePerAdultNightSatang / SATANG_PER_BAHT),
    childFreeUnderAge: String(settings.childFreeUnderAge),
    maxGuestsPerTent: settings.maxGuestsPerTent ? String(settings.maxGuestsPerTent) : "",
    tarpEnabled: settings.tarpEnabled,
    tarpPrice: String(settings.tarpPricePerNightSatang / SATANG_PER_BAHT),
    maxTarpsPerNight: String(settings.maxTarpsPerNight),
    paymentMode: settings.paymentMode ?? ("FULL" as PaymentMode),
  });
  const [tr, setTr] = useState(() => Object.fromEntries(LOCALES.map((l) => [l.code, {
    name: settings.translations[l.code]?.name ?? "", description: settings.translations[l.code]?.description ?? "",
  }])) as Record<LocaleCode, { name: string; description: string }>);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const price = parseBahtToSatang(f.price);
    if (price === null) return setErrors({ pricePerAdultNightSatang: t.errors.INVALID_PRICE });
    const tarpPrice = parseBahtToSatang(f.tarpPrice || "0");
    if (tarpPrice === null) return setErrors({ tarpPricePerNightSatang: t.errors.INVALID_PRICE });
    setBusy(true);
    setErrors({});
    try {
      const translations = Object.fromEntries(LOCALES.flatMap((l) => tr[l.code].name.trim()
        ? [[l.code, { name: tr[l.code].name.trim(), description: tr[l.code].description.trim() || null }]] : []));
      onSaved(await apiRequest<CampingSettingsDto>("PUT", "/api/admin/camping", {
        isEnabled: f.isEnabled,
        maxTentsPerNight: Number(f.maxTentsPerNight),
        pricePerAdultNightSatang: price,
        childFreeUnderAge: Number(f.childFreeUnderAge),
        maxGuestsPerTent: f.maxGuestsPerTent ? Number(f.maxGuestsPerTent) : null,
        coverAssetId: settings.coverAssetId,
        tarpEnabled: f.tarpEnabled,
        tarpPricePerNightSatang: tarpPrice,
        maxTarpsPerNight: Number(f.maxTarpsPerNight || 0),
        // Only when changed: it needs pricing.edit.
        ...(f.paymentMode !== settings.paymentMode ? { paymentMode: f.paymentMode } : {}),
        translations,
      }));
    } catch (err) {
      setErrors(fieldErrors(t, err));
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="adm-card" onSubmit={submit} noValidate>
      <h2 className="adm-h2">{t.acc.campingSettings}</h2>
      <fieldset className="adm-fieldset" disabled={!canEdit}>
        <label className="adm-check">
          <input type="checkbox" checked={f.isEnabled} onChange={(e) => setF({ ...f, isEnabled: e.target.checked })} />
          {t.acc.enabled}
        </label>
        {errors.isEnabled && <p className="adm-field__error">{errors.isEnabled}</p>}
        <div className="adm-grid2">
          <Field label={t.acc.maxTentsPerNight} type="number" min={0} max={1000} required value={f.maxTentsPerNight}
            onChange={(e) => setF({ ...f, maxTentsPerNight: e.target.value })} hint={t.acc.capacityHint} error={errors.maxTentsPerNight} />
          <Field label={t.acc.pricePerAdult} inputMode="decimal" required value={f.price} disabled={!can("pricing.edit")}
            hint={!can("pricing.edit") ? t.acc.needsPricing : undefined}
            onChange={(e) => setF({ ...f, price: e.target.value })} error={errors.pricePerAdultNightSatang} />
          <Field label={t.acc.childFreeUnderAge} type="number" min={0} max={18} required value={f.childFreeUnderAge}
            onChange={(e) => setF({ ...f, childFreeUnderAge: e.target.value })} />
          <Field label={t.acc.maxGuestsPerTent} type="number" min={1} max={50} value={f.maxGuestsPerTent}
            onChange={(e) => setF({ ...f, maxGuestsPerTent: e.target.value })} />
          <PaymentModeField id="camping-payment-mode" value={f.paymentMode} error={errors.paymentMode} onChange={(paymentMode) => setF({ ...f, paymentMode })} />
        </div>
        <fieldset className="adm-subform adm-tarp">
          <legend className="adm-h3">{t.acc.tarpTitle}</legend>
          <label className="adm-check">
            <input type="checkbox" checked={f.tarpEnabled} onChange={(e) => setF({ ...f, tarpEnabled: e.target.checked })} />
            {t.acc.tarpEnabled}
          </label>
          <div className="adm-grid2">
            <Field label={t.acc.tarpPrice} inputMode="decimal" value={f.tarpPrice} disabled={!can("pricing.edit")}
              hint={!can("pricing.edit") ? t.acc.needsPricing : undefined}
              onChange={(e) => setF({ ...f, tarpPrice: e.target.value })} error={errors.tarpPricePerNightSatang} />
            <Field label={t.acc.maxTarpsPerNight} type="number" min={0} max={1000} value={f.maxTarpsPerNight}
              onChange={(e) => setF({ ...f, maxTarpsPerNight: e.target.value })} error={errors.maxTarpsPerNight} />
          </div>
          <p className="adm-field__hint">{t.acc.tarpHint}</p>
        </fieldset>
        {LOCALES.map((l) => (
          <div key={l.code} className="adm-grid2" lang={l.code}>
            <Field label={`${t.acc.name} (${l.label})`} required={l.code === "th"} value={tr[l.code].name} maxLength={120}
              onChange={(e) => setTr({ ...tr, [l.code]: { ...tr[l.code], name: e.target.value } })} />
            <Field label={`${t.acc.description} (${l.label})`} value={tr[l.code].description} maxLength={5000}
              onChange={(e) => setTr({ ...tr, [l.code]: { ...tr[l.code], description: e.target.value } })} />
          </div>
        ))}
        {canEdit && <Button type="submit" busy={busy}>{busy ? t.common.saving : t.common.save}</Button>}
      </fieldset>
    </form>
  );
}

/** Tent counters vs bookings: shows drift and lets camping.edit recalculate (audited). */
function IntegrityPanel({ canEdit, reload, onChanged, onError, onDone }: {
  canEdit: boolean; reload: number; onChanged: () => void; onError: (e: unknown) => void; onDone: (text: string) => void;
}) {
  const { t, locale } = useAdmin();
  const [data, setData] = useState<CampingIntegrityDto | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => apiGet<CampingIntegrityDto>("/api/admin/camping/integrity").then(setData).catch(onError), [onError]);
  useEffect(() => { void load(); }, [load, reload]);

  async function recalc() {
    setConfirming(false);
    setBusy(true);
    try {
      setData(await apiRequest<CampingIntegrityDto>("POST", "/api/admin/camping/recalculate", {}));
      onDone(t.acc.recalcDone);
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;
  const fmt = new Intl.DateTimeFormat(locale.code, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <div className={`adm-card ${data.consistent ? "" : "adm-card--danger"}`} aria-live="polite">
      <h2 className="adm-h2">{t.acc.integrityTitle}</h2>
      {data.consistent ? (
        <p className="adm-muted">✓ {t.acc.integrityOk}</p>
      ) : (
        <>
          <p role="alert"><strong>{t.acc.integrityDrift.replace("{n}", String(data.drift.length + data.tarpDrift.length))}</strong></p>
          {data.drift.length > 0 && <div className="adm-tablewrap">
            <table className="adm-table">
              <thead><tr><th scope="col">{t.acc.date}</th><th scope="col" className="adm-num">{t.acc.byBookings}</th><th scope="col" className="adm-num">{t.acc.counter}</th><th scope="col" className="adm-num">{t.acc.capacity}</th></tr></thead>
              <tbody>
                {data.drift.slice(0, 31).map((d) => (
                  <tr key={d.date}>
                    <td className="adm-nowrap">{fmt.format(new Date(`${d.date}T00:00:00Z`))}</td>
                    <td className="adm-num">{d.expected}</td>
                    <td className="adm-num">{d.actual}</td>
                    <td className={`adm-num ${d.maxTents !== null && d.expected > d.maxTents ? "adm-text-error" : ""}`}>{d.maxTents ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
          {data.tarpDrift.length > 0 && (
            <div className="adm-tablewrap">
              <table className="adm-table">
                <caption className="adm-table__caption">{t.acc.tarpDriftTitle}</caption>
                <thead><tr><th scope="col">{t.acc.date}</th><th scope="col" className="adm-num">{t.acc.byBookings}</th><th scope="col" className="adm-num">{t.acc.counter}</th><th scope="col" className="adm-num">{t.acc.capacity}</th></tr></thead>
                <tbody>
                  {data.tarpDrift.slice(0, 31).map((d) => (
                    <tr key={d.date}>
                      <td className="adm-nowrap">{fmt.format(new Date(`${d.date}T00:00:00Z`))}</td>
                      <td className="adm-num">{d.expected}</td>
                      <td className="adm-num">{d.actual}</td>
                      <td className={`adm-num ${d.maxTarps !== null && d.expected > d.maxTarps ? "adm-text-error" : ""}`}>{d.maxTarps ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <div className="adm-row">
        <Button variant="secondary" onClick={() => void load()}>{t.acc.checkAgain}</Button>
        {canEdit && !data.consistent && <Button variant="danger" busy={busy} onClick={() => setConfirming(true)}>{t.acc.recalculate}</Button>}
      </div>
      <ConfirmDialog open={confirming} message={t.acc.recalcConfirm} confirmLabel={t.acc.recalculate}
        onConfirm={() => void recalc()} onCancel={() => setConfirming(false)} />
    </div>
  );
}

function NightlyCapacity({ canEdit, reload, showTarps, onError, onSaved }: {
  canEdit: boolean; reload: number; showTarps: boolean; onError: (e: unknown) => void; onSaved: () => void;
}) {
  const { t, locale } = useAdmin();
  const [from, setFrom] = useState(() => todayIn(DEFAULT_TIMEZONE));
  const [nights, setNights] = useState<CampingNightDto[]>([]);
  const [tarps, setTarps] = useState<TarpNightDto[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const grid = await apiGet<AdminAvailabilityDto>(`/api/admin/availability?from=${from}&days=${DAYS}`);
    setNights(grid.camping);
    setTarps(grid.tarps ?? []);
    setDrafts({});
  }, [from]);

  useEffect(() => {
    load().catch(onError);
  }, [load, reload, onError]);

  const setNight = async (date: string, maxTents: number | null) => {
    try {
      const updated = await apiRequest<CampingNightDto>("PUT", `/api/admin/camping/nights/${date}`, { maxTents });
      setNights((n) => n.map((x) => (x.date === date ? updated : x)));
      setDrafts((d) => ({ ...d, [date]: "" }));
      onSaved();
    } catch (err) {
      onError(err);
    }
  };

  const fmt = new Intl.DateTimeFormat(locale.code, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const tarpBy = new Map(tarps.map((n) => [n.date, n]));
  // Tarp column while the option is on, or while any shown night still has a tarp area booked.
  const tarpColumn = showTarps || tarps.some((n) => n.used > 0);
  return (
    <div className="adm-card">
      <div className="adm-pagehead">
        <h2 className="adm-h2">{t.acc.nightly}</h2>
        <div className="adm-row" style={{ marginTop: 0 }}>
          <Button variant="secondary" aria-label={t.acc.prev} onClick={() => setFrom((f) => addDays(f, -DAYS))}>←</Button>
          <Button variant="secondary" aria-label={t.acc.next} onClick={() => setFrom((f) => addDays(f, DAYS))}>→</Button>
        </div>
      </div>
      <div className="adm-tablewrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">{t.acc.date}</th>
              <th scope="col">{t.acc.capacity}</th>
              <th scope="col">{t.acc.used}</th>
              <th scope="col">{t.acc.remaining}</th>
              {tarpColumn && <th scope="col">{t.acc.tarps} ({t.acc.used}/{t.acc.capacity})</th>}
              {canEdit && <th scope="col">{t.acc.setCapacity}</th>}
            </tr>
          </thead>
          <tbody>
            {nights.map((n) => (
              <tr key={n.date}>
                <td className="adm-nowrap">{fmt.format(new Date(`${n.date}T00:00:00Z`))}</td>
                <td>{n.capacity} {n.isOverride && <span className="adm-chip">{t.acc.override}</span>}</td>
                <td>{n.used}</td>
                <td><strong className={n.remaining === 0 ? "adm-text-error" : ""}>{n.remaining}</strong></td>
                {tarpColumn && (() => {
                  const a = tarpBy.get(n.date);
                  return <td className={a && a.remaining === 0 && a.capacity > 0 ? "adm-text-error" : undefined}>{a ? `${a.used}/${a.capacity}` : "—"}</td>;
                })()}
                {canEdit && (
                  <td>
                    <form className="adm-inline" onSubmit={(e) => { e.preventDefault(); void setNight(n.date, Number(drafts[n.date])); }}>
                      <input type="number" min={n.used} max={1000} aria-label={`${t.acc.setCapacity} ${n.date}`}
                        value={drafts[n.date] ?? ""} onChange={(e) => setDrafts({ ...drafts, [n.date]: e.target.value })} />
                      <Button type="submit" variant="secondary" disabled={!drafts[n.date]}>{t.common.save}</Button>
                      {n.isOverride && <button type="button" className="adm-linkbtn" onClick={() => void setNight(n.date, null)}>{t.acc.resetToDefault}</button>}
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
