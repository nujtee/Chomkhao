import type { D1DatabaseLike } from "../env.ts";

export interface HealthRepository {
  pingDatabase(): Promise<boolean>;
  /** Name of the newest migration D1 recorded, null when none, undefined when it cannot be read (local / tests). */
  latestMigration(): Promise<string | null | undefined>;
  /** Whether a table exists, optionally with a piece of text in its definition (fallback schema probe). */
  hasTable(name: string, contains?: string): Promise<boolean | undefined>;
  /** When the cron last finished, or null (never / table missing). */
  cronLastRun(): Promise<string | null>;
}

export class D1HealthRepository implements HealthRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async pingDatabase(): Promise<boolean> {
    try {
      const row = await this.db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  async latestMigration(): Promise<string | null | undefined> {
    try {
      // `d1_migrations` is maintained by `wrangler d1 migrations apply`.
      const row = await this.db.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>();
      return row?.name ?? null;
    } catch {
      return undefined;
    }
  }

  async hasTable(name: string, contains?: string): Promise<boolean | undefined> {
    try {
      const row = await this.db
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'trigger') AND name = ?1 AND (?2 IS NULL OR instr(sql, ?2) > 0)")
        .bind(name, contains ?? null)
        .first<{ ok: number }>();
      return row?.ok === 1;
    } catch {
      return undefined;
    }
  }

  async cronLastRun(): Promise<string | null> {
    try {
      const row = await this.db.prepare("SELECT last_run_at FROM system_heartbeats WHERE name = 'cron'").first<{ last_run_at: string }>();
      return row?.last_run_at ?? null;
    } catch {
      return null;
    }
  }
}
