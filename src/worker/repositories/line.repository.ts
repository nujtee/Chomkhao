import { maskEmailHalf, maskPhoneHalf } from "../../shared/booking-types.ts";
import { netPayment } from "./booking.repository.ts";
import { withFallback } from "./schema-fallback.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import type { MsgBooking, MsgFood } from "../line/line-templates.ts";

export interface LineSettingsRow {
  enabled: number;
  guest_enabled: number;
  public_button: number;
  reminder_days_before: number;
  reminder_time: string;
  send_when_empty: number;
  bot_basic_id: string | null;
  bot_display_name: string | null;
  bot_checked_at: string | null;
  updated_at: string;
}

export interface LineRecipientRow {
  id: string;
  target_id: string;
  name: string;
  language_code: string;
  notify_checkin: number;
  notify_food: number;
  notify_payment: number;
  /** Migration 0023; undefined before it (treated as on). */
  notify_booking?: number;
  active: number;
  linked_via: "CODE" | "MANUAL";
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LinkCodeRow {
  id: string;
  purpose: "STAFF" | "GUEST";
  booking_id: string | null;
  recipient_name: string | null;
  language_code: string;
  created_by: string | null;
  expires_at: string;
  used_at: string | null;
  recipient_id: string | null;
}

export interface NotificationRow {
  id: string;
  notification_type: string;
  idempotency_key: string;
  booking_id: string | null;
  language_code: string | null;
  recipient: string;
  status: "PENDING" | "SENT" | "FAILED" | "CANCELLED";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  payload_json: string | null;
  scheduled_for: string;
  sent_at: string | null;
  created_at: string;
}

export interface NotificationListRow extends NotificationRow {
  recipient_name: string | null;
  booking_code: string | null;
}

/** Recipient flags a notification kind is filtered on — fixed strings, never request data. */
export type RecipientFlag = "notify_checkin" | "notify_food" | "notify_payment" | "notify_booking";

const NOTIFICATION_COLUMNS = `id, notification_type, idempotency_key, booking_id, language_code, recipient, status, attempts, max_attempts,
  next_attempt_at, last_error, payload_json, scheduled_for, sent_at, created_at`;

const LINE_ENABLED = "EXISTS (SELECT 1 FROM line_settings s WHERE s.id = 1 AND s.enabled = 1)";
const GUEST_ENABLED = "EXISTS (SELECT 1 FROM line_settings s WHERE s.id = 1 AND s.enabled = 1 AND s.guest_enabled = 1)";

/** LINE settings, recipients, link codes, guest links and the notification outbox. */
export class LineRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  // ------------------------------------------------------------------ settings

  async settings(): Promise<LineSettingsRow | null> {
    try {
      return await this.db
        .prepare(
          `SELECT enabled, guest_enabled, public_button, reminder_days_before, reminder_time, send_when_empty,
                  bot_basic_id, bot_display_name, bot_checked_at, updated_at FROM line_settings WHERE id = 1`,
        )
        .first<LineSettingsRow>();
    } catch (error) {
      // Code deployed before migration 0016: behave as "LINE off".
      if (/no such table/i.test(String(error))) return null;
      throw error;
    }
  }

  saveSettingsStatement(s: { enabled: boolean; guestEnabled: boolean; publicButton: boolean; reminderDaysBefore: number; reminderTime: string; sendWhenEmpty: boolean }, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO line_settings (id, enabled, guest_enabled, public_button, reminder_days_before, reminder_time, send_when_empty, updated_at, updated_by)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, guest_enabled = excluded.guest_enabled,
           public_button = excluded.public_button, reminder_days_before = excluded.reminder_days_before,
           reminder_time = excluded.reminder_time, send_when_empty = excluded.send_when_empty,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(s.enabled ? 1 : 0, s.guestEnabled ? 1 : 0, s.publicButton ? 1 : 0, s.reminderDaysBefore, s.reminderTime, s.sendWhenEmpty ? 1 : 0, now, actorId);
  }

  saveBotStatement(basicId: string | null, displayName: string | null, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE line_settings SET bot_basic_id = ?1, bot_display_name = ?2, bot_checked_at = ?3 WHERE id = 1")
      .bind(basicId, displayName, now);
  }

  // ------------------------------------------------------------------ staff recipients

  async recipients(): Promise<LineRecipientRow[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM line_recipients WHERE deleted_at IS NULL ORDER BY created_at, id`)
      .all<LineRecipientRow>();
    return results;
  }

  recipient(id: string): Promise<LineRecipientRow | null> {
    return this.db.prepare("SELECT * FROM line_recipients WHERE id = ?1").bind(id).first<LineRecipientRow>();
  }

  recipientByTarget(targetId: string): Promise<LineRecipientRow | null> {
    return this.db.prepare("SELECT * FROM line_recipients WHERE target_id = ?1").bind(targetId).first<LineRecipientRow>();
  }

  insertRecipientStatement(r: {
    id: string; targetId: string; name: string; language: string; checkin: boolean; food: boolean; payment: boolean; booking: boolean;
    via: "CODE" | "MANUAL"; actorId: string | null; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO line_recipients (id, target_id, name, language_code, notify_checkin, notify_food, notify_payment, notify_booking, active, linked_via,
           created_at, created_by, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?11, 1, ?8, ?9, ?10, ?9, ?10)`,
      )
      .bind(r.id, r.targetId, r.name, r.language, r.checkin ? 1 : 0, r.food ? 1 : 0, r.payment ? 1 : 0, r.via, r.now, r.actorId, r.booking ? 1 : 0);
  }

  /** A chat that was removed (or left) comes back: same row, new name/language, active again. */
  reviveRecipientStatement(id: string, r: { name: string; language: string; via: "CODE" | "MANUAL"; actorId: string | null; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE line_recipients SET name = ?2, language_code = ?3, linked_via = ?4, active = 1, deleted_at = NULL,
           updated_at = ?5, updated_by = ?6 WHERE id = ?1`,
      )
      .bind(id, r.name, r.language, r.via, r.now, r.actorId);
  }

  updateRecipientStatement(id: string, r: { name: string; language: string; checkin: boolean; food: boolean; payment: boolean; booking: boolean; active: boolean }, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE line_recipients SET name = ?2, language_code = ?3, notify_checkin = ?4, notify_food = ?5, notify_payment = ?6,
           notify_booking = ?10, active = ?7, updated_at = ?8, updated_by = ?9
          WHERE id = ?1 AND deleted_at IS NULL RETURNING id`,
      )
      .bind(id, r.name, r.language, r.checkin ? 1 : 0, r.food ? 1 : 0, r.payment ? 1 : 0, r.active ? 1 : 0, now, actorId, r.booking ? 1 : 0);
  }

  /** Soft delete: logs keep their recipient name. */
  deleteRecipientStatement(id: string, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE line_recipients SET active = 0, deleted_at = ?2, updated_at = ?2, updated_by = ?3 WHERE id = ?1 AND deleted_at IS NULL RETURNING id")
      .bind(id, now, actorId);
  }

  /** The bot left a group / a person blocked the account. */
  deactivateTargetStatement(targetId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE line_recipients SET active = 0, updated_at = ?2 WHERE target_id = ?1 AND active = 1")
      .bind(targetId, now);
  }

  // ------------------------------------------------------------------ link codes

  insertLinkCodeStatement(c: {
    id: string; hash: string; purpose: "STAFF" | "GUEST"; bookingId: string | null; name: string | null; language: string;
    actorId: string | null; expiresAt: string; now: string;
  }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO line_link_codes (id, code_hash, purpose, booking_id, recipient_name, language_code, created_by, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(c.id, c.hash, c.purpose, c.bookingId, c.name, c.language, c.actorId, c.expiresAt, c.now);
  }

  linkCodeByHash(hash: string): Promise<LinkCodeRow | null> {
    return this.db.prepare("SELECT * FROM line_link_codes WHERE code_hash = ?1").bind(hash).first<LinkCodeRow>();
  }

  linkCode(id: string): Promise<LinkCodeRow | null> {
    return this.db.prepare("SELECT * FROM line_link_codes WHERE id = ?1").bind(id).first<LinkCodeRow>();
  }

  /** Single use: only the first redemption before expiry changes the row. */
  redeemLinkCodeStatement(id: string, recipientId: string | null, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE line_link_codes SET used_at = ?3, recipient_id = ?2 WHERE id = ?1 AND used_at IS NULL AND expires_at > ?3 RETURNING id")
      .bind(id, recipientId, now);
  }

  /**
   * Staff pairing, one batch: redeem the code (single use, before expiry), then create or revive
   * the recipient and record it on the code — both only if THIS batch redeemed the code.
   */
  staffLinkStatements(codeId: string, now: string, r: { id: string; existing: boolean; targetId: string; name: string; language: string; actorId: string | null }): D1PreparedStatementLike[] {
    const redeemedHere = "EXISTS (SELECT 1 FROM line_link_codes c WHERE c.id = ?7 AND c.used_at = ?6 AND c.recipient_id IS NULL)";
    return [
      this.db
        .prepare("UPDATE line_link_codes SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING id")
        .bind(codeId, now),
      r.existing
        ? this.db
            .prepare(
              `UPDATE line_recipients SET name = ?3, language_code = ?4, linked_via = 'CODE', active = 1, deleted_at = NULL,
                 updated_at = ?6, updated_by = ?5
                WHERE id = ?1 AND target_id = ?2 AND ${redeemedHere}`,
            )
            .bind(r.id, r.targetId, r.name, r.language, r.actorId, now, codeId)
        : this.db
            .prepare(
              // A new chat gets new bookings, payments and check-ins; food is a kitchen choice, made in the table.
              `INSERT INTO line_recipients (id, target_id, name, language_code, notify_checkin, notify_food, notify_payment, notify_booking,
                 active, linked_via, created_at, created_by, updated_at, updated_by)
               SELECT ?1, ?2, ?3, ?4, 1, 0, 1, 1, 1, 'CODE', ?6, ?5, ?6, ?5 WHERE ${redeemedHere}`,
            )
            .bind(r.id, r.targetId, r.name, r.language, r.actorId, now, codeId),
      this.db
        .prepare("UPDATE line_link_codes SET recipient_id = ?2 WHERE id = ?1 AND used_at = ?3 AND recipient_id IS NULL")
        .bind(codeId, r.id, now),
    ];
  }

  async guestCodesSince(bookingId: string, since: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM line_link_codes WHERE booking_id = ?1 AND created_at > ?2")
      .bind(bookingId, since)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  // ------------------------------------------------------------------ guest links

  async guestLink(bookingId: string): Promise<{ line_user_id: string; linked_at: string } | null> {
    try {
      return await this.db.prepare("SELECT line_user_id, linked_at FROM booking_line_links WHERE booking_id = ?1").bind(bookingId).first();
    } catch (error) {
      if (/no such table/i.test(String(error))) return null;
      throw error;
    }
  }

  upsertGuestLinkStatement(bookingId: string, userId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO booking_line_links (booking_id, line_user_id, linked_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (booking_id) DO UPDATE SET line_user_id = excluded.line_user_id, linked_at = excluded.linked_at`,
      )
      .bind(bookingId, userId, now);
  }

  deleteGuestLinkStatement(bookingId: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM booking_line_links WHERE booking_id = ?1 RETURNING booking_id").bind(bookingId);
  }

  /** The guest blocked the Official Account: every booking they linked stops. */
  deleteGuestLinksOfUserStatement(userId: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM booking_line_links WHERE line_user_id = ?1").bind(userId);
  }

  /** Data retention: links end 30 days after check-out; used / expired codes after 7 days. */
  purgeStatements(checkoutBefore: string, codesBefore: string): D1PreparedStatementLike[] {
    return [
      this.db
        .prepare("DELETE FROM booking_line_links WHERE booking_id IN (SELECT id FROM bookings WHERE check_out < ?1)")
        .bind(checkoutBefore),
      this.db.prepare("DELETE FROM line_link_codes WHERE expires_at < ?1").bind(codesBefore),
    ];
  }

  // ------------------------------------------------------------------ outbox (same batch as the change)

  /**
   * One PENDING row per active staff recipient who wants this kind. `guard` is a fixed SQL
   * condition (bound parameters only) proving the triggering change happened in this batch.
   * INSERT OR IGNORE + the unique idempotency key: a replay can never queue twice.
   */
  private staffOutbox(type: string, flag: RecipientFlag, keyPrefix: string, bookingId: string | null, payload: unknown,
    scheduledFor: string, now: string, guard: string, guardBinds: unknown[]): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_logs (id, channel, notification_type, idempotency_key, booking_id, language_code, recipient,
           payload_json, scheduled_for, created_at, updated_at)
         SELECT lower(hex(randomblob(16))), 'LINE', ?1, ?2 || r.id, ?3, r.language_code, 'staff:' || r.id, ?4, ?5, ?6, ?6
           FROM line_recipients r
          WHERE r.active = 1 AND r.deleted_at IS NULL AND r.${flag} = 1 AND ${LINE_ENABLED} AND ${guard}`,
      )
      .bind(type, keyPrefix, bookingId, payload === null ? null : JSON.stringify(payload), scheduledFor, now, ...guardBinds);
  }

  /** PENDING → CONFIRMED in this batch (marker: confirmed_at = now): payment + kitchen + guest. */
  bookingConfirmedStatements(bookingId: string, now: string): D1PreparedStatementLike[] {
    const confirmed = "EXISTS (SELECT 1 FROM bookings b WHERE b.id = ?3 AND b.booking_status = 'CONFIRMED' AND b.confirmed_at = ?7)";
    return [
      this.staffOutbox("PAYMENT_CONFIRMED", "notify_payment", `PAYMENT_CONFIRMED:${bookingId}:staff:`, bookingId, null, now, now, confirmed, [now]),
      this.staffOutbox("FOOD_ORDER", "notify_food", `FOOD_ORDER:${bookingId}:staff:`, bookingId, null, now, now,
        `${confirmed} AND EXISTS (SELECT 1 FROM food_orders o WHERE o.booking_id = ?3 AND o.status <> 'CANCELLED')`, [now]),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_logs (id, channel, notification_type, idempotency_key, booking_id, language_code, recipient,
             scheduled_for, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), 'LINE', 'GUEST_CONFIRMED', 'GUEST_CONFIRMED:' || b.id, b.id, b.language_code, 'guest:' || b.id, ?2, ?2, ?2
             FROM bookings b JOIN booking_line_links l ON l.booking_id = b.id
            WHERE b.id = ?1 AND b.booking_status = 'CONFIRMED' AND b.confirmed_at = ?2 AND ${GUEST_ENABLED}`,
        )
        .bind(bookingId, now),
    ];
  }

  /** A slip was stored for review (same batch). Sent after a short delay, skipped if auto-verification settles it. */
  slipSubmittedStatement(paymentId: string, bookingId: string, now: string, sendAt: string): D1PreparedStatementLike {
    return this.staffOutbox("PAYMENT_REVIEW", "notify_payment", `PAYMENT_REVIEW:${paymentId}:staff:`, bookingId, { paymentId }, sendAt, now,
      "EXISTS (SELECT 1 FROM payments p WHERE p.id = ?7 AND p.status = 'PENDING_VERIFICATION')", [paymentId]);
  }

  /**
   * Deposit plan: the rest of booking ?3 came in — payment ?7 was marked verified / paid in this batch (marker:
   * updated_at = now). Same kind as the deposit's confirmation, one message per payment.
   */
  balancePaidStatement(paymentId: string, bookingId: string, now: string): D1PreparedStatementLike {
    return this.staffOutbox("PAYMENT_CONFIRMED", "notify_payment", `PAYMENT_CONFIRMED:${paymentId}:staff:`, bookingId, { paymentId }, now, now,
      "EXISTS (SELECT 1 FROM payments p WHERE p.id = ?7 AND p.booking_id = ?3 AND p.status IN ('VERIFIED', 'PAID') AND p.updated_at = ?8)", [paymentId, now]);
  }

  /** A CONFIRMED booking with food was cancelled in this batch (marker: cancelled_at = now). */
  bookingCancelledStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.staffOutbox("FOOD_CANCELLED", "notify_food", `FOOD_CANCELLED:${bookingId}:staff:`, bookingId, null, now, now,
      "EXISTS (SELECT 1 FROM bookings b WHERE b.id = ?3 AND b.booking_status = 'CANCELLED' AND b.cancelled_at = ?7) AND EXISTS (SELECT 1 FROM booking_food_items f WHERE f.booking_id = ?3)",
      [now]);
  }

  /** A guest booked (same batch as the booking insert; marker: created_at = now). */
  newBookingStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.staffOutbox("NEW_BOOKING", "notify_booking", `NEW_BOOKING:${bookingId}:staff:`, bookingId, null, now, now,
      "EXISTS (SELECT 1 FROM bookings b WHERE b.id = ?3 AND b.created_at = ?7)", [now]);
  }

  /** One guest message (only when the guest linked LINE to this booking and guest messages are on). */
  private guestOutbox(type: string, key: string, bookingId: string, payload: unknown, now: string, guard: string, guardBinds: unknown[]): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_logs (id, channel, notification_type, idempotency_key, booking_id, language_code, recipient,
           payload_json, scheduled_for, created_at, updated_at)
         SELECT lower(hex(randomblob(16))), 'LINE', ?1, ?2, b.id, b.language_code, 'guest:' || b.id, ?4, ?5, ?5, ?5
           FROM bookings b JOIN booking_line_links l ON l.booking_id = b.id
          WHERE b.id = ?3 AND ${GUEST_ENABLED} AND ${guard}`,
      )
      .bind(type, key, bookingId, payload === null ? null : JSON.stringify(payload), now, ...guardBinds);
  }

  /** Staff turned a slip down in this batch: the guest hears why and that they can pay again. */
  guestPaymentRejectedStatement(paymentId: string, bookingId: string, now: string): D1PreparedStatementLike {
    return this.guestOutbox("GUEST_PAYMENT_REJECTED", `GUEST_PAYMENT_REJECTED:${paymentId}`, bookingId, { paymentId }, now,
      "EXISTS (SELECT 1 FROM payments p WHERE p.id = ?6 AND p.status = 'REJECTED')", [paymentId]);
  }

  /** Staff cancelled the booking in this batch (marker: cancelled_at = now): the guest hears why. */
  guestCancelledStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.guestOutbox("GUEST_CANCELLED", `GUEST_CANCELLED:${bookingId}`, bookingId, null, now,
      "b.booking_status = 'CANCELLED' AND b.cancelled_at = ?6", [now]);
  }

  /** Daily digests for `date` (+ guest reminders). Safe to run every minute: keys are per date. */
  digestStatements(date: string, daysBefore: number, now: string): D1PreparedStatementLike[] {
    const payload = { date, daysBefore };
    return [
      this.staffOutbox("CHECKIN_DIGEST", "notify_checkin", `CHECKIN_DIGEST:${date}:staff:`, null, payload, now, now, "1 = 1", []),
      this.staffOutbox("FOOD_DIGEST", "notify_food", `FOOD_DIGEST:${date}:staff:`, null, payload, now, now, "1 = 1", []),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_logs (id, channel, notification_type, idempotency_key, booking_id, language_code, recipient,
             payload_json, scheduled_for, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), 'LINE', 'GUEST_CHECKIN', 'GUEST_CHECKIN:' || b.id || ':' || ?1, b.id, b.language_code,
                  'guest:' || b.id, ?3, ?2, ?2, ?2
             FROM bookings b JOIN booking_line_links l ON l.booking_id = b.id
            WHERE b.check_in = ?1 AND b.booking_status = 'CONFIRMED' AND ${GUEST_ENABLED}`,
        )
        .bind(date, now, JSON.stringify(payload)),
    ];
  }

  insertTestStatement(id: string, recipientId: string, language: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO notification_logs (id, channel, notification_type, idempotency_key, language_code, recipient, max_attempts,
           scheduled_for, created_at, updated_at)
         VALUES (?1, 'LINE', 'TEST', 'TEST:' || ?1, ?3, 'staff:' || ?2, 1, ?4, ?4, ?4)`,
      )
      .bind(id, recipientId, language, now);
  }

  async testsSince(recipientId: string, since: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM notification_logs WHERE notification_type = 'TEST' AND recipient = 'staff:' || ?1 AND created_at > ?2")
      .bind(recipientId, since)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  // ------------------------------------------------------------------ dispatcher

  async due(now: string, limit: number): Promise<NotificationRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${NOTIFICATION_COLUMNS} FROM notification_logs
          WHERE status = 'PENDING' AND scheduled_for <= ?1 AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
          ORDER BY scheduled_for, id LIMIT ?2`,
      )
      .bind(now, limit)
      .all<NotificationRow>();
    return results;
  }

  notification(id: string): Promise<NotificationRow | null> {
    return this.db.prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM notification_logs WHERE id = ?1`).bind(id).first<NotificationRow>();
  }

  /**
   * Claims one attempt: bumps `attempts` and leases the row until `leaseUntil`, only if nobody
   * else did since we read it. A crashed sender's row comes back after the lease with the same
   * retry key, so LINE still delivers at most once.
   */
  claimStatement(id: string, seenAttempts: number, leaseUntil: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE notification_logs SET attempts = attempts + 1, next_attempt_at = ?3, updated_at = ?4
          WHERE id = ?1 AND status = 'PENDING' AND attempts = ?2 AND attempts < max_attempts
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?4)
          RETURNING id`,
      )
      .bind(id, seenAttempts, leaseUntil, now);
  }

  markSentStatement(id: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE notification_logs SET status = 'SENT', sent_at = ?2, next_attempt_at = NULL, last_error = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'PENDING'")
      .bind(id, now);
  }

  markRetryStatement(id: string, error: string, nextAt: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE notification_logs SET last_error = ?2, next_attempt_at = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'PENDING'")
      .bind(id, error.slice(0, 300), nextAt, now);
  }

  markEndedStatement(id: string, status: "FAILED" | "CANCELLED", error: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE notification_logs SET status = ?2, last_error = ?3, next_attempt_at = NULL, updated_at = ?4 WHERE id = ?1 AND status = 'PENDING'")
      .bind(id, status, error.slice(0, 300), now);
  }

  /** Staff retry of a FAILED / CANCELLED notification: three more attempts, from now. */
  retryStatement(id: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE notification_logs SET status = 'PENDING', max_attempts = attempts + 3, next_attempt_at = NULL, scheduled_for = ?2,
           last_error = NULL, updated_at = ?2
          WHERE id = ?1 AND status IN ('FAILED', 'CANCELLED') RETURNING id`,
      )
      .bind(id, now);
  }

  cancelStatement(id: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE notification_logs SET status = 'CANCELLED', last_error = 'CANCELLED_BY_STAFF', next_attempt_at = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'PENDING' RETURNING id")
      .bind(id, now);
  }

  cancelGuestPendingStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE notification_logs SET status = 'CANCELLED', last_error = 'NOT_LINKED', next_attempt_at = NULL, updated_at = ?2 WHERE recipient = 'guest:' || ?1 AND status = 'PENDING'")
      .bind(bookingId, now);
  }

  private static readonly LIST_SELECT = `
    SELECT n.id, n.notification_type, n.idempotency_key, n.booking_id, n.language_code, n.recipient, n.status, n.attempts,
           n.max_attempts, n.next_attempt_at, n.last_error, n.payload_json, n.scheduled_for, n.sent_at, n.created_at,
           r.name AS recipient_name, b.booking_code
      FROM notification_logs n
      LEFT JOIN line_recipients r ON n.recipient = 'staff:' || r.id
      LEFT JOIN bookings b ON b.id = n.booking_id`;

  async list(f: { status: string | null; type: string | null; code: string | null; before: string | null; limit: number }): Promise<NotificationListRow[]> {
    const { results } = await this.db
      .prepare(
        `${LineRepository.LIST_SELECT}
          WHERE (?1 IS NULL OR n.status = ?1) AND (?2 IS NULL OR n.notification_type = ?2) AND (?3 IS NULL OR b.booking_code = ?3)
            AND (?4 IS NULL OR n.created_at < ?4)
          ORDER BY n.created_at DESC, n.id DESC LIMIT ?5`,
      )
      .bind(f.status, f.type, f.code, f.before, f.limit)
      .all<NotificationListRow>();
    return results;
  }

  listRow(id: string): Promise<NotificationListRow | null> {
    return this.db.prepare(`${LineRepository.LIST_SELECT} WHERE n.id = ?1`).bind(id).first<NotificationListRow>();
  }

  // ------------------------------------------------------------------ message data

  /** Bookings with their stay and food lines, for message texts (category names in `lang`). */
  async messageBookings(ids: string[], lang: string): Promise<MsgBooking[]> {
    if (!ids.length) return [];
    // The cron sends these: before migration 0025 every booking reads as "no deposit".
    return withFallback(() => this.messageBookingsWith(ids, lang, "deposit_satang"), () => this.messageBookingsWith(ids, lang, "NULL"));
  }

  private async messageBookingsWith(ids: string[], lang: string, deposit: string): Promise<MsgBooking[]> {
    const list = JSON.stringify(ids);
    const [b, items, food] = await this.db.batch([
      this.db
        .prepare(
          `SELECT id, booking_code, customer_name, customer_phone, customer_email, check_in, check_out, nights, adults, children, booking_status,
                  payment_status, total_satang, ${deposit} AS deposit_satang, cancel_reason, expires_at, created_at,
                  (SELECT COALESCE(SUM(${netPayment("p")}), 0) FROM payments p WHERE p.booking_id = bookings.id) AS paid_satang
             FROM bookings WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY check_in, booking_code`,
        )
        .bind(list),
      this.db
        .prepare(
          `SELECT i.booking_id, i.item_type, i.quantity, s.unit_name_snapshot,
                  (SELECT COALESCE(SUM(t.quantity), 0) FROM booking_tarps t
                    WHERE t.booking_id = i.booking_id AND (t.status = 'ACTIVE' OR b.booking_status IN ('CANCELLED', 'EXPIRED'))) AS tarps,
                  (i.status = 'ACTIVE' OR b.booking_status IN ('CANCELLED', 'EXPIRED')) AS live
             FROM booking_items i JOIN booking_price_snapshots s ON s.booking_item_id = i.id JOIN bookings b ON b.id = i.booking_id
            WHERE i.booking_id IN (SELECT value FROM json_each(?1)) ORDER BY i.created_at, i.id`,
        )
        .bind(list),
      this.db
        .prepare(
          `SELECT f.booking_id, f.service_date, f.option_name_snapshot, f.quantity, c.service_time, c.sort_order,
                  COALESCE((SELECT name FROM food_category_translations t WHERE t.food_category_id = c.id AND t.language_code = ?2),
                           (SELECT name FROM food_category_translations t WHERE t.food_category_id = c.id AND t.language_code = 'th'), c.code) AS category
             FROM booking_food_items f JOIN food_options o ON o.id = f.food_option_id JOIN food_categories c ON c.id = o.food_category_id
            WHERE f.booking_id IN (SELECT value FROM json_each(?1))
            ORDER BY f.service_date, c.sort_order, c.code, f.option_name_snapshot`,
        )
        .bind(list, lang),
    ]);
    type B = {
      id: string; booking_code: string; customer_name: string; customer_phone: string; customer_email: string | null; check_in: string; check_out: string; nights: number; adults: number; children: number;
      booking_status: string; payment_status: string; total_satang: number; deposit_satang: number | null; cancel_reason: string | null; expires_at: string | null; created_at: string;
      paid_satang: number;
    };
    type I = { booking_id: string; item_type: MsgBooking["itemType"]; quantity: number; unit_name_snapshot: string; tarps: number; live: number };
    type F = { booking_id: string; service_date: string; option_name_snapshot: string; quantity: number; service_time: string | null; category: string };
    // The stays that count (a stay cancelled alone is left out), in the order chosen.
    const staysBy = new Map<string, I[]>();
    for (const i of (items?.results ?? []) as I[]) if (i.live) staysBy.set(i.booking_id, [...(staysBy.get(i.booking_id) ?? []), i]);
    const foodBy = new Map<string, MsgFood[]>();
    for (const f of (food?.results ?? []) as F[]) {
      foodBy.set(f.booking_id, [...(foodBy.get(f.booking_id) ?? []), { date: f.service_date, category: f.category, time: f.service_time, dish: f.option_name_snapshot, quantity: f.quantity }]);
    }
    return ((b?.results ?? []) as B[]).map((r) => {
      const stays = staysBy.get(r.id) ?? [];
      const item = stays[0];
      const camp = stays.find((s) => s.item_type === "OWN_TENT");
      return {
        code: r.booking_code, customerName: r.customer_name,
        // Masked here, so a message can never carry the full number / address.
        customerPhoneMasked: maskPhoneHalf(r.customer_phone), customerEmailMasked: r.customer_email?.trim() ? maskEmailHalf(r.customer_email) : null,
        checkIn: r.check_in, checkOut: r.check_out, nights: r.nights,
        itemType: item?.item_type ?? "HOUSE", itemName: item?.unit_name_snapshot ?? "—", tents: camp?.quantity ?? 0,
        tarps: camp?.tarps ?? 0,
        stays: stays.map((s) => ({ type: s.item_type, name: s.unit_name_snapshot, quantity: s.quantity })),
        adults: r.adults, children: r.children, bookingStatus: r.booking_status, paymentStatus: r.payment_status,
        totalSatang: r.total_satang, depositSatang: r.deposit_satang, paidSatang: r.paid_satang, food: foodBy.get(r.id) ?? [],
        cancelReason: r.cancel_reason, expiresAt: r.booking_status === "PENDING" ? r.expires_at : null, createdAt: r.created_at,
      };
    });
  }

  /** Arrivals on `date`: confirmed, or still held (unexpired) — the payment line tells them apart. */
  async arrivalIds(date: string, now: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id FROM bookings
          WHERE check_in = ?1 AND (booking_status = 'CONFIRMED' OR (booking_status = 'PENDING' AND (expires_at IS NULL OR expires_at > ?2)))
          ORDER BY booking_code`,
      )
      .bind(date, now)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  async wasSent(type: string, bookingId: string, recipient: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS x FROM notification_logs WHERE notification_type = ?1 AND booking_id = ?2 AND recipient = ?3 AND status = 'SENT' LIMIT 1")
      .bind(type, bookingId, recipient)
      .first();
    return row !== null;
  }

  latestPaidMethod(bookingId: string): Promise<{ method: string; channel: string | null } | null> {
    return this.db
      .prepare("SELECT method, channel FROM payments WHERE booking_id = ?1 AND status IN ('PAID', 'VERIFIED') ORDER BY verified_at DESC, id LIMIT 1")
      .bind(bookingId)
      .first();
  }

  payment(paymentId: string): Promise<{ status: string; amount_satang: number; method: string; channel: string | null; rejected_reason: string | null; is_balance: number } | null> {
    return this.db
      .prepare(
        `SELECT p.status, p.amount_satang, p.method, p.channel, p.rejected_reason,
                CASE WHEN b.confirmed_at IS NOT NULL AND p.submitted_at > b.confirmed_at THEN 1 ELSE 0 END AS is_balance
           FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id = ?1`,
      )
      .bind(paymentId)
      .first();
  }

  /** Newest automatic check of a payment (for the staff review message). */
  latestAutoCheck(paymentId: string): Promise<{ result: string; failure_code: string | null } | null> {
    return this.db
      .prepare("SELECT result, failure_code FROM slip_verifications WHERE payment_id = ?1 AND method = 'AUTO' ORDER BY created_at DESC, id DESC LIMIT 1")
      .bind(paymentId)
      .first();
  }

  bookingLanguage(bookingId: string): Promise<{ language_code: string; booking_code: string; booking_status: string; check_out: string } | null> {
    return this.db.prepare("SELECT language_code, booking_code, booking_status, check_out FROM bookings WHERE id = ?1").bind(bookingId).first();
  }
}
