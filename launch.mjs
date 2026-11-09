import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve("../weichai");
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const check = spawnSync(
  process.execPath,
  ["scripts/check-platform-workspace.mjs"],
  { cwd: root, stdio: "inherit" },
);
if (check.status !== 0) process.exit(check.status ?? 1);
const loader = pathToFileURL(
  resolve(root, "node_modules/tsx/dist/loader.mjs"),
).href;
const run = spawnSync(
  process.execPath,
  ["--import", loader, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(run.status ?? 1);
