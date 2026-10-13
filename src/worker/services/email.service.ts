import { BOOKING_CODE_PATTERN } from "../../shared/booking-types.ts";
import {
  EMAIL_STATUSES, EMAIL_TYPES, type EmailLogDto, type EmailRecipientDto, type EmailSettingsDto, type EmailStatus, type EmailType,
} from "../../shared/email-types.ts";
import { getLocale, LOCALE_CODES, parseLocale, type Locale, type LocaleCode } from "../../shared/i18n/locales.ts";
import { bookingLookupPath } from "../../shared/routes.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ConflictError, NotFoundError, TooManyRequestsError } from "../http/errors.ts";
import { emailTexts, fillText, renderEmail, type RenderedEmail } from "../email/email-templates.ts";
import type { EmailSender } from "../email/sender.ts";
import {
  guestCancelledText, guestConfirmedText, guestPaymentRejectedText, LineFormatter, balanceReceivedText, guestBalanceRejectedText, stillDue, newBookingText, paymentConfirmedText, paymentReviewText,
  type MsgBooking,
} from "../line/line-templates.ts";
import type { EmailFlag, EmailLogListRow, EmailLogRow, EmailRecipientRow, EmailRepository, EmailSettingsRow } from "../repositories/email.repository.ts";
import type { LineRepository } from "../repositories/line.repository.ts";
import { newId } from "../security/tokens.ts";
import { Validator } from "../validation.ts";
import { addMs, iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { OutboxLike } from "./marketing.service.ts";
import { REVIEW_DELAY_MS, RETRY_DELAYS_MIN, type SiteInfo } from "./notification.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";

const LEASE_MS = 2 * 60_000;
/** Older than this and still not sent: no longer useful. */
const STALE_MS = 24 * 60 * 60_000;
const TESTS_PER_HOUR = 10;
const KEEP_DAYS = 180;
const SIMPLE_EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

const FLAG_OF: Partial<Record<EmailType, EmailFlag>> = {
  NEW_BOOKING: "notify_booking",
  PAYMENT_REVIEW: "notify_payment",
  PAYMENT_CONFIRMED: "notify_payment",
};

/**
 * E-mail outbox hooks: rows are written in the SAME D1 batch as the change that causes them, and only
 * while e-mail is on. Same guarantees as the LINE outbox.
 */
export class EmailOutbox implements OutboxLike {
  constructor(private readonly repo: EmailRepository) {}

  private async on(): Promise<boolean> {
    return (await this.repo.settings())?.enabled === 1;
  }

  async bookingCreated(bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? this.repo.bookingCreatedStatements(bookingId, now) : [];
  }

  async bookingConfirmed(bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? this.repo.bookingConfirmedStatements(bookingId, now) : [];
  }

  async slipSubmitted(paymentId: string, bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? [this.repo.slipSubmittedStatement(paymentId, bookingId, now, iso(addMs(new Date(now), REVIEW_DELAY_MS)))] : [];
  }

  async paymentRejected(paymentId: string, bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? [this.repo.paymentRejectedStatement(paymentId, bookingId, now)] : [];
  }

  async balancePaid(paymentId: string, bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? [this.repo.balancePaidStatement(paymentId, bookingId, now)] : [];
  }

  async bookingCancelled(bookingId: string, _wasConfirmed: boolean, now: string): Promise<D1PreparedStatementLike[]> {
    return (await this.on()) ? [this.repo.bookingCancelledStatement(bookingId, now)] : [];
  }
}

function toRecipient(r: EmailRecipientRow): EmailRecipientDto {
  return {
    id: r.id, email: r.email, name: r.name, language: (parseLocale(r.language_code)?.code ?? "th") as LocaleCode,
    notifyBooking: r.notify_booking === 1, notifyPayment: r.notify_payment === 1, active: r.active === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function toLog(r: EmailLogListRow): EmailLogDto {
  return {
    id: r.id, type: r.notification_type as EmailType, status: r.status, audience: r.recipient.startsWith("guest:") ? "GUEST" : "STAFF",
    recipientName: r.recipient_name, bookingCode: r.booking_code, attempts: r.attempts, lastError: r.last_error,
    createdAt: r.created_at, sentAt: r.sent_at,
  };
}

type Rendered = RenderedEmail | { skip: string };
type Outcome = "sent" | "retried" | "failed" | "cancelled";

export interface EmailConfig {
  /** Zoho Mail or Resend (from Cloudflare Secrets); null = no provider, e-mail cannot be switched on. */
  sender: EmailSender | null;
  /** https origin for links in messages (APP_BASE_URL); no buttons without it. */
  linkBase: string | null;
  siteInfo: (lang: string) => Promise<SiteInfo>;
}

/**
 * E-mail notifications through Zoho Mail or Resend: admin settings and staff addresses, a test message, the log,
 * and the cron dispatcher (retries with backoff; with Resend the Idempotency-Key = the log row, so a retry delivers once).
 * Addresses are read at send time and never written to the log or to console output.
 */
export class EmailService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: EmailRepository,
    private readonly lineRepo: LineRepository,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly config: EmailConfig,
  ) {}

  private get client(): EmailSender | null {
    return this.config.sender;
  }

  get providerConfigured(): boolean {
    return this.client !== null;
  }

  // ================================================================ settings

  private dto(s: EmailSettingsRow | null): EmailSettingsDto {
    return {
      enabled: s?.enabled === 1, guestEnabled: s ? s.guest_enabled === 1 : true, fromName: s?.from_name ?? null, fromEmail: s?.from_email ?? null,
      replyTo: s?.reply_to ?? null, providerConfigured: this.providerConfigured, provider: this.client?.provider ?? null, updatedAt: s?.updated_at ?? "",
    };
  }

  async getSettings(actor: AuthContext, meta: RequestMeta): Promise<EmailSettingsDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    return this.dto(await this.repo.settings());
  }

  async saveSettings(actor: AuthContext, body: Record<string, unknown>, meta: RequestMeta): Promise<EmailSettingsDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const v = new Validator(body).allowOnly(["enabled", "guestEnabled", "fromName", "fromEmail", "replyTo"]);
    const enabled = v.boolean("enabled", false);
    const guestEnabled = v.boolean("guestEnabled", true);
    const fromName = v.string("fromName", { max: 80 }) || null;
    const fromEmail = v.email("fromEmail") || null;
    const replyTo = v.email("replyTo") || null;
    if (enabled && !this.providerConfigured) v.errors.enabled = "EMAIL_KEY_MISSING";
    else if (enabled && !fromEmail) v.errors.fromEmail = "REQUIRED";
    v.assertValid();
    const before = await this.repo.settings();
    const input = { enabled, guestEnabled, fromName, fromEmail, replyTo };
    await this.db.batch([
      this.repo.saveSettingsStatement(input, actor.userId, iso(this.clock())),
      this.log.auditStatement(actor.userId, "UPDATE_EMAIL_SETTINGS", "settings", "email_settings",
        before ? { enabled: before.enabled === 1, guestEnabled: before.guest_enabled === 1, fromName: before.from_name, fromEmail: before.from_email, replyTo: before.reply_to } : null,
        input, meta),
    ]);
    return this.dto(await this.repo.settings());
  }

  // ================================================================ staff addresses

  async recipients(actor: AuthContext, meta: RequestMeta): Promise<EmailRecipientDto[]> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    return (await this.repo.recipients()).map(toRecipient);
  }

  private fields(v: Validator, current: EmailRecipientRow | null) {
    return {
      email: v.email("email", { required: true }),
      name: v.string("name", { required: true, max: 80 }),
      language: v.oneOf("language", LOCALE_CODES, { required: true }) as LocaleCode,
      booking: v.boolean("notifyBooking", current ? current.notify_booking === 1 : true),
      payment: v.boolean("notifyPayment", current ? current.notify_payment === 1 : true),
    };
  }

  async addRecipient(actor: AuthContext, body: Record<string, unknown>, meta: RequestMeta): Promise<EmailRecipientDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const v = new Validator(body).allowOnly(["email", "name", "language", "notifyBooking", "notifyPayment"]);
    const f = this.fields(v, null);
    v.assertValid();
    if (await this.repo.liveRecipientByEmail(f.email)) throw new ConflictError("This address is already on the list", "EMAIL_RECIPIENT_EXISTS");
    const id = newId();
    await this.db.batch([
      this.repo.insertRecipientStatement({ id, ...f, actorId: actor.userId, now: iso(this.clock()) }),
      this.log.auditStatement(actor.userId, "CREATE_EMAIL_RECIPIENT", "notifications", id, null, { name: f.name, booking: f.booking, payment: f.payment }, meta),
    ]);
    return toRecipient((await this.repo.recipient(id))!);
  }

  async updateRecipient(actor: AuthContext, id: string, body: Record<string, unknown>, meta: RequestMeta): Promise<EmailRecipientDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const before = await this.repo.recipient(id);
    if (!before || before.deleted_at) throw new NotFoundError("Recipient not found", "EMAIL_RECIPIENT_NOT_FOUND");
    const v = new Validator(body).allowOnly(["email", "name", "language", "notifyBooking", "notifyPayment", "active"]);
    const f = this.fields(v, before);
    const active = v.boolean("active", before.active === 1);
    v.assertValid();
    const other = await this.repo.liveRecipientByEmail(f.email);
    if (other && other.id !== id) throw new ConflictError("This address is already on the list", "EMAIL_RECIPIENT_EXISTS");
    const changed = await this.repo.updateRecipientStatement(id, { ...f, active }, actor.userId, iso(this.clock())).all();
    if (!changed.results.length) throw new NotFoundError("Recipient not found", "EMAIL_RECIPIENT_NOT_FOUND");
    await this.log.auditStatement(actor.userId, "UPDATE_EMAIL_RECIPIENT", "notifications", id,
      { name: before.name, booking: before.notify_booking === 1, payment: before.notify_payment === 1, active: before.active === 1 },
      { name: f.name, booking: f.booking, payment: f.payment, active }, meta).run();
    return toRecipient((await this.repo.recipient(id))!);
  }

  async deleteRecipient(actor: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const before = await this.repo.recipient(id);
    if (!before || before.deleted_at) throw new NotFoundError("Recipient not found", "EMAIL_RECIPIENT_NOT_FOUND");
    await this.db.batch([
      this.repo.deleteRecipientStatement(id, actor.userId, iso(this.clock())),
      this.log.auditStatement(actor.userId, "DELETE_EMAIL_RECIPIENT", "notifications", id, { name: before.name }, null, meta),
    ]);
  }

  /** Sends a test e-mail right away and returns its log row. */
  async test(actor: AuthContext, id: string, meta: RequestMeta): Promise<EmailLogDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const r = await this.repo.recipient(id);
    if (!r || r.deleted_at) throw new NotFoundError("Recipient not found", "EMAIL_RECIPIENT_NOT_FOUND");
    if (!this.client) throw new ConflictError("No e-mail provider is set up (Zoho Mail or Resend secrets)", "EMAIL_KEY_MISSING");
    const s = await this.repo.settings();
    if (!s?.from_email) throw new ConflictError("Set the sender address first", "EMAIL_SENDER_MISSING");
    const now = this.clock();
    if ((await this.repo.testsSince(id, iso(addMs(now, -60 * 60_000)))) >= TESTS_PER_HOUR) throw new TooManyRequestsError(15 * 60);
    const logId = newId();
    await this.db.batch([
      this.repo.insertTestStatement(logId, id, r.language_code, iso(now)),
      this.log.auditStatement(actor.userId, "SEND_EMAIL_TEST", "notifications", id, null, { emailId: logId }, meta),
    ]);
    const row = (await this.repo.log(logId))!;
    // A test goes out even while notifications are switched off (that is what it is for).
    await this.deliver(row, { ...s, enabled: 1 });
    return this.logDto(logId);
  }

  // ================================================================ log

  private async logDto(id: string): Promise<EmailLogDto> {
    const row = await this.repo.listRow(id);
    if (!row) throw new NotFoundError("E-mail not found", "EMAIL_NOT_FOUND");
    return toLog(row);
  }

  async logs(actor: AuthContext, q: URLSearchParams, meta: RequestMeta): Promise<{ items: EmailLogDto[]; nextCursor: string | null }> {
    await this.authz.requirePermission(actor, "notifications.view", meta);
    const v = new Validator(Object.fromEntries(q.entries())).allowOnly(["status", "type", "code", "before", "limit"]);
    const status = v.oneOf("status", EMAIL_STATUSES) as EmailStatus | undefined;
    const type = v.oneOf("type", EMAIL_TYPES) as EmailType | undefined;
    const code = v.string("code", { max: 20 })?.toUpperCase();
    if (code && !BOOKING_CODE_PATTERN.test(code)) v.errors.code = "INVALID_FORMAT";
    const before = v.string("before", { max: 30, pattern: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/ });
    const limitRaw = Number(q.get("limit") ?? 50);
    const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 50;
    v.assertValid();
    const rows = await this.repo.list({ status: status ?? null, type: type ?? null, code: code ?? null, before: before ?? null, limit: limit + 1 });
    const page = rows.slice(0, limit);
    return { items: page.map(toLog), nextCursor: rows.length > limit ? page[page.length - 1]!.created_at : null };
  }

  async retry(actor: AuthContext, id: string, meta: RequestMeta): Promise<EmailLogDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const changed = await this.repo.retryStatement(id, iso(this.clock())).all();
    if (!changed.results.length) throw new ConflictError("Only failed or cancelled e-mails can be retried", "NOTIFICATION_NOT_RETRYABLE");
    await this.log.auditStatement(actor.userId, "RETRY_EMAIL", "notifications", id, null, { status: "PENDING" }, meta).run();
    return this.logDto(id);
  }

  // ================================================================ dispatcher (cron)

  async tick(limit = 20): Promise<{ sent: number; retried: number; failed: number; cancelled: number }> {
    const summary = { sent: 0, retried: 0, failed: 0, cancelled: 0 };
    const now = this.clock();
    if (now.getUTCMinutes() === 41) await this.repo.purgeStatement(iso(addMs(now, -KEEP_DAYS * 24 * 60 * 60_000))).run().catch(() => undefined);
    const settings = await this.repo.settings();
    if (!settings) return summary; // before migration 0023
    const due = await this.repo.due(iso(now), limit);
    for (const row of due) {
      const outcome = await this.deliver(row, settings).catch((error: unknown) => {
        console.error(JSON.stringify({ level: "error", message: "email_dispatch_failed", id: row.id, error: String(error).slice(0, 200) }));
        return "retried" as const;
      });
      if (outcome) summary[outcome]++;
    }
    return summary;
  }

  private async deliver(row: EmailLogRow, settings: EmailSettingsRow): Promise<Outcome | null> {
    const now = this.clock();
    const at = iso(now);
    if (row.attempts >= row.max_attempts) {
      await this.repo.markEndedStatement(row.id, "FAILED", row.last_error ?? "MAX_ATTEMPTS", at).run();
      return "failed";
    }
    const claimed = await this.repo.claimStatement(row.id, row.attempts, iso(addMs(now, LEASE_MS)), at).all();
    if (!claimed.results.length) return null; // another run has it
    const end = async (status: "FAILED" | "CANCELLED", reason: string): Promise<Outcome> => {
      await this.repo.markEndedStatement(row.id, status, reason, at).run();
      return status === "FAILED" ? "failed" : "cancelled";
    };

    if (settings.enabled !== 1) return end("CANCELLED", "EMAIL_DISABLED");
    if (!settings.from_email) return end("CANCELLED", "EMAIL_SENDER_MISSING");
    if (row.notification_type !== "TEST" && Date.parse(row.scheduled_for) < now.getTime() - STALE_MS) return end("CANCELLED", "EXPIRED");

    const target = await this.resolveTarget(row, settings);
    if ("skip" in target) return end("CANCELLED", target.skip);
    const site = await this.config.siteInfo(target.lang).catch((): SiteInfo => ({ name: null, address: null, phone: null, mapUrl: null }));
    const rendered = await this.render(row, target.lang, site, target.name);
    if ("skip" in rendered) return end("CANCELLED", rendered.skip);

    if (!this.client) return this.retryOrFail(row, row.attempts + 1, "EMAIL_KEY_MISSING", null, at);
    const result = await this.client.send({
      fromEmail: settings.from_email,
      fromName: settings.from_name ?? site.name,
      to: target.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: settings.reply_to,
      idempotencyKey: `phasakura-email/${row.id}`,
    });
    if (result.ok) {
      await this.repo.markSentStatement(row.id, result.id, at).run();
      return "sent";
    }
    if (!result.retryable) return end("FAILED", result.error);
    return this.retryOrFail(row, row.attempts + 1, result.error, result.retryAfterSeconds, at);
  }

  private async retryOrFail(row: EmailLogRow, attempt: number, error: string, retryAfterSeconds: number | null, at: string): Promise<Outcome> {
    if (attempt >= row.max_attempts) {
      await this.repo.markEndedStatement(row.id, "FAILED", error, at).run();
      return "failed";
    }
    const delayMs = Math.max((RETRY_DELAYS_MIN[attempt - 1] ?? 60) * 60_000, (retryAfterSeconds ?? 0) * 1000);
    await this.repo.markRetryStatement(row.id, error, iso(addMs(new Date(at), delayMs)), at).run();
    return "retried";
  }

  private async resolveTarget(row: EmailLogRow, settings: EmailSettingsRow): Promise<{ to: string; lang: string; name: string | null } | { skip: string }> {
    if (row.recipient.startsWith("staff:")) {
      const r = await this.repo.recipient(row.recipient.slice(6));
      if (!r || r.deleted_at || r.active !== 1) return { skip: "RECIPIENT_INACTIVE" };
      const flag = FLAG_OF[row.notification_type as EmailType];
      if (flag && r[flag] !== 1) return { skip: "RECIPIENT_OPTED_OUT" };
      return { to: r.email, lang: r.language_code, name: r.name };
    }
    if (row.recipient.startsWith("guest:")) {
      if (settings.guest_enabled !== 1) return { skip: "GUEST_DISABLED" };
      const contact = await this.repo.guestContact(row.recipient.slice(6));
      const email = contact?.customer_email?.trim();
      if (!email || !SIMPLE_EMAIL.test(email)) return { skip: "NO_GUEST_EMAIL" };
      return { to: email, lang: row.language_code ?? contact!.language_code ?? "th", name: null };
    }
    return { skip: "UNKNOWN_RECIPIENT" };
  }

  private link(lang: string, path: (locale: Locale) => string): string | null {
    if (!this.config.linkBase) return null;
    return `${this.config.linkBase}${path(getLocale(parseLocale(lang)?.code ?? "th"))}`;
  }

  /** Subject + text + HTML from current D1 data (snapshots). The first line of a LINE text is the heading. */
  private async render(row: EmailLogRow, lang: string, site: SiteInfo, recipientName: string | null): Promise<Rendered> {
    const f = new LineFormatter(lang);
    const e = emailTexts(lang);
    const payload = (() => {
      try {
        return row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    })();
    const b: MsgBooking | null = row.booking_id ? (await this.lineRepo.messageBookings([row.booking_id], lang))[0] ?? null : null;
    const subject = (type: string) => fillText(e.subjects[type] ?? type, { code: b?.code ?? "", name: b?.customerName ?? "" });
    const fromLine = (type: string, text: string, button: { label: string; url: string | null } | null): Rendered => {
      const [title, ...rest] = text.split("\n");
      return renderEmail({
        lang, subject: subject(type), title: title ?? "", body: rest.join("\n"),
        button: button?.url ? { label: button.label, url: button.url } : null, siteName: site.name,
      });
    };
    const lookup = (code: string) => this.link(lang, (l) => `${bookingLookupPath(l)}?code=${encodeURIComponent(code)}`);
    const SOLD = new Set(["CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "NO_SHOW"]);

    switch (row.notification_type as EmailType) {
      case "NEW_BOOKING":
        if (!b) return { skip: "NOT_RELEVANT" };
        return fromLine("NEW_BOOKING", newBookingText(f, b, null), { label: e.openAdmin, url: this.link(lang, (l) => `/${l.path}/admin/bookings/${b.code}`) });
      case "PAYMENT_REVIEW": {
        const pay = typeof payload.paymentId === "string" ? await this.lineRepo.payment(payload.paymentId) : null;
        if (!b || !pay || pay.status !== "PENDING_VERIFICATION") return { skip: "NOT_RELEVANT" };
        const check = await this.lineRepo.latestAutoCheck(payload.paymentId as string);
        return fromLine("PAYMENT_REVIEW", paymentReviewText(f, b, pay.amount_satang, null, { channel: pay.channel, check }),
          { label: e.openAdmin, url: this.link(lang, (l) => `/${l.path}/admin/slips`) });
      }
      case "PAYMENT_CONFIRMED": {
        if (!b) return { skip: "NOT_RELEVANT" };
        if (typeof payload.paymentId === "string") {
          // Deposit plan: the rest came in.
          const pay = await this.lineRepo.payment(payload.paymentId);
          if (!pay || (pay.status !== "VERIFIED" && pay.status !== "PAID")) return { skip: "NOT_RELEVANT" };
          return fromLine("PAYMENT_CONFIRMED", balanceReceivedText(f, b, pay.amount_satang, pay.method, pay.channel),
            { label: e.openAdmin, url: this.link(lang, (l) => `/${l.path}/admin/bookings/${b.code}`) });
        }
        const paid = await this.lineRepo.latestPaidMethod(row.booking_id!);
        return fromLine("PAYMENT_CONFIRMED", paymentConfirmedText(f, b, paid?.method ?? null, paid?.channel ?? null),
          { label: e.openAdmin, url: this.link(lang, (l) => `/${l.path}/admin/bookings/${b.code}`) });
      }
      case "GUEST_BOOKING_CREATED": {
        if (!b || b.bookingStatus !== "PENDING") return { skip: "NOT_RELEVANT" };
        const body = [
          fillText(e.createdIntro, { name: b.customerName }),
          "",
          f.bookingBlock(b, { customer: false }),
          "",
          `${e.amountDue}: ${f.money(b.totalSatang)}`,
          ...(b.expiresAt ? [fillText(e.payBy, { time: f.dateTime(b.expiresAt) })] : []),
          "",
          e.keepCode,
        ].join("\n");
        return renderEmail({ lang, subject: subject("GUEST_BOOKING_CREATED"), title: e.createdTitle, body, siteName: site.name,
          button: lookup(b.code) ? { label: e.payNow, url: lookup(b.code)! } : null });
      }
      case "GUEST_CONFIRMED":
        if (!b || !SOLD.has(b.bookingStatus)) return { skip: "NOT_RELEVANT" };
        return fromLine("GUEST_CONFIRMED", guestConfirmedText(f, b, { siteName: null, link: null }), { label: e.viewBooking, url: lookup(b.code) });
      case "GUEST_PAYMENT_REJECTED": {
        const pay = typeof payload.paymentId === "string" ? await this.lineRepo.payment(payload.paymentId) : null;
        if (!b || !pay || pay.status !== "REJECTED") return { skip: "NOT_RELEVANT" };
        // The rest of a deposit: the booking stays confirmed; another slip or the reception desk will do.
        if (pay.is_balance === 1) {
          if (b.bookingStatus !== "CONFIRMED" || stillDue(b) === 0) return { skip: "NOT_RELEVANT" };
          return fromLine("GUEST_PAYMENT_REJECTED", guestBalanceRejectedText(f, b, { reason: pay.rejected_reason, link: null, siteName: null }),
            { label: e.viewBooking, url: lookup(b.code) });
        }
        if (b.bookingStatus !== "PENDING") return { skip: "NOT_RELEVANT" };
        return fromLine("GUEST_PAYMENT_REJECTED", guestPaymentRejectedText(f, b, { reason: pay.rejected_reason, link: null, siteName: null }),
          { label: e.payNow, url: lookup(b.code) });
      }
      case "GUEST_CANCELLED":
        if (!b || b.bookingStatus !== "CANCELLED") return { skip: "NOT_RELEVANT" };
        return fromLine("GUEST_CANCELLED", guestCancelledText(f, b, { siteName: null, phone: site.phone }), null);
      case "TEST": {
        const r = await this.repo.recipient(row.recipient.slice(6));
        if (!r) return { skip: "RECIPIENT_INACTIVE" };
        const kinds = [r.notify_booking === 1 && e.kinds.booking, r.notify_payment === 1 && e.kinds.payment].filter(Boolean).join(", ") || e.kinds.nothing;
        return renderEmail({ lang, subject: e.subjects.TEST!, title: e.subjects.TEST!, body: fillText(e.testIntro, { name: recipientName ?? r.name, kinds }), button: null, siteName: site.name });
      }
      default:
        return { skip: "UNKNOWN_TYPE" };
    }
  }
}
