import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  CREDIT_PLANS, type CreditLedgerEntryDto, type CreditPlan, type CreditRecipientDto, type CreditSettingsDto, type CreditSettingsInput,
  type CreditSummaryDto, type CreditTopupDto, type Page,
} from "../../../shared/credit-types.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { uploadImage } from "../../media/prepareImage.ts";
import { Link } from "../../router/Router.tsx";
import { PageTabs } from "../cms/CmsKit.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, Field, useDateFormatter } from "../ui.tsx";
import { LedgerTable, StatusBadge } from "./CreditTopupPage.tsx";
import { creditError, creditFieldErrors, useCreditTexts, useNumber } from "./creditUi.tsx";

type Tab = "requests" | "balance" | "settings" | "notices";
type Msg = { kind: "error" | "success" | "info"; text: string } | null;

/** Finance → Credit management (credits.manage, SUPER_ADMIN only). */
export function CreditAdminPage() {
  const { t, can } = useAdmin();
  const m = useCreditTexts();
  const [tab, setTab] = useState<Tab>("requests");
  if (!can("credits.manage")) return <Alert kind="error">{t.errors.FORBIDDEN}</Alert>;
  return (
    <section className="adm-credit">
      <h1 className="adm-h1">{m.admin.title}</h1>
      <p className="adm-muted">{m.admin.intro}</p>
      <PageTabs<Tab> label={m.admin.title} value={tab} onChange={setTab}
        tabs={(["requests", "balance", "settings", "notices"] as const).map((v) => ({ value: v, label: m.admin.tabs[v] }))} />
      <div className="adm-credit__tab">
        {tab === "requests" && <RequestsTab />}
        {tab === "balance" && <BalanceTab />}
        {tab === "settings" && <SettingsTab />}
        {tab === "notices" && <NoticesTab />}
      </div>
    </section>
  );
}

// ================================================================ requests

function RequestsTab() {
  const { t } = useAdmin();
  const m = useCreditTexts();
  const n = useNumber();
  const date = useDateFormatter();
  const [status, setStatus] = useState<"PENDING" | "APPROVED" | "REJECTED" | "">("PENDING");
  const [page, setPage] = useState<Page<CreditTopupDto> | null>(null);
  const [open, setOpen] = useState<{ id: string; kind: "approve" | "reject" } | null>(null);
  const [amount, setAmount] = useState("");
  const [plan, setPlan] = useState<CreditPlan>("STANDARD");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    try {
      setPage(await apiGet<Page<CreditTopupDto>>(`/api/admin/credits/topups?limit=30${status ? `&status=${status}` : ""}`));
    } catch (err) {
      setMsg({ kind: "error", text: creditError(t, m, err) });
    }
  }, [status, t, m]);
  useEffect(() => void load(), [load]);

  function start(x: CreditTopupDto, kind: "approve" | "reject") {
    setOpen({ id: x.id, kind });
    setAmount(String(x.verifiedAmount ?? x.amountRequested));
    setPlan(x.plan);
    setReason("");
    setMsg(null);
  }

  async function decide(e: FormEvent) {
    e.preventDefault();
    if (!open) return;
    setBusy(true);
    try {
      if (open.kind === "approve") {
        await apiRequest("POST", `/api/admin/credit-admin/topups/${open.id}/approve`, { amount: Number(amount), plan });
      } else {
        await apiRequest("POST", `/api/admin/credit-admin/topups/${open.id}/reject`, { reason: reason.trim() });
      }
      setOpen(null);
      setMsg({ kind: "success", text: m.admin.done });
      await load();
    } catch (err) {
      setMsg({ kind: "error", text: creditError(t, m, err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="adm-toolbar">
        <label className="adm-filter">
          <span className="adm-label">{m.cols.status}</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="PENDING">{m.status.PENDING}</option>
            <option value="APPROVED">{m.status.APPROVED}</option>
            <option value="REJECTED">{m.status.REJECTED}</option>
            <option value="">{m.admin.filterAll}</option>
          </select>
        </label>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!page ? <p role="status">{t.common.loading}</p> : (
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead><tr>
              <th scope="col">{m.cols.date}</th><th scope="col">{m.cols.by}</th><th scope="col">{m.cols.plan}</th>
              <th scope="col" className="adm-num">{m.cols.amount}</th><th scope="col">{m.cols.check}</th><th scope="col">{m.cols.status}</th><th scope="col"><span className="adm-sr">{m.cols.actions}</span></th>
            </tr></thead>
            <tbody>
              {!page.items.length && <tr><td colSpan={7} className="adm-table__empty">{m.topup.noHistory}</td></tr>}
              {page.items.map((x) => (
                <tr key={x.id}>
                  <td className="adm-nowrap">{date(x.createdAt)}</td>
                  <td>{x.requestedBy.name}</td>
                  <td>{m.plans[x.plan]}</td>
                  <td className="adm-num">{n(x.amountRequested)}{x.amountCredited !== null && x.amountCredited !== x.amountRequested && <div className="adm-small adm-muted">→ {n(x.amountCredited)}</div>}</td>
                  <td className="adm-small">
                    {x.verifyResult ? m.verify[x.verifyResult] : "—"}
                    {x.verifyReasons.length > 0 && <div className="adm-muted">{x.verifyReasons.map((r) => (m.reasons as Record<string, string>)[r] ?? r).join(", ")}</div>}
                    {x.verifiedAmount !== null && <div className="adm-muted">{n(x.verifiedAmount)}</div>}
                  </td>
                  <td>
                    <StatusBadge status={x.status} label={m.status[x.status]} />
                    {x.decidedBy && <div className="adm-small adm-muted">{x.decidedBy.name}</div>}
                    {x.decidedVia === "EASYSLIP" && <div className="adm-small adm-muted">EasySlip</div>}
                    {x.rejectReason && <div className="adm-small adm-muted">{x.rejectReason}</div>}
                  </td>
                  <td className="adm-nowrap">
                    <a className="adm-linkbtn" href={`/api/admin/credits/topups/${encodeURIComponent(x.id)}/slip`} target="_blank" rel="noopener">{m.admin.viewSlip}</a>
                    {x.status === "PENDING" && (
                      <div className="adm-row">
                        <Button variant="secondary" onClick={() => start(x, "approve")}>{m.admin.approve}</Button>
                        <Button variant="ghost" onClick={() => start(x, "reject")}>{m.admin.reject}</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <form className="adm-card adm-card--focus" onSubmit={(e) => void decide(e)}>
          <h2 className="adm-h2">{open.kind === "approve" ? m.admin.approveTitle : m.admin.reject}</h2>
          <fieldset className="adm-fieldset" disabled={busy}>
            {open.kind === "approve" ? (
              <div className="adm-grid2">
                <Field label={m.admin.approveAmount} inputMode="numeric" required value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, "").slice(0, 9))} />
                <div className="adm-field">
                  <label htmlFor="approve-plan">{m.admin.approvePlan}</label>
                  <select id="approve-plan" value={plan} onChange={(e) => setPlan(e.target.value as CreditPlan)}>
                    {CREDIT_PLANS.map((p) => <option key={p} value={p}>{m.plans[p]}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <Field label={m.admin.rejectReason} required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            )}
            <div className="adm-row">
              <Button type="submit" variant={open.kind === "approve" ? "primary" : "danger"} busy={busy}
                disabled={open.kind === "approve" ? !amount || Number(amount) < 1 : reason.trim().length < 3}>{m.admin.confirm}</Button>
              <Button variant="ghost" onClick={() => setOpen(null)}>{m.admin.cancel}</Button>
            </div>
          </fieldset>
        </form>
      )}
      {page?.nextCursor && (
        <Button variant="ghost" onClick={async () => {
          try {
            const next = await apiGet<Page<CreditTopupDto>>(`/api/admin/credits/topups?limit=30${status ? `&status=${status}` : ""}&before=${encodeURIComponent(page.nextCursor!)}`);
            setPage({ items: [...page.items, ...next.items], nextCursor: next.nextCursor });
          } catch (err) {
            setMsg({ kind: "error", text: creditError(t, m, err) });
          }
        }}>{m.topup.more}</Button>
      )}
    </>
  );
}

// ================================================================ balance + plan

function BalanceTab() {
  const { t } = useAdmin();
  const m = useCreditTexts();
  const n = useNumber();
  const [s, setS] = useState<CreditSummaryDto | null>(null);
  const [ledger, setLedger] = useState<Page<CreditLedgerEntryDto> | null>(null);
  const [mode, setMode] = useState<"add" | "sub">("add");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [plan, setPlan] = useState<CreditPlan>("STANDARD");
  const [planNote, setPlanNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    try {
      const [sum, l] = await Promise.all([
        apiGet<CreditSummaryDto>("/api/admin/credits/summary"),
        apiGet<Page<CreditLedgerEntryDto>>("/api/admin/credits/ledger?limit=30"),
      ]);
      setS(sum);
      setPlan(sum.plan);
      setLedger(l);
    } catch (err) {
      setMsg({ kind: "error", text: creditError(t, m, err) });
    }
  }, [t, m]);
  useEffect(() => void load(), [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "success", text: m.admin.done });
      await load();
      return true;
    } catch (err) {
      setMsg({ kind: "error", text: creditError(t, m, err) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!s) return msg ? <Alert kind="error">{msg.text}</Alert> : <p role="status">{t.common.loading}</p>;
  return (
    <>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="adm-kpis">
        <div className="adm-kpi"><span className="adm-kpi__label">{m.topup.cards.available}</span><span className="adm-kpi__value">{n(s.available)}</span>
          <span className="adm-kpi__sub">{m.states[s.state]}</span></div>
        <div className="adm-kpi"><span className="adm-kpi__label">{m.topup.cards.balance}</span><span className="adm-kpi__value">{n(s.balance)}</span></div>
        <div className="adm-kpi"><span className="adm-kpi__label">{m.topup.cards.held}</span><span className="adm-kpi__value">{n(s.held)}</span></div>
        <div className="adm-kpi"><span className="adm-kpi__label">{m.admin.approvePlan}</span><span className="adm-kpi__value">{m.plans[s.plan]}</span></div>
      </div>

      <div className="adm-grid2 adm-grid2--gap">
        <form className="adm-card" onSubmit={async (e) => {
          e.preventDefault();
          const v = Number(amount);
          if (await run(() => apiRequest("POST", "/api/admin/credit-admin/adjustments", { amount: mode === "add" ? v : -v, note: note.trim() }))) {
            setAmount("");
            setNote("");
          }
        }}>
          <h2 className="adm-h2">{m.admin.adjustTitle}</h2>
          <fieldset className="adm-fieldset" disabled={busy}>
            <div className="adm-tabs adm-tabs--small" role="radiogroup" aria-label={m.admin.adjustTitle}>
              {(["add", "sub"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={mode === k} aria-selected={mode === k} className="adm-tab" onClick={() => setMode(k)}>
                  {k === "add" ? m.admin.adjustAdd : m.admin.adjustSub}
                </button>
              ))}
            </div>
            <Field label={m.admin.adjustAmount} inputMode="numeric" required value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, "").slice(0, 9))} />
            <Field label={m.admin.adjustNote} required minLength={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            <p className="adm-field__hint">{m.admin.adjustHint}</p>
            <Button type="submit" variant={mode === "sub" ? "danger" : "primary"} busy={busy} disabled={!amount || Number(amount) < 1 || note.trim().length < 3}>
              {mode === "add" ? m.admin.adjustAdd : m.admin.adjustSub}
            </Button>
          </fieldset>
        </form>

        <form className="adm-card" onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => apiRequest("PUT", "/api/admin/credit-admin/plan", { plan, note: planNote.trim() }))) setPlanNote("");
        }}>
          <h2 className="adm-h2">{m.admin.planTitle}</h2>
          <fieldset className="adm-fieldset" disabled={busy}>
            <div className="adm-field">
              <label htmlFor="credit-plan-set">{m.admin.approvePlan}</label>
              <select id="credit-plan-set" value={plan} onChange={(e) => setPlan(e.target.value as CreditPlan)}>
                {CREDIT_PLANS.map((p) => <option key={p} value={p}>{m.plans[p]}</option>)}
              </select>
              <p className="adm-field__hint">{plan === "STANDARD" ? m.topup.planStandardNote : m.topup.planPremiumNote}</p>
            </div>
            <Field label={m.admin.planNote} required minLength={3} maxLength={300} value={planNote} onChange={(e) => setPlanNote(e.target.value)} />
            <Button type="submit" busy={busy} disabled={plan === s.plan || planNote.trim().length < 3}>{m.admin.planSave}</Button>
          </fieldset>
        </form>
      </div>

      <div className="adm-card">
        <h2 className="adm-h2">{m.topup.ledgerTitle}</h2>
        <LedgerTable items={ledger?.items ?? []} />
        {ledger?.nextCursor && (
          <Button variant="ghost" onClick={async () => {
            const next = await apiGet<Page<CreditLedgerEntryDto>>(`/api/admin/credits/ledger?limit=30&before=${encodeURIComponent(ledger.nextCursor!)}`).catch(() => null);
            if (next) setLedger({ items: [...ledger.items, ...next.items], nextCursor: next.nextCursor });
          }}>{m.topup.more}</Button>
        )}
      </div>
    </>
  );
}

// ================================================================ settings

type Draft = Omit<CreditSettingsInput, "feePerUnit" | "lowThreshold" | "standardMin" | "premiumMin"> & {
  feePerUnit: string; lowThreshold: string; standardMin: string; premiumMin: string; qrUrl: string | null;
};

function toDraft(s: CreditSettingsDto): Draft {
  return {
    enabled: s.enabled, feePerUnit: String(s.feePerUnit), lowThreshold: String(s.lowThreshold), approvalMode: s.approvalMode,
    standardMin: s.standardMin === null ? "" : String(s.standardMin), premiumMin: s.premiumMin === null ? "" : String(s.premiumMin),
    bankName: s.bankName, accountName: s.accountName, accountNumber: s.accountNumber, promptpayNumber: s.promptpayNumber,
    qrAssetId: s.qrAssetId, qrUrl: s.qrUrl, notifyEmail: s.notifyEmail, alertTime1: s.alertTime1, alertTime2: s.alertTime2,
  };
}

function toInput(d: Draft): CreditSettingsInput {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  return {
    enabled: d.enabled, feePerUnit: Number(d.feePerUnit), lowThreshold: Number(d.lowThreshold), approvalMode: d.approvalMode,
    standardMin: num(d.standardMin), premiumMin: num(d.premiumMin), bankName: d.bankName?.trim() || null, accountName: d.accountName?.trim() || null,
    accountNumber: d.accountNumber?.trim() || null, promptpayNumber: d.promptpayNumber?.trim() || null, qrAssetId: d.qrAssetId,
    notifyEmail: d.notifyEmail?.trim() || null, alertTime1: d.alertTime1, alertTime2: d.alertTime2,
  };
}

function useSettings() {
  const { t } = useAdmin();
  const m = useCreditTexts();
  const [s, setS] = useState<CreditSettingsDto | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiGet<CreditSettingsDto>("/api/admin/credit-admin/settings").then((x) => { setS(x); setD(toDraft(x)); },
      (err: unknown) => setMsg({ kind: "error", text: creditError(t, m, err) }));
  }, [t, m]);
  const set = (patch: Partial<Draft>) => setD((x) => (x ? { ...x, ...patch } : x));
  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!d) return;
    setBusy(true);
    setMsg(null);
    setErrors({});
    try {
      const x = await apiRequest<CreditSettingsDto>("PUT", "/api/admin/credit-admin/settings", toInput(d));
      setS(x);
      setD(toDraft(x));
      setMsg({ kind: "success", text: m.admin.done });
    } catch (err) {
      setErrors(creditFieldErrors(m, err));
      setMsg({ kind: "error", text: creditError(t, m, err) });
    } finally {
      setBusy(false);
    }
  }
  return { s, d, set, save, errors, msg, setMsg, busy, setBusy };
}

function SettingsTab() {
  const { t } = useAdmin();
  const m = useCreditTexts();
  const { s, d, set, save, errors, msg, setMsg, busy, setBusy } = useSettings();
  if (!s || !d) return msg ? <Alert kind="error">{msg.text}</Alert> : <p role="status">{t.common.loading}</p>;

  async function uploadQr(file: File) {
    setBusy(true);
    try {
      const asset = await uploadImage(file, "PAYMENT_QR");
      set({ qrAssetId: asset.id, qrUrl: asset.url });
    } catch (err) {
      setMsg({ kind: "error", text: creditError(t, m, err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} noValidate>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <fieldset className="adm-fieldset" disabled={busy}>
        <div className="adm-card">
          <h2 className="adm-h2">{m.admin.settingsTitle}</h2>
          <label className="adm-check">
            <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
            <span>{m.admin.enabled}</span>
          </label>
          {d.enabled && <Alert kind="info">{m.admin.enabledWarn}</Alert>}
          <div className="adm-grid2">
            <Field label={m.admin.feePerUnit} inputMode="numeric" required value={d.feePerUnit} hint={m.admin.feeHint} error={errors.feePerUnit}
              onChange={(e) => set({ feePerUnit: e.target.value.replace(/[^0-9]/g, "").slice(0, 6) })} />
            <Field label={m.admin.lowThreshold} inputMode="numeric" required value={d.lowThreshold} error={errors.lowThreshold}
              onChange={(e) => set({ lowThreshold: e.target.value.replace(/[^0-9]/g, "").slice(0, 9) })} />
          </div>
        </div>

        <div className="adm-card">
          <h2 className="adm-h2">{m.admin.plansTitle}</h2>
          <div className="adm-grid2">
            <Field label={m.admin.standardMin} inputMode="numeric" value={d.standardMin} error={errors.standardMin} hint={m.topup.planStandardNote}
              onChange={(e) => set({ standardMin: e.target.value.replace(/[^0-9]/g, "").slice(0, 9) })} />
            <Field label={m.admin.premiumMin} inputMode="numeric" value={d.premiumMin} error={errors.premiumMin} hint={m.topup.planPremiumNote}
              onChange={(e) => set({ premiumMin: e.target.value.replace(/[^0-9]/g, "").slice(0, 9) })} />
          </div>
          <p className="adm-field__hint">{m.admin.minHint}</p>
        </div>

        <div className="adm-card">
          <h2 className="adm-h2">{m.admin.receivingTitle}</h2>
          <div className="adm-grid2">
            <Field label={m.topup.bank} maxLength={100} value={d.bankName ?? ""} error={errors.bankName} onChange={(e) => set({ bankName: e.target.value })} />
            <Field label={m.topup.accountName} maxLength={150} value={d.accountName ?? ""} error={errors.accountName} onChange={(e) => set({ accountName: e.target.value })} />
            <Field label={m.topup.accountNumber} inputMode="numeric" maxLength={24} placeholder="123-4-56789-0" value={d.accountNumber ?? ""} error={errors.accountNumber}
              onChange={(e) => set({ accountNumber: e.target.value })} />
            <Field label={m.topup.promptpay} inputMode="numeric" maxLength={20} value={d.promptpayNumber ?? ""} error={errors.promptpayNumber}
              onChange={(e) => set({ promptpayNumber: e.target.value })} />
          </div>
          <div className="adm-field">
            <span className="adm-label">{m.admin.qr}</span>
            <div className="adm-qr">
              {d.qrUrl && <img src={d.qrUrl} alt="" width={120} height={120} />}
              <label className="adm-btn adm-btn--secondary">
                {m.admin.uploadQr}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="visually-hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadQr(f); e.target.value = ""; }} />
              </label>
              {d.qrAssetId && <Button variant="ghost" onClick={() => set({ qrAssetId: null, qrUrl: null })}>{m.admin.removeQr}</Button>}
            </div>
            {errors.qrAssetId && <p className="adm-field__error">{errors.qrAssetId}</p>}
          </div>
        </div>

        <div className="adm-card">
          <h2 className="adm-h2">{m.admin.approvalTitle}</h2>
          <div className="pay-settings__modes" role="radiogroup" aria-label={m.admin.approvalTitle}>
            {(["MANUAL", "EASYSLIP"] as const).map((mode) => (
              <label key={mode} className={`pay-settings__mode${d.approvalMode === mode ? " is-selected" : ""}`}>
                <input type="radio" name="credit-approval" value={mode} checked={d.approvalMode === mode}
                  disabled={mode === "EASYSLIP" && !s.verifierConfigured} onChange={() => set({ approvalMode: mode })} />
                <span>
                  <strong>{mode === "MANUAL" ? m.admin.modeManual : m.admin.modeEasyslip}</strong>
                  <small>{mode === "MANUAL" ? m.admin.modeManualHint : m.admin.modeEasyslipHint}</small>
                </span>
              </label>
            ))}
          </div>
          {!s.verifierConfigured && <p className="adm-field__hint">{m.admin.verifierOff}</p>}
          {errors.approvalMode && <p className="adm-field__error">{errors.approvalMode}</p>}
        </div>

        <Button type="submit" busy={busy}>{m.admin.save}</Button>
      </fieldset>
    </form>
  );
}

// ================================================================ notices

function NoticesTab() {
  const { t, href } = useAdmin();
  const m = useCreditTexts();
  const { s, d, set, save, errors, msg, busy } = useSettings();
  const [people, setPeople] = useState<CreditRecipientDto[] | null>(null);
  useEffect(() => {
    apiGet<CreditRecipientDto[]>("/api/admin/credit-admin/recipients").then(setPeople, () => setPeople([]));
  }, []);
  if (!s || !d) return msg ? <Alert kind="error">{msg.text}</Alert> : <p role="status">{t.common.loading}</p>;
  return (
    <>
      <form className="adm-card" onSubmit={(e) => void save(e)} noValidate>
        <h2 className="adm-h2">{m.admin.noticeTitle}</h2>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <p className="adm-small">
          <span className={`adm-badge ${s.emailReady ? "adm-badge--active" : "adm-badge--suspended"}`}>{s.emailReady ? m.admin.emailOn : m.admin.emailOff}</span>{" "}
          <span className={`adm-badge ${s.lineReady ? "adm-badge--active" : "adm-badge--suspended"}`}>{s.lineReady ? m.admin.lineOn : m.admin.lineOff}</span>
        </p>
        <fieldset className="adm-fieldset" disabled={busy}>
          <div className="adm-grid2">
            <Field label={m.admin.notifyEmail} type="email" maxLength={254} value={d.notifyEmail ?? ""} error={errors.notifyEmail}
              onChange={(e) => set({ notifyEmail: e.target.value })} />
            <div className="adm-field">
              <span className="adm-label">{m.admin.notifyLine}</span>
              <p className="adm-field__hint">{m.admin.notifyLineHint} <Link to={href("my-account")}>{m.admin.myAccountLink}</Link></p>
            </div>
            <Field label={m.admin.alertTime1} type="time" required value={d.alertTime1} error={errors.alertTime1} onChange={(e) => set({ alertTime1: e.target.value })} />
            <Field label={m.admin.alertTime2} type="time" required value={d.alertTime2} error={errors.alertTime2} onChange={(e) => set({ alertTime2: e.target.value })} />
          </div>
          <Button type="submit" busy={busy}>{m.admin.save}</Button>
        </fieldset>
      </form>
      <div className="adm-card">
        <h2 className="adm-h2">{m.admin.recipientsTitle}</h2>
        <p className="adm-field__hint">{m.admin.recipientsHint}</p>
        {!people ? <p role="status">{t.common.loading}</p> : (
          <div className="adm-tablewrap">
            <table className="adm-table">
              <thead><tr><th scope="col">{m.admin.colName}</th><th scope="col">Email</th><th scope="col">LINE</th></tr></thead>
              <tbody>
                {!people.length && <tr><td colSpan={3} className="adm-table__empty">{m.topup.noHistory}</td></tr>}
                {people.map((p) => (
                  <tr key={p.userId}>
                    <td>{p.name}<div className="adm-small adm-muted">{p.roles.join(", ")}</div></td>
                    <td className="adm-small">{p.email}</td>
                    <td><span className={`adm-badge ${p.lineLinked ? "adm-badge--active" : "adm-badge--muted"}`}>{p.lineLinked ? m.admin.lineLinked : m.admin.lineNotLinked}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
