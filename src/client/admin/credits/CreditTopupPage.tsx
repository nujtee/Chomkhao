import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  CREDIT_PLANS, type CreditLedgerEntryDto, type CreditPaymentInfoDto, type CreditPlan, type CreditTopupDto, type Page, type TopupResultDto,
} from "../../../shared/credit-types.ts";
import { fill } from "../../../shared/i18n/admin-credit-messages.ts";
import { apiGet, apiUpload } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, useDateFormatter } from "../ui.tsx";
import { creditError, creditFieldErrors, useCreditTexts, useNumber } from "./creditUi.tsx";

/** Finance → Top up credits (credits.topup): balance, where to pay, the request form, history. */
export function CreditTopupPage() {
  const { t } = useAdmin();
  const m = useCreditTexts();
  const n = useNumber();
  const date = useDateFormatter();
  const [info, setInfo] = useState<CreditPaymentInfoDto | null>(null);
  const [mine, setMine] = useState<Page<CreditTopupDto> | null>(null);
  const [ledger, setLedger] = useState<Page<CreditLedgerEntryDto> | null>(null);
  const [plan, setPlan] = useState<CreditPlan | null>(null);
  const [amount, setAmount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [i, h, l] = await Promise.all([
        apiGet<CreditPaymentInfoDto>("/api/admin/credits/topup-info"),
        apiGet<Page<CreditTopupDto>>("/api/admin/credits/topups?mine=1&limit=10"),
        apiGet<Page<CreditLedgerEntryDto>>("/api/admin/credits/ledger?limit=20"),
      ]);
      setInfo(i);
      setMine(h);
      setLedger(l);
      setPlan((p) => p ?? (CREDIT_PLANS.find((x) => i.minimums[x] !== null) ?? null));
    } catch (err) {
      setMsg({ kind: "error", text: creditError(t, m, err) });
    }
  }, [t, m]);
  useEffect(() => void load(), [load]);

  async function more(kind: "mine" | "ledger") {
    const page = kind === "mine" ? mine : ledger;
    if (!page?.nextCursor) return;
    const path = kind === "mine" ? "/api/admin/credits/topups?mine=1&limit=10" : "/api/admin/credits/ledger?limit=20";
    try {
      const next = await apiGet<Page<never>>(`${path}&before=${encodeURIComponent(page.nextCursor)}`);
      if (kind === "mine") setMine({ items: [...mine!.items, ...(next.items as CreditTopupDto[])], nextCursor: next.nextCursor });
      else setLedger({ items: [...ledger!.items, ...(next.items as CreditLedgerEntryDto[])], nextCursor: next.nextCursor });
    } catch (err) {
      setMsg({ kind: "error", text: creditError(t, m, err) });
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!plan || !file) {
      setErrors({ ...(plan ? {} : { plan: m.errors.REQUIRED }), ...(file ? {} : { file: m.errors.REQUIRED }) });
      return;
    }
    setBusy(true);
    setMsg(null);
    setErrors({});
    const form = new FormData();
    form.set("plan", plan);
    form.set("amount", amount.trim());
    form.set("file", file);
    try {
      const r = await apiUpload<TopupResultDto>("/api/admin/credits/topups", form);
      setMsg(r.outcome === "APPROVED"
        ? { kind: "success", text: fill(m.topup.approved, { n: n(r.topup.amountCredited ?? 0) }) }
        : { kind: "info", text: m.topup.pending });
      setAmount("");
      setFile(null);
      await load();
    } catch (err) {
      setErrors(creditFieldErrors(m, err));
      setMsg({ kind: "error", text: creditError(t, m, err) });
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard blocked: the number is on screen to copy by hand
    }
  }

  if (!info) return msg ? <Alert kind="error">{msg.text}</Alert> : <p role="status">{t.common.loading}</p>;
  const s = info.summary;
  const configured = !!(info.accountNumber || info.promptpayNumber || info.qrUrl);
  const min = plan ? info.minimums[plan] : null;

  return (
    <section className="adm-credit">
      <h1 className="adm-h1">{m.topup.title}</h1>
      <p className="adm-muted">{s.enabled ? fill(m.topup.intro, { fee: n(s.feePerUnit) }) : m.topup.off}</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <div className="adm-kpis">
        <div className="adm-kpi"><span className="adm-kpi__label">{m.topup.cards.available}</span><span className="adm-kpi__value">{n(s.available)}</span>
          <span className="adm-kpi__sub">{fill(m.planCurrent, { plan: m.plans[s.plan] })}</span></div>
        <div className="adm-kpi"><span className="adm-kpi__label">{m.topup.cards.balance}</span><span className="adm-kpi__value">{n(s.balance)}</span></div>
        <div className="adm-kpi"><span className="adm-kpi__label">{m.topup.cards.held}</span><span className="adm-kpi__value">{n(s.held)}</span></div>
        {s.enabled && (
          <div className={`adm-kpi${s.state === "EMPTY" ? " adm-kpi--warn" : ""}`}>
            <span className="adm-kpi__label">{m.topup.cards.booking}</span>
            <span className="adm-kpi__value">{s.state === "EMPTY" ? m.topup.cards.closed : m.topup.cards.open}</span>
            {s.unitsLeft !== null && <span className="adm-kpi__sub">{m.topup.cards.units} {fill(m.topup.cards.unitsValue, { n: n(s.unitsLeft) })}</span>}
          </div>
        )}
      </div>

      <form className="adm-credit__steps" onSubmit={(e) => void submit(e)} noValidate>
        <div className="adm-card">
          <h2 className="adm-h2">{m.topup.planTitle}</h2>
          <div className="adm-credit__plans" role="radiogroup" aria-label={m.topup.planTitle}>
            {CREDIT_PLANS.map((p) => {
              const pmin = info.minimums[p];
              return (
                <label key={p} className={`adm-credit__plan${plan === p ? " is-selected" : ""}${pmin === null ? " is-unavailable" : ""}`}>
                  <input type="radio" name="credit-plan" value={p} checked={plan === p} disabled={pmin === null} onChange={() => setPlan(p)} />
                  <span>
                    <strong>{m.plans[p]}</strong>
                    <small>{pmin === null ? m.topup.planUnavailable : fill(m.topup.planMin, { n: n(pmin) })}</small>
                    <small>{p === "STANDARD" ? m.topup.planStandardNote : m.topup.planPremiumNote}</small>
                  </span>
                </label>
              );
            })}
          </div>
          {errors.plan && <p className="adm-field__error">{errors.plan}</p>}
          <p className="adm-field__hint">{m.topup.planHint}</p>
        </div>

        <div className="adm-card">
          <h2 className="adm-h2">{m.topup.payTitle}</h2>
          {!configured ? <Alert kind="info">{m.topup.notSetUp}</Alert> : (
            <div className="adm-credit__pay">
              {info.qrUrl && <img className="adm-credit__qr" src={info.qrUrl} alt={m.admin.qr} width={180} height={180} />}
              <dl className="adm-dl">
                {info.bankName && (<><dt>{m.topup.bank}</dt><dd>{info.bankName}</dd></>)}
                {info.accountName && (<><dt>{m.topup.accountName}</dt><dd>{info.accountName}</dd></>)}
                {info.accountNumber && (
                  <><dt>{m.topup.accountNumber}</dt><dd><span className="adm-mono">{info.accountNumber}</span>{" "}
                    <button type="button" className="adm-linkbtn" onClick={() => void copy(info.accountNumber!)}>{copied === info.accountNumber ? m.topup.copied : m.topup.copy}</button></dd></>
                )}
                {info.promptpayNumber && (
                  <><dt>{m.topup.promptpay}</dt><dd><span className="adm-mono">{info.promptpayNumber}</span>{" "}
                    <button type="button" className="adm-linkbtn" onClick={() => void copy(info.promptpayNumber!)}>{copied === info.promptpayNumber ? m.topup.copied : m.topup.copy}</button></dd></>
                )}
              </dl>
            </div>
          )}
        </div>

        <div className="adm-card">
          <h2 className="adm-h2">{m.topup.formTitle}</h2>
          <fieldset className="adm-fieldset" disabled={!configured || busy}>
            <div className="adm-grid2">
              <div className="adm-field">
                <label htmlFor="credit-amount">{m.topup.amount}<span aria-hidden="true"> *</span></label>
                <input id="credit-amount" inputMode="numeric" pattern="[0-9]*" value={amount} required min={min ?? 1}
                  aria-invalid={errors.amount ? true : undefined} aria-describedby="credit-amount-hint"
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, "").slice(0, 9))} />
                <p id="credit-amount-hint" className="adm-field__hint">{min !== null ? `${fill(m.topup.planMin, { n: n(min) })} · ` : ""}{m.topup.amountHint}</p>
                {errors.amount && <p className="adm-field__error">{errors.amount}</p>}
              </div>
              <div className="adm-field">
                <label htmlFor="credit-slip">{m.topup.slip}<span aria-hidden="true"> *</span></label>
                <input id="credit-slip" type="file" accept="image/jpeg,image/png,image/webp" required aria-describedby="credit-slip-hint"
                  aria-invalid={errors.file ? true : undefined} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <p id="credit-slip-hint" className="adm-field__hint">{m.topup.slipHint}</p>
                {errors.file && <p className="adm-field__error">{errors.file}</p>}
              </div>
            </div>
            <Button type="submit" busy={busy} disabled={!plan || !amount || !file}>{m.topup.submit}</Button>
          </fieldset>
        </div>
      </form>

      <div className="adm-card">
        <h2 className="adm-h2">{m.topup.historyTitle}</h2>
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead><tr><th scope="col">{m.cols.date}</th><th scope="col">{m.cols.plan}</th><th scope="col" className="adm-num">{m.cols.amount}</th>
              <th scope="col" className="adm-num">{m.cols.credited}</th><th scope="col">{m.cols.status}</th></tr></thead>
            <tbody>
              {!mine?.items.length && <tr><td colSpan={5} className="adm-table__empty">{m.topup.noHistory}</td></tr>}
              {mine?.items.map((x) => (
                <tr key={x.id}>
                  <td className="adm-nowrap">{date(x.createdAt)}</td>
                  <td>{m.plans[x.plan]}</td>
                  <td className="adm-num">{n(x.amountRequested)}</td>
                  <td className="adm-num">{x.amountCredited === null ? "—" : n(x.amountCredited)}</td>
                  <td>
                    <StatusBadge status={x.status} label={m.status[x.status]} />
                    {x.rejectReason && <div className="adm-small adm-muted">{x.rejectReason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {mine?.nextCursor && <Button variant="ghost" onClick={() => void more("mine")}>{m.topup.more}</Button>}
      </div>

      <div className="adm-card">
        <h2 className="adm-h2">{m.topup.ledgerTitle}</h2>
        <LedgerTable items={ledger?.items ?? []} />
        {ledger?.nextCursor && <Button variant="ghost" onClick={() => void more("ledger")}>{m.topup.more}</Button>}
      </div>
    </section>
  );
}

export function StatusBadge({ status, label }: { status: "PENDING" | "APPROVED" | "REJECTED"; label: string }) {
  const cls = status === "APPROVED" ? "adm-badge--active" : status === "REJECTED" ? "adm-badge--suspended" : "adm-badge--warning";
  return <span className={`adm-badge ${cls}`}>{label}</span>;
}

export function LedgerTable({ items }: { items: CreditLedgerEntryDto[] }) {
  const m = useCreditTexts();
  const n = useNumber();
  const date = useDateFormatter();
  return (
    <div className="adm-tablewrap">
      <table className="adm-table">
        <thead><tr><th scope="col">{m.ledger.date}</th><th scope="col">{m.ledger.type}</th><th scope="col" className="adm-num">{m.ledger.amount}</th>
          <th scope="col" className="adm-num">{m.ledger.balance}</th><th scope="col">{m.ledger.detail}</th></tr></thead>
        <tbody>
          {!items.length && <tr><td colSpan={5} className="adm-table__empty">{m.topup.noHistory}</td></tr>}
          {items.map((l) => (
            <tr key={l.id}>
              <td className="adm-nowrap">{date(l.createdAt)}</td>
              <td>{m.ledger[l.type]}{l.plan && (l.type === "TOPUP" || l.type === "PLAN_CHANGE") ? ` · ${m.plans[l.plan]}` : ""}</td>
              <td className={`adm-num ${l.amount < 0 ? "adm-text-error" : ""}`}>{l.amount > 0 ? `+${n(l.amount)}` : l.amount === 0 ? "—" : `−${n(-l.amount)}`}</td>
              <td className="adm-num">{n(l.balanceAfter)}</td>
              <td className="adm-small">
                {[l.bookingCode, l.units ? fill(m.ledger.units, { n: l.units }) : null, l.note, l.actorName].filter(Boolean).join(" · ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
