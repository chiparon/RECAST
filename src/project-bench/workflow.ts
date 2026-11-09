import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ProjectModuleProposal,
  WorkspaceTranslationRun,
} from "../../../weichai/packages/contracts/src/index.ts";
import { CodeIntelligenceHost } from "../../../weichai/apps/vscode-extension/src/code-intelligence-host.ts";
import {
  prepareDirectModuleTranslationScope,
  prepareIntegrationTranslationScope,
  prepareModuleTranslationScope,
} from "../../../weichai/apps/vscode-extension/src/module-translation-handoff.ts";
import { orderModulesByDependency } from "../../../weichai/apps/vscode-extension/src/module-order.ts";
import { ProjectPipeline } from "../../../weichai/apps/vscode-extension/src/project-pipeline.ts";
import { ProjectPipelineFiles } from "../../../weichai/apps/vscode-extension/src/project-pipeline-files.ts";
import type { ProjectPipelineModule } from "../../../weichai/apps/vscode-extension/src/project-pipeline-types.ts";
import { WorkspaceTranslationRuntime } from "../../../weichai/services/adaptation-service/src/workspace-translation-runtime.ts";
import type { WorkspaceTranslationModelClient } from "../../../weichai/services/adaptation-service/src/workspace-translation-agent.ts";
import { compileWorkspace } from "../../../weichai/services/adaptation-service/src/workspace-compiler.ts";
import {
  createCodeIntelligenceRuntime,
  ProjectAnalysisCoordinator,
  projectAnalysisObjective,
  projectPlanHash,
  Sag2Bm25IndexStore,
  searchModulesWithSag2,
} from "../../../weichai/services/code-intelligence-service/src/index.ts";
import type { ProjectTask } from "./fixture-format.ts";
import { publicTestCommand, publicCompileCommand } from "./commands.ts";

type InputProject = Pick<
  ProjectTask,
  "id" | "requirement" | "title" | "modules" | "files"
>;
interface WorkflowOptions {
  mode: "recast" | "sag2sql";
  project: InputProject;
  sourceRoot: string;
  runRoot: string;
  client: WorkspaceTranslationModelClient;
  signal: AbortSignal;
  maxTurns: number;
}

function projectModules(project: InputProject): ProjectPipelineModule[] {
  return orderModulesByDependency(
    project.modules.map(
      (unit): ProjectPipelineModule => ({
        id: unit.name,
        name: unit.name,
        status: "pending",
        dependsOn: unit.dependsOn ?? [],
        candidates: [],
        target: {
          id: unit.name,
          name: unit.name,
          kind: "module",
          language: "TypeScript", // Contract enum groups JS and TS.
          path: unit.path,
          signature: unit.name,
          module: {
            sourceFiles: [unit.path],
            coreApis: [],
            purpose: unit.description,
            description: unit.description,
            dependsOn: unit.dependsOn ?? [],
          },
        },
      }),
    ),
  );
}

// Index only the public reference files present in every lane's input. Use the
// actual file text / scanner metadata; no expected implementation or grader is input.
async function openPublicReferenceIndex(
  project: InputProject,
  runRoot: string,
  signal: AbortSignal,
) {
  const referenceFiles = Object.keys(project.files)
    .filter((f) => f.startsWith("refs/") && f.endsWith(".mjs"))
    .sort();
  if (!referenceFiles.length)
    throw Error("SAG2 SQLite lane requires public reference modules");
  const localPath = join(runRoot, "reference-source"),
    dbFile = join(runRoot, "public-references.sqlite");
  await mkdir(localPath, { recursive: true });
  await writeFile(
    join(localPath, "package.json"),
    JSON.stringify({ name: "project-bench-public-references", type: "module" }),
  );
  for (const file of referenceFiles) {
    signal.throwIfAborted();
    await mkdir(dirname(join(localPath, file)), { recursive: true });
    await writeFile(join(localPath, file), project.files[file]);
  }
  const store = new Sag2Bm25IndexStore({ bm25: { databasePath: dbFile } });
  try {
    const runtime = await createCodeIntelligenceRuntime({ store });
    const host = new CodeIntelligenceHost({
      runtimeFactory: async () => runtime,
    });
    try {
      const repositoryId = "public-references";
      const repo = {
        repositoryId,
        role: "history" as const,
        localPath,
        displayName: "Public project references",
      };
      await runtime.registry.register(repo);
      const scan = await runtime.coordinator.run({ repositoryId, signal });
      const index = await store.getStructuralIndex(scan.scope);
      if (!index)
        throw Error("Public-reference scan did not produce a structural index");
      const first = index.files.find(
        (f) => f.relativePath === referenceFiles[0],
      );
      if (!first)
        throw Error(
          "Public reference missing in structural index: " + referenceFiles[0],
        );
      const scope = { ...scan.scope, projectId: first.projectId };
      const evidenceIds = ["project:" + scope.projectId];
      const proposal: ProjectModuleProposal = {
        ...scan.scope,
        analysisHash: index.analysisHash,
        objective: projectAnalysisObjective,
        summary:
          "Public reference source modules supplied with " + project.title,
        modules: referenceFiles.map((path) => {
          const name = basename(path, ".mjs"),
            symbols = index.symbols.filter((s) => s.relativePath === path);
          const description = project.files[path]
            .trim()
            .split(/\r?\n/, 1)[0]
            .replace(/^\s*\/\/\s*/, "");
          return {
            id: name,
            name,
            kind: "feature",
            description: description || name,
            purpose: description || name,
            coreApis: symbols.map((s) => s.name),
            sourceFiles: [path],
            symbolKeys: symbols.map((s) => s.symbolKey),
            dependsOn: [],
            evidenceIds,
            language: "JavaScript",
          };
        }),
        unassignedFiles: index.files
          .filter(
            (f) =>
              f.projectId === scope.projectId &&
              !referenceFiles.includes(f.relativePath),
          )
          .map((f) => ({
            path: f.relativePath,
            reason: "index project configuration",
          })),
      };
      const modeling = new ProjectAnalysisCoordinator({
        store,
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
        throw Error(
          "Public reference modeling failed: " + (state.error ?? state.state),
        );
      await host.synchronize({ repositories: [repo], scan: false, signal });
      return {
        repositoryId,
        scope,
        store,
        host,
        dbFile,
        async close() {
          try {
            host.dispose();
            await runtime.close();
          } finally {
            await store.close();
          }
        },
      };
    } catch (error) {
      host.dispose();
      await runtime.close();
      throw error;
    }
  } catch (error) {
    await store.close();
    throw error;
  }
}

export async function runWorkflow(input: WorkflowOptions) {
  const { mode, project, sourceRoot, runRoot, client, signal, maxTurns } =
    input;
  const compileCommand = publicCompileCommand();
  signal.throwIfAborted();
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000)
    throw Error("Invalid per-task turn budget");
  await mkdir(runRoot, { recursive: true });
  const now = performance.now();
  const refs =
    mode === "sag2sql"
      ? await openPublicReferenceIndex(project, runRoot, signal)
      : undefined;
  const indexMs = refs ? performance.now() - now : 0;
  const files = new ProjectPipelineFiles(runRoot);
  const modules = projectModules(project);
  const writable = new Set(project.modules.map((m) => m.path));
  const readable = Object.keys(project.files);
  const protectedFiles = readable.filter((f) => !writable.has(f));
  const revision = createHash("sha256")
    .update(JSON.stringify(project.files))
    .digest("hex");
  const translations: { unit: string; record: WorkspaceTranslationRun }[] = [];
  const selectedHistory: { unit: string; paths: string[] }[] = [];
  let turns = 0;

  const pipeline = new ProjectPipeline({
    prepare: async (_, s) => ({
      projectName: project.title,
      analysisRevision: revision,
      analysisHash: revision,
      modules,
      ...(await files.snapshot(sourceRoot, pipeline.current!.id, s)),
    }),
    search: async (m, _, s) => {
      const source = project.modules.find((u) => u.name === m.id)!;
      const candidates = refs
        ? await searchModulesWithSag2(
            refs.store,
            {
              target: m.target,
              requirement: source.description,
              repositoryIds: [refs.repositoryId],
              topK: 3,
            },
            s,
            { maxHops: 2 },
          )
        : [];
      m.selectedCandidateIds = candidates.map((c) => c.id);
      selectedHistory.push({
        unit: m.id,
        paths: [
          ...new Set(
            candidates.flatMap((c) => c.sourceModule?.sourceFiles ?? []),
          ),
        ],
      });
      return candidates;
    },
    generate: async (m, run, hooks) => {
      const workspaceRoot = files.output(run);
      const unit = project.modules.find((u) => u.name === m.id);
      let scope;
      if (!unit) {
        scope = await prepareIntegrationTranslationScope({
          workspaceRoot,
          targetLanguage: "JavaScript",
          requirement: run.requirement,
          writeFiles: [...writable],
          readOnlyFiles: protectedFiles,
        });
      } else {
        const args = {
          workspaceRoot,
          target: m.target,
          requirement: project.requirement,
          decisionNotes:
            "Implement the current module " +
            unit.path +
            " for this project. " +
            unit.description,
          relatedWriteFiles: [],
        };
        if (refs && m.candidates.length) {
          const historyView = await refs.host.createHistoryModulesView({
            workspaceRoot,
            candidates: m.candidates.map((c) => {
              if (!c.sourceModule)
                throw Error("Indexed candidate is missing its pinned module");
              return {
                ...c.sourceModule,
                sourceFiles: c.sourceModule.sourceFiles ?? [c.path],
                preferredFiles: c.moduleMatch?.previewFiles,
              };
            }),
          });
          scope = await prepareModuleTranslationScope({
            ...args,
            candidates: m.candidates,
            historyView,
            evidenceScopes: [refs.scope],
          });
        } else {
          scope = await prepareDirectModuleTranslationScope(args);
        }
      }
      const writeFiles = scope.profile.writeFiles;
      m.authorizedFiles = writeFiles;
      await hooks.onCheckpoint?.();
      const remaining = maxTurns - turns;
      if (remaining <= 0) throw Error("Project model turn budget exhausted");
      const runtime = new WorkspaceTranslationRuntime({
        workspaceRoot,
        client: {
          complete: async (messages, tools, childSignal) => {
            const combined = AbortSignal.any([
              signal,
              hooks.signal,
              childSignal,
            ]);
            combined.throwIfAborted();
            if (turns >= maxTurns)
              throw Error("Project model turn budget exhausted");
            turns++;
            return client.complete(messages, tools, combined);
          },
        },
        maxModelTurns: remaining,
        compileCommand,
        verification: {
          command: publicTestCommand(
            workspaceRoot,
            unit ? "tests/" + unit.name + ".mjs" : "tests/all.mjs",
          ),
          protectedFiles,
        },
      });
      try {
        let record = runtime.start({
          spec: scope.spec,
          sourceLanguage: scope.profile.sourceLanguage,
          targetLanguage: "JavaScript",
          context: scope.context,
          workspaceFiles: readable,
          writeFiles,
          evidenceScopes: scope.evidenceScopes,
          historyView: scope.historyView,
          translationMode: scope.translationMode,
          taskKind: scope.taskKind,
        });
        while (
          ["analyzing", "translating", "testing", "compiling"].includes(
            record.status,
          )
        ) {
          if (hooks.signal.aborted || signal.aborted) {
            record = await runtime.cancel(record.id);
            break;
          }
          await sleep(50);
          record = runtime.get(record.id);
        }
        translations.push({ unit: m.id, record });
        return record;
      } finally {
        await runtime.shutdown();
      }
    },
    validate: async (run, s) => {
      const output = files.output(run);
      await files.assertWriteScope(run);
      const compilation = await compileWorkspace(output, compileCommand, s);
      const verification = await compileWorkspace(
        output,
        publicTestCommand(output, "tests/all.mjs"),
        s,
      );
      const protectedFilesUnchanged = (
        await Promise.all(
          protectedFiles.map(
            async (path) =>
              (await readFile(join(output, path), "utf8")) ===
              project.files[path],
          ),
        )
      ).every(Boolean);
      return {
        compilation,
        verification,
        protectedFilesUnchanged,
        sourceHash: await files.sourceHash(run),
        coverage: null,
      };
    },
    checkpoint: (run) => files.checkpoint(run),
    sourceHash: (run) => files.sourceHash(run),
    publish: (run, s) => files.publish(run, s),
    save: (run) => files.save(run),
    changed: () => {},
  });
  const abort = () => {
    const run = pipeline.current;
    if (run && pipeline.busy) pipeline.cancel(run.id);
  };
  try {
    signal.throwIfAborted();
    pipeline.start({
      repositoryId: project.id,
      projectId: project.id,
      requirement: project.requirement,
      topK: 3,
    });
    signal.addEventListener("abort", abort, { once: true });
    await pipeline.idle();
    const projectRun = pipeline.current!;
    return {
      outputRoot: projectRun.outputRoot,
      projectRun,
      translations,
      selectedHistory,
      indexMs,
      sqliteFile: refs?.dbFile,
      modelTurns: turns,
    };
  } finally {
    signal.removeEventListener("abort", abort);
    await refs?.close();
  }
}
