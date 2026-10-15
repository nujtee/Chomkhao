import { BOOKING_CODE_PATTERN } from "../../shared/booking-types.ts";
import { DEFAULT_TIMEZONE, todayIn } from "../../shared/dates.ts";
import { LOCALE_CODES, parseLocale, type LocaleCode } from "../../shared/i18n/locales.ts";
import {
  addFriendUrl, LINE_BASIC_ID_PATTERN, LINE_TARGET_PATTERN, LINE_USER_PATTERN, LINK_CODE_ALPHABET, LINK_CODE_TTL_MINUTES,
  LINK_MESSAGE_PATTERN, lineTargetKind, maskLineId, NOTIFICATION_STATUSES, NOTIFICATION_TYPES, oaMessageUrl, REMINDER_DAYS_MAX,
  type GuestLineDto, type GuestLineLinkDto, type LineConnectionDto, type LineLinkCodeDto, type LineLinkStatusDto, type LineRecipientDto,
  type LineSettingsDto, type NotificationLogDto, type NotificationStatus, type NotificationType,
} from "../../shared/line-types.ts";
import type { D1DatabaseLike } from "../env.ts";
import { ConflictError, HttpError, NotFoundError, TooManyRequestsError, UnauthorizedError, ValidationError } from "../http/errors.ts";
import { verifyLineSignature, type LineTextMessage } from "../line/line-api.ts";
import { guestLinkedText, INVALID_CODE_REPLY, LineFormatter, staffLinkedText } from "../line/line-templates.ts";
import type { BookingRow } from "../repositories/booking.repository.ts";
import type { LineRecipientRow, LineRepository, NotificationListRow } from "../repositories/line.repository.ts";
import { newId, sha256Hex } from "../security/tokens.ts";
import { Validator } from "../validation.ts";
import { addMs, iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { NotificationService } from "./notification.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";
import type { MyLineCodeDto, MyLineDto } from "../../shared/credit-types.ts";

export const WEBHOOK_MAX_BYTES = 256 * 1024;
export const GUEST_CODES_PER_DAY = 5;
export const TESTS_PER_HOUR = 10;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LINKABLE = new Set(["PENDING", "CONFIRMED"]);

export interface LineConfig {
  secret: string | null;
  /** Absolute webhook URL for the admin to paste into LINE Developers. */
  webhookUrl: string;
  timezone: () => Promise<string | null>;
  /** Website settings → LINE OA link (https), if set. */
  siteLineUrl: () => Promise<string | null>;
  siteName: (lang: string) => Promise<string | null>;
}

interface GuestBookings {
  guestBooking(code: string, phone: string, meta: RequestMeta): Promise<BookingRow>;
}

function toRecipient(r: LineRecipientRow): LineRecipientDto {
  return {
    id: r.id, name: r.name, kind: lineTargetKind(r.target_id), targetMasked: maskLineId(r.target_id),
    language: (parseLocale(r.language_code)?.code ?? "th") as LocaleCode,
    notifyCheckin: r.notify_checkin === 1, notifyFood: r.notify_food === 1, notifyPayment: r.notify_payment === 1,
    notifyBooking: r.notify_booking !== 0, active: r.active === 1, linkedVia: r.linked_via, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function toLog(r: NotificationListRow): NotificationLogDto {
  return {
    id: r.id, type: r.notification_type as NotificationType, status: r.status, audience: r.recipient.startsWith("guest:") ? "GUEST" : "STAFF",
    recipientName: r.recipient_name, bookingCode: r.booking_code, attempts: r.attempts, maxAttempts: r.max_attempts,
    lastError: r.last_error, scheduledFor: r.scheduled_for, nextAttemptAt: r.status === "PENDING" ? r.next_attempt_at : null,
    sentAt: r.sent_at, createdAt: r.created_at,
  };
}

/** 8 unbiased characters from a 32-letter alphabet (40 bits), shown as ABCD-EFGH. */
export function newLinkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => LINK_CODE_ALPHABET[b & 31]!).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function hashCode(code: string): Promise<string> {
  return sha256Hex(`line-link:${code.replace("-", "").toUpperCase()}`);
}

/**
 * LINE Official Account (spec §47): settings, staff chats (paired with one-time codes),
 * guest opt-in per booking, the notification log, and the webhook.
 */
export class LineService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: LineRepository,
    private readonly notifications: NotificationService,
    private readonly bookings: GuestBookings,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly config: LineConfig,
  ) {}

  // ================================================================ settings

  private async settingsDto(): Promise<LineSettingsDto> {
    const s = await this.repo.settings();
    const siteUrl = await this.config.siteLineUrl();
    return {
      enabled: s?.enabled === 1,
      guestEnabled: s?.guest_enabled === 1,
      publicButton: s?.public_button === 1,
      reminderDaysBefore: s?.reminder_days_before ?? 1,
      reminderTime: s?.reminder_time ?? "18:00",
      sendWhenEmpty: s?.send_when_empty === 1,
      tokenConfigured: this.notifications.tokenConfigured,
      secretConfigured: !!this.config.secret,
      webhookUrl: this.config.webhookUrl,
      timezone: (await this.config.timezone()) ?? DEFAULT_TIMEZONE,
      bot: { basicId: s?.bot_basic_id ?? null, displayName: s?.bot_display_name ?? null, checkedAt: s?.bot_checked_at ?? null },
      addFriendUrl: siteUrl ?? addFriendUrl(s?.bot_basic_id ?? null),
      updatedAt: s?.updated_at ?? "",
    };
  }

  async getSettings(actor: AuthContext, meta: RequestMeta): Promise<LineSettingsDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    return this.settingsDto();
  }

  async saveSettings(actor: AuthContext, body: Record<string, unknown>, meta: RequestMeta): Promise<LineSettingsDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const v = new Validator(body).allowOnly(["enabled", "guestEnabled", "publicButton", "reminderDaysBefore", "reminderTime", "sendWhenEmpty"]);
    const enabled = v.boolean("enabled", false);
    const guestEnabled = v.boolean("guestEnabled", false);
    const publicButton = v.boolean("publicButton", false);
    const sendWhenEmpty = v.boolean("sendWhenEmpty", false);
    const days = body.reminderDaysBefore;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > REMINDER_DAYS_MAX) v.errors.reminderDaysBefore = "OUT_OF_RANGE";
    const time = v.string("reminderTime", { required: true, pattern: TIME });
    const before = await this.repo.settings();
    // Turning features on needs what they depend on; turning off is always allowed.
    if (enabled && !this.notifications.tokenConfigured) v.errors.enabled = "LINE_TOKEN_MISSING";
    if (guestEnabled) {
      if (!enabled) v.errors.guestEnabled = "LINE_DISABLED";
      else if (!this.config.secret) v.errors.guestEnabled = "LINE_SECRET_MISSING";
      else if (!before?.bot_basic_id) v.errors.guestEnabled = "LINE_NOT_CHECKED";
    }
    if (publicButton && !(await this.config.siteLineUrl()) && !before?.bot_basic_id) v.errors.publicButton = "LINE_URL_MISSING";
    v.assertValid();
    const input = { enabled, guestEnabled, publicButton, reminderDaysBefore: days as number, reminderTime: time, sendWhenEmpty };
    const now = iso(this.clock());
    await this.db.batch([
      this.repo.saveSettingsStatement(input, actor.userId, now),
      this.log.auditStatement(actor.userId, "UPDATE_LINE_SETTINGS", "line", "line_settings",
        before ? { enabled: before.enabled === 1, guestEnabled: before.guest_enabled === 1, publicButton: before.public_button === 1,
          reminderDaysBefore: before.reminder_days_before, reminderTime: before.reminder_time, sendWhenEmpty: before.send_when_empty === 1 } : null,
        input, meta),
    ]);
    return this.settingsDto();
  }

  /** Reads the bot profile + monthly quota from LINE; stores the public Basic ID / name. */
  async check(actor: AuthContext, meta: RequestMeta): Promise<LineConnectionDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const api = this.notifications.lineApi();
    if (!api) throw new ConflictError("LINE_CHANNEL_ACCESS_TOKEN is not set", "LINE_TOKEN_MISSING");
    const info = await api.botInfo();
    if (!info.ok) {
      throw info.status === 401
        ? new ConflictError("LINE rejected the channel access token", "LINE_TOKEN_INVALID")
        : new HttpError(502, "LINE_UNAVAILABLE", `LINE did not answer (${info.error})`);
    }
    const basicId = info.info.basicId && LINE_BASIC_ID_PATTERN.test(info.info.basicId) ? info.info.basicId : null;
    await this.repo.saveBotStatement(basicId, info.info.displayName, iso(this.clock())).run();
    const quota = await api.quota();
    return { ok: true, basicId, displayName: info.info.displayName, quotaLimit: quota.limit, quotaUsed: quota.used };
  }

  // ================================================================ staff recipients

  async recipients(actor: AuthContext, meta: RequestMeta): Promise<LineRecipientDto[]> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    return (await this.repo.recipients()).map(toRecipient);
  }

  /** `current`: an update keeps "new booking" as it was when an older client leaves it out. */
  private recipientFields(v: Validator, current: LineRecipientRow | null = null) {
    const name = v.string("name", { required: true, max: 80 });
    const language = v.oneOf("language", LOCALE_CODES, { required: true }) as LocaleCode;
    return {
      name, language,
      checkin: v.boolean("notifyCheckin", true),
      food: v.boolean("notifyFood", false),
      payment: v.boolean("notifyPayment", false),
      booking: v.boolean("notifyBooking", current ? current.notify_booking !== 0 : true),
    };
  }

  /** Manual fallback: paste a user / group id (from LINE Developers). Pairing with a code is easier. */
  async addRecipient(actor: AuthContext, body: Record<string, unknown>, meta: RequestMeta): Promise<LineRecipientDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const v = new Validator(body).allowOnly(["targetId", "name", "language", "notifyCheckin", "notifyFood", "notifyPayment", "notifyBooking"]);
    const targetId = v.string("targetId", { required: true, pattern: LINE_TARGET_PATTERN });
    const f = this.recipientFields(v);
    v.assertValid();
    const existing = await this.repo.recipientByTarget(targetId);
    if (existing && !existing.deleted_at) throw new ConflictError("This LINE chat is already a recipient", "LINE_RECIPIENT_EXISTS");
    const now = iso(this.clock());
    const id = existing?.id ?? newId();
    await this.db.batch([
      existing
        ? this.repo.reviveRecipientStatement(id, { name: f.name, language: f.language, via: "MANUAL", actorId: actor.userId, now })
        : this.repo.insertRecipientStatement({ id, targetId, name: f.name, language: f.language, checkin: f.checkin, food: f.food, payment: f.payment, booking: f.booking, via: "MANUAL", actorId: actor.userId, now }),
      ...(existing ? [this.repo.updateRecipientStatement(id, { ...f, active: true }, actor.userId, now)] : []),
      this.log.auditStatement(actor.userId, "CREATE_LINE_RECIPIENT", "line", id, null, { name: f.name, kind: lineTargetKind(targetId), via: "MANUAL" }, meta),
    ]);
    return toRecipient((await this.repo.recipient(id))!);
  }

  async updateRecipient(actor: AuthContext, id: string, body: Record<string, unknown>, meta: RequestMeta): Promise<LineRecipientDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const before = await this.repo.recipient(id);
    if (!before || before.deleted_at) throw new NotFoundError("Recipient not found", "LINE_RECIPIENT_NOT_FOUND");
    const v = new Validator(body).allowOnly(["name", "language", "notifyCheckin", "notifyFood", "notifyPayment", "notifyBooking", "active"]);
    const f = this.recipientFields(v, before);
    const active = v.boolean("active", before.active === 1);
    v.assertValid();
    const now = iso(this.clock());
    const changed = await this.repo.updateRecipientStatement(id, { ...f, active }, actor.userId, now).all();
    if (!changed.results.length) throw new NotFoundError("Recipient not found", "LINE_RECIPIENT_NOT_FOUND");
    await this.log.auditStatement(actor.userId, "UPDATE_LINE_RECIPIENT", "line", id, toRecipient(before), { ...f, active }, meta).run();
    return toRecipient((await this.repo.recipient(id))!);
  }

  async deleteRecipient(actor: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const before = await this.repo.recipient(id);
    if (!before || before.deleted_at) throw new NotFoundError("Recipient not found", "LINE_RECIPIENT_NOT_FOUND");
    await this.db.batch([
      this.repo.deleteRecipientStatement(id, actor.userId, iso(this.clock())),
      this.log.auditStatement(actor.userId, "DELETE_LINE_RECIPIENT", "line", id, toRecipient(before), null, meta),
    ]);
  }

  /** Sends a test message right away and returns its log row. */
  async test(actor: AuthContext, id: string, meta: RequestMeta): Promise<NotificationLogDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const r = await this.repo.recipient(id);
    if (!r || r.deleted_at) throw new NotFoundError("Recipient not found", "LINE_RECIPIENT_NOT_FOUND");
    if (!this.notifications.tokenConfigured) throw new ConflictError("LINE_CHANNEL_ACCESS_TOKEN is not set", "LINE_TOKEN_MISSING");
    if ((await this.repo.settings())?.enabled !== 1) throw new ConflictError("Turn LINE notifications on first", "LINE_DISABLED");
    const now = this.clock();
    if ((await this.repo.testsSince(id, iso(addMs(now, -60 * 60_000)))) >= TESTS_PER_HOUR) throw new TooManyRequestsError(15 * 60);
    const logId = newId();
    await this.db.batch([
      this.repo.insertTestStatement(logId, id, r.language_code, iso(now)),
      this.log.auditStatement(actor.userId, "SEND_LINE_TEST", "line", id, null, { notificationId: logId }, meta),
    ]);
    await this.notifications.deliverNow(logId);
    return this.logDto(logId);
  }

  // ================================================================ pairing codes

  async createLinkCode(actor: AuthContext, body: Record<string, unknown>, meta: RequestMeta): Promise<LineLinkCodeDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const v = new Validator(body).allowOnly(["name", "language"]);
    const name = v.string("name", { required: true, max: 80 });
    const language = v.oneOf("language", LOCALE_CODES, { required: true }) as LocaleCode;
    v.assertValid();
    if (!this.config.secret) throw new ConflictError("LINE_CHANNEL_SECRET is not set (needed for the webhook)", "LINE_SECRET_MISSING");
    const now = this.clock();
    const code = newLinkCode();
    const id = newId();
    const expiresAt = iso(addMs(now, LINK_CODE_TTL_MINUTES * 60_000));
    await this.db.batch([
      this.repo.insertLinkCodeStatement({ id, hash: await hashCode(code), purpose: "STAFF", bookingId: null, name, language, actorId: actor.userId, expiresAt, now: iso(now) }),
      this.log.auditStatement(actor.userId, "CREATE_LINE_LINK_CODE", "line", id, null, { name, language, expiresAt }, meta),
    ]);
    const s = await this.settingsDto();
    const message = `LINK ${code}`;
    return { id, code, message, expiresAt, addFriendUrl: s.addFriendUrl, url: s.bot.basicId ? oaMessageUrl(s.bot.basicId, message) : null };
  }

  async linkStatus(actor: AuthContext, id: string, meta: RequestMeta): Promise<LineLinkStatusDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const row = await this.repo.linkCode(id);
    if (!row || row.purpose !== "STAFF") throw new NotFoundError("Code not found", "LINE_CODE_NOT_FOUND");
    if (row.used_at && row.recipient_id) {
      const r = await this.repo.recipient(row.recipient_id);
      return { status: "LINKED", recipient: r ? toRecipient(r) : null };
    }
    return { status: row.expires_at <= iso(this.clock()) ? "EXPIRED" : "PENDING", recipient: null };
  }

  // ================================================================ My account → LINE (migration 0027)

  /** The signed-in user's own LINE link (credit notices reach it). */
  async myLine(actor: AuthContext): Promise<MyLineDto> {
    const [link, s] = await Promise.all([this.repo.userLine(actor.userId), this.repo.settings()]);
    return {
      linked: link !== null, linkedAt: link?.linked_at ?? null,
      available: s?.enabled === 1 && this.notifications.tokenConfigured && !!this.config.secret && !!s?.bot_basic_id,
    };
  }

  async createMyLinkCode(actor: AuthContext, language: LocaleCode, meta: RequestMeta): Promise<MyLineCodeDto> {
    const s = await this.repo.settings();
    if (!this.config.secret) throw new ConflictError("LINE_CHANNEL_SECRET is not set (needed for the webhook)", "LINE_SECRET_MISSING");
    if (s?.enabled !== 1) throw new ConflictError("LINE notifications are switched off", "LINE_DISABLED");
    const now = this.clock();
    if ((await this.log.countRecent(["LINE_OWN_CODE_CREATED"], 60 * 60_000, { userId: actor.userId })) >= TESTS_PER_HOUR) throw new TooManyRequestsError(15 * 60);
    const code = newLinkCode();
    const id = newId();
    const expiresAt = iso(addMs(now, LINK_CODE_TTL_MINUTES * 60_000));
    await this.db.batch([
      this.repo.insertUserLinkCodeStatement({ id, hash: await hashCode(code), userId: actor.userId, name: actor.displayName.slice(0, 80) || "User", language, expiresAt, now: iso(now) }),
      this.log.eventStatement("LINE_OWN_CODE_CREATED", "INFO", meta, { userId: actor.userId }),
    ]);
    const dto = await this.settingsDto();
    const message = `LINK ${code}`;
    return { id, code, message, expiresAt, addFriendUrl: dto.addFriendUrl, url: dto.bot.basicId ? oaMessageUrl(dto.bot.basicId, message) : null };
  }

  async myLinkStatus(actor: AuthContext, id: string): Promise<{ status: "PENDING" | "LINKED" | "EXPIRED" }> {
    const row = await this.repo.linkCode(id);
    if (!row || row.user_id !== actor.userId) throw new NotFoundError("Code not found", "LINE_CODE_NOT_FOUND");
    if (row.used_at) return { status: "LINKED" };
    return { status: row.expires_at <= iso(this.clock()) ? "EXPIRED" : "PENDING" };
  }

  async unlinkMyLine(actor: AuthContext, meta: RequestMeta): Promise<MyLineDto> {
    await this.db.batch([
      this.repo.deleteUserLineStatement(actor.userId),
      this.log.auditStatement(actor.userId, "UNLINK_OWN_LINE", "line", actor.userId, null, null, meta),
    ]);
    return this.myLine(actor);
  }

  // ================================================================ notification log

  private async logDto(id: string): Promise<NotificationLogDto> {
    const row = await this.repo.listRow(id);
    if (!row) throw new NotFoundError("Notification not found", "NOTIFICATION_NOT_FOUND");
    return toLog(row);
  }

  async logs(actor: AuthContext, q: URLSearchParams, meta: RequestMeta): Promise<{ items: NotificationLogDto[]; nextCursor: string | null }> {
    await this.authz.requirePermission(actor, "notifications.view", meta);
    const v = new Validator(Object.fromEntries(q.entries())).allowOnly(["status", "type", "code", "before", "limit"]);
    const status = v.oneOf("status", NOTIFICATION_STATUSES) as NotificationStatus | undefined;
    const type = v.oneOf("type", NOTIFICATION_TYPES) as NotificationType | undefined;
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

  async retry(actor: AuthContext, id: string, meta: RequestMeta): Promise<NotificationLogDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const changed = await this.repo.retryStatement(id, iso(this.clock())).all();
    if (!changed.results.length) throw new ConflictError("Only failed or cancelled notifications can be retried", "NOTIFICATION_NOT_RETRYABLE");
    await this.log.auditStatement(actor.userId, "RETRY_NOTIFICATION", "notifications", id, null, { status: "PENDING" }, meta).run();
    return this.logDto(id);
  }

  async cancel(actor: AuthContext, id: string, meta: RequestMeta): Promise<NotificationLogDto> {
    await this.authz.requirePermission(actor, "settings.line", meta);
    const changed = await this.repo.cancelStatement(id, iso(this.clock())).all();
    if (!changed.results.length) throw new ConflictError("Only waiting notifications can be cancelled", "NOTIFICATION_NOT_PENDING");
    await this.log.auditStatement(actor.userId, "CANCEL_NOTIFICATION", "notifications", id, null, { status: "CANCELLED" }, meta).run();
    return this.logDto(id);
  }

  /** "Send due notifications now" (the cron does this every minute). */
  async runNow(actor: AuthContext, meta: RequestMeta) {
    await this.authz.requirePermission(actor, "settings.line", meta);
    return this.notifications.tick();
  }

  // ================================================================ guests

  /** Part of the public booking view: can this booking get LINE updates, and is it linked? */
  async guestStatus(row: Pick<BookingRow, "id" | "booking_status" | "check_out">): Promise<GuestLineDto> {
    const [s, link] = await Promise.all([this.repo.settings(), this.repo.guestLink(row.id)]);
    const tz = (await this.config.timezone()) ?? DEFAULT_TIMEZONE;
    const available = !!s && s.enabled === 1 && s.guest_enabled === 1 && !!s.bot_basic_id && this.notifications.tokenConfigured
      && LINKABLE.has(row.booking_status) && row.check_out >= todayIn(tz, this.clock());
    return { available, linked: !!link };
  }

  async guestLink(code: string, phone: string, meta: RequestMeta): Promise<GuestLineLinkDto> {
    const booking = await this.bookings.guestBooking(code, phone, meta);
    const status = await this.guestStatus(booking);
    if (!status.available) throw new ConflictError("LINE updates are not available for this booking", "LINE_UNAVAILABLE");
    const now = this.clock();
    if ((await this.repo.guestCodesSince(booking.id, iso(addMs(now, -24 * 60 * 60_000)))) >= GUEST_CODES_PER_DAY) throw new TooManyRequestsError(60 * 60);
    const s = (await this.repo.settings())!;
    const linkCode = newLinkCode();
    const expiresAt = iso(addMs(now, LINK_CODE_TTL_MINUTES * 60_000));
    await this.db.batch([
      this.repo.insertLinkCodeStatement({ id: newId(), hash: await hashCode(linkCode), purpose: "GUEST", bookingId: booking.id, name: null, language: booking.language_code, actorId: null, expiresAt, now: iso(now) }),
      this.log.eventStatement("LINE_GUEST_CODE_CREATED", "INFO", meta, { identifier: booking.booking_code }),
    ]);
    const message = `${booking.booking_code}\nLINK ${linkCode}`;
    return { code: linkCode, expiresAt, message, url: oaMessageUrl(s.bot_basic_id!, message) };
  }

  async guestUnlink(code: string, phone: string, meta: RequestMeta): Promise<GuestLineDto> {
    const booking = await this.bookings.guestBooking(code, phone, meta);
    const now = iso(this.clock());
    await this.db.batch([
      this.repo.deleteGuestLinkStatement(booking.id),
      this.repo.cancelGuestPendingStatement(booking.id, now),
      this.log.eventStatement("LINE_GUEST_UNLINKED", "INFO", meta, { identifier: booking.booking_code }),
    ]);
    return this.guestStatus(booking);
  }

  // ================================================================ webhook

  /**
   * POST /api/line/webhook. Authenticated by the HMAC signature (not cookies / CSRF).
   * Only three things are acted on: "LINK <code>" messages, unfollow and leave. Nothing else is stored.
   */
  async webhook(raw: Uint8Array, signature: string | null, meta: RequestMeta): Promise<number> {
    if (!this.config.secret) throw new HttpError(503, "LINE_NOT_CONFIGURED", "LINE webhook is not configured");
    if (!(await verifyLineSignature(this.config.secret, raw, signature))) {
      if (!meta.ip || (await this.log.countRecent(["LINE_WEBHOOK_REJECTED"], 60 * 60_000, { ip: meta.ip })) < 20) {
        await this.log.event("LINE_WEBHOOK_REJECTED", "WARNING", meta, { details: { reason: "bad_signature", bytes: raw.length } });
      }
      throw new UnauthorizedError("Invalid signature", "INVALID_SIGNATURE");
    }
    let events: unknown[] = [];
    try {
      const body = JSON.parse(new TextDecoder().decode(raw)) as { events?: unknown };
      events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
    } catch {
      throw new ValidationError({ body: "INVALID_JSON" });
    }
    let handled = 0;
    for (const e of events) {
      try {
        if (await this.handleEvent(e as LineEvent, meta)) handled++;
      } catch (error) {
        console.error(JSON.stringify({ level: "error", message: "line_webhook_event_failed", error: String(error).slice(0, 200) }));
      }
    }
    return handled;
  }

  private async reply(token: string | undefined, text: string): Promise<void> {
    const api = this.notifications.lineApi();
    if (!api || !token) return;
    const message: LineTextMessage = { type: "text", text };
    const res = await api.reply(token, [message]);
    if (!res.ok) console.error(JSON.stringify({ level: "warn", message: "line_reply_failed", error: res.error }));
  }

  private async handleEvent(e: LineEvent, meta: RequestMeta): Promise<boolean> {
    if (!e || typeof e !== "object" || (e.mode !== undefined && e.mode !== "active")) return false;
    const src = e.source ?? {};
    const target = src.type === "group" ? src.groupId : src.type === "room" ? src.roomId : src.type === "user" ? src.userId : undefined;
    if (typeof target !== "string" || !LINE_TARGET_PATTERN.test(target)) return false;
    const now = iso(this.clock());

    if (e.type === "unfollow" || e.type === "leave") {
      await this.db.batch([
        this.repo.deactivateTargetStatement(target, now),
        ...(e.type === "unfollow" ? [this.repo.deleteGuestLinksOfUserStatement(target), this.repo.deleteUserLinksOfLineUserStatement(target)] : []),
      ]);
      return true;
    }
    if (e.type !== "message" || e.message?.type !== "text" || typeof e.message.text !== "string") return false;
    const match = LINK_MESSAGE_PATTERN.exec(e.message.text.slice(0, 1000));
    if (!match) return false;

    const code = `${match[1]}-${match[2]}`.toUpperCase();
    const row = await this.repo.linkCodeByHash(await hashCode(code));
    if (!row || row.used_at || row.expires_at <= now) {
      if (!(row?.used_at && e.deliveryContext?.isRedelivery)) await this.reply(e.replyToken, INVALID_CODE_REPLY);
      return false;
    }

    // "My account → LINE" (migration 0027): this back-office user's own LINE, one-to-one chat only.
    if (row.purpose === "STAFF" && row.user_id) {
      const f = new LineFormatter(row.language_code);
      if (src.type !== "user" || !LINE_USER_PATTERN.test(target)) {
        await this.reply(e.replyToken, f.t.guestOneToOne);
        return false;
      }
      const results = await this.db.batch(this.repo.userLinkStatements(row.id, row.user_id, target, now));
      if (!results[0]?.results.length) return false;
      await this.log.auditStatement(row.user_id, "LINK_OWN_LINE", "line", row.user_id, null, { via: "CODE" }, meta).run();
      await this.reply(e.replyToken, staffLinkedText(f, row.recipient_name ?? "", await this.config.siteName(row.language_code)));
      return true;
    }

    if (row.purpose === "STAFF") {
      const f = new LineFormatter(row.language_code);
      const existing = await this.repo.recipientByTarget(target);
      const id = existing?.id ?? newId();
      const name = row.recipient_name!;
      const results = await this.db.batch(this.repo.staffLinkStatements(row.id, now, {
        id, existing: !!existing, targetId: target, name, language: row.language_code, actorId: row.created_by,
      }));
      if (!results[0]?.results.length) return false;
      await this.log.auditStatement(row.created_by, "LINK_LINE_RECIPIENT", "line", id, null, { name, kind: lineTargetKind(target), via: "CODE" }, meta).run();
      await this.reply(e.replyToken, staffLinkedText(f, name, await this.config.siteName(row.language_code)));
      return true;
    }

    // GUEST: only from a one-to-one chat, and only for a booking that can still use it.
    const f = new LineFormatter(row.language_code);
    if (src.type !== "user" || !LINE_USER_PATTERN.test(target)) {
      await this.reply(e.replyToken, f.t.guestOneToOne);
      return false;
    }
    const booking = row.booking_id ? await this.repo.bookingLanguage(row.booking_id) : null;
    if (!booking || !LINKABLE.has(booking.booking_status)) {
      await this.reply(e.replyToken, INVALID_CODE_REPLY);
      return false;
    }
    const redeemed = await this.repo.redeemLinkCodeStatement(row.id, null, now).all();
    if (!redeemed.results.length) return false;
    await this.db.batch([
      this.repo.upsertGuestLinkStatement(row.booking_id!, target, now),
      this.log.eventStatement("LINE_GUEST_LINKED", "INFO", meta, { identifier: booking.booking_code }),
    ]);
    await this.reply(e.replyToken, guestLinkedText(new LineFormatter(booking.language_code), booking.booking_code));
    return true;
  }
}

interface LineEvent {
  type?: string;
  mode?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: { type?: string; text?: unknown };
  deliveryContext?: { isRedelivery?: boolean };
}
