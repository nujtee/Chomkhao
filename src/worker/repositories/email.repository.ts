import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export interface EmailSettingsRow {
  enabled: number;
  guest_enabled: number;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  updated_at: string;
}

export interface EmailRecipientRow {
  id: string;
  email: string;
  name: string;
  language_code: string;
  notify_booking: number;
  notify_payment: number;
  active: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailLogRow {
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

export interface EmailLogListRow extends EmailLogRow {
  recipient_name: string | null;
  booking_code: string | null;
}

/** Recipient flags a message kind is filtered on — fixed strings, never request data. */
export type EmailFlag = "notify_booking" | "notify_payment";

const LOG_COLUMNS = `id, notification_type, idempotency_key, booking_id, language_code, recipient, status, attempts, max_attempts,
  next_attempt_at, last_error, payload_json, scheduled_for, sent_at, created_at`;

const EMAIL_ON = "EXISTS (SELECT 1 FROM email_settings s WHERE s.id = 1 AND s.enabled = 1)";
const GUEST_ON = "EXISTS (SELECT 1 FROM email_settings s WHERE s.id = 1 AND s.enabled = 1 AND s.guest_enabled = 1)";

/** E-mail settings, staff recipients and the e-mail outbox (migration 0023). */
export class EmailRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async settings(): Promise<EmailSettingsRow | null> {
    try {
      return await this.db
        .prepare("SELECT enabled, guest_enabled, from_name, from_email, reply_to, updated_at FROM email_settings WHERE id = 1")
        .first<EmailSettingsRow>();
    } catch (error) {
      // Code deployed before migration 0023: e-mail is simply off.
      if (/no such table/i.test(String(error))) return null;
      throw error;
    }
  }

  saveSettingsStatement(s: { enabled: boolean; guestEnabled: boolean; fromName: string | null; fromEmail: string | null; replyTo: string | null }, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO email_settings (id, enabled, guest_enabled, from_name, from_email, reply_to, updated_at, updated_by)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, guest_enabled = excluded.guest_enabled, from_name = excluded.from_name,
           from_email = excluded.from_email, reply_to = excluded.reply_to, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(s.enabled ? 1 : 0, s.guestEnabled ? 1 : 0, s.fromName, s.fromEmail, s.replyTo, now, actorId);
  }

  // ------------------------------------------------------------------ staff recipients

  async recipients(): Promise<EmailRecipientRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM email_recipients WHERE deleted_at IS NULL ORDER BY created_at, id").all<EmailRecipientRow>();
    return results;
  }

  recipient(id: string): Promise<EmailRecipientRow | null> {
    return this.db.prepare("SELECT * FROM email_recipients WHERE id = ?1").bind(id).first<EmailRecipientRow>();
  }

  liveRecipientByEmail(email: string): Promise<EmailRecipientRow | null> {
    return this.db.prepare("SELECT * FROM email_recipients WHERE email = ?1 AND deleted_at IS NULL").bind(email).first<EmailRecipientRow>();
  }

  insertRecipientStatement(r: { id: string; email: string; name: string; language: string; booking: boolean; payment: boolean; actorId: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO email_recipients (id, email, name, language_code, notify_booking, notify_payment, active, created_at, created_by, updated_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?7, ?8)`,
      )
      .bind(r.id, r.email, r.name, r.language, r.booking ? 1 : 0, r.payment ? 1 : 0, r.now, r.actorId);
  }

  updateRecipientStatement(id: string, r: { email: string; name: string; language: string; booking: boolean; payment: boolean; active: boolean }, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE email_recipients SET email = ?2, name = ?3, language_code = ?4, notify_booking = ?5, notify_payment = ?6, active = ?7,
           updated_at = ?8, updated_by = ?9
          WHERE id = ?1 AND deleted_at IS NULL RETURNING id`,
      )
      .bind(id, r.email, r.name, r.language, r.booking ? 1 : 0, r.payment ? 1 : 0, r.active ? 1 : 0, now, actorId);
  }

  deleteRecipientStatement(id: string, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE email_recipients SET deleted_at = ?2, active = 0, updated_at = ?2, updated_by = ?3 WHERE id = ?1 AND deleted_at IS NULL")
      .bind(id, now, actorId);
  }

  // ------------------------------------------------------------------ outbox (rows written inside the causing batch)

  /** One PENDING row per active staff address that wants this kind; `guard` proves the change happened in this batch. */
  private staffOutbox(type: string, flag: EmailFlag, keyPrefix: string, bookingId: string | null, payload: unknown,
    scheduledFor: string, now: string, guard: string, guardBinds: unknown[]): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO email_logs (id, notification_type, idempotency_key, booking_id, language_code, recipient,
           payload_json, scheduled_for, created_at, updated_at)
         SELECT lower(hex(randomblob(16))), ?1, ?2 || r.id, ?3, r.language_code, 'staff:' || r.id, ?4, ?5, ?6, ?6
           FROM email_recipients r
          WHERE r.active = 1 AND r.deleted_at IS NULL AND r.${flag} = 1 AND ${EMAIL_ON} AND ${guard}`,
      )
      .bind(type, keyPrefix, bookingId, payload === null ? null : JSON.stringify(payload), scheduledFor, now, ...guardBinds);
  }

  /** The guest, when the booking has an e-mail address and guest e-mails are on. The address is read at send time. */
  private guestOutbox(type: string, key: string, bookingId: string, payload: unknown, now: string, guard: string, guardBinds: unknown[]): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO email_logs (id, notification_type, idempotency_key, booking_id, language_code, recipient,
           payload_json, scheduled_for, created_at, updated_at)
         SELECT lower(hex(randomblob(16))), ?1, ?2, b.id, b.language_code, 'guest:' || b.id, ?4, ?5, ?5, ?5
           FROM bookings b
          WHERE b.id = ?3 AND b.customer_email IS NOT NULL AND ${GUEST_ON} AND ${guard}`,
      )
      .bind(type, key, bookingId, payload === null ? null : JSON.stringify(payload), now, ...guardBinds);
  }

  /** New booking (marker: created_at = now): staff + guest. */
  bookingCreatedStatements(bookingId: string, now: string): D1PreparedStatementLike[] {
    return [
      this.staffOutbox("NEW_BOOKING", "notify_booking", `NEW_BOOKING:${bookingId}:staff:`, bookingId, null, now, now,
        "EXISTS (SELECT 1 FROM bookings b WHERE b.id = ?3 AND b.created_at = ?7)", [now]),
      this.guestOutbox("GUEST_BOOKING_CREATED", `GUEST_BOOKING_CREATED:${bookingId}`, bookingId, null, now, "b.created_at = ?6", [now]),
    ];
  }

  /** PENDING → CONFIRMED in this batch (marker: confirmed_at = now): staff + guest. */
  bookingConfirmedStatements(bookingId: string, now: string): D1PreparedStatementLike[] {
    return [
      this.staffOutbox("PAYMENT_CONFIRMED", "notify_payment", `PAYMENT_CONFIRMED:${bookingId}:staff:`, bookingId, null, now, now,
        "EXISTS (SELECT 1 FROM bookings b WHERE b.id = ?3 AND b.booking_status = 'CONFIRMED' AND b.confirmed_at = ?7)", [now]),
      this.guestOutbox("GUEST_CONFIRMED", `GUEST_CONFIRMED:${bookingId}`, bookingId, null, now,
        "b.booking_status = 'CONFIRMED' AND b.confirmed_at = ?6", [now]),
    ];
  }

  /** A payment waits for staff (sent after a short delay; skipped if it was settled meanwhile). */
  slipSubmittedStatement(paymentId: string, bookingId: string, now: string, sendAt: string): D1PreparedStatementLike {
    return this.staffOutbox("PAYMENT_REVIEW", "notify_payment", `PAYMENT_REVIEW:${paymentId}:staff:`, bookingId, { paymentId }, sendAt, now,
      "EXISTS (SELECT 1 FROM payments p WHERE p.id = ?7 AND p.status = 'PENDING_VERIFICATION')", [paymentId]);
  }

  /** Deposit plan: the rest came in (payment marked in this batch; marker: updated_at = now). One message per payment. */
  balancePaidStatement(paymentId: string, bookingId: string, now: string): D1PreparedStatementLike {
    return this.staffOutbox("PAYMENT_CONFIRMED", "notify_payment", `PAYMENT_CONFIRMED:${paymentId}:staff:`, bookingId, { paymentId }, now, now,
      "EXISTS (SELECT 1 FROM payments p WHERE p.id = ?7 AND p.booking_id = ?3 AND p.status IN ('VERIFIED', 'PAID') AND p.updated_at = ?8)", [paymentId, now]);
  }

  paymentRejectedStatement(paymentId: string, bookingId: string, now: string): D1PreparedStatementLike {
    return this.guestOutbox("GUEST_PAYMENT_REJECTED", `GUEST_PAYMENT_REJECTED:${paymentId}`, bookingId, { paymentId }, now,
      "EXISTS (SELECT 1 FROM payments p WHERE p.id = ?6 AND p.status = 'REJECTED')", [paymentId]);
  }

  /** Staff cancelled the booking in this batch (marker: cancelled_at = now). */
  bookingCancelledStatement(bookingId: string, now: string): D1PreparedStatementLike {
    return this.guestOutbox("GUEST_CANCELLED", `GUEST_CANCELLED:${bookingId}`, bookingId, null, now,
      "b.booking_status = 'CANCELLED' AND b.cancelled_at = ?6", [now]);
  }

  insertTestStatement(id: string, recipientId: string, language: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO email_logs (id, notification_type, idempotency_key, language_code, recipient, max_attempts, scheduled_for, created_at, updated_at)
         VALUES (?1, 'TEST', 'TEST:' || ?1, ?3, 'staff:' || ?2, 1, ?4, ?4, ?4)`,
      )
      .bind(id, recipientId, language, now);
  }

  async testsSince(recipientId: string, since: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM email_logs WHERE notification_type = 'TEST' AND recipient = 'staff:' || ?1 AND created_at > ?2")
      .bind(recipientId, since)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  // ------------------------------------------------------------------ dispatcher

  async due(now: string, limit: number): Promise<EmailLogRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${LOG_COLUMNS} FROM email_logs
          WHERE status = 'PENDING' AND scheduled_for <= ?1 AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
          ORDER BY scheduled_for, id LIMIT ?2`,
      )
      .bind(now, limit)
      .all<EmailLogRow>();
    return results;
  }

  log(id: string): Promise<EmailLogRow | null> {
    return this.db.prepare(`SELECT ${LOG_COLUMNS} FROM email_logs WHERE id = ?1`).bind(id).first<EmailLogRow>();
  }

  /** One attempt, leased (a crashed sender's row comes back with the same idempotency key). */
  claimStatement(id: string, seenAttempts: number, leaseUntil: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE email_logs SET attempts = attempts + 1, next_attempt_at = ?3, updated_at = ?4
          WHERE id = ?1 AND status = 'PENDING' AND attempts = ?2 AND attempts < max_attempts
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?4)
          RETURNING id`,
      )
      .bind(id, seenAttempts, leaseUntil, now);
  }

  markSentStatement(id: string, providerId: string | null, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE email_logs SET status = 'SENT', sent_at = ?3, provider_message_id = ?2, next_attempt_at = NULL, last_error = NULL, updated_at = ?3
          WHERE id = ?1 AND status = 'PENDING'`,
      )
      .bind(id, providerId, now);
  }

  markRetryStatement(id: string, error: string, nextAt: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE email_logs SET last_error = ?2, next_attempt_at = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'PENDING'")
      .bind(id, error.slice(0, 300), nextAt, now);
  }

  markEndedStatement(id: string, status: "FAILED" | "CANCELLED", error: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare("UPDATE email_logs SET status = ?2, last_error = ?3, next_attempt_at = NULL, updated_at = ?4 WHERE id = ?1 AND status = 'PENDING'")
      .bind(id, status, error.slice(0, 300), now);
  }

  /** Staff retry of a FAILED / CANCELLED e-mail: three more attempts, from now. */
  retryStatement(id: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE email_logs SET status = 'PENDING', max_attempts = attempts + 3, next_attempt_at = NULL, scheduled_for = ?2, last_error = NULL, updated_at = ?2
          WHERE id = ?1 AND status IN ('FAILED', 'CANCELLED') RETURNING id`,
      )
      .bind(id, now);
  }

  purgeStatement(createdBefore: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM email_logs WHERE created_at < ?1 AND status <> 'PENDING'").bind(createdBefore);
  }

  listRow(id: string): Promise<EmailLogListRow | null> {
    return this.db
      .prepare(
        `SELECT e.id, e.notification_type, e.idempotency_key, e.booking_id, e.language_code, e.recipient, e.status, e.attempts, e.max_attempts,
                e.next_attempt_at, e.last_error, e.payload_json, e.scheduled_for, e.sent_at, e.created_at,
                r.name AS recipient_name, b.booking_code
           FROM email_logs e
           LEFT JOIN email_recipients r ON e.recipient = 'staff:' || r.id
           LEFT JOIN bookings b ON b.id = e.booking_id
          WHERE e.id = ?1`,
      )
      .bind(id)
      .first<EmailLogListRow>();
  }

  async list(f: { status: string | null; type: string | null; code: string | null; before: string | null; limit: number }): Promise<EmailLogListRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT e.id, e.notification_type, e.idempotency_key, e.booking_id, e.language_code, e.recipient, e.status, e.attempts, e.max_attempts,
                e.next_attempt_at, e.last_error, e.payload_json, e.scheduled_for, e.sent_at, e.created_at,
                r.name AS recipient_name, b.booking_code
           FROM email_logs e
           LEFT JOIN email_recipients r ON e.recipient = 'staff:' || r.id
           LEFT JOIN bookings b ON b.id = e.booking_id
          WHERE (?1 IS NULL OR e.status = ?1) AND (?2 IS NULL OR e.notification_type = ?2) AND (?3 IS NULL OR b.booking_code = ?3)
            AND (?4 IS NULL OR e.created_at < ?4)
          ORDER BY e.created_at DESC, e.id DESC LIMIT ?5`,
      )
      .bind(f.status, f.type, f.code, f.before, f.limit)
      .all<EmailLogListRow>();
    return results;
  }

  /** The guest's address and language, read at send time (never copied into the log). */
  guestContact(bookingId: string): Promise<{ customer_email: string | null; language_code: string } | null> {
    return this.db.prepare("SELECT customer_email, language_code FROM bookings WHERE id = ?1").bind(bookingId).first();
  }
}
