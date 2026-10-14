import type { MarketingEventDto } from "../../shared/settings-types.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";
import { ConflictError } from "../http/errors.ts";
import type { FetchLike } from "../line/line-api.ts";
import { DEFAULT_GRAPH_VERSION, sendCapiEvent, sha256Hex, type CapiEvent } from "../marketing/meta-capi.ts";
import type { MarketingEventRow, MarketingRepository } from "../repositories/marketing.repository.ts";
import { newId } from "../security/tokens.ts";
import { iso, type AuthContext, type Clock, type RequestMeta } from "./auth-context.ts";
import type { AuthorizationService } from "./authorization.service.ts";
import type { SecurityLogService } from "./security-log.service.ts";

const LEASE_MS = 2 * 60_000;
const BACKOFF_MIN = [1, 5, 15, 60];
const MAX_ATTEMPTS = 5;
/** Meta rejects website events older than 7 days. */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const ATTRIBUTION_DAYS = 8;
const LOG_DAYS = 90;

export interface CapiSettings {
  enabled: boolean;
  pixelId: string | null;
}

/** The outbox interface the payment / slip / booking services write to (LINE + marketing combined). */
/**
 * Transactional outbox hooks: each returns statements that go into the SAME D1 batch as the change,
 * guarded so they only insert when that change happened. Optional hooks may be left out by a part.
 */
export interface OutboxLike {
  bookingConfirmed(bookingId: string, now: string): Promise<D1PreparedStatementLike[]>;
  slipSubmitted(paymentId: string, bookingId: string, now: string): Promise<D1PreparedStatementLike[]>;
  bookingCancelled(bookingId: string, wasConfirmed: boolean, now: string): Promise<D1PreparedStatementLike[]>;
  /** A guest made a booking (inside the booking batch). */
  bookingCreated?(bookingId: string, now: string): Promise<D1PreparedStatementLike[]>;
  /** Staff turned a slip down (the guest may pay again). */
  paymentRejected?(paymentId: string, bookingId: string, now: string): Promise<D1PreparedStatementLike[]>;
  /** Deposit plan: the rest came in (guest's transfer verified, or taken at reception) — payment marked in this batch. */
  balancePaid?(paymentId: string, bookingId: string, now: string): Promise<D1PreparedStatementLike[]>;
}

export class CompositeOutbox implements OutboxLike {
  constructor(private readonly parts: OutboxLike[]) {}
  async bookingConfirmed(bookingId: string, now: string) {
    return (await Promise.all(this.parts.map((p) => p.bookingConfirmed(bookingId, now)))).flat();
  }
  async slipSubmitted(paymentId: string, bookingId: string, now: string) {
    return (await Promise.all(this.parts.map((p) => p.slipSubmitted(paymentId, bookingId, now)))).flat();
  }
  async bookingCancelled(bookingId: string, wasConfirmed: boolean, now: string) {
    return (await Promise.all(this.parts.map((p) => p.bookingCancelled(bookingId, wasConfirmed, now)))).flat();
  }
  async bookingCreated(bookingId: string, now: string) {
    return (await Promise.all(this.parts.map((p) => p.bookingCreated?.(bookingId, now) ?? Promise.resolve([])))).flat();
  }
  async paymentRejected(paymentId: string, bookingId: string, now: string) {
    return (await Promise.all(this.parts.map((p) => p.paymentRejected?.(paymentId, bookingId, now) ?? Promise.resolve([])))).flat();
  }
  async balancePaid(paymentId: string, bookingId: string, now: string) {
    return (await Promise.all(this.parts.map((p) => p.balancePaid?.(paymentId, bookingId, now) ?? Promise.resolve([])))).flat();
  }
}

/**
 * Outbox hooks for marketing (Phase 14): a Purchase event is queued in the same batch that confirms
 * a booking (payment recorded / slip verified). Same shape as the LINE outbox so both are combined.
 */
export class MarketingOutbox implements OutboxLike {
  constructor(private readonly repo: MarketingRepository) {}

  async bookingConfirmed(bookingId: string, now: string): Promise<D1PreparedStatementLike[]> {
    return [this.repo.purchaseStatement(bookingId, now)];
  }

  async slipSubmitted(): Promise<D1PreparedStatementLike[]> {
    return [];
  }

  async bookingCancelled(): Promise<D1PreparedStatementLike[]> {
    return [];
  }
}

const toDto = (r: MarketingEventRow & { booking_code?: string | null }): MarketingEventDto => ({
  id: r.id, eventName: r.event_name, eventId: r.event_id, bookingCode: r.booking_code ?? null, isTest: r.is_test === 1, status: r.status,
  attempts: r.attempts, lastError: r.last_error, skipReason: r.skip_reason, eventTime: r.event_time, createdAt: r.created_at, sentAt: r.sent_at,
});

/**
 * Meta Conversions API delivery (spec §45): server-side copies of Lead and Purchase with the same
 * event_id as the browser Pixel, only for guests who gave Marketing consent. Retries with backoff;
 * browser ids are erased after 8 days, the delivery log after 90.
 */
export class MetaCapiService {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly repo: MarketingRepository,
    private readonly settings: () => Promise<CapiSettings>,
    private readonly authz: AuthorizationService,
    private readonly log: SecurityLogService,
    private readonly clock: Clock,
    private readonly config: { token: string | null; testEventCode: string | null; version?: string; fetch?: FetchLike; siteUrl: string },
  ) {}

  private async event(row: MarketingEventRow): Promise<CapiEvent | { skip: string }> {
    const time = Math.floor(new Date(row.event_time).getTime() / 1000);
    if (!row.booking_id) {
      // Test event: no guest behind it, only enough for Events Manager to accept it.
      return {
        event_name: row.event_name, event_time: time, event_id: row.event_id, action_source: "website", event_source_url: `${this.config.siteUrl}/`,
        user_data: { client_user_agent: "Chomkhao Conversions API test", external_id: [await sha256Hex(row.event_id)] },
      };
    }
    const c = await this.repo.context(row.booking_id);
    if (!c) return { skip: "BOOKING_NOT_FOUND" };
    if (c.marketing_consent !== 1) return { skip: "NO_CONSENT" };
    const contentId = c.item_type === "OWN_TENT" ? "camping" : c.slug ?? c.item_type ?? "stay";
    const user: CapiEvent["user_data"] = { external_id: [await sha256Hex(row.booking_id)] };
    if (c.user_agent) user.client_user_agent = c.user_agent;
    if (c.ip_address) user.client_ip_address = c.ip_address;
    if (c.fbp) user.fbp = c.fbp;
    if (c.fbc) user.fbc = c.fbc;
    return {
      event_name: row.event_name,
      event_time: time,
      event_id: row.event_id,
      action_source: "website",
      event_source_url: c.source_url ?? `${this.config.siteUrl}/`,
      user_data: user,
      custom_data: {
        currency: "THB",
        value: Math.round(c.total_satang) / 100,
        content_type: "product",
        content_ids: [contentId],
        contents: [{ id: contentId, quantity: c.quantity ?? 1 }],
        num_items: 1 + (c.food_items > 0 ? 1 : 0),
        ...(row.event_name === "Purchase" ? { order_id: c.booking_code } : {}),
      },
    };
  }

  private async deliver(row: MarketingEventRow, s: CapiSettings): Promise<"sent" | "retry" | "failed" | "skipped"> {
    const now = this.clock();
    if (!s.enabled && row.is_test !== 1) { await this.repo.markSkipped(row.id, "CAPI_DISABLED"); return "skipped"; }
    if (!this.config.token) { await this.repo.markSkipped(row.id, "TOKEN_MISSING"); return "skipped"; }
    if (!s.pixelId) { await this.repo.markSkipped(row.id, "PIXEL_MISSING"); return "skipped"; }
    if (now.getTime() - new Date(row.event_time).getTime() > MAX_AGE_MS) { await this.repo.markSkipped(row.id, "EXPIRED"); return "skipped"; }
    const built = await this.event(row);
    if ("skip" in built) { await this.repo.markSkipped(row.id, built.skip); return "skipped"; }
    const result = await sendCapiEvent({
      token: this.config.token, pixelId: s.pixelId, version: this.config.version || DEFAULT_GRAPH_VERSION,
      // While META_TEST_EVENT_CODE is set every event goes to Events Manager → Test events.
      testEventCode: this.config.testEventCode, fetch: this.config.fetch,
    }, built);
    if (result.ok) { await this.repo.markSent(row.id, iso(this.clock())); return "sent"; }
    if (result.retry && row.attempts < MAX_ATTEMPTS) {
      const wait = BACKOFF_MIN[Math.min(row.attempts - 1, BACKOFF_MIN.length - 1)]! * 60_000;
      await this.repo.markRetry(row.id, iso(new Date(now.getTime() + wait)), result.error);
      return "retry";
    }
    await this.repo.markFailed(row.id, result.error);
    return "failed";
  }

  /** Cron: deliver due events (and hourly retention). */
  async tick(limit = 20): Promise<{ sent: number; retried: number; failed: number; skipped: number }> {
    const now = this.clock();
    const summary = { sent: 0, retried: 0, failed: 0, skipped: 0 };
    const rows = await this.repo.claimDue(iso(now), iso(new Date(now.getTime() + LEASE_MS)), limit);
    if (rows.length) {
      const s = await this.settings();
      for (const row of rows) {
        const r = await this.deliver(row, s);
        if (r === "sent") summary.sent++;
        else if (r === "retry") summary.retried++;
        else if (r === "failed") summary.failed++;
        else summary.skipped++;
      }
    }
    if (now.getUTCMinutes() === 7) await this.retention();
    return summary;
  }

  async retention(): Promise<void> {
    const now = this.clock();
    await this.db.batch(this.repo.retentionStatements(
      iso(new Date(now.getTime() - ATTRIBUTION_DAYS * 86_400_000)), iso(new Date(now.getTime() - LOG_DAYS * 86_400_000)), iso(now),
    ));
  }

  async events(actor: AuthContext, meta: RequestMeta): Promise<MarketingEventDto[]> {
    await this.authz.requirePermission(actor, "marketing.view", meta);
    return (await this.repo.list(50)).map(toDto);
  }

  /**
   * "Send test event": a PageView to Events Manager → Test events (needs META_TEST_EVENT_CODE, so it
   * never counts as real traffic). Sent at once; the result is in the log.
   */
  async sendTest(actor: AuthContext, meta: RequestMeta): Promise<MarketingEventDto> {
    await this.authz.requirePermission(actor, "marketing.edit", meta);
    if (!this.config.token) throw new ConflictError("META_CAPI_ACCESS_TOKEN is not set", "CAPI_TOKEN_MISSING");
    if (!this.config.testEventCode) throw new ConflictError("META_TEST_EVENT_CODE is not set", "CAPI_TEST_CODE_MISSING");
    const s = await this.settings();
    if (!s.pixelId) throw new ConflictError("No Pixel ID", "PIXEL_ID_MISSING");
    const id = newId();
    const now = iso(this.clock());
    await this.db.batch([
      this.repo.insertTestStatement(id, `test-${id}`, now),
      this.log.auditStatement(actor.userId, "SEND_CAPI_TEST", "marketing", id, null, { eventName: "PageView" }, meta),
    ]);
    const row = (await this.repo.byId(id))!;
    await this.db.prepare("UPDATE marketing_events SET attempts = 1 WHERE id = ?1").bind(id).run();
    await this.deliver({ ...row, attempts: 1 }, { ...s, enabled: true });
    return toDto((await this.repo.byId(id))!);
  }
}
