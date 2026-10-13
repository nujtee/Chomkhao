import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { Harness } from "../helpers/harness.ts";

/**
 * Phase 15 — every API route, checked mechanically (spec §34, §58): the list comes from the router
 * itself, so a new endpoint is covered the day it is added.
 *   - admin routes: 401 without a session, 403 for a signed-in user without permissions
 *   - every state-changing route: rejected without same-origin proof (CSRF), except the signed LINE webhook
 *   - hostile input in paths, query strings and bodies: never a 500, never a stack trace or SQL text,
 *     and the database is intact afterwards
 */

const SAMPLE: Record<string, string> = {
  id: "zz-not-a-real-id", imageId: "zz-image", paymentId: "zz-payment", categoryId: "zz-category",
  code: "BK-20270110-ZZZZ", slug: "no-such-unit", entity: "homeSlide", type: "revenue", action: "check-in",
  pageKey: "home", date: "2027-01-12",
};
const fill = (path: string, value?: (name: string) => string) => path.replace(/:(\w+)/g, (_, n: string) => encodeURIComponent(value ? value(n) : SAMPLE[n] ?? "x"));

const HOSTILE_STRINGS = [
  "' OR '1'='1", "1; DROP TABLE users;--", "\" UNION SELECT password_hash FROM users --", "<script>alert(1)</script>",
  "../../etc/passwd", "%00", "${7*7}", "{{7*7}}", "a".repeat(5000), "😀ทดสอบ汉字", "-1", "9".repeat(40), "null", "[]",
];

type Route = { method: string; path: string };
let h: Harness;
let routes: Route[];
let root: string;
let nobody: string;

before(async () => {
  h = new Harness({ seed: true });
  routes = h.app.routes();
  await h.user({ id: "root", roles: ["SUPER_ADMIN"] });
  await h.user({ id: "nobody" }); // active staff account with no role and no permission
  root = await h.login("root@example.test");
  nobody = await h.login("nobody@example.test");
});

const isAdmin = (r: Route) => r.path.startsWith("/api/admin/");
/** Routes that end or replace the caller's own session; fuzzing them as root would sign the fuzzer out. */
const SESSION_ENDING = new Set(["/api/auth/logout", "/api/auth/refresh", "/api/auth/change-password", "/api/admin/users/:id/force-logout"]);
const fresh = () => h.login("root@example.test");
const mutates = (r: Route) => r.method !== "GET";
const bodyFor = (r: Route) => (mutates(r) ? {} : undefined);

function assertSafe(status: number, text: string, label: string) {
  assert.ok(status < 500, `${label} → ${status} ${text.slice(0, 200)}`);
  assert.doesNotMatch(text, /\n\s+at |SQLITE|D1_ERROR|no such table|syntax error|TypeError|ReferenceError/i, `${label} leaks internals: ${text.slice(0, 200)}`);
}

describe("route inventory", () => {
  it("the router knows every API route (sanity: > 140 routes, admin and public)", () => {
    assert.ok(routes.length > 140, `${routes.length}`);
    assert.ok(routes.some((r) => r.path === "/api/admin/users" && r.method === "POST"));
    assert.ok(routes.some((r) => r.path === "/api/public/bookings" && r.method === "POST"));
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    assert.equal(new Set(keys).size, keys.length, "no route registered twice");
  });

  it("only these routes are reachable without a session", () => {
    const open = routes.filter((r) => !isAdmin(r)).map((r) => `${r.method} ${r.path}`).sort();
    assert.deepEqual(open.filter((r) => !/ \/api\/(public|search|health|auth|line\/webhook)\b/.test(r)), [], "unexpected public route");
    // Auth endpoints that need a session are checked below.
  });
});

describe("authentication and authorization on every admin route", () => {
  it("401 without a session", async () => {
    const wrong: string[] = [];
    for (const r of routes.filter(isAdmin)) {
      const res = await h.api(r.method, fill(r.path), { body: bodyFor(r) });
      if (res.status !== 401) wrong.push(`${r.method} ${r.path} → ${res.status}`);
    }
    assert.deepEqual(wrong, []);
  });

  it("401 with a forged or expired-looking session cookie", async () => {
    const wrong: string[] = [];
    for (const r of routes.filter(isAdmin).filter((_, i) => i % 3 === 0)) {
      const res = await h.api(r.method, fill(r.path), { body: bodyFor(r), token: "A".repeat(43) });
      if (res.status !== 401) wrong.push(`${r.method} ${r.path} → ${res.status}`);
      else assert.match(res.setCookie ?? "", /__Host-sid=;/, "a bad cookie is cleared");
    }
    assert.deepEqual(wrong, []);
  });

  it("403 for a signed-in account without permissions — before any lookup (no IDOR / existence leaks)", async () => {
    const wrong: string[] = [];
    for (const r of routes.filter(isAdmin)) {
      // An empty body and one that would fail validation: either way the answer must be 403.
      for (const body of mutates(r) ? [{}, { unexpected: "<x>", id: "../../" }] : [undefined]) {
        const res = await h.api(r.method, fill(r.path), { body, token: nobody });
        if (res.status !== 403) wrong.push(`${r.method} ${r.path} ${JSON.stringify(body)} → ${res.status} ${res.error?.code ?? ""}`);
      }
      if (!mutates(r)) {
        // Invalid filters must not be checked before the permission either.
        const res = await h.api("GET", `${fill(r.path)}?from=x&to=y&limit=-1&status=%3Cx%3E&before=z&group=w&q=${"q".repeat(300)}`, { token: nobody });
        if (res.status !== 403) wrong.push(`GET ${r.path}?bad-query → ${res.status} ${res.error?.code ?? ""}`);
      }
    }
    assert.deepEqual(wrong, []);
    const denied = h.events("PERMISSION_DENIED").filter((e) => e.user_id === "nobody");
    assert.ok(denied.length >= routes.filter(isAdmin).length * 0.9, `denials are logged (${denied.length})`);
  });

  it("session-only auth routes refuse anonymous callers", async () => {
    for (const [method, path] of [["GET", "/api/auth/me"], ["GET", "/api/auth/menu"], ["POST", "/api/auth/logout"], ["POST", "/api/auth/refresh"], ["POST", "/api/auth/change-password"]] as const) {
      const res = await h.api(method, path, { body: method === "POST" ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });
});

describe("CSRF on every state-changing route", () => {
  for (const variant of ["no Origin, no header", "foreign Origin", "missing X-Requested-With", "cross-site fetch metadata"] as const) {
    it(`rejected: ${variant}`, async () => {
      const headers: Record<string, string> =
        variant === "no Origin, no header" ? { Origin: "", "X-Requested-With": "" }
          : variant === "foreign Origin" ? { Origin: "https://evil.example" }
            : variant === "missing X-Requested-With" ? { "X-Requested-With": "" }
              : { Origin: "", "Sec-Fetch-Site": "cross-site" };
      const wrong: string[] = [];
      for (const r of routes.filter(mutates).filter((x) => x.path !== "/api/line/webhook")) {
        const res = await h.api(r.method, fill(r.path), { body: {}, token: root, headers });
        if (res.status !== 403 || !/^CSRF_/.test(res.error?.code ?? "")) wrong.push(`${r.method} ${r.path} → ${res.status} ${res.error?.code}`);
      }
      assert.deepEqual(wrong, []);
    });
  }

  it("the LINE webhook needs its HMAC signature instead (no session, no CSRF header)", async () => {
    h.lineSecrets();
    const unsigned = await h.webhook({ events: [] }, { signature: null });
    assert.equal(unsigned.status, 401);
    const forged = await h.webhook({ events: [] }, { signature: "AAAA" });
    assert.equal(forged.status, 401);
    const ok = await h.webhook({ destination: "U", events: [] });
    assert.equal(ok.status, 200);
  });
});

describe("hostile input never breaks the API", () => {
  it("path parameters (SQL, traversal, unicode, huge) on every route, as SUPER_ADMIN and anonymously", async () => {
    for (const value of HOSTILE_STRINGS) {
      root = await fresh();
      for (const r of routes) {
        if (r.path === "/api/line/webhook" || !r.path.includes(":") || SESSION_ENDING.has(r.path)) continue;
        for (const token of [root, null]) {
          const res = await h.api(r.method, fill(r.path, () => value), { body: bodyFor(r), token });
          assertSafe(res.status, JSON.stringify(res.body), `${r.method} ${r.path} [${value.slice(0, 20)}]`);
        }
      }
    }
  });

  it("query strings on every GET route", async () => {
    for (const value of HOSTILE_STRINGS) {
      const qs = new URLSearchParams({
        lang: value, q: value, from: value, to: value, checkIn: value, checkOut: value, adults: value, children: value,
        status: value, before: value, limit: value, type: value, code: value, path: value, group: value, unitId: value,
      }).toString();
      root = await fresh();
      for (const r of routes.filter((x) => x.method === "GET")) {
        for (const token of [root, null]) {
          const res = await h.api("GET", `${fill(r.path)}?${qs}`, { token });
          assertSafe(res.status, JSON.stringify(res.body), `GET ${r.path}?… [${value.slice(0, 20)}]`);
        }
      }
    }
  });

  it("malformed and hostile JSON bodies on every state-changing route", async () => {
    const bodies: (string | unknown)[] = [
      "{", "[]", "null", "\"text\"", "1e309", JSON.stringify({ __proto__: { admin: true }, constructor: { prototype: { admin: true } } }),
      JSON.stringify({ email: HOSTILE_STRINGS[0], password: HOSTILE_STRINGS[1], name: HOSTILE_STRINGS[3], id: HOSTILE_STRINGS[4] }),
      JSON.stringify({ deep: JSON.parse("[".repeat(500) + "]".repeat(500)) }),
      JSON.stringify({ amountSatang: -1, totalSatang: 1e21, adults: 1e9, checkIn: "2027-02-30", checkOut: "0000-00-00", roles: ["SUPER_ADMIN"] }),
    ];
    for (const body of bodies) {
      const raw = typeof body === "string" ? body : JSON.stringify(body);
      root = await fresh();
      for (const r of routes.filter(mutates).filter((x) => x.path !== "/api/line/webhook" && !SESSION_ENDING.has(x.path))) {
        for (const token of [root, null]) {
          const res = await h.api(r.method, fill(r.path), { rawBody: raw, token });
          assertSafe(res.status, JSON.stringify(res.body), `${r.method} ${r.path} body ${raw.slice(0, 30)}`);
        }
      }
    }
  });

  it("wrong content types and oversized bodies are refused before any work", async () => {
    const res = await h.api("POST", "/api/public/bookings/quote", { rawBody: "a=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    assert.equal(res.status, 415);
    const big = await h.api("POST", "/api/public/bookings/quote", { rawBody: JSON.stringify({ x: "a".repeat(200_000) }) });
    assert.equal(big.status, 413);
  });

  it("the database is intact after the fuzzing (tables, users, roles, no injected rows)", async () => {
    const tables = h.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    for (const t of ["users", "roles", "bookings", "payments", "audit_logs", "marketing_events"]) assert.ok(tables.includes(t), t);
    assert.equal(h.db.get<{ n: number }>("SELECT count(*) AS n FROM users")!.n, 2);
    assert.equal(h.db.get<{ n: number }>("SELECT count(*) AS n FROM user_roles WHERE user_id = 'nobody'")!.n, 0, "no privilege gained");
    const injected = h.db.all("SELECT * FROM audit_logs WHERE new_value LIKE '%<script>%' AND action LIKE 'CREATE_USER%'");
    assert.equal(injected.length, 0);
    // The site still answers normally, and the fuzzer's own session was never lost.
    assert.equal((await h.api("GET", "/api/public/site?lang=th")).status, 200);
    assert.equal((await h.api("GET", "/api/admin/users", { token: root })).status, 200);
  });
});

describe("responses never expose secrets or other guests' data", () => {
  it("public endpoints carry no internal ids, hashes, tokens or other guests' phone numbers", async () => {
    const body = { checkIn: "2027-03-01", checkOut: "2027-03-03", adults: 2, children: 0, stay: { kind: "UNIT", unitId: "dev_house_01" }, food: [], lang: "th" };
    const q = await h.api<{ totalSatang: number }>("POST", "/api/public/bookings/quote", { body });
    const b = await h.api<{ bookingCode: string }>("POST", "/api/public/bookings", {
      body: { ...body, customer: { name: "Private Guest", phone: "0899999999", email: "private@example.test" }, privacyAccepted: true, expectedTotalSatang: q.data.totalSatang, idempotencyKey: "route-sec-key-0000000001" },
    });
    assert.equal(b.status, 201);
    const publicGets = routes.filter((r) => r.method === "GET" && !isAdmin(r) && !r.path.includes(":") && r.path !== "/api/auth/me");
    for (const r of publicGets) {
      const res = await h.api("GET", `${r.path}?lang=th&path=/th/&checkIn=2027-03-01&checkOut=2027-03-03&adults=2&q=บ้าน`);
      const text = JSON.stringify(res.body);
      for (const secret of ["0899999999", "private@example.test", "Private Guest", "password_hash", "pbkdf2", "token_hash", "__Host-sid"]) {
        assert.ok(!text.includes(secret), `${r.path} exposes ${secret}`);
      }
    }
    // Lookup needs the phone: a wrong phone says nothing about the booking.
    const wrong = await h.api("POST", "/api/public/bookings/lookup", { body: { bookingCode: b.data.bookingCode, phone: "0800000000" } });
    assert.equal(wrong.status, 404);
    assert.doesNotMatch(JSON.stringify(wrong.body), /Private Guest|0899999999/);
    const unknown = await h.api("POST", "/api/public/bookings/lookup", { body: { bookingCode: "BK-20270101-ZZZZ", phone: "0800000000" } });
    assert.deepEqual([unknown.status, unknown.error?.code], [wrong.status, wrong.error?.code], "same answer: no booking enumeration");
  });

  it("every API response has the security headers and no-store unless explicitly public", async () => {
    for (const r of routes.filter((x) => x.method === "GET")) {
      const res = await h.get(fill(r.path), isAdmin(r) ? { Cookie: `__Host-sid=${root}` } : {});
      assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff", r.path);
      assert.equal(res.headers.get("X-Frame-Options"), "DENY", r.path);
      assert.match(res.headers.get("Content-Security-Policy") ?? "", /default-src 'none'/, r.path);
      if (isAdmin(r)) assert.match(res.headers.get("Cache-Control") ?? "", /no-store|private/, `${r.path} must not be cached`);
    }
  });
});

