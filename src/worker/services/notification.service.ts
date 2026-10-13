import { addDays, DEFAULT_TIMEZONE, localDateTimeIn } from "../../shared/dates.ts";
import { getLocale, parseLocale, type Locale } from "../../shared/i18n/locales.ts";
import { bookingLookupPath } from "../../shared/routes.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { createLineApi, packMessages, retryKeyFor, type FetchLike, type LineApi, type LineTextMessage } from "../line/line-api.ts";
import {
  checkinDigestBlocks, foodOrderText, guestCancelledText, guestCheckinText, guestConfirmedText, guestPaymentRejectedText, kitchenDigestBlocks, balanceReceivedText, guestBalanceRejectedText, stillDue,
  LineFormatter, newBookingText, paymentConfirmedText, paymentReviewText, testText, type KitchenDish,
} from "../line/line-templates.ts";
import type { LineRepository, LineSettingsRow, NotificationRow, RecipientFlag } from "../repositories/line.repository.ts";
import type { ReportRepository } from "../repositories/report.repository.ts";
import { addMs, iso, type Clock } from "./auth-context.ts";

/** Slip review notices wait this long so an automatic verification can settle the slip first. */
export const REVIEW_DELAY_MS = 2 * 60_000;
/** Backoff after attempt 1, 2, 3, 4 (then the 5th attempt is the last). */
export const RETRY_DELAYS_MIN = [1, 5, 15, 60];
const LEASE_MS = 2 * 60_000;
/** Older than this and still not sent: no longer useful. */
const STALE_MS = 24 * 60 * 60_000;
const SOLD = new Set(["CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "NO_SHOW"]);

const FLAG_OF: Record<string, RecipientFlag | null> = {
  CHECKIN_DIGEST: "notify_checkin",
  FOOD_DIGEST: "notify_food",
  FOOD_ORDER: "notify_food",
  FOOD_CANCELLED: "notify_food",
  PAYMENT_REVIEW: "notify_payment",
  PAYMENT_CONFIRMED: "notify_payment",
  NEW_BOOKING: "notify_booking",
  TEST: null,
};

export interface SiteInfo {
  name: string | null;
  address: string | null;
  phone: string | null;
  mapUrl: string | null;
}

/**
 * Transactional outbox: the notification rows are written in the SAME D1 batch as the change
 * that causes them (payment confirmed, slip stored, booking cancelled), so a notification is
 * queued if and only if the change committed. Nothing is added while LINE is off.
 */
export class Outbox {
  constructor(private readonly repo: LineRepository) {}

  private async on(): Promise<boolean> {
    return (await this.repo.settings())?.enabled === 1;
  }

  async bookingConfirmed(bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? this.repo.bookingConfirmedStatements(bookingId, now) : [];
  }

  async slipSubmitted(paymentId: string, bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? [this.repo.slipSubmittedStatement(paymentId, bookingId, now, iso(addMs(new Date(now), REVIEW_DELAY_MS)))] : [];
  }

  /** Kitchen hears about food of a confirmed booking; the guest (if linked) hears why it was cancelled. */
  async bookingCancelled(bookingId: string, wasConfirmed: boolean, now: string): Promise<D1PreparedStatementLike[]> {
    if (!(await this.on())) return [];
    return [...(wasConfirmed ? [this.repo.bookingCancelledStatement(bookingId, now)] : []), this.repo.guestCancelledStatement(bookingId, now)];
  }

  /** Every new booking → staff chats that want it. */
  async bookingCreated(bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? [this.repo.newBookingStatement(bookingId, now)] : [];
  }

  /** A slip was turned down → the guest (if linked) hears the reason. */
  async paymentRejected(paymentId: string, bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? [this.repo.guestPaymentRejectedStatement(paymentId, bookingId, now)] : [];
  }

  /** Deposit plan: the rest came in → staff chats that want payment news. */
  async balancePaid(paymentId: string, bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? [this.repo.balancePaidStatement(paymentId, bookingId, now)] : [];
  }
}

export interface DispatchSummary {
  planned: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
}

type Rendered = { messages: LineTextMessage[] } | { skip: string };

/**
 * Plans the daily digests and delivers due notifications through the LINE Messaging API,
 * with retries (backoff), idempotency (unique keys + X-Line-Retry-Key) and a log row per message.
 */
export class NotificationService {
  private api: LineApi | null;

  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: LineRepository,
    private readonly reports: ReportRepository,
    private readonly siteInfo: (lang: string) => Promise<SiteInfo>,
    private readonly timezone: () => Promise<string | null>,
    private readonly clock: Clock,
    private readonly config: { token: string | null; fetch?: FetchLike; linkBase: string | null },
  ) {
    this.api = config.token ? createLineApi(config.token, config.fetch) : null;
  }

  get tokenConfigured(): boolean {
    return this.api !== null;
  }

  lineApi(): LineApi | null {
    return this.api;
  }

  /** Cron entry: plan, deliver, and (hourly) apply data retention. */
  async tick(limit = 25): Promise<DispatchSummary> {
    const planned = await this.plan();
    const summary = await this.dispatch(limit);
    if (this.clock().getUTCMinutes() === 30) await this.purge();
    return { ...summary, planned };
  }

  /** Queues today's digests once the configured time has passed (property time zone). */
  async plan(): Promise<number> {
    const s = await this.repo.settings();
    if (!s || s.enabled !== 1) return 0;
    const now = this.clock();
    const local = localDateTimeIn((await this.timezone()) ?? DEFAULT_TIMEZONE, now);
    if (local.slice(11, 16) < s.reminder_time) return 0;
    const date = addDays(local.slice(0, 10), s.reminder_days_before);
    const results = await this.db.batch(this.repo.digestStatements(date, s.reminder_days_before, iso(now)));
    return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }

  async purge(): Promise<void> {
    const now = this.clock();
    const today = localDateTimeIn((await this.timezone()) ?? DEFAULT_TIMEZONE, now).slice(0, 10);
    await this.db.batch(this.repo.purgeStatements(addDays(today, -30), iso(addMs(now, -7 * 24 * 60 * 60_000))));
  }

  async dispatch(limit = 25): Promise<Omit<DispatchSummary, "planned">> {
    const summary = { sent: 0, retried: 0, failed: 0, cancelled: 0 };
    const now = iso(this.clock());
    const due = await this.repo.due(now, limit);
    if (!due.length) return summary;
    const settings = await this.repo.settings();
    const ctx = new RenderContext(this.repo, this.reports, this.siteInfo, this.config.linkBase, settings, now);
    for (const row of due) {
      const outcome = await this.deliver(row, settings, ctx).catch((error: unknown) => {
        console.error(JSON.stringify({ level: "error", message: "notification_dispatch_failed", id: row.id, error: String(error).slice(0, 200) }));
        return "retried" as const;
      });
      if (outcome) summary[outcome]++;
    }
    return summary;
  }

  /** Delivers one notification now (test message). */
  async deliverNow(id: string): Promise<NotificationRow | null> {
    const row = await this.repo.notification(id);
    if (!row) return null;
    const settings = await this.repo.settings();
    await this.deliver(row, settings, new RenderContext(this.repo, this.reports, this.siteInfo, this.config.linkBase, settings, iso(this.clock())));
    return this.repo.notification(id);
  }

  private async deliver(row: NotificationRow, settings: LineSettingsRow | null, ctx: RenderContext): Promise<keyof Omit<DispatchSummary, "planned"> | null> {
    const now = this.clock();
    const at = iso(now);
    if (row.attempts >= row.max_attempts) {
      await this.repo.markEndedStatement(row.id, "FAILED", row.last_error ?? "MAX_ATTEMPTS", at).run();
      return "failed";
    }
    const claimed = await this.repo.claimStatement(row.id, row.attempts, iso(addMs(now, LEASE_MS)), at).all();
    if (!claimed.results.length) return null; // another run has it
    const attempt = row.attempts + 1;
    const end = async (status: "FAILED" | "CANCELLED", reason: string) => {
      await this.repo.markEndedStatement(row.id, status, reason, at).run();
      return status === "FAILED" ? ("failed" as const) : ("cancelled" as const);
    };

    if (!settings || settings.enabled !== 1) return end("CANCELLED", "LINE_DISABLED");
    if (row.notification_type !== "TEST" && Date.parse(row.scheduled_for) < now.getTime() - STALE_MS) return end("CANCELLED", "EXPIRED");

    const target = await this.resolveTarget(row, settings);
    if ("skip" in target) return end("CANCELLED", target.skip);

    const rendered = await ctx.render(row, target.lang);
    if ("skip" in rendered) return end("CANCELLED", rendered.skip);

    if (!this.api) return this.retryOrFail(row, attempt, "TOKEN_MISSING", null, at);
    const result = await this.api.push(target.to, rendered.messages, retryKeyFor(row.id));
    if (result.ok) {
      await this.repo.markSentStatement(row.id, at).run();
      return "sent";
    }
    if (!result.retryable) return end("FAILED", result.error);
    return this.retryOrFail(row, attempt, result.error, result.retryAfterSeconds, at);
  }

  private async retryOrFail(row: NotificationRow, attempt: number, error: string, retryAfterSeconds: number | null, at: string) {
    if (attempt >= row.max_attempts) {
      await this.repo.markEndedStatement(row.id, "FAILED", error, at).run();
      return "failed" as const;
    }
    const delayMs = Math.max((RETRY_DELAYS_MIN[attempt - 1] ?? 60) * 60_000, (retryAfterSeconds ?? 0) * 1000);
    await this.repo.markRetryStatement(row.id, error, iso(addMs(new Date(at), delayMs)), at).run();
    return "retried" as const;
  }

  private async resolveTarget(row: NotificationRow, settings: LineSettingsRow): Promise<{ to: string; lang: string } | { skip: string }> {
    if (row.recipient.startsWith("staff:")) {
      const r = await this.repo.recipient(row.recipient.slice(6));
      if (!r || r.deleted_at || r.active !== 1) return { skip: "RECIPIENT_INACTIVE" };
      const flag = FLAG_OF[row.notification_type];
      if (flag && r[flag] !== 1) return { skip: "RECIPIENT_OPTED_OUT" };
      return { to: r.target_id, lang: r.language_code };
    }
    if (row.recipient.startsWith("guest:")) {
      if (settings.guest_enabled !== 1) return { skip: "GUEST_DISABLED" };
      const bookingId = row.recipient.slice(6);
      const link = await this.repo.guestLink(bookingId);
      if (!link) return { skip: "NOT_LINKED" };
      return { to: link.line_user_id, lang: row.language_code ?? "th" };
    }
    return { skip: "UNKNOWN_RECIPIENT" };
  }
}

/** Builds message texts from current D1 data (snapshots); per-run caches for site info. */
class RenderContext {
  private readonly sites = new Map<string, Promise<SiteInfo>>();

  constructor(
    private readonly repo: LineRepository,
    private readonly reports: ReportRepository,
    private readonly siteInfo: (lang: string) => Promise<SiteInfo>,
    private readonly linkBase: string | null,
    private readonly settings: LineSettingsRow | null,
    private readonly now: string,
  ) {}

  private site(lang: string): Promise<SiteInfo> {
    let p = this.sites.get(lang);
    if (!p) {
      p = this.siteInfo(lang).catch(() => ({ name: null, address: null, phone: null, mapUrl: null }));
      this.sites.set(lang, p);
    }
    return p;
  }

  private link(lang: string, path: (locale: Locale) => string): string | null {
    if (!this.linkBase) return null;
    return `${this.linkBase}${path(parseLocale(lang) ?? getLocale("th"))}`;
  }

  private payload(row: NotificationRow): Record<string, unknown> {
    try {
      return row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async render(row: NotificationRow, lang: string): Promise<Rendered> {
    const f = new LineFormatter(lang);
    const p = this.payload(row);
    const sendEmpty = this.settings?.send_when_empty === 1;
    const more = (n: number) => f.fill(f.t.more, { n });
    const one = async () => (row.booking_id ? (await this.repo.messageBookings([row.booking_id], lang))[0] ?? null : null);
    const text = (t: string): Rendered => ({ messages: [{ type: "text", text: t.slice(0, 4900) }] });

    switch (row.notification_type) {
      case "CHECKIN_DIGEST": {
        const date = String(p.date ?? "");
        const ids = await this.repo.arrivalIds(date, this.now);
        if (!ids.length && !sendEmpty) return { skip: "EMPTY" };
        const bookings = await this.repo.messageBookings(ids, lang);
        const blocks = checkinDigestBlocks(f, {
          date, daysBefore: Number(p.daysBefore ?? 1), siteName: (await this.site(lang)).name, bookings,
          link: this.link(lang, (l) => `/${l.path}/admin/calendar`),
        });
        return { messages: packMessages(blocks, more) };
      }
      case "FOOD_DIGEST": {
        const date = String(p.date ?? "");
        const dishes = await this.kitchen(date, lang);
        if (!dishes.length && !sendEmpty) return { skip: "EMPTY" };
        const blocks = kitchenDigestBlocks(f, { date, daysBefore: Number(p.daysBefore ?? 1), dishes, link: this.link(lang, (l) => `/${l.path}/admin/kitchen`) });
        return { messages: packMessages(blocks, more) };
      }
      case "FOOD_ORDER":
      case "FOOD_CANCELLED": {
        const b = await one();
        if (!b || !b.food.length) return { skip: "EMPTY" };
        if (row.notification_type === "FOOD_ORDER" && !SOLD.has(b.bookingStatus)) return { skip: "NOT_RELEVANT" };
        // The kitchen only hears about a cancellation if it heard about the order.
        if (row.notification_type === "FOOD_CANCELLED" && !(await this.repo.wasSent("FOOD_ORDER", row.booking_id!, row.recipient))) return { skip: "NOT_RELEVANT" };
        return text(foodOrderText(f, b, row.notification_type === "FOOD_CANCELLED"));
      }
      case "PAYMENT_REVIEW": {
        const pay = typeof p.paymentId === "string" ? await this.repo.payment(p.paymentId) : null;
        if (!pay || pay.status !== "PENDING_VERIFICATION") return { skip: "NOT_RELEVANT" };
        const b = await one();
        if (!b) return { skip: "NOT_RELEVANT" };
        const check = await this.repo.latestAutoCheck(p.paymentId as string);
        return text(paymentReviewText(f, b, pay.amount_satang, this.link(lang, (l) => `/${l.path}/admin/slips`), { channel: pay.channel, check }));
      }
      case "PAYMENT_CONFIRMED": {
        const b = await one();
        if (!b) return { skip: "NOT_RELEVANT" };
        if (typeof p.paymentId === "string") {
          // Deposit plan: the rest came in.
          const pay = await this.repo.payment(p.paymentId);
          if (!pay || (pay.status !== "VERIFIED" && pay.status !== "PAID")) return { skip: "NOT_RELEVANT" };
          return text(balanceReceivedText(f, b, pay.amount_satang, pay.method, pay.channel));
        }
        const paid = row.booking_id ? await this.repo.latestPaidMethod(row.booking_id) : null;
        return text(paymentConfirmedText(f, b, paid?.method ?? null, paid?.channel ?? null));
      }
      case "NEW_BOOKING": {
        const b = await one();
        if (!b) return { skip: "NOT_RELEVANT" };
        return text(newBookingText(f, b, this.link(lang, (l) => `/${l.path}/admin/bookings/${b.code}`)));
      }
      case "GUEST_PAYMENT_REJECTED": {
        const pay = typeof p.paymentId === "string" ? await this.repo.payment(p.paymentId) : null;
        const b = await one();
        if (!pay || pay.status !== "REJECTED" || !b) return { skip: "NOT_RELEVANT" };
        const reply = { reason: pay.rejected_reason, link: this.link(lang, bookingLookupPath), siteName: (await this.site(lang)).name };
        // The rest of a deposit: the booking stays confirmed; another slip or the reception desk will do.
        if (pay.is_balance === 1) return b.bookingStatus === "CONFIRMED" && stillDue(b) > 0 ? text(guestBalanceRejectedText(f, b, reply)) : { skip: "NOT_RELEVANT" };
        // Only while the guest can still act on it.
        if (b.bookingStatus !== "PENDING") return { skip: "NOT_RELEVANT" };
        return text(guestPaymentRejectedText(f, b, reply));
      }
      case "GUEST_CANCELLED": {
        const b = await one();
        if (!b || b.bookingStatus !== "CANCELLED") return { skip: "NOT_RELEVANT" };
        const site = await this.site(lang);
        return text(guestCancelledText(f, b, { siteName: site.name, phone: site.phone }));
      }
      case "GUEST_CONFIRMED": {
        const b = await one();
        if (!b || !SOLD.has(b.bookingStatus)) return { skip: "NOT_RELEVANT" };
        return text(guestConfirmedText(f, b, { siteName: (await this.site(lang)).name, link: this.link(lang, bookingLookupPath) }));
      }
      case "GUEST_CHECKIN": {
        const b = await one();
        if (!b || b.bookingStatus !== "CONFIRMED" || b.checkIn !== p.date) return { skip: "NOT_RELEVANT" };
        const site = await this.site(lang);
        return text(guestCheckinText(f, b, {
          daysBefore: Number(p.daysBefore ?? 1), siteName: site.name, address: site.address, mapUrl: site.mapUrl, phone: site.phone,
          link: this.link(lang, bookingLookupPath),
        }));
      }
      case "TEST": {
        const r = await this.repo.recipient(row.recipient.slice(6));
        if (!r) return { skip: "RECIPIENT_INACTIVE" };
        return text(testText(f, {
          name: r.name, checkin: r.notify_checkin === 1, food: r.notify_food === 1, payment: r.notify_payment === 1, booking: r.notify_booking !== 0,
          siteName: (await this.site(lang)).name,
        }));
      }
      default:
        return { skip: "UNKNOWN_TYPE" };
    }
  }

  /** Portions per category and dish for one day: confirmed (paid) vs still awaiting payment. */
  private async kitchen(date: string, lang: string): Promise<KitchenDish[]> {
    const next = addDays(date, 1);
    const [orders, lines, cats] = await Promise.all([this.reports.kitchenOrders(date, next), this.reports.kitchenLines(date, next), this.reports.categoryNames(lang)]);
    const catName = new Map(cats.map((c) => [c.id, c.name]));
    const byOrder = new Map(orders.map((o) => [o.order_id, o]));
    const dishes = new Map<string, KitchenDish>();
    for (const l of lines) {
      const o = byOrder.get(l.food_order_id);
      if (!o) continue;
      const key = `${o.category_id}|${l.option_name_snapshot}`;
      const d = dishes.get(key) ?? { category: catName.get(o.category_id) ?? o.category_code, time: o.service_time, dish: l.option_name_snapshot, confirmed: 0, pending: 0 };
      if (SOLD.has(o.booking_status)) d.confirmed += l.quantity;
      else d.pending += l.quantity;
      dishes.set(key, d);
    }
    // Orders arrive sorted by category sort order; keep that order.
    const order = [...new Set(orders.map((o) => o.category_id))];
    return [...dishes.entries()].sort(([a], [b]) => order.indexOf(a.split("|")[0]!) - order.indexOf(b.split("|")[0]!)).map(([, d]) => d);
  }
}
