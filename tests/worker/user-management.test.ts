import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { PERMISSION_CODES, type AdminUserDto, type AdminUserListDto, type CreateUserResultDto, type RoleDto } from "../../src/shared/auth-types.ts";
import { Harness, STRONG_PASSWORD, tokenFromLink } from "../helpers/harness.ts";

let h: Harness;
let root: string; // SUPER_ADMIN session
let manager: string;
let viewer: string;

beforeEach(async () => {
  h = new Harness();
  await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
  await h.user({ id: "mgr", roles: ["MANAGER"] });
  await h.user({ id: "viewer", roles: ["VIEWER"] });
  await h.user({ id: "staff", roles: ["BOOKING_ADMIN"] });
  root = await h.login("root@example.test");
  manager = await h.login("mgr@example.test");
  viewer = await h.login("viewer@example.test");
});

const create = (token: string, body: Record<string, unknown>) =>
  h.api<CreateUserResultDto>("POST", "/api/admin/users", { token, body });

describe("authorization is enforced by the backend (§34)", () => {
  it("requires authentication for every admin endpoint", async () => {
    for (const [method, path] of [
      ["GET", "/api/admin/users"], ["POST", "/api/admin/users"], ["GET", "/api/admin/roles"],
      ["DELETE", "/api/admin/users/staff"], ["GET", "/api/admin/security-events"], ["GET", "/api/admin/audit-logs"],
    ] as const) {
      const res = await h.api(method, path, { body: method === "POST" ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  it("VIEWER cannot list users (403) and the denial is logged", async () => {
    const res = await h.api("GET", "/api/admin/users", { token: viewer });
    assert.equal(res.status, 403);
    const denied = h.events("PERMISSION_DENIED");
    assert.equal(denied.length, 1);
    assert.equal(denied[0]!.user_id, "viewer");
    assert.match(denied[0]!.details_json ?? "", /users\.view/);
  });

  it("MANAGER adds users with any role up to MANAGER, but never SUPER_ADMIN, and cannot delete", async () => {
    assert.equal((await h.api("GET", "/api/admin/users", { token: manager })).status, 200);
    const added = await create(manager, { email: "n@example.test", displayName: "N", roles: ["MANAGER"] });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.deepEqual(added.data.user.roles, ["MANAGER"]);
    assert.equal((await create(manager, { email: "b@example.test", displayName: "B", roles: ["BOOKING_ADMIN"] })).status, 201);
    assert.equal((await create(manager, { email: "s@example.test", displayName: "S", roles: ["SUPER_ADMIN"] })).status, 403);
    assert.equal((await h.api("PUT", "/api/admin/users/staff/roles", { token: manager, body: { roles: ["VIEWER"] } })).status, 200);
    assert.equal((await h.api("PUT", "/api/admin/users/staff/roles", { token: manager, body: { roles: ["SUPER_ADMIN"] } })).status, 403);
    assert.equal((await h.api("DELETE", "/api/admin/users/staff", { token: manager })).status, 403);
    assert.equal((await h.api("PUT", "/api/admin/users/staff/permissions", { token: manager, body: { grant: ["reports.view"], deny: [] } })).status, 403);
  });

  it("only a SUPER_ADMIN sees SUPER_ADMIN accounts and the SUPER_ADMIN role", async () => {
    const list = await h.api<AdminUserListDto>("GET", "/api/admin/users", { token: manager });
    assert.deepEqual(list.data.items.map((u) => u.id).sort(), ["mgr", "staff", "viewer"]);
    assert.equal(list.data.total, 3);
    const searched = await h.api<AdminUserListDto>("GET", "/api/admin/users?q=root", { token: manager });
    assert.equal(searched.data.total, 0);
    assert.equal((await h.api("GET", "/api/admin/users/root", { token: manager })).status, 404);
    const roles = await h.api<RoleDto[]>("GET", "/api/admin/roles?lang=th", { token: manager });
    assert.ok(!roles.data.some((r) => r.code === "SUPER_ADMIN"));
    // The SUPER_ADMIN still sees everyone.
    assert.equal((await h.api<AdminUserListDto>("GET", "/api/admin/users", { token: root })).data.total, 4);
    assert.equal((await h.api("GET", "/api/admin/users/root", { token: root })).status, 200);
    assert.ok((await h.api<RoleDto[]>("GET", "/api/admin/roles?lang=th", { token: root })).data.some((r) => r.code === "SUPER_ADMIN"));
  });

  it("a per-user DENY removes a role permission immediately", async () => {
    h.grant("mgr", "users.view", "DENY");
    assert.equal((await h.api("GET", "/api/admin/users", { token: manager })).status, 403);
  });

  it("a per-user GRANT adds a permission immediately", async () => {
    h.grant("viewer", "users.view");
    assert.equal((await h.api("GET", "/api/admin/users", { token: viewer })).status, 200);
  });

  it("rejects malformed ids and returns 404 for unknown users", async () => {
    assert.equal((await h.api("GET", "/api/admin/users/..%2Fetc", { token: root })).status, 422);
    assert.equal((await h.api("GET", "/api/admin/users/does-not-exist", { token: root })).status, 404);
  });
});

describe("listing", () => {
  it("paginates, searches (wildcards escaped) and hides deleted users by default", async () => {
    const all = await h.api<AdminUserListDto>("GET", "/api/admin/users?pageSize=2", { token: root });
    assert.equal(all.data.total, 4);
    assert.equal(all.data.items.length, 2);
    const found = await h.api<AdminUserListDto>("GET", "/api/admin/users?q=viewer", { token: root });
    assert.deepEqual(found.data.items.map((u) => u.id), ["viewer"]);
    const wildcard = await h.api<AdminUserListDto>("GET", "/api/admin/users?q=%25", { token: root });
    assert.equal(wildcard.data.total, 0, "% is literal");
    assert.equal((await h.api("GET", "/api/admin/users?pageSize=1000", { token: root })).status, 422);
    assert.equal((await h.api("GET", "/api/admin/users?status=HACKED", { token: root })).status, 422);
  });
});

describe("create user", () => {
  it("SUPER_ADMIN creates a user with an invite link; the link sets the first password", async () => {
    const res = await create(root, {
      email: "New.Person@Example.test", displayName: "New Person", roles: ["BOOKING_ADMIN"], preferredLanguage: "en",
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.email, "new.person@example.test");
    assert.deepEqual(res.data.user.roles, ["BOOKING_ADMIN"]);
    assert.match(res.data.inviteLink!.url, /^https:\/\/phasakura\.test\/en\/admin\/reset-password#token=.+&invite=1$/);

    const token = tokenFromLink(res.data.inviteLink!.url);
    const set = await h.api("POST", "/api/auth/reset-password", { body: { token, newPassword: "my own new passphrase" } });
    assert.equal(set.status, 200);
    assert.ok(await h.login("new.person@example.test", "my own new passphrase"));
    assert.equal(h.audits("CREATE").length, 1);
    assert.equal(h.audits("CREATE")[0]!.user_id, "root");
  });

  it("with a temporary password, the user must change it at first login", async () => {
    const res = await create(root, { email: "temp@example.test", displayName: "Temp", password: "provisional passphrase 1" });
    assert.equal(res.data.inviteLink, null);
    assert.equal(res.data.user.mustChangePassword, true);
    assert.ok(!JSON.stringify(h.audits("CREATE")).includes("provisional passphrase 1"));
  });

  it("validates input and uniqueness", async () => {
    const bad = await create(root, { email: "not-an-email", displayName: "", roles: ["NOPE!"], isAdmin: true });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.error!.details!).sort(), ["displayName", "email", "isAdmin", "roles"]);
    assert.equal((await create(root, { email: "x@example.test", displayName: "X", roles: ["GHOST"] })).error?.details?.roles, "UNKNOWN_ROLE");
    const dup = await create(root, { email: "VIEWER@example.test", displayName: "Dup" });
    assert.equal(dup.status, 409);
    assert.equal(dup.error?.code, "EMAIL_TAKEN");
    const weak = await create(root, { email: "w@example.test", displayName: "W", password: "short" });
    assert.equal(weak.error?.details?.password, "PASSWORD_TOO_SHORT");
  });
});

describe("privilege escalation guards", () => {
  beforeEach(() => {
    // A delegated user admin who is NOT a SUPER_ADMIN.
    for (const p of ["users.create", "users.manage_roles", "users.manage_permissions", "users.edit", "users.delete",
      "users.suspend", "users.reset_password", "users.force_logout"]) h.grant("mgr", p);
  });

  it("a non-SUPER_ADMIN cannot grant the SUPER_ADMIN role", async () => {
    const res = await create(manager, { email: "evil@example.test", displayName: "Evil", roles: ["SUPER_ADMIN"] });
    assert.equal(res.status, 403);
    assert.equal(res.error?.code, "SUPER_ADMIN_REQUIRED");
    const promote = await h.api("PUT", "/api/admin/users/staff/roles", { token: manager, body: { roles: ["SUPER_ADMIN"] } });
    assert.equal(promote.error?.code, "SUPER_ADMIN_REQUIRED");
    assert.equal(h.events("PRIVILEGE_ESCALATION_BLOCKED").length, 2);
  });

  it("a non-SUPER_ADMIN can manage ordinary users", async () => {
    const res = await create(manager, { email: "ok@example.test", displayName: "Ok", roles: ["BOOKING_ADMIN"] });
    assert.equal(res.status, 201);
  });

  it("a non-SUPER_ADMIN cannot edit, suspend, delete, reset or log out a SUPER_ADMIN", async () => {
    const attempts = [
      h.api("PATCH", "/api/admin/users/root", { token: manager, body: { displayName: "pwned" } }),
      h.api("POST", "/api/admin/users/root/suspend", { token: manager }),
      h.api("DELETE", "/api/admin/users/root", { token: manager }),
      h.api("POST", "/api/admin/users/root/reset-password", { token: manager }),
      h.api("POST", "/api/admin/users/root/force-logout", { token: manager }),
      h.api("PUT", "/api/admin/users/root/permissions", { token: manager, body: { overrides: [{ code: "users.view", effect: "DENY" }] } }),
    ];
    for (const res of await Promise.all(attempts)) assert.equal(res.error?.code, "SUPER_ADMIN_REQUIRED");
  });

  it("cannot grant permissions you do not hold", async () => {
    const res = await h.api("PUT", "/api/admin/users/staff/permissions", {
      token: manager, body: { overrides: [{ code: "users.restore", effect: "GRANT" }] },
    });
    assert.equal(res.error?.code, "CANNOT_DELEGATE");
    const ok = await h.api<AdminUserDto>("PUT", "/api/admin/users/staff/permissions", {
      token: manager, body: { overrides: [{ code: "reports.view", effect: "GRANT" }, { code: "bookings.cancel", effect: "DENY" }] },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data.permissionOverrides, [
      { code: "bookings.cancel", effect: "DENY" }, { code: "reports.view", effect: "GRANT" },
    ]);
  });

  it("cannot change your own roles or permissions", async () => {
    assert.equal((await h.api("PUT", "/api/admin/users/mgr/roles", { token: manager, body: { roles: ["MANAGER"] } })).error?.code, "CANNOT_MODIFY_SELF");
    assert.equal(
      (await h.api("PUT", "/api/admin/users/mgr/permissions", { token: manager, body: { overrides: [] } })).error?.code,
      "CANNOT_MODIFY_SELF",
    );
  });

  it("rejects malformed permission overrides", async () => {
    for (const overrides of [[{ code: "users.view", effect: "MAYBE" }], [{ code: "hack.all", effect: "GRANT" }], "x",
      [{ code: "users.view", effect: "GRANT", extra: 1 }]]) {
      const res = await h.api("PUT", "/api/admin/users/staff/permissions", { token: root, body: { overrides } });
      assert.equal(res.status, 422, JSON.stringify(overrides));
    }
  });
});

describe("SUPER_ADMIN rules (§33)", () => {
  it("SUPER_ADMIN cannot delete or suspend themselves", async () => {
    const del = await h.api("DELETE", "/api/admin/users/root", { token: root });
    assert.equal(del.status, 403);
    assert.equal(del.error?.code, "CANNOT_MODIFY_SELF");
    assert.equal((await h.api("POST", "/api/admin/users/root/suspend", { token: root })).error?.code, "CANNOT_MODIFY_SELF");
  });

  it("there is always at least one active SUPER_ADMIN", async () => {
    await h.user({ id: "root2", roles: ["SUPER_ADMIN"] });
    const root2 = await h.login("root2@example.test");
    // root deletes root2 → allowed (root remains)
    assert.equal((await h.api("DELETE", "/api/admin/users/root2", { token: root })).status, 200);
    // root2 can no longer act; root cannot remove itself → still exactly one SUPER_ADMIN
    assert.equal((await h.api("GET", "/api/auth/me", { token: root2 })).status, 401);
    assert.equal((await h.api("PUT", "/api/admin/users/root/roles", { token: root, body: { roles: [] } })).error?.code, "CANNOT_MODIFY_SELF");
    const supers = h.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_roles ur JOIN users u ON u.id = ur.user_id
        WHERE ur.role_id = 'role_super_admin' AND u.status = 'ACTIVE'`,
    )!.n;
    assert.equal(supers, 1);
  });

  it("the SUPER_ADMIN role's permissions cannot be edited", async () => {
    const res = await h.api("PUT", "/api/admin/roles/role_super_admin/permissions", { token: root, body: { permissions: [] } });
    assert.equal(res.error?.code, "SUPER_ADMIN_ROLE_LOCKED");
  });
});

describe("soft delete & restore (§32)", () => {
  it("delete: cannot log in, sessions revoked, hidden from active list, history kept; restore brings it back", async () => {
    const staff = await h.login("staff@example.test");
    h.db.run("INSERT INTO audit_logs (id, user_id, action, module) VALUES ('old', 'staff', 'UPDATE', 'bookings')");

    const del = await h.api<AdminUserDto>("DELETE", "/api/admin/users/staff", { token: root });
    assert.equal(del.status, 200);
    assert.equal(del.data.status, "DELETED");
    assert.ok(del.data.deletedAt);

    assert.equal((await h.api("GET", "/api/auth/me", { token: staff })).status, 401, "session revoked");
    const login = await h.api("POST", "/api/auth/login", { body: { identifier: "staff@example.test", password: STRONG_PASSWORD } });
    assert.equal(login.status, 401);

    const active = await h.api<AdminUserListDto>("GET", "/api/admin/users", { token: root });
    assert.ok(!active.data.items.some((u) => u.id === "staff"));
    const deleted = await h.api<AdminUserListDto>("GET", "/api/admin/users?status=DELETED", { token: root });
    assert.deepEqual(deleted.data.items.map((u) => u.id), ["staff"]);

    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE id = 'staff'")!.n, 1, "row kept");
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE user_id = 'staff'")!.n, 1, "history kept");
    assert.equal(h.db.get<{ deleted_by: string }>("SELECT deleted_by FROM users WHERE id = 'staff'")!.deleted_by, "root");

    assert.equal((await h.api("DELETE", "/api/admin/users/staff", { token: root })).error?.code, "INVALID_STATUS");
    assert.equal((await h.api("PATCH", "/api/admin/users/staff", { token: root, body: { displayName: "x" } })).error?.code, "USER_DELETED");

    const restored = await h.api<AdminUserDto>("POST", "/api/admin/users/staff/restore", { token: root });
    assert.equal(restored.data.status, "ACTIVE");
    assert.equal(restored.data.deletedAt, null);
    assert.ok(await h.login("staff@example.test"));
    assert.deepEqual(h.audits("DELETE").map((a) => a.record_id), ["staff"]);
    assert.deepEqual(h.audits("RESTORE").map((a) => a.record_id), ["staff"]);
  });

  it("restore requires users.restore (MANAGER lacks it)", async () => {
    await h.api("DELETE", "/api/admin/users/staff", { token: root });
    assert.equal((await h.api("POST", "/api/admin/users/staff/restore", { token: manager })).status, 403);
  });
});

describe("suspend, activate, force logout, reset password", () => {
  it("suspend revokes sessions and blocks login; activate restores access", async () => {
    const staff = await h.login("staff@example.test");
    const sus = await h.api<AdminUserDto>("POST", "/api/admin/users/staff/suspend", { token: root });
    assert.equal(sus.data.status, "SUSPENDED");
    assert.equal(sus.data.activeSessions, 0);
    assert.equal((await h.api("GET", "/api/auth/me", { token: staff })).status, 401);
    assert.equal((await h.api("POST", "/api/admin/users/staff/suspend", { token: root })).error?.code, "INVALID_STATUS");
    const act = await h.api<AdminUserDto>("POST", "/api/admin/users/staff/activate", { token: root });
    assert.equal(act.data.status, "ACTIVE");
    assert.ok(await h.login("staff@example.test"));
  });

  it("force logout revokes every session of the user", async () => {
    const a = await h.login("staff@example.test");
    const b = await h.login("staff@example.test", STRONG_PASSWORD, true);
    const res = await h.api<AdminUserDto>("POST", "/api/admin/users/staff/force-logout", { token: root });
    assert.equal(res.data.activeSessions, 0);
    for (const t of [a, b]) assert.equal((await h.api("GET", "/api/auth/me", { token: t })).status, 401);
    assert.ok(await h.login("staff@example.test"), "can log in again");
  });

  it("admin reset: old password stops working, sessions revoked, one-time link sets a new one", async () => {
    const staff = await h.login("staff@example.test");
    const res = await h.api<{ url: string; expiresAt: string }>("POST", "/api/admin/users/staff/reset-password", { token: root });
    assert.equal(res.status, 200);
    assert.equal((await h.api("GET", "/api/auth/me", { token: staff })).status, 401);
    const old = await h.api("POST", "/api/auth/login", { body: { identifier: "staff@example.test", password: STRONG_PASSWORD } });
    assert.equal(old.status, 401);
    await h.api("POST", "/api/auth/reset-password", { body: { token: tokenFromLink(res.data.url), newPassword: "reset by admin passphrase" } });
    assert.ok(await h.login("staff@example.test", "reset by admin passphrase"));
    assert.ok(!JSON.stringify(h.db.all("SELECT * FROM audit_logs")).includes(tokenFromLink(res.data.url)), "link token not logged");
  });

  it("cannot reset your own password through user management", async () => {
    assert.equal((await h.api("POST", "/api/admin/users/root/reset-password", { token: root })).error?.code, "CANNOT_MODIFY_SELF");
  });
});

describe("update, roles and role permissions", () => {
  it("updates profile fields with audit of old/new values", async () => {
    const res = await h.api<AdminUserDto>("PATCH", "/api/admin/users/staff", {
      token: root, body: { displayName: "Front desk", username: "frontdesk", preferredLanguage: "zh-CN" },
    });
    assert.equal(res.data.displayName, "Front desk");
    assert.equal(res.data.preferredLanguage, "zh-CN");
    const audit = h.audits("UPDATE")[0]!;
    assert.match(audit.old_value ?? "", /User staff/);
    assert.match(audit.new_value ?? "", /Front desk/);
    const clash = await h.api("PATCH", "/api/admin/users/viewer", { token: root, body: { username: "FRONTDESK" } });
    assert.equal(clash.error?.code, "USERNAME_TAKEN");
    assert.equal((await h.api("PATCH", "/api/admin/users/staff", { token: root, body: { status: "ACTIVE" } })).status, 422);
  });

  it("replaces roles", async () => {
    const res = await h.api<AdminUserDto>("PUT", "/api/admin/users/staff/roles", {
      token: root, body: { roles: ["FINANCE_ADMIN", "VIEWER"] },
    });
    assert.deepEqual(res.data.roles.sort(), ["FINANCE_ADMIN", "VIEWER"]);
    const staff = await h.login("staff@example.test");
    const me = await h.api<{ permissions: string[] }>("GET", "/api/auth/me", { token: staff });
    assert.ok(me.data.permissions.includes("payments.verify"));
    assert.ok(!me.data.permissions.includes("bookings.cancel"));
  });

  it("lists roles with localized names and permissions; SUPER_ADMIN edits another role", async () => {
    const roles = await h.api<RoleDto[]>("GET", "/api/admin/roles?lang=zh-cn", { token: root });
    assert.equal(roles.data.length, 6);
    assert.equal(roles.data[0]!.name, "超级管理员");
    assert.equal(roles.data[0]!.permissions.length, PERMISSION_CODES.length);

    const updated = await h.api<RoleDto>("PUT", "/api/admin/roles/role_viewer/permissions", {
      token: root, body: { permissions: ["dashboard.view", "bookings.view"] },
    });
    assert.deepEqual(updated.data.permissions, ["bookings.view", "dashboard.view"]);
    assert.equal(h.audits("UPDATE_ROLE_PERMISSIONS").length, 1);
    const denied = await h.api("PUT", "/api/admin/roles/role_viewer/permissions", { token: manager, body: { permissions: [] } });
    assert.equal(denied.status, 403);
  });

  it("the permission catalogue in D1 matches the typed list in code", async () => {
    const res = await h.api<{ code: string }[]>("GET", "/api/admin/permissions", { token: root });
    assert.deepEqual(res.data.map((p) => p.code).sort(), [...PERMISSION_CODES].sort());
  });
});

describe("security events & audit log endpoints", () => {
  it("require their own permissions and page newest-first", async () => {
    await h.api("POST", "/api/auth/login", { body: { identifier: "root@example.test", password: "a wrong passphrase" } });
    assert.equal((await h.api("GET", "/api/admin/security-events", { token: viewer })).status, 403);
    const events = await h.api<{ items: { eventType: string }[]; nextCursor: string | null }>(
      "GET", "/api/admin/security-events?limit=2", { token: root },
    );
    assert.equal(events.data.items.length, 2);
    assert.ok(events.data.nextCursor);
    const failed = await h.api<{ items: { eventType: string }[] }>("GET", "/api/admin/security-events?type=LOGIN_FAILED", { token: root });
    assert.ok(failed.data.items.every((e) => e.eventType === "LOGIN_FAILED"));
    assert.equal((await h.api("GET", "/api/admin/security-events?type=x;drop", { token: root })).status, 422);

    await h.api("POST", "/api/admin/users/staff/suspend", { token: root });
    const audits = await h.api<{ items: { action: string; userEmail: string }[] }>("GET", "/api/admin/audit-logs?module=users", { token: root });
    assert.equal(audits.data.items[0]!.action, "SUSPEND");
    assert.equal(audits.data.items[0]!.userEmail, "root@example.test");
  });
});
