import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { scenarios } from "./scenarios/index.ts";
import { modes } from "./harness.ts";
import { percentile, retrievalMetrics } from "./metrics.ts";
import { digest } from "./corpus.ts";
const folder = join("results", "runs", process.env.RECAST_BATCH ?? "measured");
test("nearest-rank percentiles and top-k use observed ranks", () => {
  assert.equal(percentile([6, 5, 1, 2, 4, 3], 0.95), 6);
  assert.equal(percentile([], 0.5), null);
  const row = {
    scenario: scenarios[2].id,
    mode: "sag2-2hop",
    retrieval: [
      {
        unit: "a",
        required: ["a", "b"],
        ranked: [
          { id: "b", candidateId: "new" },
          { id: "a", candidateId: "old" },
        ],
        diagnostics: { responsibilities: [], hop2NewlyDiscoveredIds: [] },
      },
    ],
    translations: [],
  };
  const [m] = retrievalMetrics(row);
  assert.equal(m.anchorHit1, 0);
  assert.equal(m.mrr, 0.5);
  assert.equal(m.recall4, 1);
  assert.equal(m.contextCompleteness, null);
});
test("40 distinct deliveries, actual FTS plans, fixed tests and isolated commits", async () => {
  const files = (await readdir(folder)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 40);
  const outputs = new Set(),
    suiteHashes = new Map();
  for (const s of scenarios)
    for (const mode of modes) {
      const r = JSON.parse(
        await readFile(join(folder, s.id + "_" + mode + ".json"), "utf8"),
      );
      assert.equal(r.scenario, s.id);
      assert.equal(r.mode, mode);
      assert.equal(r.project.status, "completed", r.project.error);
      assert.equal(r.project.acceptance, "behavior-verified");
      assert.ok(r.e2eDeliveryMs > 0);
      assert.ok(
        r.queryPlan.some((x) => x.includes("sag2_fts VIRTUAL TABLE INDEX")),
      );
      const root = r.project.outputRoot;
      assert.ok(!outputs.has(root));
      outputs.add(root);
      assert.equal(
        execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        r.project.commit,
      );
      assert.equal(
        execFileSync("git", ["-C", root, "rev-parse", "HEAD^"], {
          encoding: "utf8",
        }).trim(),
        r.project.baselineCommit,
      );
      const validation = r.project.validation;
      assert.equal(validation.protectedFilesUnchanged, true);
      for (const t of r.translations) {
        assert.ok(t.record.modelTurns > 0);
        assert.equal(t.record.acceptance, "behavior-verified");
        assert.ok(t.record.compilations.at(-1)?.success);
        assert.ok(t.record.verification.runs.at(-1)?.success);
        for (const crit of t.record.verification.criteria) {
          const hash = digest(await readFile(join(root, crit.path), "utf8"));
          assert.equal(hash, crit.hash);
          const key = s.id + "/" + crit.path;
          if (suiteHashes.has(key)) assert.equal(hash, suiteHashes.get(key));
          suiteHashes.set(key, hash);
        }
      }
      assert.equal(r.retrieval.length, s.units.length);
      assert.equal(
        r.project.modules.filter((x) => !x.taskKind).length,
        s.units.length,
      );
      if (s.id.startsWith("s08")) assert.equal(r.catalog.length, 6);
      if (s.id.startsWith("s10")) {
        assert.ok(r.catalog[0].modules >= 60);
        assert.ok(r.catalog[0].documents >= 600);
      }
      execFileSync(process.execPath, ["tests/check.mjs"], {
        cwd: root,
        timeout: 20000,
      });
      execFileSync(process.execPath, ["tests/all.mjs"], {
        cwd: root,
        timeout: 20000,
      });
    }
});
