import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { scenarios } from "./scenarios/index.ts";
import { corpus, digest } from "./corpus.ts";
import { execute } from "./velocity-simulator.ts";
import { modes } from "./harness.ts";
const option = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const batch = option("batch", new Date().toISOString().replace(/[:.]/g, "-"));
if (!/^[a-zA-Z0-9_-]+$/.test(batch)) throw Error("Invalid batch");
const filters = option("scenarios", "").split(",").filter(Boolean),
  pick = option("mode", "");
const selected = scenarios.filter(
  (s) => !filters.length || filters.includes(s.id.split("-")[0]),
);
if (!selected.length || (pick && !modes.includes(pick)))
  throw Error("Unknown selector");
const jobs = Number(option("jobs", "1"));
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 10)
  throw Error("jobs must be 1..10");
const out = resolve("results", "runs", batch),
  work = resolve("work", batch);
await mkdir(out, { recursive: true });
const pending = [...selected];
const commit = execFileSync("git", ["-C", "../weichai", "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
async function worker() {
  for (let s; (s = pending.shift()); ) {
    const offset = scenarios.indexOf(s) % 4,
      order = [...modes.slice(offset), ...modes.slice(0, offset)].filter(
        (m) => !pick || m === pick,
      );
    const c = await corpus(s, join(work, s.id));
    try {
      for (const mode of order) {
        const file = join(out, s.id + "_" + mode + ".json");
        try {
          const saved = JSON.parse(await readFile(file, "utf8"));
          if (
            saved.commit !== commit ||
            saved.project.analysisRevision !== digest(JSON.stringify(s))
          )
            throw Error(
              "Existing record uses different source or fixture; choose a new --batch: " +
                file,
            );
          console.log("already recorded", s.id, mode);
          continue;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        console.log("START", s.id, mode);
        const row = await execute(c, mode, join(work, s.id, mode));
        Object.assign(row, {
          batch,
          commit,
          node: process.version,
          platform: process.platform,
          concurrency: jobs,
          order,
        });
        await writeFile(file + ".tmp", JSON.stringify(row, null, 2));
        await rename(file + ".tmp", file);
        console.log(
          "END",
          s.id,
          mode,
          row.project.status,
          row.project.error ?? "",
          Math.round(row.elapsedMs),
        );
      }
    } finally {
      await c.close();
    }
  }
}
const workers = await Promise.allSettled(Array.from({ length: jobs }, worker));
for (const w of workers)
  if (w.status === "rejected") {
    console.error(w.reason);
    process.exitCode = 1;
  }
