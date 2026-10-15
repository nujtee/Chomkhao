import type { PermissionCode } from "./auth-types.ts";

/**
 * Administration → Menu (migration 0024): the sidebar items Super Admin can hide for everyone.
 * The paths are those of the admin sidebar (client/admin/nav.ts — a test keeps both lists equal);
 * the Worker accepts nothing else. Hiding changes the menu only: permissions still decide access.
 */

/**
 * Never hidden: the dashboard (start page) and this page, so the menu can always be restored; and the credit pages
 * (migration 0027) — the property must always be able to top up, and Super Admin to manage credits.
 */
export const ADMIN_MENU_LOCKED = ["", "admin-menu", "credit-topup", "credit-admin"] as const;

export const ADMIN_MENU_PATHS = [
  "", "bookings", "calendar",
  "houses", "vip-tents", "camping", "pricing",
  "food", "food-orders", "kitchen",
  "payments", "slips", "receiving-accounts", "payment-settings", "credit-topup", "credit-admin",
  "reports",
  "content-home", "content-gallery", "content-history", "seo",
  "ga4", "meta-pixel", "capi",
  "settings-website", "settings-branding", "settings-theme", "settings-booking-cta", "settings-line", "settings-email", "settings-privacy",
  "users", "roles", "permissions", "security-events", "admin-menu",
  "audit-logs", "system",
] as const;

export type AdminMenuPath = (typeof ADMIN_MENU_PATHS)[number];

export const HIDEABLE_MENU_PATHS: readonly string[] = ADMIN_MENU_PATHS.filter((p) => !(ADMIN_MENU_LOCKED as readonly string[]).includes(p));

/**
 * What "see" and "manage" mean for each sidebar item, in permissions (Users → a user → Menu access).
 * `view` is the permission the sidebar shows the item by; `manage` are the permissions for changing things
 * on that page (none = seeing it is all there is, e.g. settings pages whose view permission already edits).
 * Several items share a permission (Houses / VIP tents / Seasonal prices: accommodation.view …): changing
 * one changes them together. A test keeps `view` equal to the sidebar's own permission.
 */
export const MENU_ACCESS: Record<AdminMenuPath, { view: PermissionCode; manage: PermissionCode[] }> = {
  "": { view: "dashboard.view", manage: [] },
  bookings: { view: "bookings.view", manage: ["bookings.edit", "bookings.cancel"] },
  calendar: { view: "calendar.view", manage: [] },
  houses: { view: "accommodation.view", manage: ["accommodation.edit", "accommodation.block"] },
  "vip-tents": { view: "accommodation.view", manage: ["accommodation.edit", "accommodation.block"] },
  camping: { view: "camping.view", manage: ["camping.edit"] },
  pricing: { view: "accommodation.view", manage: ["pricing.edit"] },
  food: { view: "food.view", manage: ["food.edit"] },
  "food-orders": { view: "food_orders.view", manage: ["food_orders.manage"] },
  kitchen: { view: "kitchen.view", manage: [] },
  payments: { view: "payments.view", manage: ["payments.verify", "payments.refund"] },
  slips: { view: "slips.view", manage: ["payments.verify"] },
  "receiving-accounts": { view: "receiving_accounts.view", manage: ["receiving_accounts.edit"] },
  "payment-settings": { view: "receiving_accounts.view", manage: ["receiving_accounts.edit"] },
  "credit-topup": { view: "credits.topup", manage: [] },
  "credit-admin": { view: "credits.manage", manage: [] },
  reports: { view: "reports.view", manage: ["reports.export"] },
  "content-home": { view: "content.home", manage: ["content.publish"] },
  "content-gallery": { view: "content.gallery", manage: ["content.publish"] },
  "content-history": { view: "content.history", manage: ["content.publish"] },
  seo: { view: "seo.edit", manage: [] },
  ga4: { view: "marketing.view", manage: ["marketing.edit"] },
  "meta-pixel": { view: "marketing.view", manage: ["marketing.edit"] },
  capi: { view: "marketing.view", manage: ["marketing.edit"] },
  "settings-website": { view: "settings.website", manage: [] },
  "settings-branding": { view: "settings.branding", manage: [] },
  "settings-theme": { view: "settings.theme", manage: [] },
  "settings-booking-cta": { view: "settings.booking_cta", manage: [] },
  "settings-line": { view: "settings.line", manage: [] },
  "settings-email": { view: "settings.line", manage: [] },
  "settings-privacy": { view: "settings.privacy", manage: [] },
  users: {
    view: "users.view",
    manage: ["users.create", "users.edit", "users.delete", "users.manage_roles", "users.manage_permissions",
      "users.reset_password", "users.suspend", "users.force_logout", "users.restore"],
  },
  roles: { view: "roles.view", manage: [] },
  permissions: { view: "roles.view", manage: [] },
  "security-events": { view: "security_events.view", manage: [] },
  "admin-menu": { view: "settings.admin_menu", manage: [] },
  "audit-logs": { view: "audit_logs.view", manage: [] },
  system: { view: "system.view", manage: [] },
};

/** GET /api/auth/menu (any signed-in user) · PUT /api/admin/menu (settings.admin_menu) */
export interface AdminMenuDto {
  /** Hidden sidebar items (paths). */
  hidden: string[];
}
