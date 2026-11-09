import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  copyFile,
} from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import {
  dirname,
  join,
  resolve,
  relative,
  isAbsolute,
  basename,
} from "node:path";
import {
  createCodeIntelligenceRuntime,
  buildProjectModuleProposal,
  projectPlanHash,
  projectAnalysisObjective,
  ProjectAnalysisCoordinator,
  RepositoryStructuralScanner,
} from "../../../weichai/services/code-intelligence-service/src/index.ts";
import { ModelModuleHierarchyPlanner } from "../../../weichai/services/code-intelligence-service/src/module-hierarchy-planner.ts";
import { agentClient } from "../openai.ts";
import {
  buildStore,
  countEmbeddingCalls,
  type WorkerJob,
} from "./worker-store.ts";
import { runScaleQueries, scaleQueryCases } from "./queries.ts";

const job: WorkerJob = JSON.parse(await readFile(process.argv[2], "utf8"));
const requested = ["full", ...(job.increments ?? ["one", "1pct", "10pct"])];
const result: any = {
  caseId: job.caseId,
  config: job.config,
  status: "running",
  current: "starting",
  steps: [],
  startedAt: new Date().toISOString(),
  modeling: job.agent ? "adaptive-module-tree/v1" : "directory-dependency/v1",
  incrementalProtocol:
    "Each mutation starts from the original byte snapshot and original analysis hash; restoring the original revision content between mutations runs outside measurement. Historical revisions and model cache are retained.",
};
await mkdir(dirname(job.resultFile), { recursive: true });
function save() {
  result.updatedAt = new Date().toISOString();
  writeFileSync(job.resultFile + ".tmp", JSON.stringify(result, null, 2));
  renameSync(job.resultFile + ".tmp", job.resultFile);
}
let lastSave = 0;
function checkpoint(point: string, force = false) {
  result.current = point;
  if (force || Date.now() - lastSave > 1500) {
    save();
    lastSave = Date.now();
  }
}

const stageNames = [
  "scan",
  "structural-write",
  "search-projection",
  "module-modeling",
  "summary-projection",
  "activation",
];
const counter = { calls: 0, vectors: 0, httpCalls: 0, httpInputs: 0 };
countEmbeddingCalls(counter);
let active: any = null;
let phaseStart = 0;
let baseCounts = { ...counter };
function sample() {
  if (!active) return;
  active.rssPeakBytes = Math.max(
    active.rssPeakBytes,
    process.memoryUsage.rss(),
  );
  active.processLifetimeRssPeakBytes = process.resourceUsage().maxRSS * 1024;
  active.embeddingCalls = counter.calls - baseCounts.calls;
  active.embeddingVectors = counter.vectors - baseCounts.vectors;
  active.embeddingHttpCalls = counter.httpCalls - baseCounts.httpCalls;
  active.embeddingHttpInputs = counter.httpInputs - baseCounts.httpInputs;
  active.elapsedMs = performance.now() - phaseStart;
}
function startStep(phase: string) {
  baseCounts = { ...counter };
  phaseStart = performance.now();
  active = {
    phase,
    status: "running",
    stages: Object.fromEntries(stageNames.map((k) => [k, null])),
    repos: [],
    files: 0,
    loc: 0,
    documents: 0,
    changedFiles: 0,
    rssPeakBytes: 0,
    parserPeakWorkerRssBytes: null,
    parserPeakCombinedRssBytes: null,
    parserWorkers: null,
    embeddingCalls: 0,
    embeddingVectors: 0,
  };
  result.steps.push(active);
  sample();
  checkpoint(phase + "/start", true);
  return active;
}
function addStage(name: string, ms: number) {
  if (active) active.stages[name] = (active.stages[name] ?? 0) + ms;
}
const originalInfo = console.info.bind(console);
console.info = (...args: any[]) => {
  if (
    active &&
    args[0] === "[forexplore:performance]" &&
    typeof args[1] === "string"
  ) {
    const event = JSON.parse(args[1]);
    if (stageNames.includes(event.stage) && Number.isFinite(event.durationMs))
      addStage(event.stage, event.durationMs);
  }
  originalInfo(...args);
};
const monitor = setInterval(() => {
  sample();
  if (active) checkpoint(result.current);
}, 250);
monitor.unref();

function bounded(root: string, file: string) {
  const full = resolve(root, file),
    rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw Error("Path outside mutable case root: " + file);
  return full;
}
async function fallbackSources(
  root: string,
  base: string = root,
): Promise<string[]> {
  const list = [];
  for (const ent of await readdir(base, { withFileTypes: true })) {
    const path = join(base, ent.name);
    if (ent.isDirectory()) list.push(...(await fallbackSources(root, path)));
    else if (
      ent.isFile() &&
      /\.(?:ts|tsx|js|mjs|cjs|jsx|cs|kt|java|py|go|rs|ets)$/i.test(ent.name)
    )
      list.push(relative(root, path).replaceAll("\\", "/"));
  }
  return list.sort();
}
const skip = new Set([".git", "node_modules", ".forexplore", "__pycache__"]);
async function materialize() {
  const repos = [];
  const mutableRoot = resolve(job.workDir, "inputs");
  await mkdir(mutableRoot, { recursive: true });
  for (const spec of job.repositories) {
    if (!/^[\w.-]+$/.test(spec.id)) throw Error("Invalid repository ID");
    const root = bounded(mutableRoot, spec.id);
    await cp(spec.root, root, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: async (p) =>
        !skip.has(basename(p)) && !(await lstat(p)).isSymbolicLink(),
    });
    const files: string[] =
      spec.sourceFiles ??
      (spec.sourceList
        ? JSON.parse(await readFile(spec.sourceList, "utf8"))
        : await fallbackSources(root));
    for (const f of files) bounded(root, f);
    repos.push({ ...spec, root, originalRoot: spec.root, files });
  }
  return repos;
}
async function execute() {
  if (job.agent && !["B02", "B03"].includes(job.caseId))
    throw Error("Agent modeling is limited to B02/B03");
  checkpoint("copy-inputs", true);
  const repos = await materialize();
  const members = repos.flatMap((r) =>
    r.files.toSorted().map((file) => ({ repo: r, file })),
  );
  const metrics = buildStore(job);
  const scanner = new RepositoryStructuralScanner();
  const baseScan = scanner.scan.bind(scanner);
  scanner.scan = async (req) => {
    const result = await baseScan(req);
    const p = result.parserResources;
    if (p && active) {
      active.parserPeakWorkerRssBytes = Math.max(
        active.parserPeakWorkerRssBytes ?? 0,
        p.peakWorkerRss,
      );
      active.parserPeakCombinedRssBytes = Math.max(
        active.parserPeakCombinedRssBytes ?? 0,
        p.peakCombinedRss,
      );
      active.parserWorkers = Math.max(active.parserWorkers ?? 0, p.workers);
    }
    return result;
  };
  try {
    const setupStart = performance.now();
    checkpoint("initialize-store", true);
    const runtime = await createCodeIntelligenceRuntime({
      store: metrics.store,
      scanner,
    });
    for (const r of repos)
      await runtime.registry.register({
        repositoryId: r.id,
        localPath: r.root,
        role: "history",
      });
    result.setupMs = performance.now() - setupStart;
    const agentCalls: any[] = [];
    const planner = job.agent
      ? new ModelModuleHierarchyPlanner({
          complete: async (messages, signal) =>
            (await agentClient(agentCalls).complete(messages, [], signal))
              .content,
          timeoutMs: 90000,
        })
      : undefined;
    const baseline = new Map<string, string>();
    const current = new Map<string, { scope: any; hash: string }>();
    async function build(r, changes: string[] | null, restore = false) {
      const label = (restore ? "restore" : active.phase) + "/" + r.id;
      let activation = 0;
      checkpoint(label + "/scan", true);
      const run = await runtime.coordinator.run({
        repositoryId: r.id,
        mode: changes ? "incremental" : "full",
        ...(changes ? { changedPaths: changes } : {}),
        onProgress: (p) => {
          if (p.stage === "activation") activation = performance.now();
          checkpoint(label + "/" + p.stage);
        },
      });
      if (activation) addStage("activation", performance.now() - activation);
      checkpoint(label + "/module-modeling", true);
      const idx = await runtime.store.getStructuralIndex(run.scope);
      if (!idx) throw Error("Missing structural index: " + r.id);
      if (restore && run.analysisHash !== baseline.get(r.id))
        throw Error("Restored source analysis hash mismatch for " + r.id);
      if (!changes) baseline.set(r.id, run.analysisHash);
      const modeling = new ProjectAnalysisCoordinator({
        store: metrics.store,
        ...(planner
          ? { hierarchyPlanner: planner }
          : {
              allowLargeAgentPlan: true,
              plan: async (scope) => {
                const proposal = buildProjectModuleProposal(
                  idx,
                  scope,
                  projectAnalysisObjective,
                );
                const ids = [
                  ...new Set([
                    ...proposal.modules.flatMap((m) => m.evidenceIds),
                    ...(proposal.dependencies ?? []).flatMap(
                      (e) => e.evidenceIds,
                    ),
                  ]),
                ];
                return {
                  proposal,
                  evidence: {
                    ...run.scope,
                    analysisHash: idx.analysisHash,
                    planHash: projectPlanHash(proposal),
                    evidenceIds: ids,
                  },
                };
              },
            }),
      });
      let modules = 0;
      for (const p of idx.projects) {
        const scope = { ...run.scope, projectId: p.projectId };
        checkpoint(label + "/module-modeling/" + p.projectId);
        await modeling.ensure(scope, true);
        checkpoint(label + "/module-state/" + p.projectId, true);
        const state = await modeling.read(scope);
        if (state.state !== "ready" || state.projection !== "ready")
          throw Error(
            "Module modeling/projection failed: " +
              (state.error ?? state.state),
          );
        modules += state.proposal?.modules.length ?? 0;
      }
      current.set(r.id, { scope: run.scope, hash: run.analysisHash });
      if (active) {
        checkpoint(label + "/document-count", true);
        let docs: number | null = null;
        let documentCountError: string | undefined;
        const readStarted = performance.now();
        try {
          docs = await metrics.documentCount(run.scope);
        } catch (e) {
          documentCountError = String(e.message ?? e);
          (active.measurementErrors ??= []).push({
            metric: "documents", repositoryId: r.id, message: documentCountError,
          });
        }
        active.documentCountMs = (active.documentCountMs ?? 0) + performance.now() - readStarted;
        active.files += idx.files.length;
        active.loc += r.loc ?? 0;
        active.documents = active.documents === null || docs === null ? null : active.documents + docs;
        active.changedFiles += changes?.length ?? 0;
        active.repos.push({
          repositoryId: r.id,
          scope: run.scope,
          analysisHash: run.analysisHash,
          parentHash: changes ? baseline.get(r.id) : null,
          files: idx.files.length,
          projects: idx.projects.length,
          modules,
          documents: docs,
          documentCountError,
          changed: changes?.length ?? 0,
          reusedFiles: run.reusedFileCount,
          status: run.status,
        });
      }
      sample();
    }
    const snapshots = new Map<string, string[]>();
    async function rollback() {
      for (const r of repos) {
        const edits = snapshots.get(r.id);
        if (!edits) continue;
        for (const file of edits)
          await copyFile(bounded(r.originalRoot, file), bounded(r.root, file));
        await build(r, edits, true);
      }
      snapshots.clear();
    }
    for (const phase of requested) {
      // The public stores cannot reactivate superseded revisions. Rebuild the restored
      // original bytes, and require the original analysis hash before measuring the next mutation.
      if (snapshots.size) await rollback();
      const storageBefore = await metrics.storage();
      const step = startStep(phase);
      try {
        if (phase === "full") {
          for (const r of repos) await build(r, null);
        } else {
          if (!members.length) throw Error("No editable source files");
          const n =
            phase === "one"
              ? 1
              : Math.ceil(members.length * (phase === "1pct" ? 0.01 : 0.1));
          for (let i = 0; i < n; i++) {
            const { repo, file } =
              members[Math.floor((i * members.length) / n)];
            if (!snapshots.has(repo.id)) snapshots.set(repo.id, []);
            snapshots.get(repo.id)!.push(file);
            await appendFile(
              bounded(repo.root, file),
              "\n" +
                (/\.py$/i.test(file) ? "#" : "//") +
                " RECAST build benchmark " +
                phase +
                "\n",
            );
          }
          for (const r of repos)
            if (snapshots.has(r.id)) {
              if (current.get(r.id)?.hash !== baseline.get(r.id))
                throw Error("Invalid incremental parent: " + r.id);
              await build(r, snapshots.get(r.id)!);
            }
        }
        sample();
        const seconds = step.elapsedMs / 1000;
        active = null;
        step.storageBefore = storageBefore;
        step.storage = await metrics.storage();
        step.throughput = {
          filesPerSecond: step.files / seconds,
          locPerSecond: step.loc / seconds,
          documentsPerSecond: step.documents === null ? null : step.documents / seconds,
        };
        step.status = "ok";
        checkpoint(phase + "/complete", true);
      } catch (e) {
        sample();
        active = null;
        step.status = "error";
        step.error = String(e.message ?? e);
        throw e;
      }
      if (
        phase === "full" &&
        job.queries &&
        scaleQueryCases.includes(job.caseId)
      ) {
        checkpoint("full/query-probes", true);
        try {
          result.queries = await runScaleQueries({
            caseId: job.caseId,
            config: job.config,
            runtime,
            store: metrics.store,
            repositoryIds: repos.map((r) => r.id),
            workDir: job.workDir,
            onProgress: (partial) => {
              result.queries = partial;
              checkpoint("full/query-probes", true);
            },
          });
        } catch (e) {
          result.queries = { status: "error", error: String(e.message ?? e) };
        }
        save();
      }
    }
    result.agentCalls = agentCalls;
    result.status = "ok";
    await runtime.close();
  } finally {
    await metrics.close();
  }
}
try {
  await execute();
  result.current = "complete";
} catch (e) {
  sample();
  result.error = String(e.message ?? e);
  result.status = "error";
  const prev = result.steps.find((s) => s.status === "running");
  if (prev) {
    prev.status = "error";
    prev.error = result.error;
  }
  for (const phase of requested)
    if (!result.steps.some((s) => s.phase === phase)) {
      result.steps.push({
        phase,
        status: phase === "full" ? "error" : "blocked",
        error: result.error,
      });
    }
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  result.completedAt = new Date().toISOString();
  save();
}
