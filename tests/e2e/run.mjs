#!/usr/bin/env node
// Browser end-to-end runner (Phase 15): builds the client, makes a throw-away TLS certificate and test
// images, then runs each suite against a fresh server (new in-memory database per suite).
//
//   npm run test:e2e                          all suites
//   npm run test:e2e -- phase14 responsive    selected suites
//
// Needs: `npm install` (playwright, tsx, vite), `npx playwright install chromium` (or CHROMIUM_PATH),
// and `openssl` for the certificate. Optional env:
//   E2E_DIST=dir        use an already built client (index.html + assets/) instead of `vite build`
//   E2E_FONT_FILE=path  a real WOFF2 file for the Phase 12 font upload check (skipped without it)
//   CHROMIUM_PATH=path  browser executable (default: Playwright's own)
//   E2E_PORT=8443
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtures } from "./fixtures.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const ALL = ["phase09", "phase10", "phase11", "phase12", "phase13", "phase14", "phase16", "payment", "multistay", "responsive"];
const suites = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = suites.length ? suites : ALL;
for (const s of selected) if (!ALL.includes(s)) { console.error(`unknown suite ${s} (known: ${ALL.join(", ")})`); process.exit(2); }

const PORT = Number(process.env.E2E_PORT ?? 8443); // not 4190: on the Fetch "bad ports" list (ManageSieve)
const BASE = `https://localhost:${PORT}`;
const work = mkdtempSync(join(tmpdir(), "phasakura-e2e-"));
const shots = join(ROOT, "tests", "e2e", ".output");
mkdirSync(shots, { recursive: true });

// 1. Client build
let dist = process.env.E2E_DIST;
if (!dist) {
  dist = join(work, "dist");
  console.log("building the client (vite build)…");
  const r = spawnSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) { console.error("client build failed (set E2E_DIST to use an existing build)"); process.exit(1); }
}
if (!existsSync(join(dist, "index.html"))) { console.error(`${dist}/index.html not found`); process.exit(1); }

// 2. Throw-away certificate (the session cookie is __Host-: HTTPS only)
const cert = join(work, "cert.pem");
const key = join(work, "key.pem");
const ssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost",
  "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
if (ssl.status !== 0) { console.error("openssl is needed to create a local certificate"); process.exit(1); }

// 3. Test images
const { chromium } = await import("playwright");
const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const fixtures = join(work, "fixtures");
await makeFixtures(fixtures, launch);

// 4. Suites, each on a fresh server
async function startServer(extraEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "tests", "e2e", "server.mts")], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), DIST: dist, TLS_CERT: cert, TLS_KEY: key, NODE_TLS_REJECT_UNAUTHORIZED: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return { child, log: () => log }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`server did not start:\n${log}`);
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
try {
  await fetch(`${BASE}/api/health`);
  console.error(`port ${PORT} is already in use — stop that server or set E2E_PORT`);
  process.exit(1);
} catch { /* free */ }

const summary = [];
for (const suite of selected) {
  // The Phase 9 suite checks that CAPI cannot be enabled before the token secret exists.
  // Phase 16 runs the production smoke test, so its server runs with APP_ENV=production.
  const server = await startServer(suite === "phase09" ? { E2E_NO_CAPI: "1" } : suite === "phase16" ? { E2E_APP_ENV: "production" } : {});
  console.log(`\n=== ${suite}`);
  const run = spawnSync(process.execPath, [join(ROOT, "tests", "e2e", `${suite}.mjs`)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", timeout: 15 * 60_000,
    env: { ...process.env, E2E_BASE: BASE, E2E_FIXTURES: fixtures, E2E_SHOTS: shots },
  });
  process.stdout.write(run.stdout ?? "");
  const line = (run.stdout ?? "").trim().split("\n").reverse().find((l) => /passed/.test(l)) ?? "no result";
  summary.push([suite, run.status === 0 ? "PASS" : "FAIL", line.trim()]);
  server.child.kill();
  await new Promise((r) => setTimeout(r, 500));
}

console.log("\n=== summary");
for (const [suite, status, line] of summary) console.log(`${status}  ${suite.padEnd(11)} ${line}`);
console.log(`screenshots: ${shots}`);
process.exit(summary.some((s) => s[1] === "FAIL") ? 1 : 0);
