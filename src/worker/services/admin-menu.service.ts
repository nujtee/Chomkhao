import { HIDEABLE_MENU_PATHS, type AdminMenuDto } from "../../shared/admin-menu.ts";
import type { D1DatabaseLike } from "../env.ts";
import { ValidationError } from "../http/errors.ts";
import type { AdminMenuRepository } from "../repositories/admin-menu.repository.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";

/**
 * Administration → Menu: which sidebar items everyone sees. Reading is open to every signed-in admin (the
 * sidebar needs it); changing needs settings.admin_menu (SUPER_ADMIN). Only the menu changes — what each
 * user may open is still decided by permissions, checked on every request.
 */
export class AdminMenuService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: AdminMenuRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
  ) {}

  async get(): Promise<AdminMenuDto> {
    return { hidden: await this.repo.hidden() };
  }

  async save(actor: AuthContext, body: Record<string, unknown>, meta: RequestMeta): Promise<AdminMenuDto> {
    await this.authz.requirePermission(actor, "settings.admin_menu", meta);
    const keys = Object.keys(body).filter((k) => k !== "hidden");
    if (keys.length) throw new ValidationError(Object.fromEntries(keys.map((k) => [k, "UNKNOWN_FIELD"])));
    const raw = body.hidden;
    if (!Array.isArray(raw) || raw.length > HIDEABLE_MENU_PATHS.length) throw new ValidationError({ hidden: "INVALID_FORMAT" });
    // The dashboard and this page can never be hidden (HIDEABLE_MENU_PATHS leaves them out).
    if (!raw.every((p): p is string => typeof p === "string" && HIDEABLE_MENU_PATHS.includes(p))) throw new ValidationError({ hidden: "INVALID_MENU_ITEM" });
    const hidden = [...new Set(raw)].sort();
    const before = await this.repo.hidden();
    await this.db.batch([
      ...this.repo.replaceStatements(hidden, actor.userId, iso(this.clock())),
      this.log.auditStatement(actor.userId, "UPDATE_ADMIN_MENU", "settings", "admin_menu", { hidden: before }, { hidden }, meta),
    ]);
    return { hidden: await this.repo.hidden() };
  }
}
