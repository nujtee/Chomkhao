import { useEffect, useRef } from "react";
import { MENU_ACCESS, type AdminMenuPath } from "../../../shared/admin-menu.ts";
import type { AdminUserDto, PermissionCode, RoleDto } from "../../../shared/auth-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { useAdmin } from "../AdminContext.tsx";
import { ADMIN_NAV, type NavItem } from "../nav.ts";

export type Overrides = Record<string, "GRANT" | "DENY">;

/** Same rule as the Worker (rbac.repository): role permissions ∪ GRANT − DENY. */
export function hasPermission(code: string, rolePerms: ReadonlySet<string>, overrides: Overrides): boolean {
  const o = overrides[code];
  return o === "GRANT" ? true : o === "DENY" ? false : rolePerms.has(code);
}

/**
 * Turn `codes` on or off for one user with as few overrides as possible: a permission the roles already give
 * (or already withhold) gets no override; anything else becomes a GRANT or a DENY.
 */
export function setPermissions(codes: readonly string[], on: boolean, rolePerms: ReadonlySet<string>, overrides: Overrides): Overrides {
  const next = { ...overrides };
  for (const code of codes) {
    if (rolePerms.has(code) === on) delete next[code];
    else next[code] = on ? "GRANT" : "DENY";
  }
  return next;
}

function Check({ checked, indeterminate = false, disabled, label, title, onChange }: {
  checked: boolean; indeterminate?: boolean; disabled: boolean; label: string; title?: string; onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input ref={ref} type="checkbox" className="adm-access__check" checked={checked} disabled={disabled} aria-label={label} title={title}
      onChange={(e) => onChange(e.currentTarget.checked)} />
  );
}

/**
 * Users → a user → Menu access: for every sidebar item, may this user see it, and manage what is in it.
 * The ticks show the user's effective permissions (roles ± their own overrides) and edit only the overrides,
 * which the existing PUT /api/admin/users/:id/permissions saves — the Worker still checks every permission
 * and that a non-Super-Admin only hands out permissions they hold themselves.
 */
export function MenuAccessEditor({ user, roles, overrides, onChange }: {
  user: AdminUserDto;
  roles: RoleDto[];
  overrides: Overrides;
  onChange: (next: Overrides) => void;
}) {
  const { t, can, me, hiddenMenu } = useAdmin();
  const u = t.users;
  if (user.roles.includes("SUPER_ADMIN")) return <p className="adm-muted">{u.superAdminAll}</p>;

  const rolePerms = new Set<string>(roles.filter((r) => user.roles.includes(r.code)).flatMap((r) => r.permissions));
  const isSuperAdmin = !!me?.roles.includes("SUPER_ADMIN");
  /** Turning these on needs a GRANT for each the roles do not give — only of permissions the editor holds. */
  const canTurnOn = (codes: PermissionCode[]) => isSuperAdmin || codes.every((c) => rolePerms.has(c) || can(c));
  const has = (code: string) => hasPermission(code, rolePerms, overrides);
  const set = (codes: string[], on: boolean) => onChange(setPermissions(codes, on, rolePerms, overrides));

  const allItems = ADMIN_NAV.flatMap((g) => g.items);
  const codesOf = (path: string) => {
    const a = MENU_ACCESS[path as AdminMenuPath];
    return [a.view, ...a.manage];
  };
  /** Other items using any of the same permissions: their ticks move together. */
  const sharing = (item: NavItem) => {
    const mine = codesOf(item.path);
    return allItems.filter((o) => o.path !== item.path && codesOf(o.path).some((c) => mine.includes(c))).map((o) => o.label(t));
  };
  /** Manage permissions only this item uses — the ones that go when "See" is unticked. */
  const ownManage = (item: NavItem) =>
    MENU_ACCESS[item.path as AdminMenuPath].manage.filter((c) => !allItems.some((o) => o.path !== item.path && codesOf(o.path).includes(c)));
  // Credit management (migration 0027) belongs to the SUPER_ADMIN role alone: never handed out per user.
  const grantable = (item: NavItem) => item.permission !== "credits.manage";
  const groups = [
    { id: "top", label: u.topLevel, items: ADMIN_NAV.filter((g) => !g.label).flatMap((g) => g.items).filter(grantable) },
    ...ADMIN_NAV.filter((g) => g.label).map((g) => ({ id: g.id, label: g.label!(t), items: g.items.filter(grantable) })),
  ];

  const row = (item: NavItem) => {
    const { view, manage } = MENU_ACCESS[item.path as AdminMenuPath];
    const name = item.label(t);
    const seeOn = has(view);
    const manageOn = manage.filter(has).length;
    const custom = [view, ...manage].some((c) => overrides[c]);
    const shared = sharing(item);
    const viewBlocked = !seeOn && !canTurnOn([view]);
    const manageBlocked = manageOn < manage.length && !canTurnOn([view, ...manage]);
    return (
      <tr key={item.path}>
        <th scope="row">
          {name}
          {custom && <span className="adm-badge adm-badge--warning adm-access__custom">{u.custom}</span>}
          {hiddenMenu.includes(item.path) && <div className="adm-muted adm-small">{u.hiddenForAll}</div>}
          {shared.length > 0 && <div className="adm-muted adm-small">{format(u.sharedWith, { names: shared.join(", ") })}</div>}
        </th>
        <td className="adm-access__cell">
          {/* Not seeing a menu means not managing it either — except permissions other menus use too. */}
          <Check checked={seeOn} disabled={viewBlocked} label={format(u.viewOf, { menu: name })} title={viewBlocked ? u.cannotGrant : undefined}
            onChange={(on) => set(on ? [view] : [view, ...ownManage(item)], on)} />
        </td>
        <td className="adm-access__cell">
          {manage.length === 0 ? <span className="adm-muted" aria-hidden="true">—</span> : (
            // A menu the user cannot open cannot be managed there, even when a shared permission is on for another menu.
            <Check checked={seeOn && manageOn === manage.length} indeterminate={seeOn && manageOn > 0 && manageOn < manage.length}
              disabled={manageBlocked}
              label={format(u.manageOf, { menu: name })} title={manageBlocked ? u.cannotGrant : undefined}
              onChange={(on) => set(on ? [view, ...manage] : manage, on)} />
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="adm-tablewrap">
      <table className="adm-table adm-access">
        <thead>
          <tr>
            <th scope="col">{u.colMenu}</th>
            <th scope="col" className="adm-access__cell">{u.colView}</th>
            <th scope="col" className="adm-access__cell">{u.colManage}</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.id}>
            <tr className="adm-access__group"><th scope="colgroup" colSpan={3}>{g.label}</th></tr>
            {g.items.map(row)}
          </tbody>
        ))}
      </table>
    </div>
  );
}
