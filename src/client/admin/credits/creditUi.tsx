import { useEffect, useState } from "react";
import type { CreditSummaryDto } from "../../../shared/credit-types.ts";
import { fill, getCreditMessages, type AdminCreditMessages } from "../../../shared/i18n/admin-credit-messages.ts";
import type { AdminMessages } from "../../../shared/i18n/admin-messages.ts";
import { ApiError, apiGet } from "../../api/client.ts";
import { Link, useRouter } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { errorMessage } from "../ui.tsx";

export function useCreditTexts(): AdminCreditMessages {
  const { locale } = useAdmin();
  return getCreditMessages(locale.code);
}

/** The most specific text for an API error: a field code, the error code (credit texts first), else the admin default. */
export function creditError(t: AdminMessages, m: AdminCreditMessages, err: unknown): string {
  const known = m.errors as Record<string, string>;
  if (err instanceof ApiError) {
    for (const code of Object.values(err.details)) if (known[code]) return known[code]!;
    if (known[err.code]) return known[err.code]!;
  }
  return errorMessage(t, err);
}

/** Field errors from an API error, in the credit texts (falls back to the code). */
export function creditFieldErrors(m: AdminCreditMessages, err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const known = m.errors as Record<string, string>;
  return Object.fromEntries(Object.entries(err.details).map(([field, code]) => [field, known[code] ?? known.INVALID_FORMAT!]));
}

export function useNumber(): (n: number) => string {
  const { locale } = useAdmin();
  const nf = new Intl.NumberFormat(locale.code === "th" ? "th-TH" : locale.code === "zh-CN" ? "zh-CN" : "en-US");
  return (n: number) => nf.format(n);
}

/**
 * Credit status under the top bar (credits.view): quiet when all is well, an alert when credits run low or
 * online booking is closed, with a shortcut to Top up credits. Re-read on every page change.
 */
export function CreditStatusBar() {
  const { can, href } = useAdmin();
  const m = useCreditTexts();
  const n = useNumber();
  const { pathname } = useRouter();
  const [s, setS] = useState<CreditSummaryDto | null>(null);
  const allowed = can("credits.view");

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    apiGet<CreditSummaryDto>("/api/admin/credits/summary", controller.signal).then(setS, () => undefined);
    return () => controller.abort();
  }, [allowed, pathname]);

  if (!allowed || !s || !s.enabled) return null;
  const topUp = can("credits.topup") ? <Link to={href("credit-topup")} className="adm-credit-bar__link">{m.bar.topUp}</Link> : null;
  const numbers = (
    <span className="adm-credit-bar__numbers">
      <strong>{fill(m.bar.available, { n: n(s.available) })}</strong>
      <span>{fill(m.bar.balance, { n: n(s.balance) })}</span>
      {s.held > 0 && <span>{fill(m.bar.held, { n: n(s.held) })}</span>}
      <span className="adm-badge adm-badge--muted">{m.plans[s.plan]}</span>
    </span>
  );
  if (s.state === "NORMAL") {
    return <div className="adm-credit-bar adm-credit-bar--ok" role="status"><span className="adm-credit-bar__label">{m.bar.label}</span>{numbers}{topUp}</div>;
  }
  const empty = s.state === "EMPTY";
  return (
    <div className={`adm-credit-bar ${empty ? "adm-credit-bar--empty" : "adm-credit-bar--low"}`} role={empty ? "alert" : "status"}>
      <span className="adm-credit-bar__label">{empty ? m.bar.empty : m.bar.low}</span>
      {numbers}
      {topUp}
    </div>
  );
}
