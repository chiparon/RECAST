// Query-only measurements run serially against a prebuilt index.
import { mkdir, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { scenarios } from "./scenarios/index.ts";
import { corpus, target } from "./corpus.ts";
import { retrieve } from "./harness.ts";
import { searchModulesWithSag2 } from "../../weichai/services/code-intelligence-service/src/sag2-retrieval.ts";
const batch = process.argv[2] ?? "latency";
if (!/^[a-zA-Z0-9_-]+$/.test(batch)) throw Error("Invalid batch");
const out = resolve("results", "latency", batch);
await mkdir(out, { recursive: true });
const modes = [
  "standard-1hop",
  "local-sag2-1hop",
  "local-sag2-2hop",
  "sag2-1hop",
  "sag2-2hop",
];
for (const s of scenarios) {
  const c = await corpus(s, resolve("work", "latency-" + batch, s.id));
  const rows = [];
  try {
    for (const u of s.units) {
      for (let round = 0; round <= 25; round++)
        for (let j = 0; j < modes.length; j++) {
          const mode = modes[(j + round + scenarios.indexOf(s)) % modes.length];
          if (
            round > 5 &&
            !mode.startsWith("local-") &&
            mode !== "standard-1hop"
          )
            continue;
          let ms,
            ranked,
            hops = null,
            judgeMs = null;
          if (mode.startsWith("local-")) {
            const req = {
              target: target(u),
              requirement: u.query,
              topK: 4,
              repositoryIds: c.scopes.map((x) => x.repositoryId),
            };
            const t = performance.now();
            const results = await searchModulesWithSag2(
              c.store,
              req,
              undefined,
              {
                maxHops: mode.endsWith("2hop") ? 2 : 1,
                observeDiagnostics: (d) => {
                  hops = d.hopsExecuted;
                },
              },
            );
            ms = performance.now() - t;
            ranked = results.map((x) => x.sourceModule.moduleId);
          } else {
            const { trace } = await retrieve(c, u, mode, undefined);
            ms = trace.retrievalMs;
            ranked = trace.ranked.map((x) => x.id);
            hops = trace.diagnostics?.hopsExecuted ?? null;
            judgeMs = trace.judge.reduce((v, x) => v + x.ms, 0);
          }
          rows.push({
            scenario: s.id,
            unit: u.name,
            mode,
            round,
            warmup: round === 0,
            ms,
            ranked,
            hops,
            judgeMs,
          });
        }
    }
  } finally {
    await c.close();
  }
  const file = join(out, s.id + ".json");
  await writeFile(
    file + ".tmp",
    JSON.stringify({ rows, catalog: c.catalog, plan: c.plan }, null, 2),
  );
  await rename(file + ".tmp", file);
  console.log("LATENCY", s.id, rows.length);
}
