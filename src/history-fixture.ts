import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ProjectAnalysisCoordinator,
  projectAnalysisObjective,
  projectPlanHash,
  type CodeIntelligenceRuntime,
} from "../../weichai/services/code-intelligence-service/src/index.ts";
import type { Scenario, Unit } from "./scenarios/types.ts";
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function target(u: Unit) {
  return {
    id: u.name,
    name: u.name,
    kind: "module" as const,
    path: u.name + ".mjs",
    language: "TypeScript" as const,
    signature: u.name,
    module: {
      sourceFiles: [u.name + ".mjs"],
      coreApis: [],
      description: u.query,
      purpose: u.query,
      dependsOn: u.dependsOn ?? [],
    },
  };
}
/** Install fixed history source and labels into the caller's live repository store. */
export async function indexScenarioHistory(
  s: Scenario,
  root: string,
  runtime: CodeIntelligenceRuntime,
) {
  const { store } = runtime;
  const scopes = [],
    repos = [],
    catalog = [];
  for (const bucket of new Set(s.assets.map((a) => a.repo ?? 0))) {
    const assets = s.assets.filter((a) => (a.repo ?? 0) === bucket);
    const repositoryId = s.id.split("-")[0] + "-r" + bucket,
      localPath = join(root, repositoryId);
    await mkdir(localPath, { recursive: true });
    await writeFile(
      join(localPath, "package.json"),
      JSON.stringify({ name: repositoryId }),
    );
    const modules = [];
    for (const a of assets) {
      const main = a.id + (a.language === "Python" ? ".py" : ".ts");
      const sources = { [main]: a.code, ...a.files };
      for (const [file, content] of Object.entries(sources))
        await writeFile(join(localPath, file), content + "\n");
      modules.push({
        id: a.id,
        name: a.symbol,
        kind: "feature",
        description: a.description,
        purpose: a.description,
        language: a.language ?? "TypeScript",
        coreApis: [a.symbol],
        sourceFiles: Object.keys(sources),
        symbolKeys: [],
        dependsOn: a.dependsOn ?? [],
      });
    }
    const repo = {
      repositoryId,
      localPath,
      role: "history" as const,
      displayName: repositoryId,
    };
    repos.push(repo);
    await runtime.registry.register(repo);
    const run = await runtime.coordinator.run({ repositoryId });
    const idx = await store.getStructuralIndex(run.scope);
    if (!idx) throw Error("Missing index " + repositoryId);
    const primary = idx.files.find(
      (f) => f.relativePath === modules[0].sourceFiles[0],
    );
    if (!primary)
      throw Error("Primary module source was not indexed: " + repositoryId);
    const scope = { ...run.scope, projectId: primary.projectId };
    scopes.push(scope);
    const evidenceIds = ["project:" + scope.projectId];
    const owned = new Set(modules.flatMap((m) => m.sourceFiles));
    const unassignedFiles = idx.files
      .filter(
        (f) => f.projectId === scope.projectId && !owned.has(f.relativePath),
      )
      .map((f) => ({ path: f.relativePath, reason: "project configuration" }));
    const proposal = {
      ...run.scope,
      analysisHash: idx.analysisHash,
      objective: projectAnalysisObjective,
      summary: repositoryId,
      modules: modules.map((m) => ({ ...m, evidenceIds })),
      unassignedFiles,
    };
    const analysis = new ProjectAnalysisCoordinator({
      store,
      allowLargeAgentPlan: true,
      plan: async () => ({
        proposal,
        evidence: {
          ...run.scope,
          analysisHash: idx.analysisHash,
          planHash: projectPlanHash(proposal),
          evidenceIds,
        },
      }),
    });
    await analysis.ensure(scope, true);
    const state = await analysis.read(scope);
    if (state.state !== "ready" || state.projection !== "ready")
      throw Error("Module proposal " + JSON.stringify(state));
    catalog.push({
      ...scope,
      modules: modules.length,
      files: idx.files.length,
      documents: (await store.listSearchDocuments(scope)).length,
      edges: idx.dependencyEdges.length,
      analysisHash: idx.analysisHash,
    });
  }
  return { scopes, repos, catalog };
}
