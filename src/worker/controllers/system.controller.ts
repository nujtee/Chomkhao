import { requestMeta, withAuth, withPermission, type ServicesFor } from "../http/auth-guard.ts";
import { jsonOk } from "../http/response.ts";
import { readJsonObject } from "../security/request.ts";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** Admin → System status (Phase 16, `system.view`). */
export function systemController(services: ServicesFor) {
  return {
    status: withPermission("system.view", services, async (ctx, auth) => jsonOk(await services(ctx).monitoring.status(auth, requestMeta(ctx)), NO_STORE)),

    /** GET /api/auth/menu — hidden sidebar items; any signed-in user, like /api/auth/me (the sidebar needs it). */
    menu: withAuth(services, async (ctx) => jsonOk(await services(ctx).adminMenu.get(), NO_STORE)),

    /** PUT /api/admin/menu { hidden: string[] } — settings.admin_menu (SUPER_ADMIN). */
    saveMenu: withPermission("settings.admin_menu", services, async (ctx, auth) =>
      jsonOk(await services(ctx).adminMenu.save(auth, await readJsonObject(ctx.request), requestMeta(ctx)), NO_STORE)),
  };
}
