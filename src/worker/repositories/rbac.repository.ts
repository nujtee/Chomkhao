import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { withFallback } from "./schema-fallback.ts";
import { PREMIUM_ONLY_PERMISSIONS } from "../../shared/credit-types.ts";

const SUPER_ADMIN = "EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = ?1 AND ur.role_id = 'role_super_admin')";
const PREMIUM_ONLY_SQL = PREMIUM_ONLY_PERMISSIONS.map((c) => `'${c}'`).join(", ");

export interface RoleRow {
  id: string;
  code: string;
  is_system: number;
  name: string | null;
  description: string | null;
  permissions: string | null;   // comma-separated codes
  user_count: number;
}

export class RbacRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /**
   * Effective permissions = role permissions ∪ user GRANTs − user DENYs, then (migration 0027):
   *   - credits.manage only for a SUPER_ADMIN (whatever the overrides say);
   *   - while the credit system is on and the property is on the STANDARD plan, Reports / Marketing / Theme
   *     (PREMIUM_ONLY_PERMISSIONS) are removed for everyone but SUPER_ADMIN.
   */
  async effectivePermissions(userId: string): Promise<string[]> {
    // Before migration 0027 the credit tables do not exist: no plan lock (and no credits.manage permission yet).
    return withFallback(() => this.effectivePermissionsWith(userId, true), () => this.effectivePermissionsWith(userId, false));
  }

  private async effectivePermissionsWith(userId: string, credits: boolean): Promise<string[]> {
    const planLock = credits
      ? `AND NOT (p.code IN (${PREMIUM_ONLY_SQL}) AND NOT ${SUPER_ADMIN}
                     AND EXISTS (SELECT 1 FROM credit_settings cs JOIN credit_account ca ON ca.id = 1
                                  WHERE cs.id = 1 AND cs.enabled = 1 AND ca.plan = 'STANDARD'))`
      : "";
    const { results } = await this.db
      .prepare(
        `SELECT p.code FROM permissions p
          WHERE (EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                          WHERE ur.user_id = ?1 AND rp.permission_id = p.id)
              OR EXISTS (SELECT 1 FROM user_permissions up
                          WHERE up.user_id = ?1 AND up.permission_id = p.id AND up.effect = 'GRANT'))
            AND NOT EXISTS (SELECT 1 FROM user_permissions up
                             WHERE up.user_id = ?1 AND up.permission_id = p.id AND up.effect = 'DENY')
            AND (p.code <> 'credits.manage' OR ${SUPER_ADMIN})
            ${planLock}
          ORDER BY p.code`,
      )
      .bind(userId)
      .all<{ code: string }>();
    return results.map((r) => r.code);
  }

  async roleCodesForUser(userId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = ?1 ORDER BY r.sort_order`,
      )
      .bind(userId)
      .all<{ code: string }>();
    return results.map((r) => r.code);
  }

  async listRoles(languageCode: string): Promise<RoleRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.id, r.code, r.is_system,
                COALESCE(t.name, r.code) AS name, t.description,
                (SELECT group_concat(p.code, ',') FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                  WHERE rp.role_id = r.id) AS permissions,
                (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id
                  WHERE ur.role_id = r.id AND u.status <> 'DELETED') AS user_count
           FROM roles r
           LEFT JOIN role_translations t ON t.role_id = r.id AND t.language_code = ?1
          ORDER BY r.sort_order`,
      )
      .bind(languageCode)
      .all<RoleRow>();
    return results;
  }

  async listPermissions(): Promise<{ id: string; code: string; module: string; description: string }[]> {
    const { results } = await this.db
      .prepare("SELECT id, code, module, description FROM permissions ORDER BY module, code")
      .all<{ id: string; code: string; module: string; description: string }>();
    return results;
  }

  async roleIdsByCode(codes: string[]): Promise<Map<string, string>> {
    if (codes.length === 0) return new Map();
    const { results } = await this.db
      .prepare(`SELECT id, code FROM roles WHERE code IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(codes))
      .all<{ id: string; code: string }>();
    return new Map(results.map((r) => [r.code, r.id]));
  }

  async permissionIdsByCode(codes: string[]): Promise<Map<string, string>> {
    if (codes.length === 0) return new Map();
    const { results } = await this.db
      .prepare(`SELECT id, code FROM permissions WHERE code IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(codes))
      .all<{ id: string; code: string }>();
    return new Map(results.map((r) => [r.code, r.id]));
  }

  /** Replace the user's roles with exactly `roleIds` (DB triggers protect the last SUPER_ADMIN). */
  replaceUserRolesStatements(userId: string, roleIds: string[], grantedBy: string, now: string): D1PreparedStatementLike[] {
    const json = JSON.stringify(roleIds);
    return [
      this.db
        .prepare("DELETE FROM user_roles WHERE user_id = ?1 AND role_id NOT IN (SELECT value FROM json_each(?2))")
        .bind(userId, json),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, granted_at)
           SELECT ?1, value, ?3, ?4 FROM json_each(?2)`,
        )
        .bind(userId, json, grantedBy, now),
    ];
  }

  replaceUserPermissionsStatements(
    userId: string,
    overrides: { permissionId: string; effect: "GRANT" | "DENY" }[],
    grantedBy: string,
    now: string,
  ): D1PreparedStatementLike[] {
    return [
      this.db.prepare("DELETE FROM user_permissions WHERE user_id = ?1").bind(userId),
      ...overrides.map((o) =>
        this.db
          .prepare(
            `INSERT INTO user_permissions (user_id, permission_id, effect, granted_by, granted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
          )
          .bind(userId, o.permissionId, o.effect, grantedBy, now),
      ),
    ];
  }

  replaceRolePermissionsStatements(roleId: string, permissionIds: string[]): D1PreparedStatementLike[] {
    const json = JSON.stringify(permissionIds);
    return [
      this.db
        .prepare("DELETE FROM role_permissions WHERE role_id = ?1 AND permission_id NOT IN (SELECT value FROM json_each(?2))")
        .bind(roleId, json),
      this.db
        .prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT ?1, value FROM json_each(?2)")
        .bind(roleId, json),
    ];
  }
}
