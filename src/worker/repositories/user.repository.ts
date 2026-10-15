import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { containsPattern } from "./sql-like.ts";

export interface UserRow {
  id: string;
  email: string;
  username: string | null;
  display_name: string;
  password_hash: string;
  must_change_password: number;
  preferred_language: string | null;
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface UserListRow extends UserRow {
  roles: string | null;          // comma-separated role codes
  overrides: string | null;      // JSON array [{code, effect}]
  active_sessions: number;
}

const USER_COLUMNS = `u.id, u.email, u.username, u.display_name, u.password_hash, u.must_change_password,
  u.preferred_language, u.status, u.failed_login_count, u.locked_until, u.last_login_at,
  u.created_at, u.updated_at, u.deleted_at`;

const LIST_EXTRAS = `
  (SELECT group_concat(r.code, ',') FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles,
  (SELECT json_group_array(json_object('code', p.code, 'effect', up.effect))
     FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = u.id) AS overrides,
  (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?1) AS active_sessions`;

export interface UserListFilter {
  status?: "ACTIVE" | "SUSPENDED" | "DELETED" | "ALL_ACTIVE";
  query?: string;
  /** Leave SUPER_ADMIN accounts out (the reader is not a SUPER_ADMIN). */
  hideSuperAdmins?: boolean;
  limit: number;
  offset: number;
}

export class UserRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Login by email or username (both COLLATE NOCASE). */
  findByIdentifier(identifier: string): Promise<UserRow | null> {
    return this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.email = ?1 OR u.username = ?1 LIMIT 1`)
      .bind(identifier)
      .first<UserRow>();
  }

  findById(id: string): Promise<UserRow | null> {
    return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?1`).bind(id).first<UserRow>();
  }

  findByEmail(email: string): Promise<UserRow | null> {
    return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.email = ?1`).bind(email).first<UserRow>();
  }

  findByUsername(username: string): Promise<UserRow | null> {
    return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.username = ?1`).bind(username).first<UserRow>();
  }

  getDetailed(id: string, nowIso: string): Promise<UserListRow | null> {
    return this.db
      .prepare(`SELECT ${USER_COLUMNS}, ${LIST_EXTRAS} FROM users u WHERE u.id = ?2`)
      .bind(nowIso, id)
      .first<UserListRow>();
  }

  async list(filter: UserListFilter, nowIso: string): Promise<{ rows: UserListRow[]; total: number }> {
    // Builds the WHERE clause with placeholders starting at ?{first}; values are always bound.
    const build = (first: number) => {
      const where: string[] = [];
      const values: unknown[] = [];
      const next = (value: unknown) => {
        values.push(value);
        return `?${first + values.length - 1}`;
      };
      if (filter.status === "ALL_ACTIVE" || filter.status === undefined) where.push("u.status <> 'DELETED'");
      else where.push(`u.status = ${next(filter.status)}`);
      // Not a SUPER_ADMIN: SUPER_ADMIN accounts are not listed at all.
      if (filter.hideSuperAdmins) {
        where.push("NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'role_super_admin')");
      }
      if (filter.query) {
        const p = next(containsPattern(filter.query));
        where.push(`(u.email LIKE ${p} ESCAPE '\\' OR u.display_name LIKE ${p} ESCAPE '\\' OR u.username LIKE ${p} ESCAPE '\\')`);
      }
      return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", values };
    };

    const listWhere = build(2); // ?1 = now (active session count)
    const n = listWhere.values.length;
    const countWhere = build(1);
    const [rows, total] = await this.db.batch([
      this.db
        .prepare(
          `SELECT ${USER_COLUMNS}, ${LIST_EXTRAS} FROM users u ${listWhere.sql}
            ORDER BY u.created_at DESC, u.id LIMIT ?${n + 2} OFFSET ?${n + 3}`,
        )
        .bind(nowIso, ...listWhere.values, filter.limit, filter.offset),
      this.db.prepare(`SELECT COUNT(*) AS n FROM users u ${countWhere.sql}`).bind(...countWhere.values),
    ]);
    return {
      rows: (rows?.results ?? []) as UserListRow[],
      total: ((total?.results[0] as { n: number } | undefined)?.n ?? 0),
    };
  }

  insertStatement(user: {
    id: string;
    email: string;
    username: string | null;
    displayName: string;
    passwordHash: string;
    mustChangePassword: boolean;
    preferredLanguage: string | null;
    createdBy: string | null;
    now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO users (id, email, username, display_name, password_hash, password_changed_at,
           must_change_password, preferred_language, status, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?9, ?6, ?7, 'ACTIVE', ?8, ?9, ?9)`,
      )
      .bind(
        user.id, user.email, user.username, user.displayName, user.passwordHash,
        user.mustChangePassword ? 1 : 0, user.preferredLanguage, user.createdBy, user.now,
      );
  }

  updateProfileStatement(
    id: string,
    fields: { email: string; username: string | null; displayName: string; preferredLanguage: string | null },
    now: string,
  ): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE users SET email = ?2, username = ?3, display_name = ?4, preferred_language = ?5, updated_at = ?6
          WHERE id = ?1`,
      )
      .bind(id, fields.email, fields.username, fields.displayName, fields.preferredLanguage, now);
  }

  setPasswordStatement(id: string, passwordHash: string, mustChange: boolean, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE users SET password_hash = ?2, must_change_password = ?3, password_changed_at = ?4,
                failed_login_count = 0, locked_until = NULL, updated_at = ?4
          WHERE id = ?1`,
      )
      .bind(id, passwordHash, mustChange ? 1 : 0, now);
  }

  setMustChangePasswordStatement(id: string, value: boolean, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE users SET must_change_password = ?2, updated_at = ?3 WHERE id = ?1")
      .bind(id, value ? 1 : 0, now);
  }

  setStatusStatement(
    id: string,
    status: "ACTIVE" | "SUSPENDED" | "DELETED",
    now: string,
    deletedBy: string | null = null,
  ): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE users SET status = ?2,
                deleted_at = CASE WHEN ?2 = 'DELETED' THEN ?3 ELSE NULL END,
                deleted_by = CASE WHEN ?2 = 'DELETED' THEN ?4 ELSE NULL END,
                failed_login_count = CASE WHEN ?2 = 'ACTIVE' THEN 0 ELSE failed_login_count END,
                locked_until = CASE WHEN ?2 = 'ACTIVE' THEN NULL ELSE locked_until END,
                updated_at = ?3
          WHERE id = ?1`,
      )
      .bind(id, status, now, deletedBy);
  }

  async recordLoginFailure(id: string, lockedUntil: string | null, now: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE users SET failed_login_count = failed_login_count + 1,
                locked_until = COALESCE(?2, locked_until), updated_at = ?3
          WHERE id = ?1`,
      )
      .bind(id, lockedUntil, now)
      .run();
  }

  async recordLoginSuccess(id: string, now: string): Promise<void> {
    await this.db
      .prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?2 WHERE id = ?1")
      .bind(id, now)
      .run();
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.prepare("UPDATE users SET password_hash = ?2 WHERE id = ?1").bind(id, passwordHash).run();
  }
}
