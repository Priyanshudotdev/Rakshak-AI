// operator-reset.mjs — emergency operator recovery, runs ON THE VOICE BOX.
// Creates the operator or resets its password using the app's own hashing.
// The password is typed at a hidden prompt: it never appears in the command,
// shell history, logs, or chat.
//
//   cd /opt/rakshak/src && sudo -u asterisk node scripts/operator-reset.mjs <name> [--admin]
//
// --admin grants the admin role, but ONLY when creating a new operator.
// Needs DATABASE_URL in env (load from /opt/rakshak/api.env):
//   set -a; . /opt/rakshak/api.env; set +a
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { isPostgresConfigured } from "../apps/api/dist/db.js";
import { hashPassword } from "../apps/api/dist/auth.js";
import { createOperator, findOperatorByName, updatePasswordHash } from "../apps/api/dist/pgstore.js";

// Shell sourcing (. /opt/rakshak/api.env) silently yields nothing in some
// sudo contexts, so load the file directly — no shell, no quoting pitfalls.
function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z_0-9]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
if (!process.env.DATABASE_URL) loadEnvFile("/opt/rakshak/api.env");

const name = process.argv[2];
const makeAdmin = process.argv.includes("--admin");
if (!name) {
  console.error('usage: node scripts/operator-reset.mjs <name> [--admin]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (load /opt/rakshak/api.env first)");
  process.exit(1);
}
// Same boot init the API performs: creates the pool pgstore draws from.
if (!(await isPostgresConfigured())) {
  console.error("could not reach Postgres (DATABASE_URL wrong or Neon asleep — retry)");
  process.exit(1);
}

const password = await new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let buf = "";
  process.stdin.setEncoding("utf8");
  const onData = (c) => {
    if (c === "\r" || c === "\n") {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdout.write("\n");
      rl.close();
      resolve(buf);
    } else if (c === "" || c === "\b") {
      buf = buf.slice(0, -1);
    } else if (c >= " " && buf.length < 200) {
      buf += c;
    }
  };
  process.stdout.write(`New password for "${name}": `);
  process.stdin.setRawMode(true);
  process.stdin.on("data", onData);
});
if (!password || password.length < 4) {
  console.error("password must be at least 4 characters");
  process.exit(1);
}

const hash = await hashPassword(password);
const existing = await findOperatorByName(name);
if (existing) {
  const ok = await updatePasswordHash(String(existing.id), hash);
  console.log(ok ? `password reset for "${existing.name}" (role: ${existing.role})` : "update failed: operator vanished, retry");
} else {
  const op = await createOperator({ name, passwordHash: hash, role: makeAdmin ? "admin" : "operator" });
  console.log(`created "${op.name}" with role: ${op.role}`);
}
process.exit(0);
