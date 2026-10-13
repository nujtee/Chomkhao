import { useEffect, useRef, useState, type FormEvent } from "react";
import { ADMIN_MENU_LOCKED, type AdminMenuDto } from "../../../shared/admin-menu.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { ADMIN_NAV, type NavItem } from "../nav.ts";
import { Alert, Button, errorMessage } from "../ui.tsx";

const LOCKED: readonly string[] = ADMIN_MENU_LOCKED;

/** A "show the whole group" box: ticked when every item shows, half-ticked when only some do. */
function GroupBox({ label, items, shown, onChange }: { label: string; items: NavItem[]; shown: Set<string>; onChange: (show: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const open = items.filter((i) => !LOCKED.includes(i.path));
  const on = open.filter((i) => shown.has(i.path)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = on > 0 && on < open.length;
  }, [on, open.length]);
  return (
    <label className="adm-check adm-menu__group">
      <input ref={ref} type="checkbox" checked={on === open.length} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  );
}

/**
 * Administration → Menu (settings.admin_menu, SUPER_ADMIN): which sidebar items everyone sees. Unticked items
 * leave every user's sidebar; permissions still decide who may open a page. The dashboard and this page stay.
 */
export function AdminMenuPage() {
  const { t, can, hiddenMenu, setHiddenMenu } = useAdmin();
  const m = t.menu;
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(hiddenMenu));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  useEffect(() => setHidden(new Set(hiddenMenu)), [hiddenMenu]);

  if (!can("settings.admin_menu")) return <Alert kind="error">{t.errors.FORBIDDEN}</Alert>;

  const all = ADMIN_NAV.flatMap((g) => g.items);
  const shown = new Set(all.map((i) => i.path).filter((p) => !hidden.has(p)));
  const set = (paths: string[], show: boolean) => {
    const next = new Set(hidden);
    for (const p of paths) {
      if (LOCKED.includes(p)) continue;
      if (show) next.delete(p);
      else next.add(p);
    }
    setHidden(next);
    setMsg(null);
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const d = await apiRequest<AdminMenuDto>("PUT", "/api/admin/menu", { hidden: [...hidden].sort() });
      setHiddenMenu(d.hidden);
      setMsg({ kind: "success", text: m.saved });
    } catch (err) {
      setMsg({ kind: "error", text: errorMessage(t, err) });
    } finally {
      setBusy(false);
    }
  }

  const item = (i: NavItem) => {
    const locked = LOCKED.includes(i.path);
    return (
      <li key={i.path}>
        <label className="adm-check">
          <input type="checkbox" checked={shown.has(i.path)} disabled={locked} onChange={(e) => set([i.path], e.currentTarget.checked)} />
          <span>{i.label(t)}{locked && <small className="adm-muted"> · {m.locked}</small>}</span>
        </label>
      </li>
    );
  };
  const topLevel = ADMIN_NAV.filter((g) => !g.label).flatMap((g) => g.items);

  return (
    <section className="adm-menu">
      <h1 className="adm-h1">{m.title}</h1>
      <p className="adm-muted">{m.intro}</p>
      <p className="adm-field__hint">{m.note}</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form onSubmit={(e) => void save(e)}>
        <div className="adm-menu__grid">
          <fieldset className="adm-card adm-menu__card">
            <legend className="adm-h2">{m.topLevel}</legend>
            <ul className="adm-menu__items">{topLevel.map(item)}</ul>
          </fieldset>
          {ADMIN_NAV.filter((g) => g.label).map((g) => (
            <fieldset key={g.id} className="adm-card adm-menu__card">
              <legend className="adm-h2">{g.label!(t)}</legend>
              <GroupBox label={m.group} items={g.items} shown={shown} onChange={(show) => set(g.items.map((i) => i.path), show)} />
              <ul className="adm-menu__items">{g.items.map(item)}</ul>
            </fieldset>
          ))}
        </div>
        <div className="adm-row adm-row--wrap adm-menu__actions">
          <Button type="submit" busy={busy}>{t.common.save}</Button>
          <Button variant="secondary" disabled={busy || hidden.size === 0} onClick={() => set(all.map((i) => i.path), true)}>{m.showAll}</Button>
          <span className="adm-muted adm-small" role="status">{format(m.shown, { n: shown.size, total: all.length })}</span>
        </div>
      </form>
    </section>
  );
}
