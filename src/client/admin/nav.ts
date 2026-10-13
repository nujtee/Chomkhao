import type { PermissionCode } from "../../shared/auth-types.ts";
import type { AdminMessages } from "../../shared/i18n/admin-messages.ts";

export interface NavItem {
  path: string;
  label: (t: AdminMessages) => string;
  permission: PermissionCode;
  /** Implemented pages; others render a "coming in a later phase" placeholder. */
  ready?: boolean;
}

export interface NavGroup {
  /** Stable key: the collapsed / expanded state of a group is remembered by it. */
  id: string;
  /** Groups with a label collapse under it; groups without one are top-level entries. */
  label: ((t: AdminMessages) => string) | null;
  items: NavItem[];
}

/** Admin sidebar (spec §35). Each item is shown only if the user holds its permission. */
export const ADMIN_NAV: NavGroup[] = [
  { id: "dashboard", label: null, items: [{ path: "", label: (t) => t.nav.dashboard, permission: "dashboard.view", ready: true }] },
  {
    id: "bookings",
    label: (t) => t.nav.bookingsGroup,
    items: [
      { ready: true, path: "bookings", label: (t) => t.nav.bookings, permission: "bookings.view" },
      { ready: true, path: "calendar", label: (t) => t.nav.calendar, permission: "calendar.view" },
    ],
  },
  {
    id: "accommodation",
    label: (t) => t.nav.accommodationGroup,
    items: [
      { ready: true, path: "houses", label: (t) => t.nav.houses, permission: "accommodation.view" },
      { ready: true, path: "vip-tents", label: (t) => t.nav.vipTents, permission: "accommodation.view" },
      { ready: true, path: "camping", label: (t) => t.nav.camping, permission: "camping.view" },
      { ready: true, path: "pricing", label: (t) => t.nav.pricing, permission: "accommodation.view" },
    ],
  },
  {
    id: "food",
    label: (t) => t.nav.foodGroup,
    items: [
      { ready: true, path: "food", label: (t) => t.nav.foodMenu, permission: "food.view" },
      { ready: true, path: "food-orders", label: (t) => t.nav.foodOrders, permission: "food_orders.view" },
      { ready: true, path: "kitchen", label: (t) => t.nav.kitchen, permission: "kitchen.view" },
    ],
  },
  {
    id: "finance",
    label: (t) => t.nav.financeGroup,
    items: [
      { ready: true, path: "payments", label: (t) => t.nav.payments, permission: "payments.view" },
      { ready: true, path: "slips", label: (t) => t.nav.slips, permission: "slips.view" },
      { ready: true, path: "receiving-accounts", label: (t) => t.nav.receivingAccounts, permission: "receiving_accounts.view" },
      { ready: true, path: "payment-settings", label: (t) => t.nav.paymentSettings, permission: "receiving_accounts.view" },
    ],
  },
  { id: "reports", label: null, items: [{ ready: true, path: "reports", label: (t) => t.nav.reports, permission: "reports.view" }] },
  {
    id: "website",
    label: (t) => t.nav.websiteGroup,
    items: [
      { ready: true, path: "content-home", label: (t) => t.nav.home, permission: "content.home" },
      { ready: true, path: "content-gallery", label: (t) => t.nav.gallery, permission: "content.gallery" },
      { ready: true, path: "content-history", label: (t) => t.nav.history, permission: "content.history" },
      { ready: true, path: "seo", label: (t) => t.nav.seo, permission: "seo.edit" },
    ],
  },
  {
    id: "marketing",
    label: (t) => t.nav.marketingGroup,
    items: [
      { ready: true, path: "ga4", label: (t) => t.nav.ga4, permission: "marketing.view" },
      { ready: true, path: "meta-pixel", label: (t) => t.nav.metaPixel, permission: "marketing.view" },
      { ready: true, path: "capi", label: (t) => t.nav.capi, permission: "marketing.view" },
    ],
  },
  {
    id: "settings",
    label: (t) => t.nav.settingsGroup,
    items: [
      { ready: true, path: "settings-website", label: (t) => t.nav.website, permission: "settings.website" },
      { ready: true, path: "settings-branding", label: (t) => t.nav.branding, permission: "settings.branding" },
      { ready: true, path: "settings-theme", label: (t) => t.nav.theme, permission: "settings.theme" },
      { ready: true, path: "settings-booking-cta", label: (t) => t.nav.bookingCta, permission: "settings.booking_cta" },
      { ready: true, path: "settings-line", label: (t) => t.nav.line, permission: "settings.line" },
      { ready: true, path: "settings-email", label: (t) => t.nav.email, permission: "settings.line" },
      { ready: true, path: "settings-privacy", label: (t) => t.nav.privacy, permission: "settings.privacy" },
    ],
  },
  {
    id: "administration",
    label: (t) => t.nav.adminGroup,
    items: [
      { path: "users", label: (t) => t.nav.users, permission: "users.view", ready: true },
      { path: "roles", label: (t) => t.nav.roles, permission: "roles.view", ready: true },
      { path: "permissions", label: (t) => t.nav.permissions, permission: "roles.view", ready: true },
      { path: "security-events", label: (t) => t.nav.securityEvents, permission: "security_events.view", ready: true },
      { path: "admin-menu", label: (t) => t.nav.adminMenu, permission: "settings.admin_menu", ready: true },
    ],
  },
  {
    id: "system",
    label: null,
    items: [
      { path: "audit-logs", label: (t) => t.nav.auditLogs, permission: "audit_logs.view", ready: true },
      { path: "system", label: (t) => t.nav.system, permission: "system.view", ready: true },
    ],
  },
];

export function findNavItem(path: string): NavItem | undefined {
  for (const group of ADMIN_NAV) for (const item of group.items) if (item.path === path) return item;
  return undefined;
}
