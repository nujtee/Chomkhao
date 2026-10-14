import type { HealthDto } from "../../shared/system-types.ts";
import type { HealthRepository } from "../repositories/health.repository.ts";

/**
 * The newest migration this code expects (Phase 16). A test keeps it equal to the last file in
 * migrations/, so a deploy whose migrations were not applied shows up as `schema: "outdated"`.
 */
export const LATEST_MIGRATION = "0026_multi_stay.sql";
/**
 * Schema probe where D1's migration list cannot be read: what the newest migrations created or changed
 * (0020 error_events, 0021 booking_tarps, 0022 the rewritten bookings CHECK, 0023 payment settings and
 * the e-mail outbox, 0024 the admin menu, 0025 the booking deposit, 0026 several stays per booking). All must be there.
 */
const LATEST_PROBES: { table: string; contains?: string }[] = [
  { table: "error_events" },
  { table: "booking_tarps" },
  { table: "bookings", contains: "substr(booking_code, 1, 3)" },
  { table: "payment_settings" },
  { table: "email_logs" },
  { table: "admin_menu_hidden" },
  { table: "bookings", contains: "deposit_satang" },
  { table: "booking_items", contains: "pay_later_satang" },
];
/** The cron runs every minute; 5 minutes without a finished run means it stopped. */
export const CRON_STALE_MS = 5 * 60_000;

const migrationNumber = (name: string) => Number(/^(\d{4})_/.exec(name)?.[1] ?? NaN);

export class HealthService {
  constructor(
    private readonly repository: HealthRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Liveness for uptime monitors: database, schema version, cron freshness. Exposes no configuration. */
  async check(): Promise<HealthDto> {
    const dbOk = await this.repository.pingDatabase();
    let schema: HealthDto["schema"] = "unknown";
    let cron: HealthDto["cron"] = "unknown";
    if (dbOk) {
      const latest = await this.repository.latestMigration();
      if (typeof latest === "string") schema = migrationNumber(latest) >= migrationNumber(LATEST_MIGRATION) ? "ok" : "outdated";
      else if (latest === null) schema = "outdated";
      else {
        const found = await Promise.all(LATEST_PROBES.map((p) => this.repository.hasTable(p.table, p.contains)));
        schema = found.includes(undefined) ? "unknown" : found.every(Boolean) ? "ok" : "outdated";
      }
      const last = await this.repository.cronLastRun();
      if (last) cron = this.now().getTime() - new Date(last).getTime() <= CRON_STALE_MS ? "ok" : "stale";
    }
    const degraded = !dbOk || schema === "outdated" || cron === "stale";
    return { status: degraded ? "degraded" : "ok", database: dbOk ? "ok" : "unavailable", schema, cron, time: this.now().toISOString() };
  }
}
