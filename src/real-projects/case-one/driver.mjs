import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const mode = process.argv[2];
const marker = "result-" + randomUUID() + "-";
let script = "import sys, json\nsys.path.insert(0, '/project')\n";
if (mode === "external") {
  script += readFileSync(new URL("./acceptance.py", import.meta.url), "utf8");
  script += "\nprint(" + JSON.stringify(marker) + " + json.dumps(evaluate()))";
} else {
  if (!["compile", "catalog", "browser", "all"].includes(mode)) throw Error("Unknown mode");
  script += "from bench_checks.public import run\nrun(" + JSON.stringify(mode) + ")\n";
  script += "print(" + JSON.stringify(marker) + ")";
}
const run = spawnSync("docker", [
  "run", "--rm", "-i", "--platform", "linux/amd64", "--network", "none", "--read-only",
  "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "65534:65534",
  "--memory", "256m", "--pids-limit", "32", "--mount",
  "type=bind,source=" + process.cwd() + ",target=/project,readonly",
  "recast-bench-django:py312-qjs194-v1", "python", "-I", "-B", "-X", "utf8", "-"
], { encoding: "utf8", input: script, timeout: 45_000, maxBuffer: 256_000, windowsHide: true });
const line = run.stdout?.split(/\r?\n/).find((s) => s.startsWith(marker));
if (run.error || run.status !== 0 || !line) {
  console.error(run.error?.message ?? run.stderr?.trim() ?? "Runner exited without a result");
  process.exit(1);
}
console.log(mode === "external" ? line.slice(marker.length) : "passed " + mode);
