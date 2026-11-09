import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const mode = process.argv[2], marker = "verified-" + randomUUID() + "-";
let script = "import {startRedis, publicChecks} from './bench-public/priority.mjs';\nawait startRedis();\n";
if (mode === "external") {
  script += readFileSync(new URL("./acceptance.mjs", import.meta.url), "utf8");
  script += "\nconsole.log(" + JSON.stringify(marker) + " + JSON.stringify(checks));";
} else {
  if (!["compile","keys","change","counts","all"].includes(mode)) throw Error("Unknown BullMQ command");
  script += "await publicChecks(" + JSON.stringify(mode) + ");\nconsole.log(" + JSON.stringify(marker) + ");";
}
const run = spawnSync("docker", [
  "run", "--rm", "-i", "--platform", "linux/amd64", "--network", "none", "--read-only",
  "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "65534:65534",
  "--memory", "256m", "--pids-limit", "48", "--tmpfs", "/tmp:rw,nosuid,noexec,size=32m",
  "--mount", "type=bind,source=" + process.cwd() + ",target=/project,readonly",
  "--entrypoint", "/usr/local/bin/node", "recast-bench-bullmq:node24-redis725-v1",
  "--disable-warning=ExperimentalWarning", "--experimental-transform-types", "--input-type=module", "-",
], {encoding:"utf8", input:script, timeout:60_000, maxBuffer:512_000, windowsHide:true});
const result = run.stdout?.split(/\r?\n/).find(s => s.startsWith(marker));
if (run.error || run.status !== 0 || !result) {
  console.error(run.error?.message ?? run.stderr?.trim() ?? "No verdict returned from BullMQ");
  process.exit(1);
}
console.log(mode === "external" ? result.slice(marker.length) : "passed " + mode);
