import { createServices, resolveBaseUrl, type Services, type ServiceOptions } from "./container.ts";
import { canonicalHostRedirect } from "./http/canonical-host.ts";
import { accommodationController } from "./controllers/accommodation.controller.ts";
import { adminUsersController } from "./controllers/admin-users.controller.ts";
import { bookingController } from "./controllers/booking.controller.ts";
import { paymentController } from "./controllers/payment.controller.ts";
import { slipController } from "./controllers/slip.controller.ts";
import { authController } from "./controllers/auth.controller.ts";
import { healthController } from "./controllers/health.controller.ts";
import { siteController } from "./controllers/site.controller.ts";
import { adminDashboardController } from "./controllers/admin-dashboard.controller.ts";
import { cmsController } from "./controllers/cms.controller.ts";
import { settingsController } from "./controllers/settings.controller.ts";
import { reportController } from "./controllers/report.controller.ts";
import { lineController } from "./controllers/line.controller.ts";
import type { Env } from "./env.ts";
import { HttpError, MethodNotAllowedError, TooManyRequestsError } from "./http/errors.ts";
import { jsonError } from "./http/response.ts";
import { withSecurityHeaders } from "./http/security-headers.ts";
import { Router, type RequestContext } from "./router.ts";
import { assertSameOriginRequest, clientIp } from "./security/request.ts";
import { allowRequest, rateGroup, shouldLog } from "./security/rate-limit.ts";
import { readCookie, SESSION_COOKIE } from "./security/cookies.ts";
import { isSafeObjectKey } from "./services/media-url.ts";
import { LINE_WEBHOOK_PATH } from "./line/line-api.ts";
import { createPageHandler } from "./seo/pages.ts";
import { seoController } from "./controllers/seo.controller.ts";
import { searchController } from "./controllers/search.controller.ts";
import { systemController } from "./controllers/system.controller.ts";
import { emailController, paypalController } from "./controllers/notify.controller.ts";

export interface AppOptions {
  /** Override service wiring (tests). */
  services?: (env: Env, options: ServiceOptions) => Services;
  /** Extra service options (tests: fixed clock, captured reset-link delivery). */
  serviceOptions?: Omit<ServiceOptions, "origin">;
  /** Override request id generation (tests). */
  requestId?: () => string;
}

export function createApp(options: AppOptions = {}) {
  const makeServices = options.services ?? createServices;
  const newRequestId = options.requestId ?? (() => crypto.randomUUID());

  // Services are created once per request and memoised on the request.
  const cache = new WeakMap<Request, Services>();
  const services = (ctx: Pick<RequestContext, "request" | "env" | "url">): Services => {
    let s = cache.get(ctx.request);
    if (!s) {
      s = makeServices(ctx.env, { ...options.serviceOptions, origin: ctx.url.origin });
      cache.set(ctx.request, s);
    }
    return s;
  };

  const health = healthController(services);
  const site = siteController(services);
  const auth = authController(services);
  const admin = adminUsersController(services);
  const acc = accommodationController(services);
  const book = bookingController(services);
  const pay = paymentController(services);
  const slip = slipController(services);
  const dash = adminDashboardController(services);
  const cms = cmsController(services);
  const settings = settingsController(services);
  const rep = reportController(services);
  const line = lineController(services);
  const seo = seoController(services);
  const search = searchController(services);
  const system = systemController(services);
  const email = emailController(services);
  const paypal = paypalController(services);
  const servePage = createPageHandler((request, env, url) => services({ request, env, url }));

  const router = new Router()
    .get("/api/health", health.check)
    .get("/api/public/site", site.getPublicSite)
    // Page metadata for in-app navigation (Phase 13): the same data the Worker puts in <head>.
    .get("/api/public/meta", seo.meta)
    // Global search (spec §40–41, §59)
    .get("/api/search", search.search)
    .post("/api/search/click", search.click)
    .get("/api/admin/search/analytics", search.analytics)
    // System status: health, configuration warnings, cron, deliveries, server errors (Phase 16)
    .get("/api/admin/system", system.status)
    .put("/api/admin/menu", system.saveMenu)
    .post("/api/admin/search/reindex", search.reindex)
    // Authentication (spec §59)
    .post("/api/auth/login", auth.login)
    .post("/api/auth/logout", auth.logout)
    .get("/api/auth/me", auth.me)
    .get("/api/auth/menu", system.menu)
    .post("/api/auth/refresh", auth.refresh)
    .post("/api/auth/forgot-password", auth.forgotPassword)
    .post("/api/auth/reset-password", auth.resetPassword)
    .post("/api/auth/change-password", auth.changePassword)
    // User management (spec §30–31)
    .get("/api/admin/users", admin.list)
    .post("/api/admin/users", admin.create)
    .get("/api/admin/users/:id", admin.get)
    .patch("/api/admin/users/:id", admin.update)
    .delete("/api/admin/users/:id", admin.remove)
    .put("/api/admin/users/:id/roles", admin.setRoles)
    .put("/api/admin/users/:id/permissions", admin.setPermissions)
    .post("/api/admin/users/:id/reset-password", admin.resetPassword)
    .post("/api/admin/users/:id/suspend", admin.suspend)
    .post("/api/admin/users/:id/activate", admin.activate)
    .post("/api/admin/users/:id/force-logout", admin.forceLogout)
    .post("/api/admin/users/:id/restore", admin.restore)
    .get("/api/admin/roles", admin.roles)
    .put("/api/admin/roles/:id/permissions", admin.setRolePermissions)
    .get("/api/admin/permissions", admin.permissions)
    .get("/api/admin/security-events", admin.securityEvents)
    .get("/api/admin/audit-logs", admin.auditLogs)
    // Accommodation (public)
    .get("/api/public/accommodations", acc.publicList)
    .get("/api/public/accommodations/:slug", acc.publicDetail)
    .get("/api/public/availability", acc.availability)
    // Accommodation (admin)
    .get("/api/admin/accommodations", acc.list)
    .post("/api/admin/accommodations", acc.create)
    .get("/api/admin/accommodations/:id", acc.get)
    .patch("/api/admin/accommodations/:id", acc.update)
    .delete("/api/admin/accommodations/:id", acc.remove)
    .put("/api/admin/accommodations/:id/translations", acc.setTranslations)
    .put("/api/admin/accommodations/:id/amenities", acc.setAmenities)
    .post("/api/admin/accommodations/:id/images", acc.addImage)
    .put("/api/admin/accommodations/:id/images/order", acc.reorderImages)
    .patch("/api/admin/accommodations/:id/images/:imageId", acc.updateImage)
    .delete("/api/admin/accommodations/:id/images/:imageId", acc.removeImage)
    .put("/api/admin/accommodations/:id/cover", acc.setCover)
    .post("/api/admin/accommodations/:id/blocks", acc.addBlock)
    .delete("/api/admin/accommodations/:id/blocks", acc.removeBlock)
    .get("/api/admin/availability", acc.grid)
    .get("/api/admin/amenities", acc.amenities)
    .post("/api/admin/amenities", acc.createAmenity)
    .patch("/api/admin/amenities/:id", acc.updateAmenity)
    .get("/api/admin/camping", acc.camping)
    .put("/api/admin/camping", acc.updateCamping)
    .put("/api/admin/camping/nights/:date", acc.setCampingNight)
    .get("/api/admin/camping/integrity", acc.campingIntegrity)
    .post("/api/admin/camping/recalculate", acc.recalculateCamping)
    .post("/api/admin/media", acc.upload)
    .put("/api/admin/media/:id/texts", acc.setMediaTexts)
    // Booking (public)
    .get("/api/public/food-options", book.foodOptions)
    .post("/api/public/bookings/quote", book.quote)
    .post("/api/public/bookings", book.create)
    .post("/api/public/bookings/lookup", book.lookup)
    // Booking (admin)
    .get("/api/admin/bookings", book.list)
    .get("/api/admin/bookings/:code", book.get)
    .post("/api/admin/bookings/:code/cancel", book.cancel)
    .get("/api/admin/bookings/:code/move-options", book.moveOptions)
    .post("/api/admin/bookings/:code/move", book.move)
    .get("/api/admin/pricing-rules", book.rules)
    .post("/api/admin/pricing-rules", book.createRule)
    .patch("/api/admin/pricing-rules/:id", book.updateRule)
    // Payments (spec §25–26)
    .get("/api/admin/payment-settings", pay.settings)
    .put("/api/admin/payment-settings", pay.saveSettings)
    .post("/api/admin/payment-settings/paypal-check", pay.paypalCheck)
    .get("/api/admin/receiving-accounts", pay.accounts)
    .post("/api/admin/receiving-accounts", pay.createAccount)
    .patch("/api/admin/receiving-accounts/:id", pay.updateAccount)
    .delete("/api/admin/receiving-accounts/:id", pay.deleteAccount)
    .post("/api/admin/receiving-accounts/:id/primary", pay.setPrimary)
    .post("/api/admin/bookings/:code/payments", pay.recordPayment)
    .post("/api/admin/bookings/:code/payments/:paymentId/refund", pay.refund)
    // Slips (spec §27)
    .post("/api/public/bookings/slip", slip.submit)
    .get("/api/admin/slips", slip.queue)
    .get("/api/admin/payments/:id/slip", slip.image)
    .post("/api/admin/payments/:id/verify", slip.verify)
    .post("/api/admin/payments/:id/reject", slip.reject)
    // PayPal Checkout (guest): start, finish after PayPal, cancel
    .post("/api/public/bookings/paypal/order", paypal.order)
    .post("/api/public/bookings/paypal/capture", paypal.capture)
    .post("/api/public/bookings/paypal/cancel", paypal.cancel)
    // Dashboard & calendar (spec §48–49)
    .get("/api/admin/dashboard", dash.dashboard)
    .get("/api/admin/calendar", dash.calendar)
    .get("/api/admin/payments", dash.payments)
    .post("/api/admin/bookings/:code/stay/:action", dash.stay)
    .get("/api/admin/booking-settings", dash.bookingSettings)
    .put("/api/admin/booking-settings", dash.saveBookingSettings)
    // Food capacity & kitchen orders (spec §22, §24)
    .get("/api/admin/food/capacity", dash.foodCapacity)
    .put("/api/admin/food/capacity/:categoryId/:date", dash.setFoodCapacity)
    .get("/api/admin/food-orders", dash.foodOrders)
    .patch("/api/admin/food-orders/:id", dash.updateFoodOrder)
    // Generic CMS records: food menu, home, gallery, history, SEO redirects
    .get("/api/admin/cms/:entity", cms.list)
    .post("/api/admin/cms/:entity", cms.create)
    .put("/api/admin/cms/:entity/order", cms.reorder)
    .get("/api/admin/cms/:entity/:id", cms.get)
    .patch("/api/admin/cms/:entity/:id", cms.update)
    .delete("/api/admin/cms/:entity/:id", cms.remove)
    .post("/api/admin/cms/:entity/:id/publish", cms.publish)
    .post("/api/admin/cms/:entity/:id/unpublish", cms.unpublish)
    // Website settings, branding, CTA, marketing, SEO, theme (spec §36–45)
    .get("/api/admin/settings/website", settings.website)
    .put("/api/admin/settings/website", settings.saveWebsite)
    .get("/api/admin/settings/branding", settings.branding)
    .put("/api/admin/settings/branding", settings.saveBranding)
    .get("/api/admin/settings/booking-cta", settings.bookingCta)
    .put("/api/admin/settings/booking-cta", settings.saveBookingCta)
    .get("/api/admin/settings/marketing", settings.marketing)
    .put("/api/admin/settings/marketing", settings.saveMarketing)
    .get("/api/admin/marketing/events", settings.capiEvents)
    .post("/api/admin/marketing/capi-test", settings.capiTest)
    .get("/api/admin/settings/privacy", settings.privacy)
    .put("/api/admin/settings/privacy", settings.savePrivacy)
    .get("/api/public/privacy", settings.publicPrivacy)
    .get("/api/admin/i18n/coverage", seo.coverage)
    .get("/api/admin/seo", settings.seo)
    .put("/api/admin/seo/:pageKey", settings.saveSeo)
    .get("/api/admin/theme", settings.theme)
    .get("/api/admin/theme/preview", settings.themePreview)
    .put("/api/admin/theme/draft", settings.saveThemeDraft)
    .delete("/api/admin/theme/draft", settings.discardThemeDraft)
    .post("/api/admin/theme/publish", settings.publishTheme)
    .post("/api/admin/theme/versions/:id/rollback", settings.rollbackTheme)
    // Public content (spec §59)
    .get("/api/public/home", settings.publicHome)
    .get("/api/public/home/slides", settings.publicSlides)
    .get("/api/public/gallery", settings.publicGallery)
    .get("/api/public/gallery/categories", settings.publicGalleryCategories)
    .get("/api/public/history", settings.publicHistory)
    .get("/api/public/history/timeline", settings.publicTimeline)
    .get("/api/public/food-menu", settings.publicFoodMenu)
    // Uploaded web fonts (Phase 12)
    .get("/api/admin/fonts", settings.fonts)
    .post("/api/admin/fonts", settings.uploadFont)
    .delete("/api/admin/fonts/:id", settings.deleteFont)
    // Reports (spec §50)
    .get("/api/admin/reports/:type", rep.run)
    .get("/api/admin/reports/:type/export", rep.exportXlsx)
    // LINE Official Account (spec §47)
    .get("/api/admin/line/settings", line.settings)
    .put("/api/admin/line/settings", line.saveSettings)
    .post("/api/admin/line/check", line.check)
    .get("/api/admin/line/recipients", line.recipients)
    .post("/api/admin/line/recipients", line.addRecipient)
    .patch("/api/admin/line/recipients/:id", line.updateRecipient)
    .delete("/api/admin/line/recipients/:id", line.deleteRecipient)
    .post("/api/admin/line/recipients/:id/test", line.testRecipient)
    .post("/api/admin/line/link-codes", line.createLinkCode)
    .get("/api/admin/line/link-codes/:id", line.linkStatus)
    .get("/api/admin/notifications", line.logs)
    .post("/api/admin/notifications/run", line.runNow)
    .post("/api/admin/notifications/:id/retry", line.retry)
    .post("/api/admin/notifications/:id/cancel", line.cancel)
    // E-mail notifications (Zoho Mail / Resend)
    .get("/api/admin/email/settings", email.settings)
    .put("/api/admin/email/settings", email.saveSettings)
    .get("/api/admin/email/recipients", email.recipients)
    .post("/api/admin/email/recipients", email.addRecipient)
    .patch("/api/admin/email/recipients/:id", email.updateRecipient)
    .delete("/api/admin/email/recipients/:id", email.deleteRecipient)
    .post("/api/admin/email/recipients/:id/test", email.testRecipient)
    .get("/api/admin/email/logs", email.logs)
    .post("/api/admin/email/logs/:id/retry", email.retry)
    .post("/api/public/bookings/line-link", line.guestLink)
    .post("/api/public/bookings/line-unlink", line.guestUnlink)
    .post(LINE_WEBHOOK_PATH, line.webhook);

  async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
    const requestId = newRequestId();
    let response: Response;
    try {
      await enforceRateLimit(request, env, url);
      // The LINE webhook is server-to-server and authenticated by its HMAC signature instead.
      if (url.pathname !== LINE_WEBHOOK_PATH) assertSameOriginRequest(request, url);
      const { handler, params } = router.match(request.method, url.pathname);
      response = await handler({ request, env, url, params, requestId });
      if (request.method === "HEAD") {
        response = new Response(null, { status: response.status, headers: response.headers });
      }
    } catch (error) {
      response = toErrorResponse(error, requestId);
      // Unexpected failures also go to the owner's error log (System status); no query string, no body.
      if (response.status >= 500) {
        try {
          await services({ request, env, url }).monitoring.recordError({ source: "API", error, requestId, method: request.method, path: url.pathname });
        } catch {
          // services unavailable: the console log above is all there is
        }
      }
    }
    return withSecurityHeaders(response, requestId);
  }

  /** Per-IP request limits (Phase 14); 429 + Retry-After, one security event per IP / minute. */
  async function enforceRateLimit(request: Request, env: Env, url: URL): Promise<void> {
    const group = rateGroup(request.method, url.pathname);
    const ip = clientIp(request);
    if (!group || (await allowRequest(env, group, ip))) return;
    if (ip && shouldLog(group, ip)) {
      await services({ request, env, url }).securityLog
        .event("RATE_LIMITED", "WARNING", { ip, userAgent: request.headers.get("User-Agent") }, { details: { group, path: url.pathname.slice(0, 100) } });
    }
    throw new TooManyRequestsError(60, "Too many requests. Please wait a moment and try again.");
  }

  /** GET /media/<object key> — public R2 images registered in D1 only. */
  async function serveMedia(request: Request, env: Env, url: URL): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    let key: string;
    try {
      key = decodeURIComponent(url.pathname.slice("/media/".length));
    } catch {
      return new Response("Not found", { status: 404 });
    }
    if (!isSafeObjectKey(key)) return new Response("Not found", { status: 404 });
    try {
      const s = services({ request, env, url });
      // Unpublished content images: only a signed-in staff session may see them (admin previews).
      const isStaff = async () => (await s.sessions.authenticate(readCookie(request, SESSION_COOKIE))) !== null;
      const res = await s.media.serve(key, request.headers.get("If-None-Match"), isStaff);
      if (!res) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
      return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "media_serve_failed", error: String(error) }));
      return new Response("Error", { status: 500 });
    }
  }

  /** GET /map-tiles/<z>/<x>/<y>.png — footer map thumbnail (OpenStreetMap tiles around the site only). */
  async function serveMapTile(request: Request, env: Env, url: URL): Promise<Response> {
    try {
      const res = await services({ request, env, url }).mapTiles.serve(request, url);
      return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "map_tile_failed", error: String(error).slice(0, 200) }));
      return new Response("Error", { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  }

  return {
    /** Every API route (method + pattern); used by the route security tests. */
    routes: () => router.list(),

    /**
     * Cron (every minute): release unpaid holds whose time is up (nights, tents, kitchen portions),
     * then plan and deliver LINE notifications. The camping drift check runs every 15 minutes.
     */
    async scheduled(env: Env, scheduledTime?: number): Promise<number> {
      const s = makeServices(env, { ...options.serviceOptions, origin: resolveBaseUrl(env, "https://localhost") });
      const minute = scheduledTime === undefined ? null : new Date(scheduledTime).getUTCMinutes();
      const started = Date.now();
      const failures: string[] = [];
      // Each task runs on its own: one failing never stops the others (Phase 16), and every failure
      // reaches the console (Workers Observability) and the owner's error log.
      const task = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
        try {
          return await run();
        } catch (error) {
          failures.push(name);
          console.error(JSON.stringify({ level: "error", message: `${name}_failed`, error: String(error).slice(0, 200) }));
          await s.monitoring.recordError({ source: "CRON", error, path: name, context: name });
          return null;
        }
      };

      const expired = (await task("bookings_expire", () => s.bookings.expireDue(200))) ?? 0;
      if (expired) console.log(JSON.stringify({ level: "info", message: "bookings_expired", count: expired }));
      if (minute === null || minute % 15 === 0) {
        const drift = await task("camping_drift", () => s.availability.detectCampingDrift());
        if (drift) console.error(JSON.stringify({ level: "error", message: "camping_inventory_drift", nights: drift }));
      }
      // Search index: rebuilt only when the content it is built from changed (checked every 5 minutes).
      if (minute === null || minute % 5 === 0) {
        const rows = await task("search_index", () => s.search.rebuildIfStale());
        if (rows !== null && rows !== undefined) console.log(JSON.stringify({ level: "info", message: "search_index_rebuilt", rows }));
      }
      // Meta Conversions API (Phase 14): due Lead / Purchase events, retries and retention.
      const capi = await task("capi", () => s.capi.tick());
      if (capi && (capi.sent || capi.failed || capi.retried)) console.log(JSON.stringify({ level: "info", message: "capi_events", ...capi }));
      const line = await task("line_notifications", () => s.notifications.tick());
      if (line && (line.planned || line.sent || line.failed || line.retried)) console.log(JSON.stringify({ level: "info", message: "line_notifications", ...line }));
      // E-mail (Zoho Mail / Resend) and PayPal captures left in flight (migration 0023).
      const mail = await task("email_notifications", () => s.email.tick());
      if (mail && (mail.sent || mail.failed || mail.retried)) console.log(JSON.stringify({ level: "info", message: "email_notifications", ...mail }));
      const pp = await task("paypal_reconcile", () => s.paypal.reconcile());
      if (pp?.settled) console.log(JSON.stringify({ level: "info", message: "paypal_reconciled", ...pp }));
      // Error log retention, once an hour.
      if (minute === null || minute === 11) await task("error_log_retention", () => s.monitoring.retention());

      // Heartbeat last: /api/health turns "stale" if this stops happening.
      await s.monitoring.heartbeat("cron", failures.length === 0, Date.now() - started, failures.length ? `failed: ${failures.join(", ")}` : null);
      return expired;
    },

    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const canonical = canonicalHostRedirect(request, env, url);
      if (canonical) return canonical;
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return handleApi(request, env, url);
      }
      if (url.pathname.startsWith("/media/")) {
        return serveMedia(request, env, url);
      }
      if (url.pathname.startsWith("/map-tiles/")) {
        return serveMapTile(request, env, url);
      }
      // Everything else: robots.txt, sitemap.xml, redirects and the app shell with page metadata (Phase 13).
      const group = rateGroup(request.method, url.pathname);
      if (group && !(await allowRequest(env, group, clientIp(request)))) {
        return new Response("Too many requests", { status: 429, headers: { "Retry-After": "60", "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      }
      return servePage(request, env, url);
    },
  };
}

function toErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof MethodNotAllowedError) {
    return jsonError(error.status, error.code, error.message, requestId, {
      Allow: [...error.allow, ...(error.allow.includes("GET") ? ["HEAD"] : [])].join(", "),
    });
  }
  if (error instanceof TooManyRequestsError) {
    return jsonError(error.status, error.code, error.message, requestId, { "Retry-After": String(error.retryAfterSeconds) });
  }
  if (error instanceof HttpError) {
    return jsonError(error.status, error.code, error.message, requestId, {}, error.details);
  }
  // Unexpected: log server-side with the request id; never leak details to clients.
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ level: "error", requestId, message }));
  return jsonError(500, "INTERNAL_ERROR", "Internal server error", requestId);
}

const app = createApp();

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return app.fetch(request, env);
  },
  scheduled(controller: { scheduledTime?: number }, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): void {
    ctx.waitUntil(app.scheduled(env, controller?.scheduledTime));
  },
};
