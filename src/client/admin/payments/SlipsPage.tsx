import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { SlipQueueDto, SlipQueueItemDto, SlipVerificationDto } from "../../../shared/payment-types.ts";
import { formatBaht } from "../../../shared/booking-rules.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { useStayDate } from "../bookings/shared.tsx";
import { apiGet } from "../../api/client.ts";
import { Alert, Button, ConfirmDialog, detailMessage, useDateFormatter } from "../ui.tsx";
import { useCursorList } from "../useCursorList.ts";

type Tab = "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED";

export function useFailureText() {
  const { t } = useAdmin();
  return (code: string | null) => {
    if (!code) return "";
    const known = (t.slip as Record<string, string>)[`f${code}`];
    return known ?? format(t.slip.fOther, { code });
  };
}

function Check({ v }: { v: SlipVerificationDto }) {
  const { t, locale } = useAdmin();
  const dateTime = useDateFormatter();
  const failure = useFailureText();
  return (
    <li className={`adm-check adm-check--${v.result.toLowerCase()}`}>
      <strong>{v.method === "AUTO" ? `${t.slip.auto}${v.provider ? ` (${v.provider})` : ""}` : `${t.slip.manual}${v.verifiedByName ? ` · ${v.verifiedByName}` : ""}`}</strong>
      {" · "}{t.slip[`r${v.result}`]}
      {v.failureCode && <> — {failure(v.failureCode)}</>}
      <div className="adm-small adm-muted">
        {v.amountSatang !== null && <>{t.slip.amountOnSlip}: {formatBaht(v.amountSatang, locale.code)} · </>}
        {v.transferredAt && <>{t.slip.transferredAt}: {dateTime(v.transferredAt)} · </>}
        {v.senderBank && <>{t.slip.sender}: {v.senderBank} · </>}
        {v.receiverAccountMasked && <>{t.slip.receiver}: <span className="adm-mono">{v.receiverAccountMasked}</span>{v.receiverBank && ` (${v.receiverBank})`} · </>}
        {v.transactionRef && <>{t.slip.txRef}: <span className="adm-mono">{v.transactionRef}</span> · </>}
        {dateTime(v.createdAt)}
      </div>
    </li>
  );
}

/**
 * Decline a payment: the reason goes to the guest (booking page, LINE, e-mail). The guest either pays
 * again (the booking stays held) or the booking is cancelled and its nights / tents / food released.
 */
export function DeclineDialog({ open, code, canCancel, busy, onClose, onSubmit }: {
  open: boolean; code: string; canCancel: boolean; busy: boolean; onClose: () => void;
  onSubmit: (reason: string, cancelBooking: boolean) => void;
}) {
  const { t } = useAdmin();
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [cancelBooking, setCancelBooking] = useState(true);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  const ok = reason.trim().length >= 3;
  return (
    <dialog ref={ref} className="adm-dialog slip-decline" aria-labelledby={`${id}-h`} onClose={onClose} onCancel={onClose}>
      <form method="dialog" onSubmit={(e: FormEvent) => { e.preventDefault(); if (ok) onSubmit(reason.trim(), canCancel && cancelBooking); }}>
        <h2 id={`${id}-h`} className="adm-h2">{t.slip.rejectTitle} · <span className="adm-mono">{code}</span></h2>
        <div className="adm-field">
          <label htmlFor={`${id}-reason`}>{t.slip.rejectReason}<span aria-hidden="true"> *</span></label>
          <textarea id={`${id}-reason`} rows={3} required minLength={3} maxLength={500} value={reason} aria-describedby={`${id}-hint`}
            onChange={(e) => setReason(e.currentTarget.value)} />
          <p id={`${id}-hint`} className="adm-field__hint">{t.slip.reasonHint}</p>
        </div>
        <fieldset className="adm-fieldset slip-decline__choice">
          <label className="adm-check">
            <input type="radio" name={`${id}-what`} checked={!cancelBooking || !canCancel} onChange={() => setCancelBooking(false)} />
            <span>{t.slip.payAgain}</span>
          </label>
          {canCancel && (
            <label className="adm-check">
              <input type="radio" name={`${id}-what`} checked={cancelBooking} onChange={() => setCancelBooking(true)} />
              <span>{t.slip.cancelBooking}</span>
            </label>
          )}
        </fieldset>
        <div className="adm-row adm-row--wrap adm-dialog__actions">
          <Button type="submit" variant="danger" busy={busy} disabled={!ok}>{canCancel && cancelBooking ? t.slip.cancelBooking : t.slip.reject}</Button>
          <Button variant="ghost" onClick={onClose}>{t.common.close}</Button>
        </div>
      </form>
    </dialog>
  );
}

function SlipCard({ item, approvalMode, onChanged }: { item: SlipQueueItemDto; approvalMode: SlipQueueDto["approvalMode"] | null; onChanged: (text: string) => void }) {
  const { t, can, href, locale } = useAdmin();
  const dateTime = useDateFormatter();
  const stayDate = useStayDate();
  const [ref, setRef] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canAct = item.status === "PENDING_VERIFICATION" && can("payments.verify");
  const autoPassed = item.verifications.some((v) => v.method === "AUTO" && v.result === "PASSED");

  async function approve() {
    setConfirm(false);
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", `/api/admin/payments/${encodeURIComponent(item.paymentId)}/verify`, ref.trim() ? { transactionRef: ref.trim() } : {});
      onChanged(t.slip.verifiedDone);
    } catch (err) {
      setError(detailMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function decline(reason: string, cancelBooking: boolean) {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", `/api/admin/payments/${encodeURIComponent(item.paymentId)}/reject`, { reason, cancelBooking });
      setDeclining(false);
      onChanged(cancelBooking ? t.slip.cancelledDone : t.slip.rejectedDone);
    } catch (err) {
      setDeclining(false);
      setError(detailMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="adm-card adm-slip">
      {item.slipUrl ? (
        <a href={item.slipUrl} target="_blank" rel="noopener" className="adm-slip__img" aria-label={t.slip.openSlip}>
          <img src={item.slipUrl} alt={format(t.slip.slipAlt, { code: item.bookingCode })} loading="lazy" decoding="async" />
        </a>
      ) : (
        <div className="adm-slip__img adm-slip__paypal" role="img" aria-label={t.slip.paypalItem}>
          <strong>PayPal</strong>
          {item.reference && <span className="adm-small adm-mono">{t.slip.paypalRef}: {item.reference}</span>}
        </div>
      )}
      <div className="adm-slip__body">
        <h2 className="adm-h2"><Link to={href("bookings", item.bookingCode)} className="adm-mono">{item.bookingCode}</Link></h2>
        <p className="adm-small">{item.customerName} · {stayDate(item.checkIn)} → {stayDate(item.checkOut)}</p>
        <p>
          {/* What this slip must show: the deposit on a deposit plan (the rest is taken at check-in), else the total. */}
          {t.slip.total}: <strong>{formatBaht(item.amountSatang, locale.code)}</strong>
          {item.amountSatang < item.totalSatang && <span className="adm-muted adm-small"> ({t.pay.kindDeposit} · {t.bk.total} {formatBaht(item.totalSatang, locale.code)})</span>}
          {item.channel && <> · <span className="adm-badge adm-badge--muted">{t.pay[`c${item.channel}`]}</span></>}
          {" · "}<span className="adm-muted adm-small">{t.slip.submitted} {dateTime(item.submittedAt)}</span>
        </p>
        {item.channel === "PAYPAL" && item.status === "PENDING_VERIFICATION" && <Alert kind="info">{t.slip.paypalNote}</Alert>}
        <h3 className="adm-h3">{t.slip.checks}</h3>
        {item.verifications.length === 0 ? <p className="adm-muted adm-small">{t.slip.noChecks}</p> : (
          <ul className="adm-checks">{item.verifications.map((v, i) => <Check key={i} v={v} />)}</ul>
        )}
        {canAct && autoPassed && approvalMode === "MANUAL" && <p className="adm-small adm-slip__ok">✓ {t.slip.autoPassedWaiting}</p>}
        {item.rejectedReason && <p className="adm-small"><strong>{t.slip.reasonShown}:</strong> {item.rejectedReason}</p>}
        {error && <Alert kind="error">{error}</Alert>}
        {canAct && (
          <div className="adm-slip__actions">
            <form className="adm-inline" onSubmit={(e: FormEvent) => { e.preventDefault(); setConfirm(true); }}>
              {item.slipUrl && <input aria-label={t.slip.txRefInput} placeholder={t.slip.txRefInput} maxLength={64} value={ref} onChange={(e) => setRef(e.target.value)} />}
              <Button type="submit" busy={busy}>{t.slip.approve}</Button>
            </form>
            <Button variant="danger" busy={busy} onClick={() => setDeclining(true)}>{t.slip.reject}</Button>
          </div>
        )}
      </div>
      <ConfirmDialog open={confirm} message={t.slip.verifyConfirm} confirmLabel={t.slip.approve}
        onCancel={() => setConfirm(false)} onConfirm={() => void approve()} />
      <DeclineDialog open={declining} code={item.bookingCode} canCancel={can("bookings.cancel")} busy={busy}
        onClose={() => setDeclining(false)} onSubmit={(r, c) => void decline(r, c)} />
    </article>
  );
}

/** Slip review queue (spec §27). Images are fetched from an authenticated endpoint, never from public storage. */
export function SlipsPage() {
  const { t, can, href } = useAdmin();
  const [tab, setTab] = useState<Tab>("PENDING_VERIFICATION");
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [context, setContext] = useState<Pick<SlipQueueDto, "approvalMode" | "verifierConfigured"> | null>(null);
  const buildUrl = useCallback((before: string | null) => {
    const p = new URLSearchParams({ status: tab, limit: "30" });
    if (before) p.set("before", before);
    void version;
    return `/api/admin/slips?${p}`;
  }, [tab, version]);
  const { items, cursor, loading, error, more } = useCursorList<SlipQueueItemDto>(buildUrl);
  useEffect(() => {
    apiGet<SlipQueueDto>("/api/admin/slips?status=PENDING_VERIFICATION&limit=1")
      .then((d) => setContext({ approvalMode: d.approvalMode, verifierConfigured: d.verifierConfigured }), () => undefined);
  }, [version]);
  const tabs: { value: Tab; label: string }[] = [
    { value: "PENDING_VERIFICATION", label: t.slip.pending },
    { value: "VERIFIED", label: t.slip.verified },
    { value: "REJECTED", label: t.slip.rejected },
  ];

  return (
    <section>
      <h1 className="adm-h1">{t.slip.title}</h1>
      {context && (
        <div className="adm-slip-mode" role="note">
          <p>{context.approvalMode === "AUTO" ? t.slip.modeAuto : t.slip.modeManual}</p>
          {!context.verifierConfigured && <p className="adm-small">{t.slip.noVerifier}</p>}
          {can("receiving_accounts.view") && <Link to={href("payment-settings")} className="adm-small">{t.slip.changeMode}</Link>}
        </div>
      )}
      <div role="tablist" aria-label={t.slip.title} className="adm-tabs">
        {tabs.map((x) => (
          <button key={x.value} role="tab" type="button" aria-selected={tab === x.value} className="adm-tab"
            onClick={() => { setTab(x.value); setMessage(null); }}>{x.label}</button>
        ))}
      </div>
      {message && <Alert kind="success">{message}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {!loading && items.length === 0 && <p className="adm-empty">{t.slip.empty}</p>}
      <div className="adm-slips">
        {items.map((item) => (
          <SlipCard key={item.paymentId} item={item} approvalMode={context?.approvalMode ?? null}
            onChanged={(text) => { setMessage(text); setVersion((v) => v + 1); }} />
        ))}
      </div>
      {loading && <p role="status">{t.common.loading}</p>}
      {cursor && !loading && <Button variant="secondary" onClick={more}>{t.common.loadMore}</Button>}
    </section>
  );
}
