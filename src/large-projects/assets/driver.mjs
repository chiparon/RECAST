import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { image } from "./image-tag.mjs";

const [task, mode] = process.argv.slice(2);
if (!["autocomplete", "prepopulate", "password"].includes(task)) throw Error("Unknown fixture");
const marker = "large-" + randomUUID() + "-";
let script = "import sys,json\nsys.path.insert(0,'/project')\n";
if (mode === "external") {
  // A submission may prevent importing its own modules. Emit failed checks in
  // that case, while letting unavailable Docker/Python runtimes fail this CLI.
  const checks = readFileSync(new URL("./" + task + "-acceptance.py", import.meta.url), "utf8");
  script += "from bench_checks.common import grade\nprint(" + JSON.stringify(marker) +
    " + json.dumps(grade(" + JSON.stringify(checks) + ")))\n";
} else {
  script += "from bench_checks.scenario import run\nrun(" + JSON.stringify(mode) + ")\nprint(" + JSON.stringify(marker) + ")\n";
}
const r = spawnSync("docker", [
  "run", "--rm", "-i", "--platform", "linux/amd64", "--network", "none", "--read-only",
  "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "65534:65534",
  "--memory", "384m", "--pids-limit", "32", "--mount",
  "type=bind,source=" + process.cwd() + ",target=/project,readonly",
  image, "python", "-I", "-B", "-X", "utf8", "-",
], { encoding: "utf8", input: script, timeout: 60_000, maxBuffer: 512_000, windowsHide: true });
const line = r.stdout?.split(/\r?\n/).find(s => s.startsWith(marker));
if (r.error || r.status !== 0 || !line) {
  console.error(r.error?.message ?? r.stderr?.trim() ?? "Runner exited without result");
  process.exit(1);
}
console.log(mode === "external" ? line.slice(marker.length) : "passed " + mode);
