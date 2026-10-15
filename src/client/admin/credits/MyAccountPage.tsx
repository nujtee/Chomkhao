import { useEffect, useState } from "react";
import type { MyLineCodeDto, MyLineDto } from "../../../shared/credit-types.ts";
import { fill } from "../../../shared/i18n/admin-credit-messages.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, useDateFormatter } from "../ui.tsx";
import { creditError, useCreditTexts } from "./creditUi.tsx";

/** My account: the signed-in user's own LINE for credit notices (and a link to change the password). */
export function MyAccountPage() {
  const { t, me, href, can, locale } = useAdmin();
  const m = useCreditTexts();
  const date = useDateFormatter();
  const [line, setLine] = useState<MyLineDto | null>(null);
  const [code, setCode] = useState<MyLineCodeDto | null>(null);
  const [state, setState] = useState<"PENDING" | "LINKED" | "EXPIRED" | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = can("credits.view");

  useEffect(() => {
    if (!allowed) return;
    apiGet<MyLineDto>("/api/admin/me/line").then(setLine, (err: unknown) => setMsg({ kind: "error", text: creditError(t, m, err) }));
  }, [allowed, t, m]);

  // While a code waits, ask every 4 seconds whether LINE confirmed it.
  useEffect(() => {
    if (!code || state !== "PENDING") return;
    const timer = setInterval(() => {
      apiGet<{ status: "PENDING" | "LINKED" | "EXPIRED" }>(`/api/admin/me/line/link-code/${encodeURIComponent(code.id)}`).then(async (r) => {
        setState(r.status);
        if (r.status === "LINKED") {
          setMsg({ kind: "success", text: m.me.done });
          setLine(await apiGet<MyLineDto>("/api/admin/me/line"));
          setCode(null);
        }
      }, () => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [code, state, m]);

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const c = await apiRequest<MyLineCodeDto>("POST", "/api/admin/me/line/link-code", { language: locale.code });
      setCode(c);
      setState("PENDING");
    } catch (err) {
      setMsg({ kind: "error", text: creditError(t, m, err) });
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      setLine(await apiRequest<MyLineDto>("DELETE", "/api/admin/me/line", {}));
    } catch (err) {
      setMsg({ kind: "error", text: creditError(t, m, err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="adm-form-narrow">
      <h1 className="adm-h1">{m.me.title}</h1>
      <p className="adm-muted">{me?.displayName} · {me?.email}</p>
      <p><Link to={href("change-password")}>{t.nav.changePassword}</Link></p>
      {allowed && (
        <div className="adm-card">
          <h2 className="adm-h2">{m.me.lineTitle}</h2>
          <p className="adm-field__hint">{m.me.lineIntro}</p>
          {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
          {!line ? <p role="status">{t.common.loading}</p> : line.linked ? (
            <div className="adm-row">
              <span className="adm-badge adm-badge--active">✓ {fill(m.me.linked, { date: date(line.linkedAt) })}</span>
              <Button variant="ghost" busy={busy} onClick={() => void unlink()}>{m.me.unlink}</Button>
            </div>
          ) : !line.available ? <Alert kind="info">{m.me.unavailable}</Alert> : (
            <>
              <p><span className="adm-badge adm-badge--muted">{m.me.notLinked}</span></p>
              {!code ? <Button busy={busy} onClick={() => void create()}>{m.me.link}</Button> : (
                <div className="adm-onetime">
                  <p>{m.me.steps}</p>
                  <p className="adm-mono adm-credit__code">{code.message}</p>
                  <div className="adm-row adm-row--wrap">
                    {code.addFriendUrl && <a className="adm-btn adm-btn--secondary" href={code.addFriendUrl} target="_blank" rel="noopener">{m.me.addFriend}</a>}
                    {code.url && <a className="adm-btn adm-btn--primary" href={code.url} target="_blank" rel="noopener">{m.me.openLine}</a>}
                  </div>
                  <p className="adm-field__hint" role="status">{state === "EXPIRED" ? m.me.expired : m.me.waiting}</p>
                  {state === "EXPIRED" && <Button variant="secondary" busy={busy} onClick={() => void create()}>{m.me.link}</Button>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
