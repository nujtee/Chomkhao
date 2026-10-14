/**
 * Production preflight (Phase 16): checks the deploy configuration in this repository before
 * `wrangler deploy`. It reads files only — no network, no Cloudflare credentials, no secret values.
 *
 *   npm run preflight
 *   npx wrangler secret list > secrets.json && npm run preflight -- --secrets secrets.json && rm secrets.json
 *
 * `--secrets` takes the output of `wrangler secret list` (JSON: [{ "name": … }]) or one name per line;
 * only the NAMES are read. Exit code 1 when anything is an error. What only the owner can check in the
 * Cloudflare / LINE / Google / Meta dashboards is in docs/PRODUCTION.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LATEST_MIGRATION } from "../src/worker/services/health.service.ts";

export type Level = "ok" | "warn" | "error" | "todo";
export interface Finding { level: Level; area: string; message: string }

/** JSON with comments and trailing commas (wrangler.jsonc). Strings are left untouched. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Secrets the Worker reads, the feature that needs each, and whether that feature is decided by config. */
export const SECRETS: { name: string; needs: string }[] = [
  { name: "SLIP_VERIFICATION_API_KEY", needs: "automatic slip verification (SLIP_VERIFY_PROVIDER)" },
  { name: "LINE_CHANNEL_ACCESS_TOKEN", needs: "LINE notifications (Admin → LINE)" },
  { name: "LINE_CHANNEL_SECRET", needs: "LINE webhook signature check (Admin → LINE)" },
  { name: "META_CAPI_ACCESS_TOKEN", needs: "Meta Conversions API (Admin → Marketing)" },
  { name: "META_PIXEL_ID", needs: "optional: overrides the Pixel ID from Admin → Marketing for CAPI" },
  { name: "META_TEST_EVENT_CODE", needs: "testing only — remove after Events Manager → Test events" },
  { name: "GA4_SERVICE_ACCOUNT_KEY", needs: "GA4 numbers on the dashboard (Admin → Marketing → GA4 property ID)" },
  { name: "ZOHO_CLIENT_ID", needs: "e-mail notifications from the Zoho Mail mailbox (Admin → Settings → E-mail notifications)" },
  { name: "ZOHO_CLIENT_SECRET", needs: "e-mail notifications from the Zoho Mail mailbox" },
  { name: "ZOHO_REFRESH_TOKEN", needs: "e-mail notifications from the Zoho Mail mailbox (scopes ZohoMail.messages.CREATE,ZohoMail.accounts.READ)" },
  { name: "ZOHO_REGION", needs: "optional: Zoho data centre when not US — eu, in, com.au, jp, ca, sa" },
  { name: "RESEND_API_KEY", needs: "optional: e-mail through Resend instead (used only while the Zoho secrets are not set)" },
  { name: "PAYPAL_CLIENT_ID", needs: "PayPal Checkout (Admin → Finance → Payment settings)" },
  { name: "PAYPAL_CLIENT_SECRET", needs: "PayPal Checkout (Admin → Finance → Payment settings)" },
  { name: "PAYPAL_ENV", needs: "optional: \"sandbox\" while testing with sandbox PayPal credentials (unset = live)" },
];
const SECRET_NAMES = new Set(SECRETS.map((s) => s.name));
const KNOWN_SLIP_PROVIDERS = new Set(["easyslip"]);
const RATE_LIMITS = ["RL_PUBLIC", "RL_WRITE", "RL_AUTH", "RL_ADMIN"];

export interface PreflightInput {
  wrangler: string;
  /** Migration file name → SQL. */
  migrations: Record<string, string>;
  latestMigration: string;
  headers: string;
  /** Files tracked by Git (null when Git is not available). */
  tracked: string[] | null;
  /** Secret names from `wrangler secret list` (null when not given). */
  secrets: string[] | null;
  exists: (path: string) => boolean;
  today: Date;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function preflight(input: PreflightInput): Finding[] {
  const out: Finding[] = [];
  const add = (level: Level, area: string, message: string) => out.push({ level, area, message });

  // ---- wrangler.jsonc
  let cfg: Obj;
  try {
    const parsed = parseJsonc(input.wrangler);
    if (!isObj(parsed)) throw new Error("not an object");
    cfg = parsed;
  } catch (e) {
    add("error", "config", `wrangler.jsonc cannot be read: ${(e as Error).message}`);
    return out;
  }
  if (!str(cfg.name)) add("error", "config", "name is missing");
  if (!str(cfg.main) || !input.exists(str(cfg.main))) add("error", "config", `main "${str(cfg.main)}" does not exist`);
  const compat = Date.parse(str(cfg.compatibility_date));
  if (Number.isNaN(compat)) add("error", "config", "compatibility_date is missing or not a date");
  else if (compat > input.today.getTime()) add("error", "config", `compatibility_date ${str(cfg.compatibility_date)} is in the future`);
  else if (input.today.getTime() - compat > 548 * 86_400_000) add("warn", "config", `compatibility_date ${str(cfg.compatibility_date)} is over 18 months old — update it and re-run the tests`);
  else add("ok", "config", `compatibility_date ${str(cfg.compatibility_date)}`);

  const assets = isObj(cfg.assets) ? cfg.assets : null;
  const rwf = Array.isArray(assets?.run_worker_first) ? (assets.run_worker_first as unknown[]) : [];
  if (!assets || assets.binding !== "ASSETS" || !rwf.includes("/*") || !rwf.includes("!/assets/*") || assets.not_found_handling !== "none") {
    add("error", "config", 'assets must bind ASSETS with run_worker_first ["/*", "!/assets/*"] and not_found_handling "none" (pages are rendered by the Worker)');
  } else add("ok", "config", "static assets: Worker first, /assets/* direct");

  const crons = isObj(cfg.triggers) && Array.isArray(cfg.triggers.crons) ? (cfg.triggers.crons as unknown[]) : [];
  if (!crons.includes("* * * * *")) add("error", "cron", 'triggers.crons must include "* * * * *" (holds expire, LINE / CAPI delivery, heartbeat)');
  else add("ok", "cron", "every minute");

  const obs = isObj(cfg.observability) ? cfg.observability : null;
  if (obs?.enabled !== true) add("warn", "monitoring", "observability.enabled is not true — no Workers Logs to investigate errors");
  else if (typeof obs.head_sampling_rate === "number" && obs.head_sampling_rate < 1) add("warn", "monitoring", `observability.head_sampling_rate ${obs.head_sampling_rate}: some error logs will be dropped`);
  else add("ok", "monitoring", "Workers Logs on (every request)");

  // vars
  const vars = isObj(cfg.vars) ? cfg.vars : {};
  for (const name of Object.keys(vars)) {
    if (SECRET_NAMES.has(name)) add("error", "secrets", `${name} is in vars (plain text, in Git) — remove it and use \`wrangler secret put ${name}\``);
  }
  if (vars.APP_ENV !== "production") add("error", "vars", `APP_ENV is "${str(vars.APP_ENV)}" — must be "production" (otherwise robots.txt blocks everything and pages are noindex)`);
  else add("ok", "vars", "APP_ENV production");
  const base = str(vars.APP_BASE_URL).trim();
  let baseHost: string | null = null;
  if (!base) add("error", "vars", "APP_BASE_URL is empty — set the canonical https origin, e.g. https://www.your-domain.com (links in e-mails, LINE, sitemap, canonical)");
  else if (!/^https:\/\/[a-z0-9.-]+$/i.test(base)) add("error", "vars", `APP_BASE_URL "${base}" must be https://host with no path and no trailing slash`);
  else if (/localhost|\.test$|\.local$|example\.(com|org|net)$/i.test(base)) add("error", "vars", `APP_BASE_URL "${base}" is not a public domain`);
  else {
    baseHost = new URL(base).hostname.toLowerCase();
    add("ok", "vars", `APP_BASE_URL ${base}`);
  }
  const media = str(vars.PUBLIC_MEDIA_BASE_URL).trim();
  if (media && !/^https:\/\/[a-z0-9.-]+(\/[^\s]*)?$/i.test(media)) add("error", "vars", "PUBLIC_MEDIA_BASE_URL must be an https URL (or empty to serve /media/* through the Worker)");
  const provider = str(vars.SLIP_VERIFY_PROVIDER).trim();
  if (!provider) add("warn", "payments", "SLIP_VERIFY_PROVIDER is empty — EasySlip is used once SLIP_VERIFICATION_API_KEY is set; without the key staff verify every slip by hand (allowed)");
  else if (!KNOWN_SLIP_PROVIDERS.has(provider)) add("error", "payments", `SLIP_VERIFY_PROVIDER "${provider}" is not supported (known: ${[...KNOWN_SLIP_PROVIDERS].join(", ")})`);
  else add("ok", "payments", `slip verification: ${provider}`);
  if (vars.META_GRAPH_API_VERSION !== undefined && !/^v\d+\.\d+$/.test(str(vars.META_GRAPH_API_VERSION))) add("error", "vars", "META_GRAPH_API_VERSION must look like v23.0");

  // D1
  const d1 = Array.isArray(cfg.d1_databases) ? (cfg.d1_databases as Obj[]).find((d) => d.binding === "DB") : undefined;
  if (!d1) add("error", "d1", "no D1 binding named DB");
  else {
    const id = str(d1.database_id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) add("error", "d1", `database_id "${id}" is a placeholder — run \`wrangler d1 create ${str(d1.database_name) || "chomkhao-db"}\` and paste the id`);
    else add("ok", "d1", `${str(d1.database_name)} (${id.slice(0, 8)}…)`);
    if (d1.migrations_dir !== "migrations") add("error", "d1", 'migrations_dir must be "migrations"');
  }

  // R2
  const buckets = Array.isArray(cfg.r2_buckets) ? (cfg.r2_buckets as Obj[]) : [];
  const pub = buckets.find((b) => b.binding === "MEDIA_PUBLIC");
  const priv = buckets.find((b) => b.binding === "MEDIA_PRIVATE");
  if (!pub || !priv) add("error", "r2", "R2 bindings MEDIA_PUBLIC and MEDIA_PRIVATE are both required");
  else if (pub.bucket_name === priv.bucket_name) add("error", "r2", "MEDIA_PUBLIC and MEDIA_PRIVATE must be different buckets (payment slips are private)");
  else add("ok", "r2", `${str(pub.bucket_name)} (public) / ${str(priv.bucket_name)} (private)`);

  // Rate limits
  const rl = Array.isArray(cfg.ratelimits) ? (cfg.ratelimits as Obj[]) : [];
  const missing = RATE_LIMITS.filter((n) => !rl.some((r) => r.name === n));
  const ids = rl.map((r) => String(r.namespace_id));
  const badPeriod = rl.filter((r) => !isObj(r.simple) || ![10, 60].includes(r.simple.period as number) || !((r.simple.limit as number) > 0));
  if (missing.length) add("error", "security", `rate limit bindings missing: ${missing.join(", ")}`);
  else if (new Set(ids).size !== ids.length) add("error", "security", "rate limit namespace_id values must be unique");
  else if (badPeriod.length) add("error", "security", "rate limit period must be 10 or 60 and limit > 0");
  else add("ok", "security", `rate limits ${RATE_LIMITS.join(", ")} (namespace_id must be unique in your Cloudflare account)`);

  // Custom domain
  const routes = Array.isArray(cfg.routes) ? (cfg.routes as unknown[]) : cfg.route ? [cfg.route] : [];
  const patterns = routes.map((r) => (typeof r === "string" ? { pattern: r, custom: false } : { pattern: str((r as Obj).pattern), custom: (r as Obj).custom_domain === true }));
  if (!patterns.length) add("error", "domain", 'no routes — add { "pattern": "www.your-domain.com", "custom_domain": true } (DNS record and certificate are created by Cloudflare)');
  else {
    for (const p of patterns.filter((p) => !p.custom)) add("warn", "domain", `route "${p.pattern}" is not a custom domain — custom_domain: true lets Cloudflare manage DNS and the certificate`);
    if (baseHost && !patterns.some((p) => p.pattern.toLowerCase().replace(/\/\*$/, "") === baseHost)) add("warn", "domain", `APP_BASE_URL host ${baseHost} is not one of the routes (${patterns.map((p) => p.pattern).join(", ")})`);
    else if (baseHost) add("ok", "domain", `${baseHost} → this Worker`);
  }
  if (cfg.workers_dev === true || (!patterns.length && cfg.workers_dev !== false)) add("warn", "domain", "workers_dev is on: the site is also public at *.workers.dev (duplicate content, skips zone security settings) — set \"workers_dev\": false once the domain works");
  if (cfg.preview_urls !== false) add("warn", "domain", 'preview_urls is not false: uploaded versions get public preview URLs with the production D1 / R2 bindings — set "preview_urls": false');

  // ---- migrations
  const names = Object.keys(input.migrations).sort();
  const badName = names.filter((n) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(n));
  const numbers = names.map((n) => Number(n.slice(0, 4)));
  const gap = numbers.findIndex((n, i) => n !== i + 1);
  if (badName.length) add("error", "migrations", `bad file names: ${badName.join(", ")}`);
  else if (gap >= 0) add("error", "migrations", `numbering must run 0001…${String(names.length).padStart(4, "0")} without gaps or duplicates (problem at ${names[gap]})`);
  else if (names.at(-1) !== input.latestMigration) add("error", "migrations", `LATEST_MIGRATION in health.service.ts is ${input.latestMigration}, newest file is ${names.at(-1)}`);
  else add("ok", "migrations", `${names.length} files, newest ${names.at(-1)} (= /api/health schema check)`);
  const virtual = names.filter((n) => /create\s+virtual\s+table/i.test(input.migrations[n]!));
  if (virtual.length) add("error", "backup", `virtual tables in ${virtual.join(", ")}: \`wrangler d1 export\` cannot back up a database with virtual tables`);
  else add("ok", "backup", "no virtual tables (wrangler d1 export works)");

  // ---- static headers
  if (!/^\/\*[\s\S]*?Strict-Transport-Security:/m.test(input.headers)) add("warn", "security", "public/_headers has no Strict-Transport-Security for /*");

  // ---- repository hygiene
  if (input.tracked === null) add("todo", "secrets", "Git not available — make sure .dev.vars and bootstrap*.sql are never committed");
  else {
    const leaked = input.tracked.filter((f) => /(^|\/)(\.dev\.vars|\.env(\..+)?|bootstrap[^/]*\.sql)$/.test(f) && !/\.example$/.test(f));
    if (leaked.length) add("error", "secrets", `committed to Git: ${leaked.join(", ")} — remove them, rotate every secret inside`);
    else add("ok", "secrets", ".dev.vars / bootstrap SQL not in Git");
  }

  // ---- secrets (names only)
  if (input.secrets === null) {
    add("todo", "secrets", "pass --secrets (from `npx wrangler secret list`) to check which secrets exist");
  } else {
    const have = new Set(input.secrets);
    if (provider && !have.has("SLIP_VERIFICATION_API_KEY")) add("error", "secrets", `SLIP_VERIFY_PROVIDER is "${provider}" but SLIP_VERIFICATION_API_KEY is not set`);
    const zoho = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"];
    const zohoSet = zoho.filter((n) => have.has(n));
    if (zohoSet.length > 0 && zohoSet.length < zoho.length) {
      add("error", "secrets", `Zoho Mail needs all of ${zoho.join(", ")} — missing ${zoho.filter((n) => !have.has(n)).join(", ")} (e-mail is not sent through Zoho until then)`);
    }
    if (have.has("META_TEST_EVENT_CODE")) add("warn", "secrets", "META_TEST_EVENT_CODE is set: every CAPI event goes to Test events — `wrangler secret delete META_TEST_EVENT_CODE` after testing");
    for (const s of SECRETS) {
      if (s.name === "META_TEST_EVENT_CODE") continue;
      if (s.name === "SLIP_VERIFICATION_API_KEY" && provider) continue;
      add(have.has(s.name) ? "ok" : "todo", "secrets", `${s.name} ${have.has(s.name) ? "set" : "not set"} — ${s.needs}`);
    }
    for (const n of have) if (!SECRET_NAMES.has(n)) add("warn", "secrets", `${n} is set but the Worker never reads it`);
  }
  return out;
}

/** `wrangler secret list` output (JSON array of { name }) or one name per line. */
export function secretNames(text: string): string[] {
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const list = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (Array.isArray(list)) return list.map((s) => String((s as { name?: unknown })?.name ?? "")).filter(Boolean);
    } catch { /* not JSON: fall through */ }
  }
  // Plain text (one name per line, or "Secret Name: X"): SECRET_STYLE names only.
  return [...new Set(text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
}

function main(): void {
  const ROOT = join(import.meta.dirname, "..");
  const { values } = parseArgs({ options: { secrets: { type: "string" } } });
  const dir = join(ROOT, "migrations");
  const migrations = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  let tracked: string[] | null = null;
  try {
    tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch { /* not a Git checkout */ }
  const findings = preflight({
    wrangler: readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"),
    migrations,
    latestMigration: LATEST_MIGRATION,
    headers: readFileSync(join(ROOT, "public", "_headers"), "utf8"),
    tracked,
    secrets: values.secrets ? secretNames(readFileSync(values.secrets, "utf8")) : null,
    exists: (p) => existsSync(join(ROOT, p)),
    today: new Date(),
  });
  const mark: Record<Level, string> = { ok: "✓", warn: "!", error: "✗", todo: "□" };
  for (const f of findings) console.log(`${mark[f.level]} ${f.area.padEnd(10)} ${f.message}`);
  const count = (l: Level) => findings.filter((f) => f.level === l).length;
  console.log(`\n${count("error")} error(s), ${count("warn")} warning(s), ${count("todo")} to do. Owner checklist (dashboards): docs/PRODUCTION.md`);
  process.exit(count("error") ? 1 : 0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) main();
