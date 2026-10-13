import { AdminMenuRepository } from "./repositories/admin-menu.repository.ts";
import { AdminMenuService } from "./services/admin-menu.service.ts";
import type { Env } from "./env.ts";
import { D1HealthRepository } from "./repositories/health.repository.ts";
import { LogRepository } from "./repositories/log.repository.ts";
import { PasswordResetRepository } from "./repositories/password-reset.repository.ts";
import { RbacRepository } from "./repositories/rbac.repository.ts";
import { SessionRepository } from "./repositories/session.repository.ts";
import { D1SiteSettingsRepository } from "./repositories/site-settings.repository.ts";
import { UserRepository } from "./repositories/user.repository.ts";
import { AccommodationRepository } from "./repositories/accommodation.repository.ts";
import { InventoryRepository } from "./repositories/inventory.repository.ts";
import { MediaRepository } from "./repositories/media.repository.ts";
import { BookingRepository } from "./repositories/booking.repository.ts";
import { PricingRepository } from "./repositories/pricing.repository.ts";
import { PaymentRepository } from "./repositories/payment.repository.ts";
import { PaymentService } from "./services/payment.service.ts";
import { SlipService } from "./services/slip.service.ts";
import { createSlipVerifier, type SlipVerifier } from "./slip/slip-verifier.ts";
import { BookingService } from "./services/booking.service.ts";
import { PricingRuleService } from "./services/pricing-rule.service.ts";
import { QuoteService } from "./services/quote.service.ts";
import { AccommodationService } from "./services/accommodation.service.ts";
import { AdminLogService } from "./services/admin-log.service.ts";
import { AvailabilityService } from "./services/availability.service.ts";
import { MediaService } from "./services/media.service.ts";
import { AuthService } from "./services/auth.service.ts";
import { systemClock, type Clock } from "./services/auth-context.ts";
import { AuthorizationService } from "./services/authorization.service.ts";
import { HealthService } from "./services/health.service.ts";
import { ConsoleOrNoopDelivery, PasswordLinkService, type PasswordResetDelivery } from "./services/password-link.service.ts";
import { SecurityLogService } from "./services/security-log.service.ts";
import { SessionService } from "./services/session.service.ts";
import { SiteService } from "./services/site.service.ts";
import { UserManagementService } from "./services/user-management.service.ts";
import { CmsService } from "./cms/cms.service.ts";
import { DashboardRepository } from "./repositories/dashboard.repository.ts";
import { FoodAdminRepository } from "./repositories/food-admin.repository.ts";
import { SettingsRepository } from "./repositories/settings.repository.ts";
import { DashboardService } from "./services/dashboard.service.ts";
import { FoodAdminService } from "./services/food-admin.service.ts";
import { PublicContentService } from "./services/public-content.service.ts";
import { SettingsService } from "./services/settings.service.ts";
import { ReportRepository } from "./repositories/report.repository.ts";
import { ReportService } from "./services/report.service.ts";
import { LineRepository } from "./repositories/line.repository.ts";
import { LineService } from "./services/line.service.ts";
import { NotificationService, Outbox } from "./services/notification.service.ts";
import { LINE_WEBHOOK_PATH, type FetchLike } from "./line/line-api.ts";
import { getLocale, parseLocale } from "../shared/i18n/locales.ts";
import { ImageResolver } from "./media/image-resolver.ts";
import { FontRepository } from "./repositories/font.repository.ts";
import { FontService } from "./services/font.service.ts";
import { SeoRepository } from "./repositories/seo.repository.ts";
import { SeoService } from "./services/seo.service.ts";
import { TranslationCoverageService } from "./services/translation-coverage.service.ts";
import { SearchRepository } from "./repositories/search.repository.ts";
import { SearchService } from "./services/search.service.ts";
import { MarketingRepository } from "./repositories/marketing.repository.ts";
import { CompositeOutbox, MarketingOutbox, MetaCapiService } from "./services/marketing.service.ts";
import { PrivacyService } from "./services/privacy.service.ts";
import { Ga4ReportService } from "./services/ga4-report.service.ts";
import { MonitoringRepository } from "./repositories/monitoring.repository.ts";
import { MonitoringService } from "./services/monitoring.service.ts";
import { edgeCache, MapTileService } from "./services/map-tile.service.ts";
import { EmailRepository } from "./repositories/email.repository.ts";
import { EmailOutbox, EmailService } from "./services/email.service.ts";
import { createPaypalApi, paypalEnvironment, type FetchLike as PaypalFetch } from "./paypal/paypal-api.ts";
import { PaypalService } from "./services/paypal.service.ts";
import { createEmailSender } from "./email/provider.ts";
import type { FetchLike as EmailFetch } from "./email/sender.ts";

/**
 * Composition root: wires repositories into services per request.
 * Tests replace pieces via `createApp({ services, clock, delivery })`.
 */
export interface Services {
  site: SiteService;
  health: HealthService;
  sessions: SessionService;
  auth: AuthService;
  authorization: AuthorizationService;
  users: UserManagementService;
  logs: AdminLogService;
  media: MediaService;
  accommodation: AccommodationService;
  availability: AvailabilityService;
  quotes: QuoteService;
  bookings: BookingService;
  pricingRules: PricingRuleService;
  payments: PaymentService;
  slips: SlipService;
  dashboard: DashboardService;
  cms: CmsService;
  settings: SettingsService;
  foodAdmin: FoodAdminService;
  content: PublicContentService;
  reports: ReportService;
  line: LineService;
  notifications: NotificationService;
  fonts: FontService;
  seo: SeoService;
  translations: TranslationCoverageService;
  search: SearchService;
  capi: MetaCapiService;
  /** Security events / audit writer (rate-limit events, Phase 14). */
  securityLog: SecurityLogService;
  privacy: PrivacyService;
  /** Heartbeats, server error log, System status (Phase 16). */
  monitoring: MonitoringService;
  /** Footer map thumbnail tiles (OpenStreetMap, through the Worker). */
  mapTiles: MapTileService;
  /** E-mail notifications through Zoho Mail or Resend (migration 0023). */
  email: EmailService;
  /** PayPal Checkout (migration 0023). */
  paypal: PaypalService;
  /** Administration → Menu: sidebar items hidden for everyone (migration 0024). */
  adminMenu: AdminMenuService;
}

export interface ServiceOptions {
  /** Origin of the current request, used for links when APP_BASE_URL is not set. */
  origin: string;
  clock?: Clock;
  delivery?: PasswordResetDelivery;
  /** Tests: replace the slip verification service (null = manual only). */
  slipVerifier?: SlipVerifier | null;
  /** Tests / e2e: fetch used for the LINE Messaging API. */
  lineFetch?: FetchLike;
  /** Tests / e2e: fetch used for the Meta Conversions API. */
  metaFetch?: FetchLike;
  /** Google APIs (GA4 Data API, OAuth) — tests use a fake. */
  googleFetch?: FetchLike;
  /** Tests / e2e: fetch used for OpenStreetMap map tiles. */
  mapFetch?: FetchLike;
  /** Tests / e2e: fetch used for the e-mail API (Zoho Mail / Resend). */
  emailFetch?: EmailFetch;
  /** Tests / e2e: fetch used for the PayPal REST API. */
  paypalFetch?: PaypalFetch;
}

/** Absolute links (reset / invite) use APP_BASE_URL when configured (https only). */
export function resolveBaseUrl(env: Env, origin: string): string {
  const configured = env.APP_BASE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.hostname === "localhost") return url.origin;
    } catch {
      // fall through to the request origin
    }
  }
  return origin;
}

/** Only an explicitly configured https APP_BASE_URL is used for links inside LINE messages (cron has no request origin). */
export function configuredBaseUrl(env: Env): string | null {
  const configured = env.APP_BASE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function createServices(env: Env, options: ServiceOptions): Services {
  const clock = options.clock ?? systemClock;
  const db = env.DB;

  const users = new UserRepository(db);
  const rbac = new RbacRepository(db);
  const resets = new PasswordResetRepository(db);
  const logRepo = new LogRepository(db);

  const log = new SecurityLogService(logRepo, clock);
  const authorization = new AuthorizationService(log);
  const sessions = new SessionService(new SessionRepository(db), rbac, clock);
  const links = new PasswordLinkService(resets, resolveBaseUrl(env, options.origin), clock);
  const delivery = options.delivery ?? new ConsoleOrNoopDelivery(env.APP_ENV === "development");

  const mediaRepo = new MediaRepository(db);
  const units = new AccommodationRepository(db);
  const inventory = new InventoryRepository(db);

  const pricing = new PricingRepository(db);
  const paymentRepo = new PaymentRepository(db);
  const bookingRepo = new BookingRepository(db);
  const availability = new AvailabilityService(db, units, inventory, mediaRepo, authorization, log, clock, pricing);
  const media = new MediaService(db, mediaRepo, env.MEDIA_PUBLIC, authorization, log, env.PUBLIC_MEDIA_BASE_URL, clock);
  const fontRepo = new FontRepository(db);
  // Responsive image renditions (Phase 12).
  const images = new ImageResolver(db, env.PUBLIC_MEDIA_BASE_URL);
  const quotes = new QuoteService(pricing, units, inventory, availability, clock, images, env.PUBLIC_MEDIA_BASE_URL);

  // LINE (Phase 11): outbox rows are written inside the payment / slip / cancel batches.
  const site = new SiteService(new D1SiteSettingsRepository(db), env.PUBLIC_MEDIA_BASE_URL);
  const publicSite = (lang: string) => site.getPublicSite(getLocale(parseLocale(lang)?.code ?? "th"));
  const lineRepo = new LineRepository(db);
  // Outbox rows written inside the payment / slip / cancel batches: LINE (Phase 11) + Meta CAPI Purchase (Phase 14).
  const marketingRepo = new MarketingRepository(db);
  const emailRepo = new EmailRepository(db);
  // + e-mail (migration 0023): staff and guest messages through Zoho Mail (or Resend).
  const outbox = new CompositeOutbox([new Outbox(lineRepo), new MarketingOutbox(marketingRepo), new EmailOutbox(emailRepo)]);
  const siteInfo = async (lang: string) => {
    const s = await publicSite(lang);
    return { name: s.siteName, address: s.contact.address, phone: s.contact.phone, mapUrl: s.contact.mapUrl };
  };
  const notifications = new NotificationService(
    db, lineRepo, new ReportRepository(db), siteInfo,
    () => inventory.siteTimezone(), clock,
    { token: env.LINE_CHANNEL_ACCESS_TOKEN?.trim() || null, fetch: options.lineFetch, linkBase: configuredBaseUrl(env) },
  );
  let bookingsRef: BookingService | null = null;
  const line = new LineService(db, lineRepo, notifications, { guestBooking: (c, p, m) => bookingsRef!.guestBooking(c, p, m) },
    authorization, log, clock, {
      secret: env.LINE_CHANNEL_SECRET?.trim() || null,
      webhookUrl: `${resolveBaseUrl(env, options.origin)}${LINE_WEBHOOK_PATH}`,
      timezone: () => inventory.siteTimezone(),
      siteLineUrl: async () => (await publicSite("th")).contact.lineOaUrl,
      siteName: async (lang) => (await publicSite(lang)).siteName,
    });
  const paypalApi = createPaypalApi(env, options.paypalFetch);
  const bookings = new BookingService(db, bookingRepo, quotes, authorization, log, clock, paymentRepo, env.PUBLIC_MEDIA_BASE_URL,
    outbox, (row) => line.guestStatus(row), marketingRepo, paypalApi !== null);
  bookingsRef = bookings;
  const verifier = options.slipVerifier !== undefined ? options.slipVerifier : createSlipVerifier(env);
  const accommodation = new AccommodationService(db, units, inventory, mediaRepo, env.MEDIA_PUBLIC, authorization, log, env.PUBLIC_MEDIA_BASE_URL, clock, images);
  const content = new PublicContentService(db, clock, env.PUBLIC_MEDIA_BASE_URL, images);
  const privacy = new PrivacyService(db, authorization, log, clock);
  const health = new HealthService(new D1HealthRepository(db), clock);
  // Dashboard visitors / page views / funnel from the GA4 Data API (Phase 14); key = Cloudflare Secret.
  const ga4 = new Ga4ReportService(db, async () => (await new SettingsRepository(db).marketing())?.ga4_property_id ?? null, clock, {
    keyJson: env.GA4_SERVICE_ACCOUNT_KEY, fetch: options.googleFetch,
  });

  return {
    site,
    health,
    monitoring: new MonitoringService(new MonitoringRepository(db), health, authorization, clock, env),
    adminMenu: new AdminMenuService(db, new AdminMenuRepository(db), authorization, log, clock),
    sessions,
    authorization,
    auth: new AuthService(db, users, resets, sessions, links, delivery, log, clock),
    users: new UserManagementService(db, users, rbac, sessions, links, authorization, log, clock),
    logs: new AdminLogService(logRepo, authorization),
    media,
    accommodation,
    availability,
    quotes,
    bookings,
    slips: new SlipService(db, paymentRepo, bookings, pricing, env.MEDIA_PRIVATE, verifier, authorization, log, clock, outbox),
    payments: new PaymentService(db, paymentRepo, bookingRepo, mediaRepo, authorization, log, env.PUBLIC_MEDIA_BASE_URL, clock, outbox, {
      verifier: { configured: verifier !== null, provider: verifier?.provider ?? null },
      paypal: { configured: paypalApi !== null, environment: paypalEnvironment(env) },
    }),
    paypal: new PaypalService(db, paymentRepo, bookings, paypalApi, log, clock, outbox, {
      baseUrl: resolveBaseUrl(env, options.origin),
      siteName: async (lang) => (await publicSite(lang)).siteName,
    }),
    email: new EmailService(db, emailRepo, lineRepo, authorization, log, clock, {
      sender: createEmailSender(env, options.emailFetch), linkBase: configuredBaseUrl(env), siteInfo,
    }),
    pricingRules: new PricingRuleService(db, pricing, units, authorization, log, clock),
    dashboard: new DashboardService(new DashboardRepository(db), inventory, authorization, clock, (from, to) => ga4.dashboard(from, to)),
    cms: new CmsService(db, authorization, log, clock, env.PUBLIC_MEDIA_BASE_URL),
    settings: new SettingsService(db, new SettingsRepository(db), authorization, log, clock, env.PUBLIC_MEDIA_BASE_URL, {
      capiToken: !!env.META_CAPI_ACCESS_TOKEN?.trim(),
      testEventCode: !!env.META_TEST_EVENT_CODE?.trim(),
      pixelId: env.META_PIXEL_ID?.trim() || null,
      ga4Key: ga4.keyConfigured(),
    }, fontRepo),
    foodAdmin: new FoodAdminService(db, new FoodAdminRepository(db), inventory, authorization, log, clock),
    content,
    reports: new ReportService(new ReportRepository(db), inventory, authorization, log, clock),
    line,
    notifications,
    fonts: new FontService(db, fontRepo, media, mediaRepo, authorization, log, clock, env.PUBLIC_MEDIA_BASE_URL),
    // Page metadata, sitemap, robots, redirects (Phase 13). Only production is indexable.
    seo: new SeoService(new SeoRepository(db), site, accommodation, content, resolveBaseUrl(env, options.origin),
      env.PUBLIC_MEDIA_BASE_URL, env.APP_ENV === "production", (locale) => privacy.publicPolicy(locale)),
    translations: new TranslationCoverageService(db, authorization),
    capi: new MetaCapiService(db, marketingRepo, async () => {
      const m = await new SettingsRepository(db).marketing();
      return { enabled: m?.meta_capi_enabled === 1, pixelId: env.META_PIXEL_ID?.trim() || m?.meta_pixel_id || null };
    }, authorization, log, clock, {
      token: env.META_CAPI_ACCESS_TOKEN?.trim() || null,
      testEventCode: env.META_TEST_EVENT_CODE?.trim() || null,
      version: env.META_GRAPH_API_VERSION?.trim() || undefined,
      fetch: options.metaFetch,
      siteUrl: resolveBaseUrl(env, options.origin),
    }),
    privacy,
    securityLog: log,
    // Footer map thumbnail: tiles around Settings → Website latitude / longitude only.
    mapTiles: new MapTileService(async () => {
      const s = await new SettingsRepository(db).site();
      return s && s.latitude !== null && s.longitude !== null ? { latitude: s.latitude, longitude: s.longitude } : null;
    }, { fetch: options.mapFetch, cache: edgeCache(), siteUrl: resolveBaseUrl(env, options.origin) }),
    // Global search (spec §40–41): index for matching only; results re-read from source, live availability.
    search: new SearchService(db, new SearchRepository(db), accommodation, quotes, content, availability,
      () => inventory.siteTimezone(), authorization, log, clock),
  };
}
