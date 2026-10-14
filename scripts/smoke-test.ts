/**
 * Production smoke test (Phase 16): read-only checks against a deployed site, run right after every deploy.
 *
 *   npm run smoke -- https://www.your-domain.com
 *   SMOKE_ADMIN_IDENTIFIER=owner@… SMOKE_ADMIN_PASSWORD=… npm run smoke -- https://www.your-domain.com
 *
 * It never books, pays or changes settings. With the two SMOKE_ADMIN_* variables (environment only — never
 * on the command line) it also signs in, reads Admin → System status and signs out again (one login
 * audit entry). `--no-http` skips the http:// → https:// redirect check. Exit code 1 when anything fails.
 */
import { parseArgs } from "node:util";
import type { HealthDto, SystemStatusDto } from "../src/shared/system-types.ts";
import type { Finding, Level } from "./preflight.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface SmokeOptions {
  fetch?: Fetch;
  admin?: { identifier: string; password: string } | null;
  http?: boolean;
  /** Random part of the 404 probe path (tests pass a fixed one). */
  nonce?: string;
}

const LOCALES = ["th", "en", "zh-cn"];

export async function smoke(baseUrl: string, options: SmokeOptions = {}): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (level: Level, area: string, message: string) => out.push({ level, area, message });
  const doFetch: Fetch = options.fetch ?? ((i, init) => fetch(i, init));
  const base = baseUrl.replace(/\/+$/, "");
  let origin: URL;
  try {
    origin = new URL(base);
    if (origin.protocol !== "https:") throw new Error("must be https");
  } catch (e) {
    add("error", "input", `${baseUrl}: ${(e as Error).message}`);
    return out;
  }
  const get = async (path: string, init: RequestInit = {}) => {
    try {
      return await doFetch(`${base}${path}`, { redirect: "manual", ...init });
    } catch (e) {
      add("error", "network", `${path}: ${(e as Error).cause ? String((e as Error).cause) : (e as Error).message} (DNS, certificate or Worker not reachable)`);
      return null;
    }
  };
  const header = (res: Response, name: string) => res.headers.get(name) ?? "";
  const noindex = (res: Response, html = "") => /noindex/i.test(header(res, "X-Robots-Tag")) || /<meta[^>]+name="robots"[^>]+noindex/i.test(html);

  // 1. Health: database, migrations, cron
  const h = await get("/api/health");
  if (h) {
    let body: HealthDto | null = null;
    try { body = ((await h.json()) as { data: HealthDto }).data; } catch { /* not JSON */ }
    if (!body) add("error", "health", `/api/health answered ${h.status} without JSON — is this the Chomkhao Worker?`);
    else {
      add(body.database === "ok" ? "ok" : "error", "health", `database ${body.database}`);
      add(body.schema === "ok" ? "ok" : body.schema === "unknown" ? "warn" : "error", "health",
        body.schema === "outdated" ? "schema outdated — run `npm run db:migrate:remote`" : `schema ${body.schema}`);
      add(body.cron === "ok" ? "ok" : body.cron === "unknown" ? "warn" : "error", "health",
        body.cron === "unknown" ? "cron has not run yet — check again in 2 minutes (Triggers → Cron)" : body.cron === "stale" ? "cron stopped (no heartbeat for 5+ minutes) — check Workers → Triggers and the logs" : "cron ok");
      if (h.status !== (body.status === "ok" ? 200 : 503)) add("error", "health", `status ${h.status} does not match "${body.status}"`);
      if (!/no-store/.test(header(h, "Cache-Control"))) add("warn", "health", "/api/health is cacheable — uptime monitors may see old answers");
    }
    for (const [name, want] of [["X-Content-Type-Options", /nosniff/], ["Content-Security-Policy", /default-src 'none'/], ["Strict-Transport-Security", /max-age=\d{7,}/]] as const) {
      if (!want.test(header(h, name))) add("error", "security", `API response without ${name}`);
    }
  }

  // The Worker sends pages on any other host to APP_BASE_URL: testing this host would test nothing else.
  const probe = await get("/th/", { method: "HEAD" });
  const moved = probe && probe.status >= 300 && probe.status < 400 ? header(probe, "Location") : "";
  if (/^https?:\/\//.test(moved) && new URL(moved).host !== origin.host) {
    add("error", "domain", `${origin.host} redirects to ${new URL(moved).host} (APP_BASE_URL) — run the smoke test against that address, or fix APP_BASE_URL`);
    return out;
  }

  // 2. Entry redirect
  const root = await get("/", { headers: { "Accept-Language": "en" } });
  if (root) {
    const loc = header(root, "Location");
    if (root.status >= 300 && root.status < 400 && /\/(th|en|zh-cn)\/$/.test(loc)) add("ok", "pages", `/ → ${loc}`);
    else add("error", "pages", `/ answered ${root.status} ${loc} (expected a redirect to a language home page)`);
  }

  // 3. Home page per language: status, lang, canonical domain, indexable, security headers, assets
  let assetChecked = false;
  for (const l of LOCALES) {
    const res = await get(`/${l}/`);
    if (!res) continue;
    const html = await res.text();
    const problems: string[] = [];
    if (res.status !== 200) problems.push(`status ${res.status}`);
    if (!/text\/html/.test(header(res, "Content-Type"))) problems.push("not HTML");
    const lang = /<html[^>]*\blang="([^"]+)"/i.exec(html)?.[1]?.toLowerCase();
    if (lang !== (l === "zh-cn" ? "zh-cn" : l)) problems.push(`<html lang="${lang ?? ""}">`);
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
    if (!canonical) problems.push("no canonical link");
    else if (new URL(canonical).host !== origin.host) problems.push(`canonical points to ${new URL(canonical).host} (APP_BASE_URL?)`);
    if (noindex(res, html)) problems.push("noindex (APP_ENV must be production; check Website → SEO)");
    if (!/hreflang=/.test(html)) problems.push("no hreflang alternates");
    add(problems.length ? "error" : "ok", "pages", `/${l}/ ${problems.length ? problems.join("; ") : "200, indexable, canonical on this domain"}`);
    if (l === "th") {
      const csp = header(res, "Content-Security-Policy");
      const sec: [string, boolean][] = [
        ["CSP frame-ancestors 'none'", /frame-ancestors 'none'/.test(csp)],
        ["CSP object-src 'none'", /object-src 'none'/.test(csp)],
        ["CSP without unsafe-inline / unsafe-eval scripts", !/script-src[^;]*'unsafe-(inline|eval)'/.test(csp)],
        ["HSTS ≥ 1 year", Number(/max-age=(\d+)/.exec(header(res, "Strict-Transport-Security"))?.[1] ?? 0) >= 31_536_000],
        ["X-Content-Type-Options", header(res, "X-Content-Type-Options") === "nosniff"],
        ["Referrer-Policy", !!header(res, "Referrer-Policy")],
      ];
      for (const [name, ok] of sec) if (!ok) add("error", "security", `page header missing: ${name}`);
      if (sec.every(([, ok]) => ok)) add("ok", "security", "page security headers (CSP, HSTS, nosniff, referrer)");
    }
    const script = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    if (script && !assetChecked) {
      assetChecked = true;
      const a = await get(script);
      if (a && a.status === 200 && /immutable/.test(header(a, "Cache-Control"))) add("ok", "assets", `${script} cached immutable`);
      else if (a) add(a.status === 200 ? "warn" : "error", "assets", `${script}: ${a.status} ${header(a, "Cache-Control")}`);
    }
  }
  if (!assetChecked) add("error", "assets", "no /assets/*.js script in the page — was the client built before deploy?");

  // 4. robots.txt / sitemap.xml
  const robots = await get("/robots.txt");
  if (robots) {
    const text = await robots.text();
    if (robots.status !== 200) add("error", "seo", `robots.txt ${robots.status}`);
    else if (/^Disallow:\s*\/\s*$/m.test(text)) add("error", "seo", "robots.txt blocks the whole site (APP_ENV is not production)");
    else if (!text.includes(`Sitemap: ${base}/sitemap.xml`)) add("error", "seo", `robots.txt does not point to ${base}/sitemap.xml (APP_BASE_URL?)`);
    else add("ok", "seo", "robots.txt (private areas excluded, sitemap on this domain)");
  }
  const sitemap = await get("/sitemap.xml");
  if (sitemap) {
    const xml = await sitemap.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    const foreign = locs.filter((u) => !u.startsWith(`${base}/`));
    if (sitemap.status !== 200 || !/<urlset/.test(xml)) add("error", "seo", `sitemap.xml ${sitemap.status}`);
    else if (foreign.length) add("error", "seo", `sitemap has ${foreign.length} URL(s) on another domain, e.g. ${foreign[0]}`);
    else if (noindex(sitemap)) add("error", "seo", "sitemap.xml is noindex");
    else add(locs.length ? "ok" : "warn", "seo", `sitemap.xml ${locs.length} URL(s)`);
  }

  // 5. Unknown page → real 404, not indexed
  const missing = await get(`/th/smoke-${options.nonce ?? Math.random().toString(36).slice(2, 10)}`);
  if (missing) {
    const html = await missing.text();
    add(missing.status === 404 && noindex(missing, html) ? "ok" : "error", "pages", `unknown page → ${missing.status}${noindex(missing, html) ? ", noindex" : ""}`);
  }

  // 6. Back office: reachable, never indexed or cached
  const adminEntry = await get("/admin");
  const adminPath = adminEntry && adminEntry.status >= 300 && adminEntry.status < 400 ? header(adminEntry, "Location") : "/th/admin";
  const admin = await get(adminPath.startsWith("/") ? adminPath : new URL(adminPath).pathname);
  if (admin) {
    const html = await admin.text();
    const okAdmin = admin.status === 200 && noindex(admin, html) && /no-store/.test(header(admin, "Cache-Control"));
    add(okAdmin ? "ok" : "error", "security", `back office ${adminPath}: ${admin.status}${noindex(admin, html) ? ", noindex" : ", INDEXABLE"}, ${header(admin, "Cache-Control") || "no Cache-Control"}`);
  }

  // 7. Public API + CSRF protection
  const site = await get("/api/public/site?lang=th");
  if (site) {
    const data = site.ok ? ((await site.json()) as { data: { siteName: string | null; configured: boolean } }).data : null;
    if (!data) add("error", "api", `/api/public/site ${site.status}`);
    else if (!data.configured || !data.siteName) add("warn", "content", "website settings not saved yet (Admin → Website → Settings: site name, logo)");
    else add("ok", "content", `site name "${data.siteName}"`);
  }
  const csrf = await get("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (csrf) {
    if (csrf.status === 403) add("ok", "security", "cross-site POST rejected (CSRF)");
    else if (csrf.status === 429) add("warn", "security", "CSRF probe rate-limited — run again later");
    else add("error", "security", `POST without Origin / X-Requested-With answered ${csrf.status} (expected 403)`);
  }

  // 8. http:// → https://
  if (options.http !== false) {
    try {
      const plain = await doFetch(`http://${origin.host}/`, { redirect: "manual" });
      const loc = header(plain, "Location");
      if (plain.status >= 300 && plain.status < 400 && loc.startsWith("https://")) add("ok", "tls", "http:// redirects to https://");
      else add("error", "tls", `http:// answered ${plain.status} — turn on SSL/TLS → Edge Certificates → Always Use HTTPS`);
    } catch (e) {
      add("warn", "tls", `http:// could not be checked: ${(e as Error).message}`);
    }
  }

  // 9. Optional: signed-in System status
  if (options.admin) {
    const headers = { "Content-Type": "application/json", Origin: origin.origin, "X-Requested-With": "phasakura" };
    const login = await get("/api/auth/login", { method: "POST", headers, body: JSON.stringify({ ...options.admin, rememberMe: false }) });
    const cookie = login?.headers.getSetCookie?.().map((c) => c.split(";")[0] ?? "").find((c) => c.startsWith("__Host-sid="));
    if (!login || login.status !== 200 || !cookie) add("error", "admin", `sign-in failed (${login?.status ?? "no answer"})`);
    else {
      const status = await get("/api/admin/system", { headers: { ...headers, Cookie: cookie } });
      if (status?.status === 200) {
        const data = ((await status.json()) as { data: SystemStatusDto }).data;
        for (const c of data.checks.filter((c) => c.level !== "ok")) add(c.level === "error" ? "error" : "warn", "system", `${c.key}${c.value ? ` (${c.value})` : ""} — see Admin → System status`);
        if (data.checks.every((c) => c.level === "ok")) add("ok", "system", "all System status checks ok");
        if (data.errorCount24h) add("warn", "system", `${data.errorCount24h} server error(s) in the last 24 h`);
      } else {
        const code = status ? (((await status.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code ?? status.status) : "no answer";
        add(code === "PASSWORD_CHANGE_REQUIRED" ? "warn" : "error", "admin", code === "PASSWORD_CHANGE_REQUIRED" ? "this account must change its password first" : `System status: ${code} (needs system.view)`);
      }
      await get("/api/auth/logout", { method: "POST", headers: { ...headers, Cookie: cookie } });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "no-http": { type: "boolean", default: false } } });
  const url = positionals[0];
  if (!url) {
    console.error("usage: npm run smoke -- https://www.your-domain.com [--no-http]");
    process.exit(2);
  }
  const id = process.env.SMOKE_ADMIN_IDENTIFIER, pw = process.env.SMOKE_ADMIN_PASSWORD;
  const findings = await smoke(url, { http: !values["no-http"], admin: id && pw ? { identifier: id, password: pw } : null });
  const mark: Record<Level, string> = { ok: "✓", warn: "!", error: "✗", todo: "□" };
  for (const f of findings) console.log(`${mark[f.level]} ${f.area.padEnd(9)} ${f.message}`);
  const count = (l: Level) => findings.filter((f) => f.level === l).length;
  console.log(`\n${count("ok")} ok, ${count("warn")} warning(s), ${count("error")} error(s)${id && pw ? "" : " — set SMOKE_ADMIN_IDENTIFIER / SMOKE_ADMIN_PASSWORD to include System status"}`);
  process.exit(count("error") ? 1 : 0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) await main();
