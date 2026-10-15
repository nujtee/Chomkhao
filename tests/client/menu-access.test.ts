import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADMIN_MENU_PATHS, MENU_ACCESS } from "../../src/shared/admin-menu.ts";
import { PERMISSION_CODES, type CurrentUserDto, type RoleDto } from "../../src/shared/auth-types.ts";
import { ADMIN_NAV } from "../../src/client/admin/nav.ts";
import { hasPermission, setPermissions } from "../../src/client/admin/pages/MenuAccessEditor.tsx";
import { Harness } from "../helpers/harness.ts";

/** Permissions on purpose not tied to one menu: they stay in the "Advanced" list. */
const NOT_A_MENU = ["content.view", "notifications.view", "bookings.create", "bookings.export", "credits.view"];

describe("menu access map (shared/admin-menu.ts)", () => {
  it("covers every sidebar item, and 'see' is the permission the sidebar shows it by", () => {
    for (const item of ADMIN_NAV.flatMap((g) => g.items)) {
      assert.equal(MENU_ACCESS[item.path as keyof typeof MENU_ACCESS]?.view, item.permission, item.path);
    }
    assert.deepEqual(Object.keys(MENU_ACCESS).sort(), [...ADMIN_MENU_PATHS].sort());
  });

  it("every permission is either behind a menu tick or knowingly left to the Advanced list", () => {
    const mapped = new Set(Object.values(MENU_ACCESS).flatMap((a) => [a.view, ...a.manage]));
    const loose = PERMISSION_CODES.filter((c) => !mapped.has(c));
    assert.deepEqual(loose.sort(), [...NOT_A_MENU].sort(), "a new permission: put it in MENU_ACCESS or in NOT_A_MENU");
  });
});

describe("ticks → overrides", () => {
  const role = new Set(["bookings.view", "bookings.edit", "content.gallery"]);

  it("as few overrides as possible: what the roles already give needs none", () => {
    assert.deepEqual(setPermissions(["payments.view"], true, role, {}), { "payments.view": "GRANT" });
    assert.deepEqual(setPermissions(["content.gallery"], false, role, {}), { "content.gallery": "DENY" });
    // Back to what the roles say: the override disappears.
    assert.deepEqual(setPermissions(["payments.view"], false, role, { "payments.view": "GRANT" }), {});
    assert.deepEqual(setPermissions(["bookings.edit", "bookings.cancel"], true, role, {}), { "bookings.cancel": "GRANT" });
  });

  it("effective = roles ∪ GRANT − DENY, like the Worker", () => {
    assert.equal(hasPermission("bookings.view", role, {}), true);
    assert.equal(hasPermission("bookings.view", role, { "bookings.view": "DENY" }), false);
    assert.equal(hasPermission("payments.view", role, { "payments.view": "GRANT" }), true);
    assert.equal(hasPermission("payments.view", role, {}), false);
  });

  it("saved through the existing endpoint, the user's own permissions follow the ticks", async () => {
    const h = new Harness({ seed: true });
    const root = await h.login(await h.user({ id: "root", roles: ["SUPER_ADMIN"] }));
    const email = await h.user({ id: "editor", roles: ["CONTENT_ADMIN"] });
    const roles = (await h.api<RoleDto[]>("GET", "/api/admin/roles", { token: root })).data;
    const base = new Set<string>(roles.find((r) => r.code === "CONTENT_ADMIN")!.permissions);
    assert.ok(base.has("content.gallery") && !base.has("payments.view"));

    // "See Payments" on, "See Gallery" off.
    let overrides = setPermissions(["payments.view"], true, base, {});
    overrides = setPermissions(["content.gallery"], false, base, overrides);
    const body = { overrides: Object.entries(overrides).map(([code, effect]) => ({ code, effect })) };
    assert.equal((await h.api("PUT", "/api/admin/users/editor/permissions", { token: root, body })).status, 200);

    const me = (await h.api<CurrentUserDto>("GET", "/api/auth/me", { token: await h.login(email) })).data;
    assert.ok(me.permissions.includes("payments.view"));
    assert.ok(!me.permissions.includes("content.gallery"));
  });
});
