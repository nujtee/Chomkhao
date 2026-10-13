import { useEffect, useState, type ReactNode } from "react";
import { LOCALES } from "../../shared/i18n/locales.ts";
import { adminPath, pagePath } from "../../shared/routes.ts";
import { Link, useRouter } from "../router/Router.tsx";
import { useAdmin } from "./AdminContext.tsx";
import { ADMIN_NAV } from "./nav.ts";

/** Expanded sidebar groups, remembered in this browser (best effort: storage may be unavailable). */
const NAV_STORE = "pk_admin_nav_open";
function readOpenGroups(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(NAV_STORE) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function AdminLayout({ currentPath, children }: { currentPath: string; children: ReactNode }) {
  const { t, me, can, href, logout, locale, hiddenMenu } = useAdmin();
  const { pathname } = useRouter();
  const [open, setOpen] = useState(false);

  // Sidebar groups start collapsed; the group of the page being shown is always opened on arrival.
  const activeGroup = ADMIN_NAV.find((g) => g.label && g.items.some((i) => i.path === currentPath))?.id;
  const [openGroups, setOpenGroups] = useState<string[]>(() => {
    const saved = readOpenGroups();
    return activeGroup && !saved.includes(activeGroup) ? [...saved, activeGroup] : saved;
  });
  useEffect(() => {
    if (activeGroup) setOpenGroups((g) => (g.includes(activeGroup) ? g : [...g, activeGroup]));
  }, [activeGroup]);
  useEffect(() => {
    try {
      localStorage.setItem(NAV_STORE, JSON.stringify(openGroups));
    } catch {
      // private mode / storage blocked: the menu still works, it just is not remembered
    }
  }, [openGroups]);
  const toggleGroup = (id: string) => setOpenGroups((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Same admin page in another language.
  const rest = pathname.split("/").slice(3);

  return (
    <div className="adm-shell">
      <a className="skip-link" href="#adm-main">{t.nav.adminNavigation}</a>
      <header className="adm-topbar">
        <button
          type="button"
          className="adm-topbar__menu"
          aria-expanded={open}
          aria-controls="adm-sidebar"
          aria-label={open ? t.nav.closeMenu : t.nav.openMenu}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <Link to={href()} className="adm-topbar__title">Admin</Link>
        <nav className="adm-topbar__langs" aria-label={t.common.language}>
          {LOCALES.map((l) => (
            <Link
              key={l.code}
              to={`${adminPath(l)}${rest.length ? `/${rest.join("/")}` : ""}`}
              lang={l.code}
              aria-current={l.code === locale.code ? "true" : undefined}
            >
              {l.shortLabel}
            </Link>
          ))}
        </nav>
        <div className="adm-topbar__user">
          <span className="adm-topbar__name">{me?.displayName}</span>
          <Link to={href("change-password")} className="adm-topbar__link">{t.nav.changePassword}</Link>
          <button type="button" className="adm-topbar__link" onClick={() => void logout()}>{t.auth.logout}</button>
        </div>
      </header>

      <aside id="adm-sidebar" className={`adm-sidebar ${open ? "adm-sidebar--open" : ""}`}>
        <nav aria-label={t.nav.adminNavigation}>
          {ADMIN_NAV.map((group) => {
            const items = group.items.filter((item) => can(item.permission) && !hiddenMenu.includes(item.path));
            if (items.length === 0) return null;
            const label = group.label?.(t);
            const listId = `adm-nav-${group.id}`;
            const expanded = !label || openGroups.includes(group.id);
            return (
              <div key={group.id} className="adm-nav__group">
                {label && (
                  <button
                    type="button"
                    className={`adm-nav__toggle${group.id === activeGroup ? " adm-nav__toggle--current" : ""}`}
                    aria-expanded={expanded}
                    aria-controls={listId}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <span>{label}</span>
                    <svg className="adm-nav__chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
                <ul id={listId} className={label ? "adm-nav__sub" : undefined} hidden={!expanded}>
                  {items.map((item) => (
                    <li key={item.path}>
                      <Link
                        to={href(...(item.path ? [item.path] : []))}
                        className={`adm-nav__link ${label ? "adm-nav__link--sub" : "adm-nav__link--top"} ${item.ready ? "" : "adm-nav__link--soon"}`}
                        aria-current={currentPath === item.path ? "page" : undefined}
                      >
                        {label && <span className="adm-nav__dash" aria-hidden="true">-</span>}
                        {item.label(t)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="adm-nav__group">
            <a className="adm-nav__link" href={pagePath(locale, "home")} target="_blank" rel="noopener">{t.nav.viewSite} ↗</a>
          </div>
        </nav>
        {/* Mobile only: account actions + language (the top bar is too narrow). */}
        <div className="adm-sidebar__account">
          <p className="adm-nav__heading">{me?.displayName}</p>
          <nav className="adm-sidebar__langs" aria-label={t.common.language}>
            {LOCALES.map((l) => (
              <Link key={l.code} to={`${adminPath(l)}${rest.length ? `/${rest.join("/")}` : ""}`} lang={l.code}
                aria-current={l.code === locale.code ? "true" : undefined}>
                {l.shortLabel}
              </Link>
            ))}
          </nav>
          <Link to={href("change-password")} className="adm-nav__link">{t.nav.changePassword}</Link>
          <button type="button" className="adm-nav__link adm-nav__button" onClick={() => void logout()}>{t.auth.logout}</button>
        </div>
      </aside>
      {open && <div className="adm-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}

      <main id="adm-main" className="adm-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
