/**
 * Auth / RBAC API contract shared by the Worker and the admin UI.
 *
 * PERMISSION_CODES mirrors the permission catalogue in D1 (migration 0010) so that
 * `requirePermission(user, "users.delete")` is type-checked. WHICH role holds WHICH
 * permission is data in D1 — never decided in code. A test keeps both lists in sync.
 */
import type { LocaleCode } from "./i18n/locales.ts";

export const PERMISSION_CODES = [
  "dashboard.view",
  "bookings.view", "bookings.create", "bookings.edit", "bookings.cancel", "bookings.export", "calendar.view",
  "accommodation.view", "accommodation.edit", "accommodation.block", "pricing.edit", "camping.view", "camping.edit",
  "food.view", "food.edit", "food_orders.view", "food_orders.manage", "kitchen.view",
  "payments.view", "payments.verify", "payments.refund", "slips.view", "receiving_accounts.view", "receiving_accounts.edit",
  "reports.view", "reports.export",
  "content.view", "content.home", "content.gallery", "content.history", "content.publish", "seo.edit",
  "marketing.view", "marketing.edit",
  "settings.website", "settings.branding", "settings.theme", "settings.booking_cta", "settings.line", "settings.privacy",
  "settings.admin_menu",
  "users.view", "users.create", "users.edit", "users.delete", "users.manage_roles", "users.manage_permissions",
  "users.reset_password", "users.suspend", "users.force_logout", "users.restore",
  "roles.view", "security_events.view", "audit_logs.view", "notifications.view",
  "system.view",
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

export const ROLE_CODES = ["SUPER_ADMIN", "MANAGER", "BOOKING_ADMIN", "FINANCE_ADMIN", "CONTENT_ADMIN", "VIEWER"] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export type UserStatus = "ACTIVE" | "SUSPENDED" | "DELETED";

/** GET /api/auth/me */
export interface CurrentUserDto {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  preferredLanguage: LocaleCode | null;
  roles: string[];
  permissions: PermissionCode[];
  mustChangePassword: boolean;
  session: { expiresAt: string; rememberMe: boolean };
}

export interface LoginRequest {
  identifier: string;
  password: string;
  rememberMe?: boolean;
}

export interface PermissionOverrideDto {
  code: PermissionCode;
  effect: "GRANT" | "DENY";
}

export interface AdminUserDto {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  preferredLanguage: LocaleCode | null;
  status: UserStatus;
  roles: string[];
  permissionOverrides: PermissionOverrideDto[];
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  activeSessions: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AdminUserListDto {
  items: AdminUserDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** One-time link shown to the admin (invite / password reset). Never stored in plain text. */
export interface PasswordLinkDto {
  url: string;
  expiresAt: string;
}

export interface CreateUserResultDto {
  user: AdminUserDto;
  /** Present when no initial password was given: the user sets it via this link. */
  inviteLink: PasswordLinkDto | null;
}

export interface RoleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: PermissionCode[];
  userCount: number;
}

export interface PermissionDto {
  code: PermissionCode;
  module: string;
  description: string;
}

export interface SecurityEventDto {
  id: string;
  eventType: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  userId: string | null;
  userEmail: string | null;
  identifier: string | null;
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogDto {
  id: string;
  userId: string | null;
  userEmail: string | null;
  action: string;
  module: string;
  recordId: string | null;
  oldValue: unknown;
  newValue: unknown;
  ip: string | null;
  createdAt: string;
}

export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
}
