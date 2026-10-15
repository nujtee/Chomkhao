import type { CreditPlan, CreditSettingsInput } from "../../shared/credit-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

export interface CreditSettingsRow {
  enabled: number;
  fee_per_unit: number;
  low_threshold: number;
  approval_mode: "MANUAL" | "EASYSLIP";
  standard_min: number | null;
  premium_min: number | null;
  bank_name: string | null;
  account_name: string | null;
  account_number: string | null;
  promptpay_number: string | null;
  qr_asset_id: string | null;
  qr_key: string | null;
  notify_email: string | null;
  alert_time_1: string;
  alert_time_2: string;
  updated_at: string;
}

export interface CreditAccountRow {
  balance: number;
  held: number;
  plan: CreditPlan;
  updated_at: string;
}

export interface TopupRow {
  id: string;
  requested_by: string;
  requested_by_name: string;
  plan: CreditPlan;
  amount_requested: number;
  amount_credited: number | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  slip_asset_id: string;
  slip_key: string | null;
  slip_mime: string | null;
  transaction_ref: string | null;
  verify_result: "PASSED" | "FAILED" | "NOT_A_SLIP" | "ERROR" | null;
  verify_reasons: string | null;
  verified_amount: number | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decided_via: "STAFF" | "EASYSLIP" | null;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface LedgerRow {
  id: string;
  entry_type: "TOPUP" | "ADJUST_ADD" | "ADJUST_SUB" | "FEE_CAPTURE" | "PLAN_CHANGE";
  amount: number;
  balance_after: number;
  plan: CreditPlan | null;
  booking_code: string | null;
  units: number | null;
  note: string | null;
  actor_name: string | null;
  created_at: string;
}

export interface CreditUserRow {
  id: string;
  display_name: string;
  email: string;
  preferred_language: string | null;
  roles: string | null;
  line_user_id: string | null;
}

/** Back-office users who get the low / empty notices: every ACTIVE user but SUPER_ADMIN. */
const STAFF_USERS = `u.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'role_super_admin')`;
const SUPER_ADMINS = `u.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'role_super_admin')`;
const EMAIL_ON = "EXISTS (SELECT 1 FROM email_settings s WHERE s.id = 1 AND s.enabled = 1)";
const LINE_ON = "EXISTS (SELECT 1 FROM line_settings s WHERE s.id = 1 AND s.enabled = 1)";

const TOPUP_SELECT = `SELECT t.*, ru.display_name AS requested_by_name, du.display_name AS decided_by_name,
       m.object_key AS slip_key, m.mime_type AS slip_mime
  FROM credit_topups t
  JOIN users ru ON ru.id = t.requested_by
  LEFT JOIN users du ON du.id = t.decided_by
  LEFT JOIN media_assets m ON m.id = t.slip_asset_id`;

/** App-usage credits (migration 0027). Holds / captures / releases happen in triggers on `bookings`. */
export class CreditRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  // ------------------------------------------------------------------ settings + balance

  settings(): Promise<CreditSettingsRow | null> {
    return this.db
      .prepare(
        `SELECT s.*, m.object_key AS qr_key FROM credit_settings s
           LEFT JOIN media_assets m ON m.id = s.qr_asset_id AND m.status = 'ACTIVE'
          WHERE s.id = 1`,
      )
      .first<CreditSettingsRow>();
  }

  account(): Promise<CreditAccountRow | null> {
    return this.db.prepare("SELECT balance, held, plan, updated_at FROM credit_account WHERE id = 1").first<CreditAccountRow>();
  }

  saveSettingsStatement(s: CreditSettingsInput, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE credit_settings SET enabled = ?1, fee_per_unit = ?2, low_threshold = ?3, approval_mode = ?4, standard_min = ?5,
           premium_min = ?6, bank_name = ?7, account_name = ?8, account_number = ?9, promptpay_number = ?10, qr_asset_id = ?11,
           notify_email = ?12, alert_time_1 = ?13, alert_time_2 = ?14, updated_by = ?15, updated_at = ?16
          WHERE id = 1`,
      )
      .bind(s.enabled ? 1 : 0, s.feePerUnit, s.lowThreshold, s.approvalMode, s.standardMin, s.premiumMin, s.bankName, s.accountName,
        s.accountNumber, s.promptpayNumber, s.qrAssetId, s.notifyEmail, s.alertTime1, s.alertTime2, actorId, now);
  }

  // ------------------------------------------------------------------ top-ups

  insertSlipAssetStatement(a: { id: string; key: string; mime: string; size: number; width: number; height: number; sha256: string; userId: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, width, height, sha256, uploaded_by, created_at)
         VALUES (?1, 'PRIVATE', ?2, 'PAYMENT_SLIP', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(a.id, a.key, a.mime, a.size, a.width, a.height, a.sha256, a.userId, a.now);
  }

  insertTopupStatement(t: { id: string; userId: string; plan: CreditPlan; amount: number; assetId: string; sha256: string; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `INSERT INTO credit_topups (id, requested_by, plan, amount_requested, slip_asset_id, slip_sha256, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
      )
      .bind(t.id, t.userId, t.plan, t.amount, t.assetId, t.sha256, t.now);
  }

  topup(id: string): Promise<TopupRow | null> {
    return this.db.prepare(`${TOPUP_SELECT} WHERE t.id = ?1`).bind(id).first<TopupRow>();
  }

  async topups(f: { status: string | null; userId: string | null; before: string | null; limit: number }): Promise<TopupRow[]> {
    const { results } = await this.db
      .prepare(
        `${TOPUP_SELECT}
          WHERE (?1 IS NULL OR t.status = ?1) AND (?2 IS NULL OR t.requested_by = ?2) AND (?3 IS NULL OR t.created_at < ?3)
          ORDER BY t.created_at DESC LIMIT ?4`,
      )
      .bind(f.status, f.userId, f.before, f.limit)
      .all<TopupRow>();
    return results;
  }

  async pendingCount(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM credit_topups WHERE status = 'PENDING'").first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Same image already sent (top-up not rejected) or used to pay a booking. */
  async slipInUse(sha256: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM credit_topups WHERE slip_sha256 = ?1 AND status <> 'REJECTED')
            OR EXISTS (SELECT 1 FROM payments WHERE slip_sha256 = ?1 AND status IN ('PENDING_VERIFICATION', 'VERIFIED', 'PAID'))`,
      )
      .bind(sha256)
      .first();
    return row !== null;
  }

  /** One bank transfer pays once: a top-up (not rejected) or an accepted booking payment. */
  async transactionRefUsed(ref: string, exceptTopupId: string | null = null): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM credit_topups WHERE transaction_ref = ?1 AND status <> 'REJECTED' AND (?2 IS NULL OR id <> ?2))
            OR EXISTS (SELECT 1 FROM slip_verifications WHERE transaction_ref = ?1 AND result = 'PASSED')`,
      )
      .bind(ref, exceptTopupId)
      .first();
    return row !== null;
  }

  /** Result of the automatic check (the top-up stays PENDING). */
  recordVerificationStatement(id: string, v: { result: string; reasons: string[]; amount: number | null; ref: string | null; now: string }): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE credit_topups SET verify_result = ?2, verify_reasons = ?3, verified_amount = ?4, transaction_ref = ?5, updated_at = ?6
          WHERE id = ?1 AND status = 'PENDING'`,
      )
      .bind(id, v.result, JSON.stringify(v.reasons), v.amount, v.ref, v.now);
  }

  /**
   * Approve, one batch: the top-up (only while PENDING), the balance + plan, and the ledger row — the last two only
   * if THIS batch decided it (marker decided_at = now).
   */
  approveStatements(a: { id: string; amount: number; plan: CreditPlan; via: "STAFF" | "EASYSLIP"; actorId: string | null; now: string }): D1PreparedStatementLike[] {
    const decidedHere = "EXISTS (SELECT 1 FROM credit_topups t WHERE t.id = ?1 AND t.status = 'APPROVED' AND t.decided_at = ?2)";
    return [
      this.db
        .prepare(
          `UPDATE credit_topups SET status = 'APPROVED', amount_credited = ?3, plan = ?4, decided_by = ?5, decided_via = ?6,
             decided_at = ?2, updated_at = ?2
            WHERE id = ?1 AND status = 'PENDING' RETURNING id`,
        )
        .bind(a.id, a.now, a.amount, a.plan, a.actorId, a.via),
      this.db
        .prepare(`UPDATE credit_account SET balance = balance + ?3, plan = ?4, updated_at = ?2 WHERE id = 1 AND ${decidedHere}`)
        .bind(a.id, a.now, a.amount, a.plan),
      this.db
        .prepare(
          `INSERT INTO credit_ledger (id, entry_type, amount, balance_after, plan, topup_id, actor_id, created_at)
           SELECT lower(hex(randomblob(16))), 'TOPUP', ?3, (SELECT balance FROM credit_account WHERE id = 1), ?4, ?1, ?5, ?2
            WHERE ${decidedHere}`,
        )
        .bind(a.id, a.now, a.amount, a.plan, a.actorId),
    ];
  }

  rejectStatement(id: string, reason: string, actorId: string, now: string): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE credit_topups SET status = 'REJECTED', reject_reason = ?2, decided_by = ?3, decided_via = 'STAFF', decided_at = ?4, updated_at = ?4
          WHERE id = ?1 AND status = 'PENDING' RETURNING id`,
      )
      .bind(id, reason, actorId, now);
  }

  // ------------------------------------------------------------------ manual changes (Super Admin)

  /**
   * Add (amount > 0) or take away (amount < 0) credits. A deduction never touches credits held by unpaid bookings
   * (balance − held must stay ≥ 0, CHECK held ≤ balance). The ledger row is written only if the balance changed here.
   */
  adjustStatements(a: { amount: number; note: string; actorId: string; now: string }): D1PreparedStatementLike[] {
    const changedHere = "EXISTS (SELECT 1 FROM credit_account WHERE id = 1 AND updated_at = ?2)";
    return [
      this.db
        .prepare("UPDATE credit_account SET balance = balance + ?1, updated_at = ?2 WHERE id = 1 AND balance + ?1 >= held RETURNING balance")
        .bind(a.amount, a.now),
      this.db
        .prepare(
          `INSERT INTO credit_ledger (id, entry_type, amount, balance_after, note, actor_id, created_at)
           SELECT lower(hex(randomblob(16))), ?3, ?1, (SELECT balance FROM credit_account WHERE id = 1), ?4, ?5, ?2 WHERE ${changedHere}`,
        )
        .bind(a.amount, a.now, a.amount > 0 ? "ADJUST_ADD" : "ADJUST_SUB", a.note, a.actorId),
    ];
  }

  planStatements(p: { plan: CreditPlan; note: string; actorId: string; now: string }): D1PreparedStatementLike[] {
    return [
      this.db.prepare("UPDATE credit_account SET plan = ?1, updated_at = ?2 WHERE id = 1 AND plan <> ?1 RETURNING plan").bind(p.plan, p.now),
      this.db
        .prepare(
          `INSERT INTO credit_ledger (id, entry_type, amount, balance_after, plan, note, actor_id, created_at)
           SELECT lower(hex(randomblob(16))), 'PLAN_CHANGE', 0, balance, ?1, ?3, ?4, ?2 FROM credit_account
            WHERE id = 1 AND plan = ?1 AND updated_at = ?2`,
        )
        .bind(p.plan, p.now, p.note, p.actorId),
    ];
  }

  async ledger(f: { before: string | null; limit: number }): Promise<LedgerRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT l.id, l.entry_type, l.amount, l.balance_after, l.plan, b.booking_code, l.units, l.note, u.display_name AS actor_name, l.created_at
           FROM credit_ledger l
           LEFT JOIN bookings b ON b.id = l.booking_id
           LEFT JOIN users u ON u.id = l.actor_id
          WHERE (?1 IS NULL OR l.created_at < ?1)
          ORDER BY l.created_at DESC, l.id DESC LIMIT ?2`,
      )
      .bind(f.before, f.limit)
      .all<LedgerRow>();
    return results;
  }

  /** Sum of the ledger = the balance (System status checks it). */
  async ledgerSum(): Promise<number> {
    const row = await this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM credit_ledger").first<{ s: number }>();
    return row?.s ?? 0;
  }

  // ------------------------------------------------------------------ people

  async staffUsers(): Promise<CreditUserRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT u.id, u.display_name, u.email, u.preferred_language,
                (SELECT group_concat(r.code, ',') FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles,
                l.line_user_id
           FROM users u LEFT JOIN user_line_links l ON l.user_id = u.id
          WHERE ${STAFF_USERS}
          ORDER BY u.display_name`,
      )
      .all<CreditUserRow>();
    return results;
  }

  userContact(userId: string): Promise<CreditUserRow | null> {
    return this.db
      .prepare(
        `SELECT u.id, u.display_name, u.email, u.preferred_language, NULL AS roles, l.line_user_id
           FROM users u LEFT JOIN user_line_links l ON l.user_id = u.id
          WHERE u.id = ?1 AND u.status = 'ACTIVE'`,
      )
      .bind(userId)
      .first<CreditUserRow>();
  }

  myLine(userId: string): Promise<{ line_user_id: string; linked_at: string } | null> {
    return this.db.prepare("SELECT line_user_id, linked_at FROM user_line_links WHERE user_id = ?1").bind(userId).first();
  }

  unlinkMyLineStatement(userId: string): D1PreparedStatementLike {
    return this.db.prepare("DELETE FROM user_line_links WHERE user_id = ?1").bind(userId);
  }

  // ------------------------------------------------------------------ notices (outbox rows, INSERT OR IGNORE = once per key)

  /**
   * Low / empty notice for every back-office user: an e-mail (account address) and, when they linked it, a LINE
   * message. `key` ends with ":user:"; the user id is appended.
   */
  staffNoticeStatements(type: "CREDIT_LOW" | "CREDIT_EMPTY", key: string, payload: unknown, now: string): D1PreparedStatementLike[] {
    const json = JSON.stringify(payload);
    return [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO email_logs (id, notification_type, idempotency_key, language_code, recipient, payload_json, scheduled_for, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), ?1, ?2 || u.id, COALESCE(u.preferred_language, 'th'), 'user:' || u.id, ?3, ?4, ?4, ?4
             FROM users u WHERE ${STAFF_USERS} AND ${EMAIL_ON}`,
        )
        .bind(type, key, json, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_logs (id, channel, notification_type, idempotency_key, language_code, recipient, payload_json, scheduled_for, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), 'LINE', ?1, ?2 || u.id, COALESCE(u.preferred_language, 'th'), 'user:' || u.id, ?3, ?4, ?4, ?4
             FROM users u JOIN user_line_links l ON l.user_id = u.id WHERE ${STAFF_USERS} AND ${LINE_ON}`,
        )
        .bind(type, key, json, now),
    ];
  }

  /** A top-up waits for Super Admin: e-mail to credit_settings.notify_email, LINE to every SUPER_ADMIN who linked it. */
  topupRequestStatements(topupId: string, now: string): D1PreparedStatementLike[] {
    const json = JSON.stringify({ topupId });
    const pending = "EXISTS (SELECT 1 FROM credit_topups t WHERE t.id = ?1 AND t.status = 'PENDING')";
    return [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO email_logs (id, notification_type, idempotency_key, language_code, recipient, payload_json, scheduled_for, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), 'CREDIT_TOPUP_REQUEST', 'CREDIT_TOPUP_REQUEST:' || ?1 || ':credit-admin', 'th', 'credit-admin', ?2, ?3, ?3, ?3
            WHERE EXISTS (SELECT 1 FROM credit_settings WHERE id = 1 AND notify_email IS NOT NULL) AND ${EMAIL_ON} AND ${pending}`,
        )
        .bind(topupId, json, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_logs (id, channel, notification_type, idempotency_key, language_code, recipient, payload_json, scheduled_for, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), 'LINE', 'CREDIT_TOPUP_REQUEST', 'CREDIT_TOPUP_REQUEST:' || ?1 || ':user:' || u.id,
                  COALESCE(u.preferred_language, 'th'), 'user:' || u.id, ?2, ?3, ?3, ?3
             FROM users u JOIN user_line_links l ON l.user_id = u.id WHERE ${SUPER_ADMINS} AND ${LINE_ON} AND ${pending}`,
        )
        .bind(topupId, json, now),
    ];
  }

  /** The user who asked hears the decision (e-mail + own LINE). */
  topupResultStatements(topupId: string, userId: string, now: string): D1PreparedStatementLike[] {
    const json = JSON.stringify({ topupId });
    const decided = "EXISTS (SELECT 1 FROM credit_topups t WHERE t.id = ?1 AND t.status <> 'PENDING' AND t.decided_at = ?4)";
    return [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO email_logs (id, notification_type, idempotency_key, language_code, recipient, payload_json, scheduled_for, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), 'CREDIT_TOPUP_RESULT', 'CREDIT_TOPUP_RESULT:' || ?1 || ':user:' || u.id,
                  COALESCE(u.preferred_language, 'th'), 'user:' || u.id, ?3, ?4, ?4, ?4
             FROM users u WHERE u.id = ?2 AND u.status = 'ACTIVE' AND ${EMAIL_ON} AND ${decided}`,
        )
        .bind(topupId, userId, json, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_logs (id, channel, notification_type, idempotency_key, language_code, recipient, payload_json, scheduled_for, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), 'LINE', 'CREDIT_TOPUP_RESULT', 'CREDIT_TOPUP_RESULT:' || ?1 || ':user:' || u.id,
                  COALESCE(u.preferred_language, 'th'), 'user:' || u.id, ?3, ?4, ?4, ?4
             FROM users u JOIN user_line_links l ON l.user_id = u.id WHERE u.id = ?2 AND u.status = 'ACTIVE' AND ${LINE_ON} AND ${decided}`,
        )
        .bind(topupId, userId, json, now),
    ];
  }
}
