import { createContext, useContext } from "react";
import type { CurrentUserDto, PermissionCode } from "../../shared/auth-types.ts";
import type { AdminMessages } from "../../shared/i18n/admin-messages.ts";
import type { AdminCmsMessages } from "../../shared/i18n/admin-cms-messages.ts";
import type { Locale } from "../../shared/i18n/locales.ts";

export interface AdminContextValue {
  locale: Locale;
  t: AdminMessages;
  /** Phase 9 screens (dashboard, calendar, food, website, theme, marketing, SEO, content). */
  c: AdminCmsMessages;
  me: CurrentUserDto | null;
  setMe: (me: CurrentUserDto | null) => void;
  /** Sidebar items Super Admin hid for everyone (Administration → Menu); menu only, not access. */
  hiddenMenu: string[];
  setHiddenMenu: (paths: string[]) => void;
  /** Hides/shows UI only — the Worker enforces every permission. */
  can: (permission: PermissionCode) => boolean;
  /** Navigate within the admin: go("users", id) → /{lang}/admin/users/{id} */
  go: (...segments: string[]) => void;
  href: (...segments: string[]) => string;
  logout: () => Promise<void>;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error("useAdmin must be used inside <AdminApp>");
  return value;
}
