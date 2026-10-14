import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEV_SEED_FILE, MIGRATIONS_DIR, SqliteD1, migrationFiles } from "../helpers/sqlite-d1.ts";
import { containsPattern, D1_PATTERN_MAX_BYTES } from "../../src/worker/repositories/sql-like.ts";

const db = SqliteD1.migrated();

function tables(): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((r) => r.name);
}

/** Columns that appear in any index (or PK/UNIQUE autoindex) of a table. */
function indexedColumns(table: string): Set<string> {
  const cols = new Set<string>();
  for (const idx of db.all<{ name: string }>(`PRAGMA index_list(${JSON.stringify(table)})`)) {
    for (const c of db.all<{ name: string }>(`PRAGMA index_info(${JSON.stringify(idx.name)})`)) cols.add(c.name);
  }
  for (const c of db.all<{ name: string; pk: number }>(`PRAGMA table_info(${JSON.stringify(table)})`)) {
    if (c.pk > 0) cols.add(c.name);
  }
  return cols;
}

describe("Cloudflare D1 limits", () => {
  it("every LIKE / GLOB pattern in the schema fits D1's 50-byte limit (else: 'pattern too complex' on D1 only)", () => {
    const tooLong: string[] = [];
    for (const r of db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL")) {
      for (const m of r.sql.matchAll(/(?:GLOB|LIKE)\s+'((?:[^']|'')*)'/gi)) {
        if (Buffer.byteLength(m[1]!) > D1_PATTERN_MAX_BYTES) tooLong.push(`${r.name}: ${m[1]}`);
      }
      // Patterns built in SQL (|| concatenation) cannot be measured here: keep them out of the schema.
      assert.doesNotMatch(r.sql, /(?:GLOB|LIKE)\s+'[^']*'\s*\|\|/i, r.name);
    }
    assert.deepEqual(tooLong, []);
  });

  it("booking codes and colours are still checked by the database", () => {
    const ins = (code: string) => () => db.run(`INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults,
      customer_name, customer_phone, customer_phone_normalized, accommodation_subtotal_satang, subtotal_satang, total_satang)
      VALUES ('${code}', '${code}', 'th', '2027-02-01', '2027-02-02', 1, 2, 'X', '0812345678', '0812345678', 1, 1, 1)`);
    db.exec("SAVEPOINT d1_limits");
    try {
      assert.doesNotThrow(ins("BK-20270201-A7K2"));
      for (const bad of ["BK-2027020-A7K2X", "BK-20270201-a7k2", "XX-20270201-A7K2", "BK-20270201_A7K2", "BK-2027020A-A7K2", "BK-20270201-A7K"]) {
        assert.throws(ins(bad), /CHECK constraint failed/, bad);
      }
      assert.doesNotThrow(() => db.run("INSERT INTO booking_cta_settings (id, color) VALUES (1, '#1a2B3c')"));
      assert.throws(() => db.run("UPDATE booking_cta_settings SET color = '#12345G' WHERE id = 1"), /CHECK constraint failed/);
      assert.throws(() => db.run("UPDATE booking_cta_settings SET color = '123456' WHERE id = 1"), /CHECK constraint failed/);
    } finally {
      db.exec("ROLLBACK TO d1_limits");
      db.exec("RELEASE d1_limits");
    }
  });

  it("search terms become LIKE patterns within the limit (whole characters, escaped)", () => {
    const thai = "สมชายใจดีมีสุขรักษ์ไทยเที่ยวป่า"; // 31 characters, 3 bytes each
    const p = containsPattern(thai);
    assert.ok(Buffer.byteLength(p) <= D1_PATTERN_MAX_BYTES, `${Buffer.byteLength(p)} bytes`);
    assert.ok(thai.startsWith(p.slice(1, -1)), "a prefix of the term, never a broken character");
    assert.equal(containsPattern("50%_off\\"), "%50\\%\\_off\\\\%");
    assert.equal(Buffer.byteLength(containsPattern("x".repeat(200))), 50);
  });
});

describe("migrations", () => {
  it("are numbered sequentially with no gaps", () => {
    const numbers = migrationFiles().map((f) => Number(f.slice(0, 4)));
    assert.deepEqual(
      numbers,
      numbers.map((_, i) => i + 1),
    );
  });

  /**
   * Announced table rebuilds (spec §53: announcement + backup + rollback plan in the file). A rebuild
   * may only DROP a table it re-creates from `<table>__new` with every row copied, and must re-create
   * every trigger it drops.
   */
  const ANNOUNCED_REBUILDS = ["0022_d1_glob_limits.sql", "0026_multi_stay.sql"];

  it("announced rebuilds only replace tables (copy every row, rename back) and restore dropped triggers", () => {
    for (const file of ANNOUNCED_REBUILDS) {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      assert.match(raw, /DESTRUCTIVE/);
      assert.match(raw, /Backup \/ rollback/);
      const sql = raw.replace(/--.*$/gm, "");
      assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|\bDROP\s+(INDEX|VIEW)\b|\bALTER\s+TABLE\s+\w+\s+DROP\b/i, file);
      for (const [, table] of sql.matchAll(/\bDROP\s+TABLE\s+(\w+)/gi)) {
        assert.match(sql, new RegExp(`INSERT INTO ${table}__new \\(([^)]+)\\) SELECT \\1 FROM ${table};`), `${table}: all rows copied`);
        assert.match(sql, new RegExp(`ALTER TABLE ${table}__new RENAME TO ${table};`), `${table}: renamed back`);
      }
      for (const [, trigger] of sql.matchAll(/\bDROP\s+TRIGGER\s+(\w+)/gi)) {
        assert.match(sql, new RegExp(`CREATE TRIGGER ${trigger}\\b`), `${trigger}: re-created`);
      }
    }
  });

  it("contain no destructive statements (other than announced rebuilds)", () => {
    for (const file of migrationFiles().filter((f) => !ANNOUNCED_REBUILDS.includes(f))) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(/--.*$/gm, "");
      assert.doesNotMatch(sql, /\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER)\b/i, file);
      assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+\w+\s+DROP\b/i, file);
      assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i, file);
    }
  });

  it("dev seed only inserts data (no schema changes) and is labelled dev-only", () => {
    const seed = readFileSync(DEV_SEED_FILE, "utf8");
    assert.match(seed, /DEVELOPMENT SEED DATA ONLY/);
    const code = seed.replace(/--.*$/gm, "");
    assert.doesNotMatch(code, /\b(CREATE|DROP|ALTER|DELETE|UPDATE)\b/i);
    assert.doesNotMatch(code, /INSERT\s+INTO\s+users\b/i, "no seeded user accounts");
  });

  it("every table is STRICT", () => {
    const nonStrict = db
      .all<{ name: string; strict: number }>("PRAGMA table_list")
      .filter((t) => t.name !== "sqlite_schema" && !t.name.startsWith("sqlite_") && t.strict !== 1);
    assert.deepEqual(nonStrict.map((t) => t.name), []);
  });

  it("has no foreign key violations after migrations and dev seed", () => {
    const seeded = SqliteD1.migrated({ seed: true });
    assert.deepEqual(seeded.all("PRAGMA foreign_key_check"), []);
    assert.equal(Object.values(seeded.get("PRAGMA integrity_check")!)[0], "ok");
  });
});

describe("schema covers the spec (§52)", () => {
  const required = [
    // core
    "users", "roles", "permissions", "role_permissions", "user_roles", "user_permissions", "sessions",
    "password_reset_tokens", "security_events",
    "accommodation_units", "accommodation_translations", "accommodation_images", "accommodation_amenities",
    "camping_settings",
    "bookings", "booking_items", "booking_guests", "booking_price_snapshots",
    "pricing_settings", "price_history",
    "payments", "slip_verifications", "receiving_accounts", "payment_account_snapshots",
    "notification_logs", "audit_logs",
    // food
    "food_categories", "food_options", "food_option_translations", "food_images", "included_meals",
    "booking_food_items", "booking_included_meals", "food_daily_capacity", "food_orders",
    // search
    "search_index", "search_history", "search_analytics",
    // branding / theme / marketing / seo
    "branding_settings", "site_settings", "theme_settings", "theme_versions", "font_settings",
    "marketing_settings", "seo_settings", "seo_redirects",
    // content
    "home_sections", "home_section_translations", "home_slides", "home_slide_translations", "home_versions",
    "gallery_categories", "gallery_category_translations", "gallery_images", "gallery_image_translations",
    "history_sections", "history_translations", "history_timeline", "history_timeline_translations",
    // cta
    "booking_cta_settings",
  ];

  it("creates every table listed in the spec", () => {
    const existing = new Set(tables());
    const missing = required.filter((t) => !existing.has(t));
    assert.deepEqual(missing, []);
  });

  it("indexes the columns required by §53", () => {
    const expectations: Record<string, string[]> = {
      bookings: ["booking_code", "check_in", "check_out", "booking_status", "payment_status", "customer_phone_normalized"],
      booking_items: ["unit_id"],
      booking_unit_nights: ["unit_id", "stay_date"],
      search_index: ["entity_type", "entity_id", "language_code", "is_active"],
      gallery_images: ["category_id", "status", "sort_order"],
      gallery_categories: ["status", "sort_order"],
      home_slides: ["status", "start_at", "end_at", "sort_order"],
    };
    for (const [table, columns] of Object.entries(expectations)) {
      const indexed = indexedColumns(table);
      for (const column of columns) assert.ok(indexed.has(column), `${table}.${column} is not indexed`);
    }
  });

  it("stores money as INTEGER satang, never REAL", () => {
    const moneyColumns = tables().flatMap((t) =>
      db
        .all<{ name: string; type: string }>(`PRAGMA table_info(${JSON.stringify(t)})`)
        .filter((c) => /satang|price|amount|total/i.test(c.name) && !c.name.endsWith("_json"))
        .map((c) => ({ table: t, ...c })),
    );
    assert.ok(moneyColumns.length > 20);
    for (const c of moneyColumns) assert.equal(c.type, "INTEGER", `${c.table}.${c.name}`);
  });

  it("stores no plaintext secrets (only token hashes, no CAPI/LINE tokens)", () => {
    for (const t of tables()) {
      for (const c of db.all<{ name: string }>(`PRAGMA table_info(${JSON.stringify(t)})`)) {
        // tokens_json = theme design tokens (colors/fonts), not credentials.
        if (/token|secret|password/i.test(c.name) && c.name !== "tokens_json") {
          assert.ok(
            ["token_hash", "password_hash", "password_changed_at", "must_change_password"].includes(c.name),
            `${t}.${c.name} looks like a secret column`,
          );
        }
      }
    }
  });
});

describe("RBAC reference data (§29–31)", () => {
  const perms = (role: string) =>
    db
      .all<{ code: string }>(
        `SELECT p.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
           JOIN permissions p ON p.id = rp.permission_id WHERE r.code = ?`,
        role,
      )
      .map((r) => r.code);

  it("defines the six roles with names in every enabled language", () => {
    assert.deepEqual(
      db.all<{ code: string }>("SELECT code FROM roles ORDER BY sort_order").map((r) => r.code),
      ["SUPER_ADMIN", "MANAGER", "BOOKING_ADMIN", "FINANCE_ADMIN", "CONTENT_ADMIN", "VIEWER"],
    );
    const missing = db.all(
      `SELECT r.code, l.code AS lang FROM roles r CROSS JOIN languages l
        LEFT JOIN role_translations t ON t.role_id = r.id AND t.language_code = l.code
        WHERE l.is_enabled = 1 AND t.name IS NULL`,
    );
    assert.deepEqual(missing, []);
  });

  it("contains every user-management permission from §31", () => {
    const codes = new Set(db.all<{ code: string }>("SELECT code FROM permissions").map((r) => r.code));
    for (const p of [
      "users.view", "users.create", "users.edit", "users.delete", "users.manage_roles",
      "users.manage_permissions", "users.reset_password", "users.suspend", "users.force_logout", "users.restore",
    ]) {
      assert.ok(codes.has(p), p);
    }
  });

  it("SUPER_ADMIN holds every permission", () => {
    const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permissions")!.n;
    assert.equal(perms("SUPER_ADMIN").length, total);
  });

  it("only SUPER_ADMIN can manage users, roles and permissions", () => {
    for (const role of ["MANAGER", "BOOKING_ADMIN", "FINANCE_ADMIN", "CONTENT_ADMIN", "VIEWER"]) {
      const p = perms(role);
      for (const forbidden of ["users.create", "users.delete", "users.manage_roles", "users.manage_permissions"]) {
        assert.ok(!p.includes(forbidden), `${role} must not have ${forbidden}`);
      }
    }
  });

  it("VIEWER is read-only and cannot see slips", () => {
    const p = perms("VIEWER");
    assert.ok(p.every((code) => code.endsWith(".view")), p.join(","));
    assert.ok(!p.includes("slips.view"));
  });

  it("only finance-capable roles can verify payments", () => {
    const holders = db
      .all<{ code: string }>(
        `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
          WHERE rp.permission_id = 'perm_payments_verify' ORDER BY r.sort_order`,
      )
      .map((r) => r.code);
    assert.deepEqual(holders, ["SUPER_ADMIN", "MANAGER", "FINANCE_ADMIN"]);
  });

  it("ships no user accounts", () => {
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n, 0);
  });
});
