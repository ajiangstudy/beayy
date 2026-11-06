import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cwd = path.dirname(fileURLToPath(import.meta.url));
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const wrangler = ["--yes", "wrangler@4.45.0"];

function run(args, allowFailure = false) {
  const result = spawnSync(command, [...wrangler, ...args], {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  const code = result.status ?? 1;
  if (code !== 0 && !allowFailure) process.exit(code);
  return code;
}

// First-time setup opens Cloudflare login in a browser; no API token or card is needed.
if (run(["whoami"], true) !== 0) {
  run(["login"]);
  if (run(["whoami"], true) !== 0) throw new Error("Cloudflare 登录未完成，请重新运行 npm run deploy。");
}

// Wrangler auto-creates the D1 database from its binding and provisions the SQLite DO class.
run(["deploy"]);

// Initialize the remote account/index schema. CREATE IF NOT EXISTS makes this safe to repeat.
run(["d1", "execute", "beayy-sync-selfhosted", "--remote", "--yes", "--file=./schema.sql"]);

console.log("\nBeayy sync is ready. Use the HTTPS workers.dev URL printed by Wrangler.");
