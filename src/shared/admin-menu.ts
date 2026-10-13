/**
 * Administration → Menu (migration 0024): the sidebar items Super Admin can hide for everyone.
 * The paths are those of the admin sidebar (client/admin/nav.ts — a test keeps both lists equal);
 * the Worker accepts nothing else. Hiding changes the menu only: permissions still decide access.
 */

/** Never hidden: the dashboard (start page) and this page, so the menu can always be restored. */
export const ADMIN_MENU_LOCKED = ["", "admin-menu"] as const;

export const ADMIN_MENU_PATHS = [
  "", "bookings", "calendar",
  "houses", "vip-tents", "camping", "pricing",
  "food", "food-orders", "kitchen",
  "payments", "slips", "receiving-accounts", "payment-settings",
  "reports",
  "content-home", "content-gallery", "content-history", "seo",
  "ga4", "meta-pixel", "capi",
  "settings-website", "settings-branding", "settings-theme", "settings-booking-cta", "settings-line", "settings-email", "settings-privacy",
  "users", "roles", "permissions", "security-events", "admin-menu",
  "audit-logs", "system",
] as const;

export type AdminMenuPath = (typeof ADMIN_MENU_PATHS)[number];

export const HIDEABLE_MENU_PATHS: readonly string[] = ADMIN_MENU_PATHS.filter((p) => !(ADMIN_MENU_LOCKED as readonly string[]).includes(p));

/** GET /api/auth/menu (any signed-in user) · PUT /api/admin/menu (settings.admin_menu) */
export interface AdminMenuDto {
  /** Hidden sidebar items (paths). */
  hidden: string[];
}
