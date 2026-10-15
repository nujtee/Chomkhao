import type {
  AdminUserDto,
  AdminUserListDto,
  CreateUserResultDto,
  PasswordLinkDto,
  PermissionCode,
  PermissionOverrideDto,
  RoleDto,
  UserStatus,
} from "../../shared/auth-types.ts";
import { parseLocale } from "../../shared/i18n/locales.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../http/errors.ts";
import type { RbacRepository } from "../repositories/rbac.repository.ts";
import type { UserListRow, UserRepository, UserRow } from "../repositories/user.repository.ts";
import { hashPassword, validatePasswordPolicy } from "../security/password.ts";
import { newId, randomToken } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import { AuthorizationService } from "./authorization.service.ts";
import type { PasswordLinkService } from "./password-link.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import type { SessionService } from "./session.service.ts";

const MODULE = "users";

export interface CreateUserInput {
  email: string;
  username: string | null;
  displayName: string;
  preferredLanguage: string | null;
  roles: string[];
  /** Optional temporary password (user must change it on first login). Otherwise an invite link is returned. */
  password: string | null;
}

export interface UpdateUserInput {
  email?: string;
  username?: string | null;
  displayName?: string;
  preferredLanguage?: string | null;
}

/**
 * Admin user management (spec §30–33). Every method:
 *   1. checks the permission via AuthorizationService,
 *   2. applies SUPER_ADMIN / self-protection rules,
 *   3. writes the change and its audit record in ONE atomic D1 batch.
 * The database triggers are a second line of defence for the last-SUPER_ADMIN rule.
 */
export class UserManagementService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly users: UserRepository,
    private readonly rbac: RbacRepository,
    private readonly sessions: SessionService,
    private readonly links: PasswordLinkService,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------- queries

  async list(
    actor: AuthContext,
    filter: { status?: "ACTIVE" | "SUSPENDED" | "DELETED"; query?: string; page: number; pageSize: number },
    meta: RequestMeta,
  ): Promise<AdminUserListDto> {
    await this.authz.requirePermission(actor, "users.view", meta);
    const { rows, total } = await this.users.list(
      { status: filter.status, query: filter.query, limit: filter.pageSize, offset: (filter.page - 1) * filter.pageSize },
      this.now(),
    );
    return { items: rows.map(toDto), total, page: filter.page, pageSize: filter.pageSize };
  }

  async get(actor: AuthContext, id: string, meta: RequestMeta): Promise<AdminUserDto> {
    await this.authz.requirePermission(actor, "users.view", meta);
    return toDto(await this.detailed(id));
  }

  async listRoles(actor: AuthContext, language: string, meta: RequestMeta): Promise<RoleDto[]> {
    await this.authz.requirePermission(actor, "roles.view", meta);
    const rows = await this.rbac.listRoles(parseLocale(language)?.code ?? "th");
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name ?? r.code,
      description: r.description,
      isSystem: r.is_system === 1,
      permissions: (r.permissions ? r.permissions.split(",").sort() : []) as PermissionCode[],
      userCount: r.user_count,
    }));
  }

  async listPermissions(actor: AuthContext, meta: RequestMeta) {
    await this.authz.requirePermission(actor, "roles.view", meta);
    return (await this.rbac.listPermissions()).map((p) => ({
      code: p.code as PermissionCode,
      module: p.module,
      description: p.description,
    }));
  }

  // --------------------------------------------------------------- commands

  async create(actor: AuthContext, input: CreateUserInput, meta: RequestMeta): Promise<CreateUserResultDto> {
    await this.authz.requirePermission(actor, "users.create", meta);
    if (input.roles.length > 0) await this.authz.requirePermission(actor, "users.manage_roles", meta);
    if (input.roles.includes(AuthorizationService.SUPER_ADMIN_ROLE)) {
      await this.authz.requireSuperAdminFor(actor, "grant_super_admin", meta);
    }
    const roleIds = await this.resolveRoles(input.roles);
    await this.assertUnique(input.email, input.username, null);

    const identifiers = [input.email, input.username ?? "", input.displayName];
    if (input.password) {
      const error = validatePasswordPolicy(input.password, identifiers);
      if (error) throw new ValidationError({ password: `PASSWORD_${error}` });
    }

    const now = this.now();
    const id = newId();
    // Without an initial password the account gets an unguessable random one and an invite link.
    const passwordHash = await hashPassword(input.password ?? randomToken(32));
    const statements: D1PreparedStatementLike[] = [
      this.users.insertStatement({
        id,
        email: input.email,
        username: input.username,
        displayName: input.displayName,
        passwordHash,
        mustChangePassword: input.password !== null,
        preferredLanguage: input.preferredLanguage,
        createdBy: actor.userId,
        now,
      }),
      ...this.rbac.replaceUserRolesStatements(id, [...roleIds.values()], actor.userId, now),
    ];

    let inviteLink: PasswordLinkDto | null = null;
    if (!input.password) {
      const link = await this.links.issue(id, "INVITE", input.preferredLanguage, meta);
      statements.push(...link.statements);
      inviteLink = { url: link.url, expiresAt: link.expiresAt };
    }
    statements.push(
      this.log.auditStatement(actor.userId, "CREATE", MODULE, id, null, {
        email: input.email, username: input.username, displayName: input.displayName,
        preferredLanguage: input.preferredLanguage, roles: input.roles, initialPassword: input.password ? "SET" : "INVITE",
      }, meta),
    );
    await this.commit(statements);
    return { user: toDto(await this.detailed(id)), inviteLink };
  }

  async update(actor: AuthContext, id: string, input: UpdateUserInput, meta: RequestMeta): Promise<AdminUserDto> {
    await this.authz.requirePermission(actor, "users.edit", meta);
    const target = await this.detailed(id);
    this.assertNotDeleted(target);
    await this.guardSuperAdminTarget(actor, target, "edit_super_admin", meta);

    const next = {
      email: input.email ?? target.email,
      username: input.username === undefined ? target.username : input.username,
      displayName: input.displayName ?? target.display_name,
      preferredLanguage: input.preferredLanguage === undefined ? target.preferred_language : input.preferredLanguage,
    };
    await this.assertUnique(next.email, next.username, id);

    const before = pickProfile(target);
    await this.commit([
      this.users.updateProfileStatement(id, next, this.now()),
      this.log.auditStatement(actor.userId, "UPDATE", MODULE, id, before, next, meta),
    ]);
    return toDto(await this.detailed(id));
  }

  async setRoles(actor: AuthContext, id: string, roles: string[], meta: RequestMeta): Promise<AdminUserDto> {
    await this.authz.requirePermission(actor, "users.manage_roles", meta);
    if (id === actor.userId) throw new ForbiddenError("You cannot change your own roles", "CANNOT_MODIFY_SELF");
    const target = await this.detailed(id);
    this.assertNotDeleted(target);

    const before = splitRoles(target.roles);
    // Granting SUPER_ADMIN, or changing anything about a SUPER_ADMIN, requires a SUPER_ADMIN.
    if (before.includes(AuthorizationService.SUPER_ADMIN_ROLE) || roles.includes(AuthorizationService.SUPER_ADMIN_ROLE)) {
      await this.authz.requireSuperAdminFor(actor, "change_super_admin_roles", meta);
    }
    const roleIds = await this.resolveRoles(roles);

    const now = this.now();
    await this.commit([
      ...this.rbac.replaceUserRolesStatements(id, [...roleIds.values()], actor.userId, now),
      this.log.auditStatement(actor.userId, "UPDATE_ROLES", MODULE, id, { roles: before }, { roles }, meta),
    ]);
    return toDto(await this.detailed(id));
  }

  async setPermissionOverrides(
    actor: AuthContext,
    id: string,
    overrides: PermissionOverrideDto[],
    meta: RequestMeta,
  ): Promise<AdminUserDto> {
    await this.authz.requirePermission(actor, "users.manage_permissions", meta);
    if (id === actor.userId) throw new ForbiddenError("You cannot change your own permissions", "CANNOT_MODIFY_SELF");
    const target = await this.detailed(id);
    this.assertNotDeleted(target);
    await this.guardSuperAdminTarget(actor, target, "override_super_admin_permissions", meta);

    const codes = overrides.map((o) => o.code);
    if (new Set(codes).size !== codes.length) throw new ValidationError({ permissions: "DUPLICATE_PERMISSION" });
    await this.authz.requireCanDelegate(actor, overrides.filter((o) => o.effect === "GRANT").map((o) => o.code), meta);
    const ids = await this.rbac.permissionIdsByCode(codes);
    const unknown = codes.filter((c) => !ids.has(c));
    if (unknown.length) throw new ValidationError({ permissions: "UNKNOWN_PERMISSION" });
    // Credit management is never granted to one user (migration 0027; the database refuses it too).
    if (overrides.some((o) => o.code === "credits.manage" && o.effect === "GRANT")) {
      throw new ValidationError({ permissions: "SUPER_ADMIN_ONLY" }, "credits.manage belongs to SUPER_ADMIN only");
    }

    const now = this.now();
    await this.commit([
      ...this.rbac.replaceUserPermissionsStatements(
        id,
        overrides.map((o) => ({ permissionId: ids.get(o.code)!, effect: o.effect })),
        actor.userId,
        now,
      ),
      this.log.auditStatement(actor.userId, "UPDATE_PERMISSIONS", MODULE, id,
        { overrides: parseOverrides(target.overrides) }, { overrides }, meta),
    ]);
    return toDto(await this.detailed(id));
  }

  /** Issues a one-time reset link for the admin to hand over; signs the user out everywhere. */
  async resetPassword(actor: AuthContext, id: string, meta: RequestMeta): Promise<PasswordLinkDto> {
    await this.authz.requirePermission(actor, "users.reset_password", meta);
    if (id === actor.userId) {
      throw new ForbiddenError("Use Change password for your own account", "CANNOT_MODIFY_SELF");
    }
    const target = await this.detailed(id);
    this.assertNotDeleted(target);
    await this.guardSuperAdminTarget(actor, target, "reset_super_admin_password", meta);

    const link = await this.links.issue(id, "ADMIN_RESET", target.preferred_language, meta);
    const now = this.now();
    await this.commit([
      ...link.statements,
      // The old password stops working immediately; the user sets a new one via the link.
      this.users.setPasswordStatement(id, await hashPassword(randomToken(32)), false, now),
      this.sessions.revokeAllStatement(id, "PASSWORD_CHANGED"),
      this.log.auditStatement(actor.userId, "RESET_PASSWORD", MODULE, id, null, { linkExpiresAt: link.expiresAt }, meta),
      this.log.eventStatement("ADMIN_PASSWORD_RESET_ISSUED", "WARNING", meta, { userId: id, details: { by: actor.userId } }),
    ]);
    return { url: link.url, expiresAt: link.expiresAt };
  }

  async suspend(actor: AuthContext, id: string, meta: RequestMeta): Promise<AdminUserDto> {
    await this.authz.requirePermission(actor, "users.suspend", meta);
    return this.changeStatus(actor, id, "ACTIVE", "SUSPENDED", "SUSPEND", meta);
  }

  async activate(actor: AuthContext, id: string, meta: RequestMeta): Promise<AdminUserDto> {
    await this.authz.requirePermission(actor, "users.suspend", meta);
    return this.changeStatus(actor, id, "SUSPENDED", "ACTIVE", "ACTIVATE", meta);
  }

  async delete(actor: AuthContext, id: string, meta: RequestMeta): Promise<AdminUserDto> {
    await this.authz.requirePermission(actor, "users.delete", meta);
    return this.changeStatus(actor, id, null, "DELETED", "DELETE", meta);
  }

  async restore(actor: AuthContext, id: string, meta: RequestMeta): Promise<AdminUserDto> {
    await this.authz.requirePermission(actor, "users.restore", meta);
    return this.changeStatus(actor, id, "DELETED", "ACTIVE", "RESTORE", meta);
  }

  async forceLogout(actor: AuthContext, id: string, meta: RequestMeta): Promise<AdminUserDto> {
    await this.authz.requirePermission(actor, "users.force_logout", meta);
    const target = await this.detailed(id);
    await this.guardSuperAdminTarget(actor, target, "force_logout_super_admin", meta);
    await this.commit([
      this.sessions.revokeAllStatement(id, "FORCE_LOGOUT"),
      this.log.auditStatement(actor.userId, "FORCE_LOGOUT", MODULE, id, { activeSessions: target.active_sessions }, null, meta),
      this.log.eventStatement("FORCE_LOGOUT", "WARNING", meta, { userId: id, details: { by: actor.userId } }),
    ]);
    return toDto(await this.detailed(id));
  }

  /** Edit a role's permissions. SUPER_ADMIN keeps every permission and cannot be edited. */
  async setRolePermissions(actor: AuthContext, roleId: string, codes: string[], language: string, meta: RequestMeta): Promise<RoleDto> {
    await this.authz.requirePermission(actor, "users.manage_permissions", meta);
    await this.authz.requireSuperAdminFor(actor, "edit_role_permissions", meta);
    const roles = await this.rbac.listRoles("en");
    const role = roles.find((r) => r.id === roleId);
    if (!role) throw new NotFoundError("Role not found");
    if (role.code === AuthorizationService.SUPER_ADMIN_ROLE) {
      throw new ForbiddenError("The SUPER_ADMIN role always has every permission", "SUPER_ADMIN_ROLE_LOCKED");
    }
    const ids = await this.rbac.permissionIdsByCode(codes);
    if (codes.some((c) => !ids.has(c))) throw new ValidationError({ permissions: "UNKNOWN_PERMISSION" });
    // Credit management stays with the SUPER_ADMIN role (migration 0027; the database refuses it too).
    if (codes.includes("credits.manage")) throw new ValidationError({ permissions: "SUPER_ADMIN_ONLY" }, "credits.manage belongs to SUPER_ADMIN only");

    await this.commit([
      ...this.rbac.replaceRolePermissionsStatements(roleId, [...ids.values()]),
      this.log.auditStatement(actor.userId, "UPDATE_ROLE_PERMISSIONS", "roles", roleId,
        { permissions: role.permissions ? role.permissions.split(",").sort() : [] }, { permissions: [...codes].sort() }, meta),
    ]);
    const updated = (await this.listRoles(actor, language, meta)).find((r) => r.id === roleId);
    if (!updated) throw new NotFoundError("Role not found");
    return updated;
  }

  // ---------------------------------------------------------------- helpers

  private async changeStatus(
    actor: AuthContext,
    id: string,
    requiredFrom: UserStatus | null,
    to: UserStatus,
    action: string,
    meta: RequestMeta,
  ): Promise<AdminUserDto> {
    if (id === actor.userId && to !== "ACTIVE") {
      throw new ForbiddenError(
        to === "DELETED" ? "You cannot delete your own account" : "You cannot suspend your own account",
        "CANNOT_MODIFY_SELF",
      );
    }
    const target = await this.detailed(id);
    if (requiredFrom !== null && target.status !== requiredFrom) {
      throw new ConflictError(`User is ${target.status}, expected ${requiredFrom}`, "INVALID_STATUS");
    }
    if (requiredFrom === null && target.status === to) {
      throw new ConflictError(`User is already ${to}`, "INVALID_STATUS");
    }
    await this.guardSuperAdminTarget(actor, target, `${action.toLowerCase()}_super_admin`, meta);

    const statements: D1PreparedStatementLike[] = [
      this.users.setStatusStatement(id, to, this.now(), to === "DELETED" ? actor.userId : null),
      this.log.auditStatement(actor.userId, action, MODULE, id, { status: target.status }, { status: to }, meta),
    ];
    if (to === "SUSPENDED") statements.push(this.sessions.revokeAllStatement(id, "USER_SUSPENDED"));
    if (to === "DELETED") statements.push(this.sessions.revokeAllStatement(id, "USER_DELETED"));
    await this.commit(statements);
    return toDto(await this.detailed(id));
  }

  /** Commits a batch; maps DB rule violations to friendly errors. */
  private async commit(statements: D1PreparedStatementLike[]): Promise<void> {
    try {
      await this.db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("LAST_SUPER_ADMIN")) {
        throw new ConflictError("At least one active SUPER_ADMIN must remain", "LAST_SUPER_ADMIN");
      }
      if (/UNIQUE constraint failed: users\.email/.test(message)) throw new ConflictError("Email already in use", "EMAIL_TAKEN");
      if (/UNIQUE constraint failed: users\.username/.test(message)) throw new ConflictError("Username already in use", "USERNAME_TAKEN");
      throw error;
    }
  }

  private async detailed(id: string): Promise<UserListRow> {
    const row = await this.users.getDetailed(id, this.now());
    if (!row) throw new NotFoundError("User not found", "USER_NOT_FOUND");
    return row;
  }

  private async guardSuperAdminTarget(actor: AuthContext, target: UserListRow, reason: string, meta: RequestMeta) {
    if (splitRoles(target.roles).includes(AuthorizationService.SUPER_ADMIN_ROLE)) {
      await this.authz.requireSuperAdminFor(actor, reason, meta);
    }
  }

  private assertNotDeleted(target: UserRow) {
    if (target.status === "DELETED") throw new ConflictError("User is deleted. Restore the user first.", "USER_DELETED");
  }

  private async resolveRoles(codes: string[]): Promise<Map<string, string>> {
    const ids = await this.rbac.roleIdsByCode(codes);
    if (codes.some((c) => !ids.has(c))) throw new ValidationError({ roles: "UNKNOWN_ROLE" });
    return ids;
  }

  private async assertUnique(email: string, username: string | null, selfId: string | null) {
    const byEmail = await this.users.findByEmail(email);
    if (byEmail && byEmail.id !== selfId) throw new ConflictError("Email already in use", "EMAIL_TAKEN");
    if (username) {
      const byUsername = await this.users.findByUsername(username);
      if (byUsername && byUsername.id !== selfId) throw new ConflictError("Username already in use", "USERNAME_TAKEN");
    }
  }

  private now(): string {
    return iso(this.clock());
  }
}

function splitRoles(roles: string | null): string[] {
  return roles ? roles.split(",").filter(Boolean) : [];
}

function parseOverrides(json: string | null): PermissionOverrideDto[] {
  if (!json) return [];
  try {
    return (JSON.parse(json) as PermissionOverrideDto[]).sort((a, b) => a.code.localeCompare(b.code));
  } catch {
    return [];
  }
}

function pickProfile(u: UserRow) {
  return { email: u.email, username: u.username, displayName: u.display_name, preferredLanguage: u.preferred_language };
}

export function toDto(u: UserListRow): AdminUserDto {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    displayName: u.display_name,
    preferredLanguage: parseLocale(u.preferred_language)?.code ?? null,
    status: u.status,
    roles: splitRoles(u.roles),
    permissionOverrides: parseOverrides(u.overrides),
    mustChangePassword: u.must_change_password === 1,
    lockedUntil: u.locked_until,
    lastLoginAt: u.last_login_at,
    activeSessions: u.active_sessions,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    deletedAt: u.deleted_at,
  };
}
