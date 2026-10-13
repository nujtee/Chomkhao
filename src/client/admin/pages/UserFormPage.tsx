import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  AdminUserDto,
  CreateUserResultDto,
  PasswordLinkDto,
  PermissionCode,
  PermissionDto,
  PermissionOverrideDto,
  RoleDto,
} from "../../../shared/auth-types.ts";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { LOCALES } from "../../../shared/i18n/locales.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { Link } from "../../router/Router.tsx";
import { useAdmin } from "../AdminContext.tsx";
import { MenuAccessEditor } from "./MenuAccessEditor.tsx";
import {
  Alert,
  Button,
  ConfirmDialog,
  errorMessage,
  Field,
  fieldErrors,
  OneTimeLink,
  PasswordField,
  StatusBadge,
  useDateFormatter,
} from "../ui.tsx";

type Action = "reset-password" | "suspend" | "activate" | "force-logout" | "delete" | "restore";

export function UserFormPage({ userId }: { userId: string | null }) {
  const { t, can, me, href, go, locale } = useAdmin();
  const formatDate = useDateFormatter();
  const isNew = userId === null;
  const isSelf = userId !== null && userId === me?.id;

  const [user, setUser] = useState<AdminUserDto | null>(null);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [catalog, setCatalog] = useState<PermissionDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // profile form
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [language, setLanguage] = useState<string>("");
  const [password, setPassword] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, "GRANT" | "DENY">>({});

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [link, setLink] = useState<{ title: string; value: PasswordLinkDto } | null>(null);
  const [created, setCreated] = useState<CreateUserResultDto | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);

  const applyUser = useCallback((u: AdminUserDto) => {
    setUser(u);
    setEmail(u.email);
    setUsername(u.username ?? "");
    setDisplayName(u.displayName);
    setLanguage(u.preferredLanguage ?? "");
    setSelectedRoles(u.roles);
    setOverrides(Object.fromEntries(u.permissionOverrides.map((o) => [o.code, o.effect])));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const tasks: Promise<unknown>[] = [];
    if (!isNew) tasks.push(apiGet<AdminUserDto>(`/api/admin/users/${encodeURIComponent(userId)}`, controller.signal).then(applyUser));
    if (can("roles.view")) {
      tasks.push(apiGet<RoleDto[]>(`/api/admin/roles?lang=${locale.path}`, controller.signal).then(setRoles));
      tasks.push(apiGet<PermissionDto[]>("/api/admin/permissions", controller.signal).then(setCatalog));
    }
    Promise.all(tasks).catch((err: unknown) => !controller.signal.aborted && setLoadError(errorMessage(t, err)));
    return () => controller.abort();
  }, [userId, isNew, can, applyUser, t, locale]);

  const permissionsByModule = useMemo(() => {
    const groups = new Map<string, PermissionDto[]>();
    for (const p of catalog) groups.set(p.module, [...(groups.get(p.module) ?? []), p]);
    return [...groups.entries()];
  }, [catalog]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setMessage(null);
    setFields({});
    try {
      await fn();
    } catch (err) {
      setFields(fieldErrors(t, err));
      setMessage({ kind: "error", text: errorMessage(t, err) });
    } finally {
      setBusy(null);
    }
  }

  const saveProfile = (e: FormEvent) => {
    e.preventDefault();
    void run("profile", async () => {
      const profile = {
        email: email.trim(),
        username: username.trim() || null,
        displayName: displayName.trim(),
        preferredLanguage: language || null,
      };
      if (isNew) {
        const body: Record<string, unknown> = { ...profile };
        if (profile.username === null) delete body.username;
        if (profile.preferredLanguage === null) delete body.preferredLanguage;
        if (selectedRoles.length) body.roles = selectedRoles;
        if (password) body.password = password;
        const result = await apiRequest<CreateUserResultDto>("POST", "/api/admin/users", body);
        setPassword("");
        setCreated(result);
      } else {
        applyUser(await apiRequest<AdminUserDto>("PATCH", `/api/admin/users/${encodeURIComponent(userId)}`, profile));
        setMessage({ kind: "success", text: t.common.saved });
      }
    });
  };

  const saveRoles = () =>
    run("roles", async () => {
      applyUser(await apiRequest<AdminUserDto>("PUT", `/api/admin/users/${encodeURIComponent(userId!)}/roles`, { roles: selectedRoles }));
      setMessage({ kind: "success", text: t.common.saved });
    });

  const savePermissions = () =>
    run("permissions", async () => {
      const list: PermissionOverrideDto[] = Object.entries(overrides).map(([code, effect]) => ({ code: code as PermissionCode, effect }));
      applyUser(await apiRequest<AdminUserDto>("PUT", `/api/admin/users/${encodeURIComponent(userId!)}/permissions`, { overrides: list }));
      setMessage({ kind: "success", text: t.common.saved });
    });

  const doAction = (action: Action) =>
    run(action, async () => {
      setConfirm(null);
      const path = `/api/admin/users/${encodeURIComponent(userId!)}${action === "delete" ? "" : `/${action}`}`;
      if (action === "reset-password") {
        const value = await apiRequest<PasswordLinkDto>("POST", path);
        setLink({ title: t.users.resetLinkTitle, value });
        applyUser(await apiGet<AdminUserDto>(`/api/admin/users/${encodeURIComponent(userId!)}`));
        return;
      }
      applyUser(await apiRequest<AdminUserDto>(action === "delete" ? "DELETE" : "POST", path));
      setMessage({ kind: "success", text: t.common.saved });
    });

  // ------------------------------------------------------------------ render

  if (created) {
    return (
      <section>
        <h1 className="adm-h1">{t.users.created}</h1>
        <div className="adm-card">
          <p><strong>{created.user.displayName}</strong> — {created.user.email}</p>
          {created.inviteLink && <OneTimeLink title={t.users.inviteLinkTitle} url={created.inviteLink.url} expiresAt={created.inviteLink.expiresAt} />}
          <div className="adm-row">
            <Button onClick={() => go("users", created.user.id)}>{t.users.editUser}</Button>
            <Button variant="secondary" onClick={() => go("users")}>{t.common.back}</Button>
          </div>
        </div>
      </section>
    );
  }

  if (loadError) return <Alert kind="error">{loadError}</Alert>;
  if (!isNew && !user) return <p role="status">{t.common.loading}</p>;

  const deleted = user?.status === "DELETED";
  const canEditProfile = isNew ? can("users.create") : can("users.edit") && !deleted;
  const actionLabels: Record<Action, { label: string; confirm?: string; danger?: boolean }> = {
    "reset-password": { label: t.users.resetPassword, confirm: t.users.resetPasswordConfirm, danger: true },
    suspend: { label: t.users.suspend, confirm: t.users.suspendConfirm, danger: true },
    activate: { label: t.users.activate },
    "force-logout": { label: t.users.forceLogout, confirm: t.users.forceLogoutConfirm },
    delete: { label: t.users.delete, confirm: t.users.deleteConfirm, danger: true },
    restore: { label: t.users.restore },
  };
  const availableActions: Action[] = [];
  if (user && !isSelf) {
    if (!deleted && can("users.reset_password")) availableActions.push("reset-password");
    if (user.status === "ACTIVE" && can("users.suspend")) availableActions.push("suspend");
    if (user.status === "SUSPENDED" && can("users.suspend")) availableActions.push("activate");
    if (!deleted && can("users.force_logout") && user.activeSessions > 0) availableActions.push("force-logout");
    if (!deleted && can("users.delete")) availableActions.push("delete");
    if (deleted && can("users.restore")) availableActions.push("restore");
  }

  return (
    <section>
      <p><Link to={href("users")}>← {t.users.title}</Link></p>
      <div className="adm-pagehead">
        <h1 className="adm-h1">{isNew ? t.users.newUser : user!.displayName}</h1>
        {user && <StatusBadge status={user.status} />}
      </div>
      {user && (
        <p className="adm-muted adm-small">
          {t.users.lastLogin}: {user.lastLoginAt ? formatDate(user.lastLoginAt) : t.users.never} · {t.users.activeSessions}: {user.activeSessions}
          {user.lockedUntil && new Date(user.lockedUntil) > new Date() && <> · {format(t.users.locked, { time: formatDate(user.lockedUntil) })}</>}
        </p>
      )}
      {isSelf && <Alert kind="info">{t.users.selfNote}</Alert>}
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {link && <OneTimeLink title={link.title} url={link.value.url} expiresAt={link.value.expiresAt} />}

      <form className="adm-card" onSubmit={saveProfile} noValidate>
        <h2 className="adm-h2">{t.users.profile}</h2>
        <fieldset disabled={!canEditProfile} className="adm-fieldset">
          <div className="adm-grid2">
            <Field label={t.users.name} required value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={100} error={fields.displayName} />
            <Field label={t.users.email} type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} error={fields.email} />
            <Field label={t.users.username} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32} error={fields.username} />
            <div className="adm-field">
              <label htmlFor="pref-lang">{t.users.preferredLanguage}</label>
              <select id="pref-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="">{t.common.none}</option>
                {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
          </div>
          {isNew && (
            <>
              {can("users.manage_roles") && roles.length > 0 && (
                <RolePicker roles={roles} selected={selectedRoles} onChange={setSelectedRoles} canGrantSuperAdmin={!!me?.roles.includes("SUPER_ADMIN")} />
              )}
              <PasswordField label={t.users.initialPassword} autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)} hint={t.users.initialPasswordHint} error={fields.password} maxLength={128} />
            </>
          )}
          {canEditProfile && <Button type="submit" busy={busy === "profile"}>{busy === "profile" ? t.common.saving : t.common.save}</Button>}
        </fieldset>
      </form>

      {!isNew && user && !deleted && !isSelf && can("users.manage_roles") && roles.length > 0 && (
        <div className="adm-card">
          <h2 className="adm-h2">{t.users.roles}</h2>
          <RolePicker roles={roles} selected={selectedRoles} onChange={setSelectedRoles} canGrantSuperAdmin={!!me?.roles.includes("SUPER_ADMIN")} />
          <Button onClick={() => void saveRoles()} busy={busy === "roles"}>{t.common.save}</Button>
        </div>
      )}

      {!isNew && user && !deleted && !isSelf && can("users.manage_permissions") && catalog.length > 0 && (
        <div className="adm-card" role="group" aria-labelledby="menu-access-h">
          <h2 className="adm-h2" id="menu-access-h">{t.users.menuAccess}</h2>
          <p className="adm-muted adm-small">{t.users.menuAccessHint}</p>
          {[...selectedRoles].sort().join() !== [...user.roles].sort().join() && <Alert kind="info">{t.users.saveRolesFirst}</Alert>}
          <MenuAccessEditor user={user} roles={roles} overrides={overrides} onChange={setOverrides} />
          {!user.roles.includes("SUPER_ADMIN") && (
            <div className="adm-row adm-row--wrap adm-access__actions">
              <Button onClick={() => void savePermissions()} busy={busy === "permissions"}>{t.common.save}</Button>
              <Button variant="secondary" disabled={Object.keys(overrides).length === 0} onClick={() => setOverrides({})}>{t.users.resetToRoles}</Button>
            </div>
          )}
          <details className="adm-access__advanced">
          <summary>{t.users.advanced}</summary>
          <p className="adm-muted adm-small">{t.users.permissionOverridesHint}</p>
          {permissionsByModule.map(([module, perms]) => (
            <fieldset key={module} className="adm-permgroup">
              <legend>{module}</legend>
              {perms.map((p) => (
                <div key={p.code} className="adm-permrow">
                  <label htmlFor={`ov-${p.code}`}>
                    <code>{p.code}</code>
                    <span className="adm-muted adm-small"> {p.description}</span>
                  </label>
                  <select id={`ov-${p.code}`} value={overrides[p.code] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value as "" | "GRANT" | "DENY";
                      setOverrides((prev) => {
                        const next = { ...prev };
                        if (v) next[p.code] = v;
                        else delete next[p.code];
                        return next;
                      });
                    }}>
                    <option value="">{t.users.inherit}</option>
                    <option value="GRANT" disabled={!can(p.code) && !me?.roles.includes("SUPER_ADMIN")}>{t.users.grant}</option>
                    <option value="DENY">{t.users.deny}</option>
                  </select>
                </div>
              ))}
            </fieldset>
          ))}
          <Button onClick={() => void savePermissions()} busy={busy === "permissions"}>{t.common.save}</Button>
          </details>
        </div>
      )}

      {availableActions.length > 0 && (
        <div className="adm-card">
          <h2 className="adm-h2">{t.users.actions}</h2>
          <div className="adm-row adm-row--wrap">
            {availableActions.map((a) => (
              <Button key={a} variant={actionLabels[a].danger ? "danger" : "secondary"} busy={busy === a}
                onClick={() => (actionLabels[a].confirm ? setConfirm(a) : void doAction(a))}>
                {actionLabels[a].label}
              </Button>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        message={confirm ? (actionLabels[confirm].confirm ?? "") : ""}
        confirmLabel={confirm ? actionLabels[confirm].label : t.common.confirm}
        danger={confirm ? actionLabels[confirm].danger : false}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void doAction(confirm)}
      />
    </section>
  );
}

function RolePicker({
  roles,
  selected,
  onChange,
  canGrantSuperAdmin,
}: {
  roles: RoleDto[];
  selected: string[];
  onChange: (roles: string[]) => void;
  canGrantSuperAdmin: boolean;
}) {
  const { t } = useAdmin();
  return (
    <fieldset className="adm-fieldset adm-roles">
      <legend>{t.users.roles}</legend>
      {roles.map((r) => (
        <label key={r.code} className="adm-check">
          <input
            type="checkbox"
            checked={selected.includes(r.code)}
            disabled={r.code === "SUPER_ADMIN" && !canGrantSuperAdmin}
            onChange={(e) => onChange(e.target.checked ? [...selected, r.code] : selected.filter((c) => c !== r.code))}
          />
          <span><strong>{r.name}</strong> <code className="adm-small">{r.code}</code>
            {r.description && <span className="adm-muted adm-small"> — {r.description}</span>}</span>
        </label>
      ))}
    </fieldset>
  );
}
