import { useCallback, useEffect, useMemo, useState } from "react";
import type { CurrentUserDto, PermissionCode } from "../../shared/auth-types.ts";
import { getAdminMessages, type AdminMessages } from "../../shared/i18n/admin-messages.ts";
import { getCmsMessages } from "../../shared/i18n/admin-cms-messages.ts";
import type { Locale } from "../../shared/i18n/locales.ts";
import { adminNextSegments, adminPath } from "../../shared/routes.ts";
import { clearHeadMeta } from "../seo/headMeta.ts";
import { ApiError, apiGet, apiRequest, setUnauthorizedHandler } from "../api/client.ts";
import { useRouter } from "../router/Router.tsx";
import { AdminContext, type AdminContextValue } from "./AdminContext.tsx";
import { AdminLayout } from "./AdminLayout.tsx";
import { CampingPage } from "./accommodation/CampingPage.tsx";
import { BookingDetailPage } from "./bookings/BookingDetailPage.tsx";
import { BookingsPage } from "./bookings/BookingsPage.tsx";
import { PricingRulesPage } from "./bookings/PricingRulesPage.tsx";
import { ReceivingAccountsPage } from "./payments/ReceivingAccountsPage.tsx";
import { PaymentSettingsPage } from "./payments/PaymentSettingsPage.tsx";
import { SlipsPage } from "./payments/SlipsPage.tsx";
import { UnitEditPage } from "./accommodation/UnitEditPage.tsx";
import { UnitsPage } from "./accommodation/UnitsPage.tsx";
import { findNavItem } from "./nav.ts";
import { AuditLogsPage } from "./pages/AuditLogsPage.tsx";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { PermissionsPage } from "./pages/PermissionsPage.tsx";
import { PlaceholderPage } from "./pages/PlaceholderPage.tsx";
import { ResetPasswordPage } from "./pages/ResetPasswordPage.tsx";
import { RolesPage } from "./pages/RolesPage.tsx";
import { SecurityEventsPage } from "./pages/SecurityEventsPage.tsx";
import { UserFormPage } from "./pages/UserFormPage.tsx";
import { UsersPage } from "./pages/UsersPage.tsx";
import { CalendarPage } from "./bookings/CalendarPage.tsx";
import { GalleryPage, HistoryPage, HomeContentPage } from "./content/ContentPages.tsx";
import { FoodMenuPage, FoodOrdersPage } from "./food/FoodPages.tsx";
import { PaymentsPage } from "./payments/PaymentsPage.tsx";
import { BookingCtaPage, BrandingPage, MarketingPage, SeoPage, WebsiteSettingsPage } from "./settings/SettingsPages.tsx";
import { ThemePage } from "./settings/ThemePage.tsx";
import { LinePage } from "./settings/LinePage.tsx";
import { EmailPage } from "./settings/EmailPage.tsx";
import { PrivacySettingsPage } from "./settings/PrivacySettingsPage.tsx";
import { SystemStatusPage } from "./pages/SystemStatusPage.tsx";
import { AdminMenuPage } from "./pages/AdminMenuPage.tsx";
import type { AdminMenuDto } from "../../shared/admin-menu.ts";
import { ReportPrintPage } from "./reports/ReportPrintPage.tsx";
import { ReportsPage } from "./reports/ReportsPage.tsx";
import { CreditTopupPage } from "./credits/CreditTopupPage.tsx";
import { CreditAdminPage } from "./credits/CreditAdminPage.tsx";
import { MyAccountPage } from "./credits/MyAccountPage.tsx";
import "../styles/admin.css";

const PUBLIC_PAGES = new Set(["login", "forgot-password", "reset-password"]);

/** Keeps admin pages out of search engines (also sent as X-Robots-Tag by the Worker assets). */
function useNoIndex() {
  useEffect(() => {
    // Public page metadata (if the visitor came from the website) does not belong to admin pages.
    clearHeadMeta();
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

export function AdminApp({ locale, segments }: { locale: Locale; segments: string[] }) {
  const { navigate } = useRouter();
  const c = getCmsMessages(locale.code);
  // Error codes from Phase 9 endpoints live in the CMS dictionary; one lookup table for errorMessage().
  const t: AdminMessages = useMemo(() => {
    const base = getAdminMessages(locale.code);
    return { ...base, errors: { ...c.errors, ...base.errors } };
  }, [locale.code, c]);
  const [me, setMe] = useState<CurrentUserDto | null | undefined>(undefined);
  /** null until loaded for the signed-in user: the sidebar waits for it, so hidden items never flash. */
  const [hiddenMenu, setHiddenMenu] = useState<string[] | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  useNoIndex();

  useEffect(() => {
    document.documentElement.lang = locale.code;
  }, [locale]);

  // Load the current session once.
  useEffect(() => {
    const controller = new AbortController();
    apiGet<CurrentUserDto>("/api/auth/me", controller.signal)
      .then(setMe)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setMe(error instanceof ApiError && error.status === 401 ? null : null);
      });
    return () => controller.abort();
  }, []);

  // Sidebar items hidden by Super Admin (Administration → Menu), once signed in.
  const meId = me?.id ?? null;
  useEffect(() => {
    setHiddenMenu(null);
    if (!meId) return;
    const controller = new AbortController();
    apiGet<AdminMenuDto>("/api/auth/menu", controller.signal)
      .then((d) => setHiddenMenu(d.hidden))
      .catch(() => !controller.signal.aborted && setHiddenMenu([])); // the full menu is the safe fallback
    return () => controller.abort();
  }, [meId]);

  // Any 401 later (expired / revoked session) sends the user back to the login page.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setMe((current) => {
        if (current) setSessionExpired(true);
        return null;
      });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const href = useCallback((...s: string[]) => adminPath(locale, ...s), [locale]);
  const go = useCallback((...s: string[]) => navigate(adminPath(locale, ...s)), [locale, navigate]);

  const logout = useCallback(async () => {
    try {
      await apiRequest("POST", "/api/auth/logout");
    } finally {
      setMe(null);
      navigate(adminPath(locale, "login"));
    }
  }, [locale, navigate]);

  const value: AdminContextValue = useMemo(
    () => ({
      locale,
      t,
      c,
      me: me ?? null,
      setMe: (next) => {
        if (next) setSessionExpired(false);
        setMe(next);
      },
      hiddenMenu: hiddenMenu ?? [],
      setHiddenMenu,
      can: (permission: PermissionCode) => !!me?.permissions.includes(permission),
      go,
      href,
      logout,
    }),
    [locale, t, c, me, hiddenMenu, go, href, logout],
  );

  const page = segments[0] ?? "";
  const isPublicPage = PUBLIC_PAGES.has(page);
  const here = segments.join("/");

  // Redirects: signed-out users → login (remembering the page they opened, e.g. a booking linked from LINE);
  // signed-in users away from login, back to that page.
  useEffect(() => {
    if (me === undefined) return;
    if (me === null && !isPublicPage) {
      const next = adminNextSegments(here) ? `?next=${encodeURIComponent(here)}` : "";
      navigate(`${adminPath(locale, "login")}${next}`, { replace: true });
    }
    if (me && page === "login") {
      const next = adminNextSegments(new URLSearchParams(window.location.search).get("next"));
      navigate(adminPath(locale, ...(next ?? [])), { replace: true });
    }
  }, [me, isPublicPage, page, here, locale, navigate]);

  let content;
  if (me === undefined || (me && !isPublicPage && hiddenMenu === null)) {
    content = <p className="adm-loading" role="status">{t.common.loading}</p>;
  } else if (isPublicPage || me === null) {
    content =
      page === "forgot-password" ? <ForgotPasswordPage />
        : page === "reset-password" ? <ResetPasswordPage />
          : <LoginPage expired={sessionExpired} />;
  } else if (me.mustChangePassword) {
    content = <ChangePasswordPage forced />;
  } else if (page === "reports" && segments[1] === "print" && segments.length === 2) {
    // Printable report (PDF): full page, no admin chrome.
    content = <ReportPrintPage />;
  } else {
    content = <AdminLayout currentPath={page}>{renderPage(segments, t.common.notFound)}</AdminLayout>;
  }

  return <AdminContext.Provider value={value}>{content}</AdminContext.Provider>;
}

function renderPage(segments: string[], notFound: string) {
  const [page = "", id, extra] = segments;
  if (extra !== undefined) return <PlaceholderPage title={notFound} />;
  switch (page) {
    case "":
      return <DashboardPage />;
    case "users":
      // key: a different user (or new → saved user) must start with fresh page state.
      if (id === "new") return <UserFormPage key="new" userId={null} />;
      return id ? <UserFormPage key={id} userId={id} /> : <UsersPage />;
    case "houses":
    case "vip-tents": {
      const type = page === "houses" ? "HOUSE" : "VIP_TENT";
      if (id === "new") return <UnitEditPage key={`${page}-new`} type={type} unitId={null} />;
      return id ? <UnitEditPage key={id} type={type} unitId={id} /> : <UnitsPage key={page} type={type} />;
    }
    case "camping":
      return <CampingPage />;
    case "pricing":
      return <PricingRulesPage />;
    case "receiving-accounts":
      return <ReceivingAccountsPage />;
    case "payment-settings":
      return <PaymentSettingsPage />;
    case "slips":
      return <SlipsPage />;
    case "bookings":
      return id ? <BookingDetailPage key={id} code={id} /> : <BookingsPage />;
    case "calendar":
      return <CalendarPage />;
    case "reports":
      return id ? <PlaceholderPage title={notFound} /> : <ReportsPage />;
    case "kitchen":
      return <ReportsPage key="kitchen" fixedType="kitchen" />;
    case "payments":
      return <PaymentsPage />;
    case "food":
      return <FoodMenuPage />;
    case "food-orders":
      return <FoodOrdersPage />;
    case "content-home":
      return <HomeContentPage />;
    case "content-gallery":
      return <GalleryPage />;
    case "content-history":
      return <HistoryPage />;
    case "seo":
      return <SeoPage />;
    case "ga4":
    case "meta-pixel":
    case "capi":
      return <MarketingPage focus={page} />;
    case "settings-website":
      return <WebsiteSettingsPage />;
    case "settings-branding":
      return <BrandingPage />;
    case "settings-theme":
      return <ThemePage />;
    case "settings-booking-cta":
      return <BookingCtaPage />;
    case "settings-line":
      return <LinePage />;
    case "settings-email":
      return <EmailPage />;
    case "settings-privacy":
      return <PrivacySettingsPage />;
    case "roles":
      return <RolesPage />;
    case "permissions":
      return <PermissionsPage />;
    case "security-events":
      return <SecurityEventsPage />;
    case "system":
      return <SystemStatusPage />;
    case "admin-menu":
      return <AdminMenuPage />;
    case "audit-logs":
      return <AuditLogsPage />;
    case "credit-topup":
      return <CreditTopupPage />;
    case "credit-admin":
      return <CreditAdminPage />;
    case "my-account":
      return <MyAccountPage />;
    case "change-password":
      return <ChangePasswordPage forced={false} />;
    default: {
      const item = findNavItem(page);
      return <PlaceholderPage title={item ? null : notFound} navPath={item ? page : undefined} />;
    }
  }
}
