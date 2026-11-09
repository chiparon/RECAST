import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CodeIntelligenceHost } from "../../../weichai/apps/vscode-extension/src/code-intelligence-host.ts";
import type { ProjectModuleProposal } from "../../../weichai/packages/contracts/src/index.ts";
import {
  createCodeIntelligenceRuntime,
  ProjectAnalysisCoordinator,
  projectAnalysisObjective,
  projectPlanHash,
  Sag2Bm25IndexStore,
} from "../../../weichai/services/code-intelligence-service/src/index.ts";
import type { MethodTask } from "./method-types.ts";

// Index only public upstream references all arms can read. Preserve their real names,
// contents and scanner-owned file/symbol identifiers. Native checks use the full tree.
export async function openRealIndex(
  task: MethodTask,
  sourceRoot: string,
  runRoot: string,
  signal: AbortSignal,
) {
  const localPath = join(runRoot, "reference-source");
  const databasePath = join(runRoot, "reference.sqlite");
  await mkdir(localPath, { recursive: true });
  await writeFile(
    join(localPath, "package.json"),
    JSON.stringify({ name: "upstream-public-reference-view", private: true }),
  );
  for (const path of task.referenceFiles) {
    signal.throwIfAborted();
    await mkdir(dirname(join(localPath, path)), { recursive: true });
    await copyFile(join(sourceRoot, path), join(localPath, path));
  }
  const store = new Sag2Bm25IndexStore({ bm25: { databasePath } });
  const runtime = await createCodeIntelligenceRuntime({ store });
  const host = new CodeIntelligenceHost({
    runtimeFactory: async () => runtime,
  });
  const close = async () => {
    try {
      host.dispose();
      await runtime.close();
    } finally {
      await store.close();
    }
  };
  try {
    const repositoryId = "upstream-public-references";
    const repo = {
      repositoryId,
      role: "history" as const,
      localPath,
      displayName: task.title,
    };
    await runtime.registry.register(repo);
    const scan = await runtime.coordinator.run({ repositoryId, signal });
    const index = await store.getStructuralIndex(scan.scope);
    if (!index) throw Error("Missing upstream structural index.");
    const referenceSet = new Set(task.referenceFiles);
    const sources = index.files.filter(
      (file) => referenceSet.has(file.relativePath) && file.languageId,
    );
    if (!sources.length)
      throw Error("SQLite scanner recognized no upstream reference modules.");
    const scopes = [];
    for (const projectId of new Set(sources.map((file) => file.projectId))) {
      const scoped = sources.filter((file) => file.projectId === projectId);
      const scope = { ...scan.scope, projectId };
      const evidenceIds = scoped.map((file) => "file:" + file.fileId);
      const proposal: ProjectModuleProposal = {
        ...scan.scope,
        analysisHash: index.analysisHash,
        objective: projectAnalysisObjective,
        summary: task.title + " public upstream source files",
        modules: scoped.map((file) => {
          const symbols = index.symbols.filter(
            (s) => s.relativePath === file.relativePath,
          );
          const name = file.relativePath;
          const description =
            name +
            " — " +
            symbols
              .slice(0, 16)
              .map((s) => s.name)
              .join(", ");
          return {
            id: file.fileId,
            name,
            kind: "feature",
            purpose: description,
            description,
            sourceFiles: [name],
            coreApis: symbols.map((s) => s.name),
            symbolKeys: symbols.map((s) => s.symbolKey),
            dependsOn: [],
            evidenceIds: ["file:" + file.fileId],
            language: file.languageId!,
          };
        }),
        unassignedFiles: index.files
          .filter((f) => f.projectId === projectId && !scoped.includes(f))
          .map((f) => ({
            path: f.relativePath,
            reason: "Reference project discovery metadata",
          })),
      };
      const modeling = new ProjectAnalysisCoordinator({
        store,
        allowLargeAgentPlan: true,
        plan: async () => ({
          proposal,
          evidence: {
            ...scan.scope,
            analysisHash: index.analysisHash,
            planHash: projectPlanHash(proposal),
            evidenceIds,
          },
        }),
      });
      await modeling.ensure(scope, true);
      const state = await modeling.read(scope);
      if (state.state !== "ready" || state.projection !== "ready")
        throw Error(state.error ?? "Failed to project upstream references");
      scopes.push(scope);
    }
    await host.synchronize({ repositories: [repo], scan: false, signal });
    return {
      store,
      host,
      repositoryId,
      databasePath,
      scopes,
      indexedFiles: sources.map((f) => f.relativePath),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
