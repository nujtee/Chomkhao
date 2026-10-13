import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADMIN_MENU_LOCKED, ADMIN_MENU_PATHS, type AdminMenuDto } from "../../src/shared/admin-menu.ts";
import { ADMIN_NAV } from "../../src/client/admin/nav.ts";
import { Harness } from "../helpers/harness.ts";

let seq = 0;

async function setup() {
  const h = new Harness({ seed: true });
  const root = await h.login(await h.user({ id: `root_${++seq}`, roles: ["SUPER_ADMIN"] }));
  const manager = await h.login(await h.user({ id: `mgr_${++seq}`, roles: ["MANAGER"] }));
  const save = (token: string, body: unknown) => h.api<AdminMenuDto>("PUT", "/api/admin/menu", { token, body });
  return { h, root, manager, save };
}

describe("Administration → Menu (settings.admin_menu)", () => {
  it("Super Admin hides items for everyone; every signed-in admin reads the list; audited", async () => {
    const { h, root, manager, save } = await setup();
    assert.deepEqual((await h.api<AdminMenuDto>("GET", "/api/auth/menu", { token: manager })).data, { hidden: [] });
    assert.equal((await h.api("GET", "/api/auth/menu")).status, 401);

    const r = await save(root, { hidden: ["ga4", "capi", "ga4", "meta-pixel", "kitchen"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.data.hidden, ["capi", "ga4", "kitchen", "meta-pixel"], "sorted, once each");
    assert.deepEqual((await h.api<AdminMenuDto>("GET", "/api/auth/menu", { token: manager })).data.hidden, ["capi", "ga4", "kitchen", "meta-pixel"]);
    const audit = h.audits("UPDATE_ADMIN_MENU");
    assert.equal(audit.length, 1);
    assert.match(audit[0]!.new_value!, /meta-pixel/);

    // Show everything again.
    assert.deepEqual((await save(root, { hidden: [] })).data.hidden, []);
  });

  it("only with the permission; the dashboard and this page cannot be hidden; nothing unknown", async () => {
    const { save, root, manager } = await setup();
    assert.equal((await save(manager, { hidden: ["ga4"] })).status, 403);
    for (const bad of [[""], ["admin-menu"], ["nope"], ["../users"], [1], "ga4"]) {
      const res = await save(root, { hidden: bad });
      assert.equal(res.status, 422, JSON.stringify(bad));
    }
    assert.equal((await save(root, { hidden: [], extra: true })).error?.details?.extra, "UNKNOWN_FIELD");
  });

  it("hiding is about the menu only: access still follows permissions", async () => {
    const { h, save, root, manager } = await setup();
    await save(root, { hidden: ["bookings", "payments"] });
    assert.equal((await h.api("GET", "/api/admin/bookings?limit=5", { token: manager })).status, 200);
    assert.equal((await h.api("GET", "/api/admin/payments?limit=5", { token: manager })).status, 200);
  });

  it("the Worker's list matches the sidebar (nav.ts) item for item", () => {
    const nav = ADMIN_NAV.flatMap((g) => g.items.map((i) => i.path));
    assert.deepEqual([...nav].sort(), [...ADMIN_MENU_PATHS].sort());
    for (const locked of ADMIN_MENU_LOCKED) assert.ok(nav.includes(locked), locked);
  });
});
