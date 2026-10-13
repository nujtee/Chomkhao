import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { getLineMessages, type AdminLineMessages } from "../../../shared/i18n/admin-line-messages.ts";
import { LOCALES, type LocaleCode } from "../../../shared/i18n/locales.ts";
import {
  NOTIFICATION_STATUSES, NOTIFICATION_TYPES, REMINDER_DAYS_MAX,
  type LineConnectionDto, type LineLinkCodeDto, type LineLinkStatusDto, type LineRecipientDto, type LineSettingsDto, type NotificationLogDto,
} from "../../../shared/line-types.ts";
import { ApiError, apiGet, apiRequest } from "../../api/client.ts";
import { QrCode } from "../../booking/QrCode.tsx";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { PageTabs } from "../cms/CmsKit.tsx";
import { Alert, Button, ConfirmDialog, errorMessage, Field, useDateFormatter } from "../ui.tsx";
import { useCursorList } from "../useCursorList.ts";

type Tab = "connection" | "recipients" | "log";
type Msg = { kind: "error" | "success" | "info"; text: string } | null;

function useLineMessages(): AdminLineMessages {
  const { locale } = useAdmin();
  return getLineMessages(locale.code);
}

/** LINE-specific error codes first, then the shared admin dictionary. */
function useLineErrors() {
  const { t } = useAdmin();
  const m = useLineMessages();
  const lookup = (code: string) => (m.errors as Record<string, string>)[code] ?? (t.errors as Record<string, string>)[code];
  return {
    text(err: unknown): string {
      if (err instanceof ApiError) {
        for (const code of Object.values(err.details)) if (lookup(code)) return lookup(code)!;
        return lookup(err.code) ?? errorMessage(t, err);
      }
      return errorMessage(t, err);
    },
    fields(err: unknown): Record<string, string> {
      if (!(err instanceof ApiError)) return {};
      return Object.fromEntries(Object.entries(err.details).map(([k, code]) => [k, lookup(code) ?? t.errors.INVALID_FORMAT]));
    },
  };
}

function CopyButton({ value, label, done }: { value: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="secondary" onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false))}>
      {copied ? done : label}
    </Button>
  );
}

const langLabel = (code: string) => LOCALES.find((l) => l.code === code)?.label ?? code;

/** Settings → LINE (spec §47): connection + schedule, recipient chats (pairing codes), delivery log. */
export function LinePage() {
  const { can } = useAdmin();
  const m = useLineMessages();
  const canEdit = can("settings.line");
  const canLog = can("notifications.view");
  const [tab, setTab] = useState<Tab>(canEdit ? "connection" : "log");
  const tabs = [
    ...(canEdit ? [{ value: "connection" as const, label: m.tabs.connection }, { value: "recipients" as const, label: m.tabs.recipients }] : []),
    ...(canLog ? [{ value: "log" as const, label: m.tabs.log }] : []),
  ];
  return (
    <section className="line-page">
      <h1 className="adm-h1">{m.title}</h1>
      <p className="adm-muted">{m.intro}</p>
      {tabs.length > 1 && <PageTabs label={m.title} value={tab} onChange={setTab} tabs={tabs} />}
      {tab === "connection" && canEdit && <ConnectionTab />}
      {tab === "recipients" && canEdit && <RecipientsTab />}
      {tab === "log" && canLog && <LogTab />}
    </section>
  );
}

// ==================================================================== connection + schedule

function ConnectionTab() {
  const { t } = useAdmin();
  const m = useLineMessages();
  const errors = useLineErrors();
  const dateTime = useDateFormatter();
  const [s, setS] = useState<LineSettingsDto | null>(null);
  const [f, setF] = useState<LineSettingsDto | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [conn, setConn] = useState<LineConnectionDto | null>(null);

  const load = useCallback(() => apiGet<LineSettingsDto>("/api/admin/line/settings").then((d) => { setS(d); setF(d); }), []);
  useEffect(() => { load().catch((err: unknown) => setMsg({ kind: "error", text: errors.text(err) })); }, [load]);

  if (!s || !f) return msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : <p role="status">{t.common.loading}</p>;
  const set = <K extends keyof LineSettingsDto>(k: K, v: LineSettingsDto[K]) => setF({ ...f, [k]: v });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setFieldErr({});
    try {
      const saved = await apiRequest<LineSettingsDto>("PUT", "/api/admin/line/settings", {
        enabled: f!.enabled, guestEnabled: f!.guestEnabled, publicButton: f!.publicButton,
        reminderDaysBefore: f!.reminderDaysBefore, reminderTime: f!.reminderTime, sendWhenEmpty: f!.sendWhenEmpty,
      });
      setS(saved);
      setF(saved);
      setMsg({ kind: "success", text: t.common.saved });
    } catch (err) {
      setFieldErr(errors.fields(err));
      setMsg({ kind: "error", text: errors.text(err) });
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setChecking(true);
    setMsg(null);
    try {
      setConn(await apiRequest<LineConnectionDto>("POST", "/api/admin/line/check", {}));
      await load();
    } catch (err) {
      setConn(null);
      setMsg({ kind: "error", text: errors.text(err) });
    } finally {
      setChecking(false);
    }
  }

  const ok = (v: boolean) => (v ? <span className="adm-badge adm-badge--active">✓ {m.conn.set}</span> : <span className="adm-badge adm-badge--suspended">{m.conn.missing}</span>);
  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="adm-card">
        <h2 className="adm-h2">{m.conn.title}</h2>
        <dl className="adm-dl">
          <dt>{m.conn.token}</dt><dd>{ok(s.tokenConfigured)}</dd>
          <dt>{m.conn.secret}</dt><dd>{ok(s.secretConfigured)}</dd>
          <dt>{m.conn.bot}</dt>
          <dd>{s.bot.displayName ? <>{s.bot.displayName} <span className="adm-mono adm-muted">{s.bot.basicId}</span></> : <span className="adm-muted">{m.conn.notChecked}</span>}</dd>
          {s.bot.checkedAt && <><dt>{m.conn.lastChecked}</dt><dd>{dateTime(s.bot.checkedAt)}</dd></>}
          {s.addFriendUrl && <><dt>{m.conn.addFriend}</dt><dd><a href={s.addFriendUrl} target="_blank" rel="noopener noreferrer" className="adm-mono">{s.addFriendUrl}</a></dd></>}
        </dl>
        <p className="adm-field__hint">{m.conn.secretHelp}</p>
        <div className="adm-field">
          <label htmlFor="line-webhook">{m.conn.webhook}</label>
          <div className="adm-onetime__row">
            <input id="line-webhook" readOnly value={s.webhookUrl} className="adm-mono" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton value={s.webhookUrl} label={m.conn.copy} done={m.conn.copied} />
          </div>
          <p className="adm-field__hint">{m.conn.webhookHelp}</p>
        </div>
        <div className="adm-row adm-row--wrap">
          <Button variant="secondary" busy={checking} disabled={!s.tokenConfigured} onClick={() => void check()}>{m.conn.check}</Button>
          {conn && (
            <span role="status" className="adm-small">
              ✓ {m.conn.connected} · {m.conn.quota}: {conn.quotaUsed === null ? "—" : conn.quotaLimit === null
                ? format(m.conn.quotaUnlimited, { used: conn.quotaUsed })
                : format(m.conn.quotaValue, { used: conn.quotaUsed, limit: conn.quotaLimit })}
            </span>
          )}
        </div>
      </div>

      <form className="adm-card" onSubmit={(e) => void save(e)} noValidate>
        <h2 className="adm-h2">{m.settings.title}</h2>
        <fieldset className="adm-fieldset" disabled={busy}>
          <label className="adm-check"><input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.currentTarget.checked)} /><span>{m.settings.enabled}</span></label>
          {fieldErr.enabled && <p className="adm-field__error">{fieldErr.enabled}</p>}
          <label className="adm-check"><input type="checkbox" checked={f.guestEnabled} onChange={(e) => set("guestEnabled", e.currentTarget.checked)} /><span>{m.settings.guestEnabled}</span></label>
          {fieldErr.guestEnabled && <p className="adm-field__error">{fieldErr.guestEnabled}</p>}
          <label className="adm-check"><input type="checkbox" checked={f.publicButton} onChange={(e) => set("publicButton", e.currentTarget.checked)} /><span>{m.settings.publicButton}</span></label>
          {fieldErr.publicButton && <p className="adm-field__error">{fieldErr.publicButton}</p>}
          <fieldset className="adm-fieldset adm-subform">
            <legend>{m.settings.reminder}</legend>
            <div className="adm-row adm-row--wrap">
              <Field label={m.settings.daysBefore} type="number" min={0} max={REMINDER_DAYS_MAX} step={1} inputMode="numeric" value={String(f.reminderDaysBefore)}
                error={fieldErr.reminderDaysBefore} onChange={(e) => set("reminderDaysBefore", Number(e.currentTarget.value))} />
              <Field label={m.settings.time} type="time" step={60} value={f.reminderTime} error={fieldErr.reminderTime}
                onChange={(e) => set("reminderTime", e.currentTarget.value)} />
            </div>
            <p className="adm-field__hint">{format(m.settings.timezoneNote, { tz: s.timezone })}</p>
            <label className="adm-check"><input type="checkbox" checked={f.sendWhenEmpty} onChange={(e) => set("sendWhenEmpty", e.currentTarget.checked)} /><span>{m.settings.sendWhenEmpty}</span></label>
          </fieldset>
          <p className="adm-field__hint">{m.settings.linksNote}</p>
          <Button type="submit" busy={busy}>{t.common.save}</Button>
        </fieldset>
      </form>
    </>
  );
}

// ==================================================================== recipients + pairing

function RecipientsTab() {
  const { t } = useAdmin();
  const m = useLineMessages();
  const errors = useLineErrors();
  const [list, setListState] = useState<LineRecipientDto[] | null>(null);
  // Latest list for handlers (toggles fire quickly one after another; never patch from a stale row).
  const listRef = useRef<LineRecipientDto[] | null>(null);
  const setList = (next: LineRecipientDto[] | null | ((l: LineRecipientDto[] | null) => LineRecipientDto[] | null)) => {
    const value = typeof next === "function" ? next(listRef.current) : next;
    listRef.current = value;
    setListState(value);
  };
  const [settings, setSettings] = useState<LineSettingsDto | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; language: LocaleCode } | null>(null);
  const [removing, setRemoving] = useState<LineRecipientDto | null>(null);

  const load = useCallback(() => Promise.all([
    apiGet<LineRecipientDto[]>("/api/admin/line/recipients").then(setList),
    apiGet<LineSettingsDto>("/api/admin/line/settings").then(setSettings),
  ]), []);
  useEffect(() => { load().catch((err: unknown) => setMsg({ kind: "error", text: errors.text(err) })); }, [load]);

  /** Optimistic: the box changes at once; the saved row (or the old one, on error) replaces it. */
  async function patch(id: string, change: Partial<LineRecipientDto>) {
    const before = listRef.current?.find((x) => x.id === id);
    if (!before) return false;
    const next = { ...before, ...change };
    setList((l) => l?.map((x) => (x.id === id ? next : x)) ?? null);
    setBusyId(id);
    setMsg(null);
    try {
      const saved = await apiRequest<LineRecipientDto>("PATCH", `/api/admin/line/recipients/${id}`, {
        name: next.name, language: next.language, notifyCheckin: next.notifyCheckin, notifyFood: next.notifyFood,
        notifyPayment: next.notifyPayment, notifyBooking: next.notifyBooking, active: next.active,
      });
      setList((l) => l?.map((x) => (x.id === id ? saved : x)) ?? null);
      return true;
    } catch (err) {
      setList((l) => l?.map((x) => (x.id === id ? before : x)) ?? null);
      setMsg({ kind: "error", text: errors.text(err) });
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function test(r: LineRecipientDto) {
    setBusyId(r.id);
    setMsg(null);
    try {
      const log = await apiRequest<NotificationLogDto>("POST", `/api/admin/line/recipients/${r.id}/test`, {});
      setMsg(log.status === "SENT" ? { kind: "success", text: m.rec.testSent } : { kind: "error", text: format(m.rec.testFailed, { error: log.lastError ?? log.status }) });
    } catch (err) {
      setMsg({ kind: "error", text: errors.text(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(r: LineRecipientDto) {
    setRemoving(null);
    try {
      await apiRequest("DELETE", `/api/admin/line/recipients/${r.id}`);
      setList((l) => l?.filter((x) => x.id !== r.id) ?? null);
    } catch (err) {
      setMsg({ kind: "error", text: errors.text(err) });
    }
  }

  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="adm-card">
        <h2 className="adm-h2">{m.rec.title}</h2>
        {!list ? <p role="status">{t.common.loading}</p> : (
          <div className="adm-tablewrap">
            <table className="adm-table line-recipients">
              <thead>
                <tr>
                  <th scope="col">{m.rec.name}</th>
                  <th scope="col">{m.rec.language}</th>
                  <th scope="col">{m.rec.types}</th>
                  <th scope="col">{m.rec.active}</th>
                  <th scope="col"><span className="visually-hidden">{m.actions}</span></th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && <tr><td colSpan={5} className="adm-table__empty">{m.rec.empty}</td></tr>}
                {list.map((r) => {
                  const isEditing = editing?.id === r.id;
                  const busy = busyId === r.id;
                  return (
                    <tr key={r.id} className={r.active ? undefined : "line-row--off"}>
                      <td>
                        {isEditing ? (
                          <input aria-label={m.rec.name} maxLength={80} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.currentTarget.value })} />
                        ) : <strong>{r.name}</strong>}
                        <div className="adm-small adm-muted">{m.rec.kinds[r.kind]} · <span className="adm-mono">{r.targetMasked}</span> · {m.rec.via[r.linkedVia]}</div>
                      </td>
                      <td>
                        {isEditing ? (
                          <select aria-label={m.rec.language} value={editing.language} onChange={(e) => setEditing({ ...editing, language: e.currentTarget.value as LocaleCode })}>
                            {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                          </select>
                        ) : langLabel(r.language)}
                      </td>
                      <td>
                        <div className="line-types">
                          {([["notifyBooking", m.rec.booking], ["notifyCheckin", m.rec.checkin], ["notifyFood", m.rec.food], ["notifyPayment", m.rec.payment]] as const).map(([k, label]) => (
                            <label key={k} className="adm-check">
                              <input type="checkbox" checked={r[k]} disabled={busy} onChange={(e) => void patch(r.id, { [k]: e.currentTarget.checked })} />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      </td>
                      <td>
                        <label className="adm-check">
                          <input type="checkbox" checked={r.active} disabled={busy} onChange={(e) => void patch(r.id, { active: e.currentTarget.checked })} />
                          <span className="visually-hidden">{m.rec.active}</span>
                        </label>
                      </td>
                      <td>
                        <div className="adm-row adm-row--wrap line-actions">
                          {isEditing ? (
                            <>
                              <Button variant="primary" busy={busy} onClick={() => void patch(r.id, { name: editing.name, language: editing.language }).then((ok) => ok && setEditing(null))}>{m.rec.save}</Button>
                              <Button variant="ghost" onClick={() => setEditing(null)}>{m.rec.cancel}</Button>
                            </>
                          ) : (
                            <>
                              <Button variant="secondary" busy={busy} disabled={!r.active} onClick={() => void test(r)}>{m.rec.test}</Button>
                              <Button variant="ghost" onClick={() => setEditing({ id: r.id, name: r.name, language: r.language })}>{m.rec.edit}</Button>
                              <Button variant="ghost" onClick={() => setRemoving(r)}>{m.rec.remove}</Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PairingCard settings={settings} onLinked={() => void load()} />
      <ManualAdd onAdded={(r) => setList((l) => [...(l ?? []), r])} />
      <ConfirmDialog open={!!removing} danger confirmLabel={m.rec.remove} message={removing ? format(m.rec.removeConfirm, { name: removing.name }) : ""}
        onCancel={() => setRemoving(null)} onConfirm={() => removing && void remove(removing)} />
    </>
  );
}

function PairingCard({ settings, onLinked }: { settings: LineSettingsDto | null; onLinked: () => void }) {
  const { locale } = useAdmin();
  const m = useLineMessages();
  const errors = useLineErrors();
  const time = useDateFormatter();
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<LocaleCode>(locale.code);
  const [code, setCode] = useState<LineLinkCodeDto | null>(null);
  const [status, setStatus] = useState<LineLinkStatusDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll while waiting for the "LINK …" message to reach the webhook.
  useEffect(() => {
    if (!code || status?.status === "LINKED" || status?.status === "EXPIRED") return;
    const timer = window.setInterval(() => {
      apiGet<LineLinkStatusDto>(`/api/admin/line/link-codes/${code.id}`).then((s) => {
        setStatus(s);
        if (s.status === "LINKED") onLinked();
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [code, status?.status, onLinked]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCode(await apiRequest<LineLinkCodeDto>("POST", "/api/admin/line/link-codes", { name: name.trim(), language }));
      setStatus({ status: "PENDING", recipient: null });
    } catch (err) {
      setError(errors.text(err));
    } finally {
      setBusy(false);
    }
  }

  /** One person done (or the code ran out): start over for the next one. */
  function next() {
    setCode(null);
    setStatus(null);
    setName("");
    setError(null);
  }

  const addFriend = settings?.addFriendUrl ?? null;
  const done = status?.status === "LINKED" || status?.status === "EXPIRED";
  return (
    <div className="adm-card">
      <h2 className="adm-h2">{m.rec.pairTitle}</h2>
      <p>{m.rec.pairIntro}</p>
      <ol className="line-steps line-steps--pair">
        <li>
          <p>{m.rec.pairStep1}</p>
          {addFriend && (
            <div className="line-qr">
              <QrCode value={addFriend} label={m.rec.pairScanAdd} size={140} />
              <div className="line-qr__text">
                <span className="adm-label">{m.rec.pairScanAdd}</span>
                <a href={addFriend} target="_blank" rel="noopener noreferrer">{m.conn.addFriend}</a>
              </div>
            </div>
          )}
        </li>
        <li>
          <p>{m.rec.pairStep2}</p>
          {error && <Alert kind="error">{error}</Alert>}
          {!code ? (
            <form className="adm-row adm-row--wrap line-pair-form" onSubmit={(e) => void create(e)}>
              <Field label={m.rec.pairName} required maxLength={80} value={name} onChange={(e) => setName(e.currentTarget.value)} />
              <div className="adm-field">
                <label htmlFor="line-pair-lang">{m.rec.language}</label>
                <select id="line-pair-lang" value={language} onChange={(e) => setLanguage(e.currentTarget.value as LocaleCode)}>
                  {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </div>
              <Button type="submit" busy={busy} disabled={!name.trim()}>{m.rec.pairCreate}</Button>
            </form>
          ) : (
            <div className="line-code" aria-live="polite">
              {status?.status === "PENDING" && code.url && (
                <div className="line-qr">
                  <QrCode value={code.url} label={m.rec.pairScanCode} size={180} />
                  <div className="line-qr__text">
                    <span className="adm-label">{m.rec.pairScanCode}</span>
                    <a href={code.url} target="_blank" rel="noopener noreferrer">{m.rec.pairOpenLine}</a>
                  </div>
                </div>
              )}
              <span className="adm-label">{code.url ? m.rec.pairOrType : m.rec.pairMessage}</span>
              <div className="adm-onetime__row">
                <output className="line-code__value adm-mono">{code.message}</output>
                <CopyButton value={code.message} label={m.conn.copy} done={m.conn.copied} />
              </div>
              {status?.status === "LINKED" && <Alert kind="success">{format(m.rec.pairLinked, { name: status.recipient?.name ?? "" })}</Alert>}
              {status?.status === "EXPIRED" && <Alert kind="error">{m.rec.pairExpired}</Alert>}
              {status?.status === "PENDING" && <p className="adm-small adm-muted" role="status"><span className="line-spinner" aria-hidden="true" /> {format(m.rec.pairWaiting, { time: time(code.expiresAt) })}</p>}
              {done && <div><Button onClick={next}>{m.rec.pairNext}</Button></div>}
            </div>
          )}
        </li>
        <li><p>{m.rec.pairStep3}</p></li>
      </ol>
      <p className="adm-field__hint">{m.rec.groupNote}</p>
    </div>
  );
}

function ManualAdd({ onAdded }: { onAdded: (r: LineRecipientDto) => void }) {
  const { locale } = useAdmin();
  const m = useLineMessages();
  const errors = useLineErrors();
  const empty = { targetId: "", name: "", language: locale.code as LocaleCode, notifyBooking: true, notifyCheckin: true, notifyFood: false, notifyPayment: true };
  const [f, setF] = useState(empty);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setFieldErr({});
    try {
      onAdded(await apiRequest<LineRecipientDto>("POST", "/api/admin/line/recipients", { ...f, targetId: f.targetId.trim(), name: f.name.trim() }));
      setF(empty);
      setMsg({ kind: "success", text: m.rec.added });
    } catch (err) {
      setFieldErr(errors.fields(err));
      setMsg({ kind: "error", text: errors.text(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="adm-card line-manual">
      <summary>{m.rec.manualTitle}</summary>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form onSubmit={(e) => void add(e)} noValidate>
        <fieldset className="adm-fieldset" disabled={busy}>
          <div className="adm-grid2">
            <Field label={m.rec.targetId} required spellCheck={false} autoCapitalize="off" maxLength={33} className="adm-mono" value={f.targetId}
              error={fieldErr.targetId} onChange={(e) => setF({ ...f, targetId: e.currentTarget.value })} />
            <Field label={m.rec.name} required maxLength={80} value={f.name} error={fieldErr.name} onChange={(e) => setF({ ...f, name: e.currentTarget.value })} />
          </div>
          <div className="adm-field">
            <label htmlFor="line-manual-lang">{m.rec.language}</label>
            <select id="line-manual-lang" value={f.language} onChange={(e) => setF({ ...f, language: e.currentTarget.value as LocaleCode })}>
              {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>
          <div className="line-types">
            <label className="adm-check"><input type="checkbox" checked={f.notifyBooking} onChange={(e) => setF({ ...f, notifyBooking: e.currentTarget.checked })} /><span>{m.rec.booking}</span></label>
            <label className="adm-check"><input type="checkbox" checked={f.notifyCheckin} onChange={(e) => setF({ ...f, notifyCheckin: e.currentTarget.checked })} /><span>{m.rec.checkin}</span></label>
            <label className="adm-check"><input type="checkbox" checked={f.notifyFood} onChange={(e) => setF({ ...f, notifyFood: e.currentTarget.checked })} /><span>{m.rec.food}</span></label>
            <label className="adm-check"><input type="checkbox" checked={f.notifyPayment} onChange={(e) => setF({ ...f, notifyPayment: e.currentTarget.checked })} /><span>{m.rec.payment}</span></label>
          </div>
          <Button type="submit" busy={busy} disabled={!f.targetId.trim() || !f.name.trim()}>{m.rec.add}</Button>
        </fieldset>
      </form>
    </details>
  );
}

// ==================================================================== delivery log

const TONE: Record<string, string> = { SENT: "active", PENDING: "warning", FAILED: "suspended", CANCELLED: "muted" };

function LogTab() {
  const { t, can, href } = useAdmin();
  const m = useLineMessages();
  const errors = useLineErrors();
  const dateTime = useDateFormatter();
  const [draft, setDraft] = useState({ status: "", type: "", code: "" });
  const [filters, setFilters] = useState(draft);
  const [version, setVersion] = useState(0);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canAct = can("settings.line");

  const buildUrl = useCallback((before: string | null) => {
    const params = new URLSearchParams({ limit: "50" });
    if (filters.status) params.set("status", filters.status);
    if (filters.type) params.set("type", filters.type);
    if (filters.code.trim()) params.set("code", filters.code.trim().toUpperCase());
    if (before) params.set("before", before);
    void version; // bumped after an action: a new callback makes the list reload
    return `/api/admin/notifications?${params}`;
  }, [filters, version]);
  const { items, cursor, loading, error, more } = useCursorList<NotificationLogDto>(buildUrl);
  const reason = useMemo(() => (code: string | null) => {
    if (!code) return null;
    return (m.log.reasons as Record<string, string>)[code] ?? code;
  }, [m]);

  async function act(id: string, path: string, after?: (r: unknown) => void) {
    setBusy(id);
    setMsg(null);
    try {
      const r = await apiRequest<unknown>("POST", path, {});
      after?.(r);
      setVersion((v) => v + 1);
    } catch (err) {
      setMsg({ kind: "error", text: errors.text(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <form className="adm-filters" onSubmit={(e: FormEvent) => { e.preventDefault(); setFilters({ ...draft }); /* new object: searching again reloads */ }}>
        <label className="adm-filter"><span>{m.log.status}</span>
          <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.currentTarget.value })}>
            <option value="">{m.log.all}</option>
            {NOTIFICATION_STATUSES.map((s) => <option key={s} value={s}>{m.log.statuses[s]}</option>)}
          </select>
        </label>
        <label className="adm-filter"><span>{m.log.type}</span>
          <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.currentTarget.value })}>
            <option value="">{m.log.all}</option>
            {NOTIFICATION_TYPES.map((x) => <option key={x} value={x}>{m.log.types[x]}</option>)}
          </select>
        </label>
        <label className="adm-filter adm-filter--grow"><span>{m.log.booking}</span>
          <input type="search" placeholder="BK-YYYYMMDD-XXXX" maxLength={20} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.currentTarget.value })} /></label>
        <Button type="submit" variant="secondary">{m.log.search}</Button>
        {canAct && (
          <Button variant="ghost" busy={busy === "run"} onClick={() => void act("run", "/api/admin/notifications/run", (r) => {
            const s = r as { sent: number; retried: number; failed: number; cancelled: number };
            setMsg({ kind: "info", text: format(m.log.ran, s) });
          })}>{m.log.runNow}</Button>
        )}
      </form>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="adm-tablewrap">
        <table className="adm-table line-log">
          <thead>
            <tr>
              <th scope="col">{m.log.time}</th>
              <th scope="col">{m.log.type}</th>
              <th scope="col">{m.log.recipient}</th>
              <th scope="col">{m.log.booking}</th>
              <th scope="col">{m.log.status}</th>
              <th scope="col" className="adm-num">{m.log.attempts}</th>
              {canAct && <th scope="col"><span className="visually-hidden">{m.actions}</span></th>}
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && <tr><td colSpan={canAct ? 7 : 6} className="adm-table__empty">{m.log.empty}</td></tr>}
            {items.map((n) => (
              <tr key={n.id}>
                <td className="adm-small">
                  {dateTime(n.createdAt)}
                  {n.sentAt ? <div className="adm-muted">{format(m.log.sentAt, { time: dateTime(n.sentAt) })}</div>
                    : n.status === "PENDING" && <div className="adm-muted">{format(m.log.scheduled, { time: dateTime(n.nextAttemptAt ?? n.scheduledFor) })}</div>}
                </td>
                <td>{m.log.types[n.type] ?? n.type}</td>
                <td>{n.audience === "GUEST" ? <span className="adm-badge adm-badge--muted">{m.log.guest}</span> : n.recipientName ?? "—"}</td>
                <td>{n.bookingCode ? <Link to={href("bookings", n.bookingCode)} className="adm-mono">{n.bookingCode}</Link> : "—"}</td>
                <td>
                  <span className={`adm-badge adm-badge--${TONE[n.status]}`}>{m.log.statuses[n.status]}</span>
                  {n.lastError && <div className="adm-small adm-muted line-reason">{reason(n.lastError)}</div>}
                </td>
                <td className="adm-num">{format(m.log.attemptsValue, { n: n.attempts, max: n.maxAttempts })}</td>
                {canAct && (
                  <td>
                    {(n.status === "FAILED" || n.status === "CANCELLED") && <Button variant="secondary" busy={busy === n.id} onClick={() => void act(n.id, `/api/admin/notifications/${n.id}/retry`)}>{m.log.retry}</Button>}
                    {n.status === "PENDING" && <Button variant="ghost" busy={busy === n.id} onClick={() => void act(n.id, `/api/admin/notifications/${n.id}/cancel`)}>{m.log.cancel}</Button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && <div className="adm-pager"><Button variant="secondary" busy={loading} onClick={more}>{t.common.loadMore}</Button></div>}
    </>
  );
}
