/**
 * D1 backup (Phase 16): records the current Time Travel bookmark, then exports the production database
 * to backups/<database>-<UTC time>.sql with a SHA-256 checksum next to it.
 *
 *   npm run db:backup                      # remote production database (needs `wrangler login`)
 *   npm run db:backup -- --database other  # another database name
 *
 * The export holds guests' personal data and password hashes: keep it encrypted and off shared drives,
 * never commit it (backups/ is gitignored). A running export blocks other queries to the database for
 * its duration — run it at a quiet time. Restore steps: docs/PRODUCTION.md → Backup & restore.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** backups/chomkhao-db-20270110T030000Z.sql */
export function backupFileName(database: string, at: Date): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(database)) throw new Error(`invalid database name: ${database}`);
  return `${database}-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.sql`;
}

function wrangler(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function main(): void {
  const ROOT = join(import.meta.dirname, "..");
  const { values } = parseArgs({ options: { database: { type: "string", default: "chomkhao-db" } } });
  const database = values.database!;
  const dir = join(ROOT, "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, backupFileName(database, new Date()));

  console.log(`Time Travel bookmark before the export (restore point if anything goes wrong):`);
  process.stdout.write(wrangler(["d1", "time-travel", "info", database]));

  console.log(`\nExporting ${database} (remote) → ${file}`);
  wrangler(["d1", "export", database, "--remote", `--output=${file}`]);
  chmodSync(file, 0o600);
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(`${file}.sha256`, `${sha}  ${file.split("/").pop()}\n`, { mode: 0o600 });
  console.log(`Done: ${(statSync(file).size / 1024).toFixed(0)} KB, sha256 ${sha}`);
  console.log("Next: encrypt it and copy it off this machine (e.g. an encrypted drive or password-manager attachment).");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) main();
