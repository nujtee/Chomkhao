import type { D1DatabaseLike, D1PreparedStatementLike } from "../env.ts";

/** admin_menu_hidden (migration 0024): one row per hidden sidebar item. */
export class AdminMenuRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async hidden(): Promise<string[]> {
    try {
      const { results } = await this.db.prepare("SELECT path FROM admin_menu_hidden ORDER BY path").all<{ path: string }>();
      return results.map((r) => r.path);
    } catch {
      return []; // before migration 0024: nothing hidden
    }
  }

  /** Replaces the whole set (same batch as the audit row). */
  replaceStatements(paths: string[], actorId: string, now: string): D1PreparedStatementLike[] {
    return [
      this.db.prepare("DELETE FROM admin_menu_hidden"),
      this.db
        .prepare("INSERT INTO admin_menu_hidden (path, hidden_by, hidden_at) SELECT value, ?2, ?3 FROM json_each(?1)")
        .bind(JSON.stringify(paths), actorId, now),
    ];
  }
}
