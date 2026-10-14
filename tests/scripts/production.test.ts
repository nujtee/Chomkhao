import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { backupFileName } from "../../scripts/backup-d1.ts";
import { parseJsonc, preflight, secretNames, type Finding, type PreflightInput } from "../../scripts/preflight.ts";
import { smoke } from "../../scripts/smoke-test.ts";
import { LATEST_MIGRATION } from "../../src/worker/services/health.service.ts";
import { Harness, ORIGIN } from "../helpers/harness.ts";

/** Phase 16 — deploy preflight, post-deploy smoke test and backup helper. */

const ROOT = join(import.meta.dirname, "..", "..");
const WRANGLER = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
const MIGRATIONS = Object.fromEntries(readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).map((f) => [f, readFileSync(join(ROOT, "migrations", f), "utf8")]));

/** The repository config: production values for chomkhao.com. */
const READY = WRANGLER;
/** The same config before the owner filled in the domain, the D1 id and the base URL (a fresh fork). */
const BLANK = WRANGLER
  .replace(/"APP_BASE_URL": "[^"]*"/, '"APP_BASE_URL": ""')
  .replace(/"database_id": "[^"]*"/, '"database_id": "REPLACE_WITH_D1_DATABASE_ID"')
  .replace(/\n {2}"routes": \[[\s\S]*?\],/, "")
  .replace('"workers_dev": false,', "");

function run(overrides: Partial<PreflightInput> = {}): Finding[] {
  return preflight({
    wrangler: READY, migrations: MIGRATIONS, latestMigration: LATEST_MIGRATION,
    headers: readFileSync(join(ROOT, "public", "_headers"), "utf8"), tracked: ["src/worker/index.ts", ".dev.vars.example"],
    secrets: null, exists: () => true, today: new Date("2026-10-07T00:00:00Z"), ...overrides,
  });
}
const errors = (f: Finding[]) => f.filter((x) => x.level === "error").map((x) => `${x.area}: ${x.message}`);
const warns = (f: Finding[]) => f.filter((x) => x.level === "warn").map((x) => `${x.area}: ${x.message}`);

describe("preflight (npm run preflight)", () => {
  it("reads JSONC: comments, trailing commas, // inside strings", () => {
    assert.deepEqual(parseJsonc('{\n  // c\n  "a": "http://x", /* b */ "b": [1, 2,],\n}'), { a: "http://x", b: [1, 2] });
    assert.deepEqual(parseJsonc('{"q": "say \\"hi\\" // not a comment"}'), { q: 'say "hi" // not a comment' });
  });

  it("a fresh config fails only on the values the owner must fill in (domain, D1 id, base URL)", () => {
    const found = errors(run({ wrangler: BLANK }));
    assert.equal(found.length, 3, found.join("\n"));
    assert.ok(found.some((e) => e.startsWith("vars: APP_BASE_URL is empty")));
    assert.ok(found.some((e) => e.startsWith("d1: database_id")));
    assert.ok(found.some((e) => e.startsWith("domain: no routes")));
  });

  it("the repository config (chomkhao.com) passes; only manual slip checking remains a warning", () => {
    const f = run();
    assert.deepEqual(errors(f), []);
    assert.deepEqual(warns(f).map((w) => w.split(":")[0]), ["payments"]);
  });

  it("catches risky configuration", () => {
    const cases: [string, string, RegExp][] = [
      ['"APP_ENV": "production"', '"APP_ENV": "staging"', /APP_ENV/],
      ['"APP_BASE_URL": "https://chomkhao.com"', '"APP_BASE_URL": "https://chomkhao.com/"', /no trailing slash/],
      ['"APP_BASE_URL": "https://chomkhao.com"', '"APP_BASE_URL": "http://chomkhao.com"', /https/],
      ['"SLIP_VERIFY_PROVIDER": ""', '"SLIP_VERIFY_PROVIDER": "ocr"', /not supported/],
      ['"META_GRAPH_API_VERSION": "v23.0"', '"META_GRAPH_API_VERSION": "v23.0", "LINE_CHANNEL_SECRET": "abc"', /LINE_CHANNEL_SECRET is in vars/],
      ['"namespace_id": "2002"', '"namespace_id": "2001"', /unique/],
      ['"period": 60 } },\n    { "name": "RL_WRITE"', '"period": 30 } },\n    { "name": "RL_WRITE"', /period/],
      ['"crons": ["* * * * *"]', '"crons": ["*/5 * * * *"]', /crons/],
      ['"bucket_name": "chomkhao-media-private"', '"bucket_name": "chomkhao-media-public"', /different buckets/],
      ['"run_worker_first": ["/*", "!/assets/*"]', '"run_worker_first": ["/api/*"]', /run_worker_first/],
      ['"compatibility_date": "2026-06-01"', '"compatibility_date": "2027-01-01"', /future/],
    ];
    for (const [from, to, expect] of cases) {
      assert.ok(READY.includes(from), `fixture has ${from}`);
      const found = errors(run({ wrangler: READY.replace(from, to) }));
      assert.ok(found.some((e) => expect.test(e)), `${to} → ${found.join(" | ") || "no error"}`);
    }
    assert.match(errors(run({ wrangler: "{ nope" }))[0] ?? "", /cannot be read/);
    assert.ok(warns(run({ wrangler: READY.replace('"workers_dev": false,', '"workers_dev": true,') })).some((w) => /workers\.dev/.test(w)));
    assert.ok(warns(run({ wrangler: READY.replace('"preview_urls": false,', "") })).some((w) => /preview/.test(w)));
    assert.ok(warns(run({ wrangler: READY.replace('"head_sampling_rate": 1', '"head_sampling_rate": 0.1') })).some((w) => /dropped/.test(w)));
    assert.ok(warns(run({ wrangler: READY.replace('    { "pattern": "chomkhao.com", "custom_domain": true },\n', "") })).some((w) => /not one of the routes/.test(w)));
  });

  it("migrations: numbering, LATEST_MIGRATION in sync, no virtual tables (D1 export)", () => {
    const gap = { ...MIGRATIONS };
    delete gap["0007_food.sql"];
    assert.match(errors(run({ migrations: gap })).join(), /numbering/);
    assert.match(errors(run({ latestMigration: "0019_privacy_marketing.sql" })).join(), /LATEST_MIGRATION/);
    assert.match(errors(run({ migrations: { ...MIGRATIONS, "0021_fts.sql": "CREATE VIRTUAL TABLE x USING fts5(a);" }, latestMigration: "0021_fts.sql" })).join(), /virtual tables/);
    assert.match(errors(run({ migrations: { ...MIGRATIONS, "21_bad.sql": "" } })).join(), /bad file names/);
  });

  it("secret files in Git are an error; secret names (never values) are checked against the config", () => {
    assert.match(errors(run({ tracked: [".dev.vars", "bootstrap.sql"] })).join(), /\.dev\.vars, bootstrap\.sql/);
    const withProvider = READY.replace('"SLIP_VERIFY_PROVIDER": ""', '"SLIP_VERIFY_PROVIDER": "easyslip"');
    assert.match(errors(run({ wrangler: withProvider, secrets: [] })).join(), /SLIP_VERIFICATION_API_KEY is not set/);
    assert.deepEqual(errors(run({ wrangler: withProvider, secrets: ["SLIP_VERIFICATION_API_KEY"] })), []);
    const f = run({ secrets: ["META_TEST_EVENT_CODE", "LINE_CHANNEL_ACCESS_TOKEN", "OLD_THING"] });
    assert.ok(warns(f).some((w) => /META_TEST_EVENT_CODE/.test(w)));
    assert.ok(warns(f).some((w) => /OLD_THING/.test(w)));
    assert.ok(f.some((x) => x.level === "ok" && /LINE_CHANNEL_ACCESS_TOKEN set/.test(x.message)));
    assert.ok(f.some((x) => x.level === "todo" && /LINE_CHANNEL_SECRET not set/.test(x.message)));
    // Zoho Mail needs all three secrets; one or two of them is a half-finished setup.
    assert.match(errors(run({ secrets: ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET"] })).join(), /missing ZOHO_REFRESH_TOKEN/);
    assert.deepEqual(errors(run({ secrets: ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"] })), []);
    assert.deepEqual(warns(run({ secrets: ["ZOHO_REGION", "RESEND_API_KEY"] })).filter((w) => w.startsWith("secrets")), []);
  });

  it("reads `wrangler secret list` output in JSON (with a banner) or as text", () => {
    assert.deepEqual(secretNames(' ⛅️ wrangler 4.40\n[\n  { "name": "LINE_CHANNEL_SECRET", "type": "secret_text" },\n  { "name": "GA4_SERVICE_ACCOUNT_KEY", "type": "secret_text" }\n]\n'), ["LINE_CHANNEL_SECRET", "GA4_SERVICE_ACCOUNT_KEY"]);
    assert.deepEqual(secretNames("Secret Name: META_CAPI_ACCESS_TOKEN\nSecret Name: LINE_CHANNEL_SECRET\n"), ["META_CAPI_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"]);
    assert.deepEqual(secretNames(""), []);
  });
});

describe("backup file names (npm run db:backup)", () => {
  it("UTC timestamp, safe database names only", () => {
    assert.equal(backupFileName("chomkhao-db", new Date("2027-01-10T03:04:05.678Z")), "chomkhao-db-20270110T030405Z.sql");
    assert.throws(() => backupFileName("../x", new Date()), /invalid database name/);
    assert.throws(() => backupFileName("db; rm -rf /", new Date()), /invalid database name/);
  });
});

describe("smoke test (npm run smoke) against the real app", () => {
  const SHELL = '<!doctype html><html lang="th"><head><meta charset="utf-8" /><title>x</title><script type="module" src="/assets/main-abc123.js"></script></head><body><div id="root"></div></body></html>';
  function site(env: Record<string, unknown> = {}) {
    const h = new Harness({ seed: true });
    Object.assign(h.env, {
      APP_ENV: "production", APP_BASE_URL: ORIGIN,
      ASSETS: {
        fetch: async (req: Request) => new URL(req.url).pathname.startsWith("/assets/")
          ? new Response("export {}", { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000, immutable" } })
          : new Response(SHELL, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      },
      ...env,
    });
    const fetch = (input: string, init?: RequestInit) => h.app.fetch(new Request(input, init), h.env);
    return { h, fetch };
  }

  it("a correctly configured production site passes (cron not run yet is only a warning)", async () => {
    const { h, fetch } = site();
    const f = await smoke(ORIGIN, { fetch, http: false, nonce: "probe" });
    assert.deepEqual(errors(f), []);
    assert.deepEqual(warns(f).map((w) => w.split(":")[0]), ["health"], warns(f).join("\n"));
    await h.app.scheduled(h.env, h.now.getTime());
    assert.deepEqual(warns(await smoke(ORIGIN, { fetch, http: false })), []);
  });

  it("signs in, reports System status problems and signs out again", async () => {
    const { h, fetch } = site();
    const email = await h.user({ id: "owner", roles: ["SUPER_ADMIN"] });
    await h.app.scheduled(h.env, h.now.getTime());
    const f = await smoke(ORIGIN, { fetch, http: false, admin: { identifier: email, password: "correct horse battery staple" } });
    assert.deepEqual(errors(f), []);
    const system = f.filter((x) => x.area === "system").map((x) => x.message.split(" ")[0]);
    assert.ok(system.includes("superAdmins") && system.includes("slipVerification") && system.includes("rateLimits"), system.join());
    const sessions = h.db.all("SELECT revoked_at FROM sessions WHERE user_id = 'owner'") as { revoked_at: string | null }[];
    assert.equal(sessions.length, 1);
    assert.ok(sessions[0]!.revoked_at, "signed out");
    const wrong = await smoke(ORIGIN, { fetch, http: false, admin: { identifier: email, password: "wrong password here" } });
    assert.match(errors(wrong).join(), /sign-in failed \(401\)/);
  });

  it("finds the classic deploy mistakes", async () => {
    const dev = await smoke(ORIGIN, { fetch: site({ APP_ENV: "development" }).fetch, http: false });
    assert.match(errors(dev).join("\n"), /robots\.txt blocks the whole site/);
    assert.match(errors(dev).join("\n"), /noindex/);

    const other = await smoke(ORIGIN, { fetch: site({ APP_BASE_URL: "https://old-domain.example" }).fetch, http: false });
    assert.match(errors(other).join("\n"), /phasakura\.test redirects to old-domain\.example \(APP_BASE_URL\)/);

    const { h, fetch } = site();
    h.db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)");
    h.db.run("INSERT INTO d1_migrations (name) VALUES ('0018_search_state.sql')");
    assert.match(errors(await smoke(ORIGIN, { fetch, http: false })).join(), /db:migrate:remote/);

    const unreachable = await smoke(ORIGIN, { fetch: async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }); }, http: false });
    assert.match(errors(unreachable)[0] ?? "", /ENOTFOUND/);
    assert.match(errors(await smoke("http://insecure.example"))[0] ?? "", /must be https/);
  });

  it("http → https: a redirect passes, a page served over http fails", async () => {
    const { fetch } = site();
    const viaHttp = (status: number, location: string | null) => async (input: string, init?: RequestInit) =>
      input.startsWith("http://") ? new Response(null, { status, headers: location ? { Location: location } : {} }) : fetch(input, init);
    assert.ok((await smoke(ORIGIN, { fetch: viaHttp(301, `${ORIGIN}/`) })).some((x) => x.area === "tls" && x.level === "ok"));
    assert.match(errors(await smoke(ORIGIN, { fetch: viaHttp(200, null) })).join(), /Always Use HTTPS/);
  });
});
