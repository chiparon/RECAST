import { join } from "node:path";
import type {
  CodeIntelligenceRuntime,
  IndexStore,
} from "../../../weichai/services/code-intelligence-service/src/index.ts";
import { searchModules } from "../../../weichai/services/code-intelligence-service/src/module-matching.ts";
import { searchModulesWithSag2 } from "../../../weichai/services/code-intelligence-service/src/sag2-retrieval.ts";
import { scenarios } from "../scenarios/index.ts";
import type { Scenario } from "../scenarios/types.ts";
import { digest, indexScenarioHistory, target } from "../history-fixture.ts";
import { percentile } from "../metrics.ts";

export const scaleQueryCases = ["B03", "B06", "B08", "B09"];
const selectedIds = ["s01", "s03", "s06", "s07"];
const probes = scenarios.filter((s) => selectedIds.includes(s.id.slice(0, 3)));
const overlayId = "scaleprobe";
const repositoryId = overlayId + "-r0";
const warmRepeats = 5;
const modes = ["standard-1hop", "sag2-2hop"] as const;
type Mode = (typeof modes)[number];
type Phase = "cold" | "warm";
interface Sample {
  query: string;
  unit: string;
  mode: Mode;
  phase: Phase;
  repeat: number;
  ms: number;
  status: "ok" | "error";
  recallAt4: number | null;
  hops: number | null;
  ranked: Array<{ repositoryId: string; moduleId: string; path: string }>;
  error?: string;
}

const overlay: Scenario = {
  id: overlayId,
  // Prefix only the repeated distractor IDs. Original implementation paths and dependency IDs stay intact.
  assets: probes.flatMap((s) =>
    s.assets.map((a) =>
      a.id.startsWith("display-")
        ? { ...a, id: s.id.slice(0, 3) + "-" + a.id }
        : a,
    ),
  ),
  units: probes.flatMap((s) => s.units),
};
const labels = probes.flatMap((s) =>
  s.units.map((u) => ({
    query: s.id.slice(0, 3),
    unit: u.name,
    requirement: u.query,
    required: u.required.map((moduleId) => ({ repositoryId, moduleId })),
  })),
);

function summarize(samples: Sample[], mode: Mode, phase: Phase, query: string) {
  const group = samples.filter(
    (s) =>
      s.mode === mode &&
      s.phase === phase &&
      (query === "all" || s.query === query),
  );
  const success = group.filter((s) => s.status === "ok");
  const times = success.map((s) => s.ms);
  const recall = success.reduce((n, s) => n + s.recallAt4!, 0);
  return {
    mode,
    phase,
    query,
    planned: group.length,
    succeeded: times.length,
    failed: group.length - times.length,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    recallAt4: success.length ? recall / success.length : null,
    recallAt4IncludingErrors: group.length ? recall / group.length : null,
  };
}

export interface ScaleQueryInput {
  caseId: string;
  config: string;
  runtime: CodeIntelligenceRuntime;
  store: IndexStore;
  repositoryIds: string[];
  workDir: string;
  onProgress?: (snapshot: {
    status: string;
    samples: Sample[];
    summary: ReturnType<typeof summarize>[];
  }) => void;
}

export async function runScaleQueries({
  caseId,
  config,
  runtime,
  store,
  repositoryIds,
  workDir,
  onProgress,
}: ScaleQueryInput) {
  const samples: Sample[] = [];
  const errors: string[] = [];
  const nativeIds = [...new Set(repositoryIds)];
  const scope = [...nativeIds, repositoryId];
  const protocol = {
    version: 1,
    overlayHash: digest(JSON.stringify(overlay)),
    warmRepeats,
    topK: 4,
    cold: "first call per query/mode after projection; shared store, OS and DB pages are not flushed",
    warm: "five subsequent fresh searches per query/mode, serially interleaved; no host result cache",
    truth:
      "Four fixed S scenarios in one additional indexed repository; recall scores exact repository/module IDs of the labeled probe only",
    algorithms:
      "standard searchModules vs SAG2 maxHops=2 with product's StructuralSag2JevJudge",
  };
  let overlayCatalog: unknown[] = [],
    ownsProbe = false;
  const snapshot = (status: string) => ({
    caseId,
    config,
    status,
    protocol,
    errors,
    scope,
    probes: labels,
    overlayCatalog,
    samples,
    summary: modes.flatMap((mode) =>
      (["cold", "warm"] as const).flatMap((phase) =>
        ["all", ...selectedIds].map((query) =>
          summarize(samples, mode, phase, query),
        ),
      ),
    ),
  });
  onProgress?.(snapshot("running"));
  try {
    if (!scaleQueryCases.includes(caseId))
      throw Error("No scale query protocol for " + caseId);
    if (
      !nativeIds.length ||
      nativeIds.includes(repositoryId) ||
      scope.length > 32
    )
      throw Error("Invalid scale-query repository scope: " + scope.length);
    if (await store.getRepository(repositoryId))
      throw Error("Reserved probe repository ID already exists");
    for (const id of nativeIds) {
      const repo = await store.getRepository(id);
      if (
        !repo?.activeRevision ||
        repo.role !== "history" ||
        (
          await store.getRevision({
            repositoryId: id,
            analysisRevision: repo.activeRevision,
          })
        )?.status !== "ready"
      )
        throw Error(
          "Expected an active, queryable native history revision: " + id,
        );
    }
    ownsProbe = true;
    const installed = await indexScenarioHistory(
      overlay,
      join(workDir, "query-fixture"),
      runtime,
    );
    overlayCatalog = installed.catalog;
    for (let repeat = 0; repeat <= warmRepeats; repeat++) {
      for (let index = 0; index < probes.length; index++) {
        const scenario = probes[(index + repeat) % probes.length];
        for (const u of scenario.units) {
          const request = {
            target: target(u),
            requirement: u.query,
            topK: 4,
            repositoryIds: scope,
          };
          for (let i = 0; i < modes.length; i++) {
            const mode = modes[(i + index + repeat) % modes.length];
            const sample: Sample = {
              query: scenario.id.slice(0, 3),
              unit: u.name,
              mode,
              phase: repeat === 0 ? "cold" : "warm",
              repeat,
              ms: 0,
              status: "ok",
              ranked: [],
              hops: null,
              recallAt4: null,
            };
            const begin = performance.now();
            try {
              const found =
                mode === "standard-1hop"
                  ? await searchModules(store, request)
                  : await searchModulesWithSag2(store, request, undefined, {
                      maxHops: 2,
                      observeDiagnostics: (d) => {
                        sample.hops = d.hopsExecuted;
                      },
                    });
              sample.ms = performance.now() - begin;
              sample.ranked = found.slice(0, 4).flatMap((c) =>
                c.sourceModule
                  ? [
                      {
                        repositoryId: c.sourceModule.repositoryId,
                        moduleId: c.sourceModule.moduleId,
                        path: c.path,
                      },
                    ]
                  : [],
              );
              const hits = new Set(
                sample.ranked
                  .filter((m) => m.repositoryId === repositoryId)
                  .map((m) => m.moduleId),
              );
              sample.recallAt4 =
                u.required.filter((id) => hits.has(id)).length /
                u.required.length;
            } catch (e) {
              sample.ms = performance.now() - begin;
              sample.status = "error";
              sample.error = e instanceof Error ? e.message : String(e);
            }
            samples.push(sample);
            onProgress?.(snapshot("running"));
          }
        }
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    if (ownsProbe) {
      try {
        if (await store.getRepository(repositoryId))
          await store.removeRepository(repositoryId);
      } catch (e) {
        errors.push(
          "Removing query probe: " +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }
  }
  const failed = samples.filter((s) => s.status === "error").length;
  return snapshot(errors.length ? "error" : failed ? "partial" : "ok");
}
