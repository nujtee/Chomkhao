/**
 * One-time bootstrap of the first SUPER_ADMIN (no default admin/password ships in migrations).
 *
 *   npm run admin:bootstrap -- --email owner@example.com --name "Owner" [--username owner] [--out bootstrap.sql]
 *   npx wrangler d1 execute chomkhao-db --remote --file bootstrap.sql   # or --local
 *   rm bootstrap.sql
 *
 * - A strong random password is generated and printed ONCE to this terminal (never written to the file).
 *   Set BOOTSTRAP_PASSWORD to choose your own instead (must pass the password policy).
 * - The account must change its password at first login.
 * - The SQL only inserts when no ACTIVE SUPER_ADMIN exists, so running it twice is harmless.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { hashPassword, validatePasswordPolicy } from "../src/worker/security/password.ts";
import { randomToken } from "../src/worker/security/tokens.ts";

function sqlString(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

export async function buildBootstrapSql(input: {
  id: string;
  email: string;
  displayName: string;
  username: string | null;
  password: string;
}): Promise<string> {
  const hash = await hashPassword(input.password);
  const noActiveSuperAdmin = `NOT EXISTS (SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
      WHERE ur.role_id = 'role_super_admin' AND u.status = 'ACTIVE')`;
  return `-- Bootstrap first SUPER_ADMIN. Contains a password HASH only. Delete this file after use.
INSERT INTO users (id, email, username, display_name, password_hash, password_changed_at, must_change_password, status)
SELECT ${sqlString(input.id)}, ${sqlString(input.email)}, ${sqlString(input.username)}, ${sqlString(input.displayName)},
       ${sqlString(hash)}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1, 'ACTIVE'
 WHERE ${noActiveSuperAdmin};
INSERT INTO user_roles (user_id, role_id)
SELECT ${sqlString(input.id)}, 'role_super_admin'
 WHERE EXISTS (SELECT 1 FROM users WHERE id = ${sqlString(input.id)}) AND ${noActiveSuperAdmin};
INSERT INTO audit_logs (id, user_id, action, module, record_id, new_value)
SELECT ${sqlString(crypto.randomUUID())}, NULL, 'BOOTSTRAP_SUPER_ADMIN', 'users', ${sqlString(input.id)},
       json_object('email', ${sqlString(input.email)})
 WHERE EXISTS (SELECT 1 FROM user_roles WHERE user_id = ${sqlString(input.id)});
`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      username: { type: "string" },
      out: { type: "string", default: "bootstrap-super-admin.sql" },
    },
  });
  const email = values.email?.trim().toLowerCase();
  const displayName = values.name?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName) {
    console.error('Usage: npm run admin:bootstrap -- --email you@example.com --name "Your Name" [--username you] [--out file.sql]');
    process.exit(1);
  }
  const username = values.username?.trim() || null;
  if (username && !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    console.error("Invalid username (3–32 chars: letters, digits, . _ -)");
    process.exit(1);
  }

  const chosen = process.env.BOOTSTRAP_PASSWORD;
  const password = chosen ?? `${randomToken(18)}`;
  const policyError = validatePasswordPolicy(password, [email, username ?? "", displayName]);
  if (policyError) {
    console.error(`BOOTSTRAP_PASSWORD rejected by password policy: ${policyError}`);
    process.exit(1);
  }

  const sql = await buildBootstrapSql({ id: crypto.randomUUID(), email, displayName, username, password });
  writeFileSync(values.out!, sql, { mode: 0o600 });

  console.log(`\nWrote ${values.out} (password hash only).`);
  console.log(`Apply:  npx wrangler d1 execute chomkhao-db --remote --file ${values.out}   (or --local)`);
  console.log(`Then delete ${values.out}.\n`);
  if (!chosen) {
    console.log("Temporary password (shown once — you must change it at first login):");
    console.log(`  ${password}\n`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  await main();
}
