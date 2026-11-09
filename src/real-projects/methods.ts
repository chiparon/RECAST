import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ProjectPipeline } from "../../../weichai/apps/vscode-extension/src/project-pipeline.ts";
import { orderModulesByDependency } from "../../../weichai/apps/vscode-extension/src/module-order.ts";
import {
  prepareDirectModuleTranslationScope,
  prepareIntegrationTranslationScope,
  prepareModuleTranslationScope,
} from "../../../weichai/apps/vscode-extension/src/module-translation-handoff.ts";
import type { ProjectPipelineModule } from "../../../weichai/apps/vscode-extension/src/project-pipeline-types.ts";
import type {
  Language,
  WorkspaceTranslationRun,
} from "../../../weichai/packages/contracts/src/index.ts";
import { compileWorkspace } from "../../../weichai/services/adaptation-service/src/workspace-compiler.ts";
import { WorkspaceTranslationRuntime } from "../../../weichai/services/adaptation-service/src/workspace-translation-runtime.ts";
import { searchModulesWithSag2 } from "../../../weichai/services/code-intelligence-service/src/index.ts";
import { git, publicCommand, RealProjectFiles } from "./method-files.ts";
import { openRealIndex } from "./method-index.ts";
import { runRealRaw } from "./method-raw.ts";
import type { MethodOptions, MethodTask } from "./method-types.ts";

const byExtension: Record<string, string> = {
  ".py": "Python",
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".ts": "TypeScript",
  ".go": "Go",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".java": "Java",
  ".cs": "C#",
  ".rs": "Rust",
  ".lua": "Lua",
};
function targetLanguage(unit: MethodTask["modules"][number]) {
  return unit.language ?? byExtension[extname(unit.path)] ?? "Text";
}
function projectModules(task: MethodTask) {
  const supported: Language[] = [
    "TypeScript",
    "Python",
    "Java",
    "C#",
    "Rust",
    "Go",
    "C",
    "C++",
  ];
  return orderModulesByDependency(
    task.modules.map((unit): ProjectPipelineModule => {
      const lang = targetLanguage(unit) as Language;
      return {
        id: unit.name,
        name: unit.name,
        status: "pending",
        candidates: [],
        dependsOn: unit.dependsOn ?? [],
        target: {
          id: unit.name,
          name: unit.name,
          kind: "module",
          path: unit.path,
          signature: unit.name,
          language: supported.includes(lang) ? lang : "TypeScript",
          module: {
            sourceFiles: [unit.path],
            coreApis: [],
            purpose: unit.description,
            description: unit.description,
            dependsOn: unit.dependsOn ?? [],
          },
        },
      };
    }),
  );
}

export async function runRealMethod(options: MethodOptions) {
  const { arm, client, sourceRoot, runRoot } = options;
  const signal = options.signal ?? new AbortController().signal;
  // All three receive the same module interfaces and dependency map, in addition
  // to the common product requirement and the same readable upstream sources.
  const task: MethodTask = {
    ...options.task,
    requirement:
      options.task.requirement +
      "\n\nPublic module manifest:\n" +
      JSON.stringify(options.task.modules),
  };
  const writable = task.modules.map((m) => m.path);
  if (
    task.readFiles.length > 256 ||
    !writable.every((path) => task.readFiles.includes(path)) ||
    !task.referenceFiles.every(
      (path) => task.readFiles.includes(path) && !writable.includes(path),
    )
  )
    throw Error("Invalid shared project file inventory.");
  if (arm === "rawagent") return runRealRaw({ ...options, task }, signal);

  const indexStart = performance.now();
  const refs =
    arm === "sag2sql"
      ? await openRealIndex(task, sourceRoot, runRoot, signal)
      : undefined;
  const indexMs = refs ? performance.now() - indexStart : null;
  const files = new RealProjectFiles(runRoot);
  const compile = publicCommand(task.compileCommand),
    test = publicCommand(task.testCommand);
  const protectedFiles = task.readFiles.filter((f) => !writable.includes(f));
  const criteria = protectedFiles.filter(
    (f) => !task.referenceFiles.includes(f),
  );
  // The runtime additionally hashes its test criteria. Read-only files are checked
  // across the complete tracked tree at validation, publication and external grading.
  const protectedCriteria = (criteria.length ? criteria : protectedFiles).slice(
    0,
    100,
  );
  const translations: { unit: string; record: WorkspaceTranslationRun }[] = [];
  const selectedHistory: { unit: string; paths: string[] }[] = [];
  const modules = projectModules(task);
  const pipeline = new ProjectPipeline({
    prepare: async (_, s) => {
      const snapshot = await files.snapshot(
        sourceRoot,
        pipeline.current!.id,
        s,
      );
      const revision = await git(snapshot.outputRoot, [
        "rev-parse",
        "HEAD^{tree}",
      ]);
      return {
        ...snapshot,
        projectName: task.title,
        analysisRevision: revision,
        analysisHash: revision,
        modules,
      };
    },
    search: async (module, _, s) => {
      const unit = task.modules.find((u) => u.name === module.id)!;
      const candidates = refs
        ? await searchModulesWithSag2(
            refs.store,
            {
              target: module.target,
              requirement: unit.description,
              repositoryIds: [refs.repositoryId],
              topK: 3,
            },
            s,
            { maxHops: 2 },
          )
        : [];
      module.selectedCandidateIds = candidates.map((c) => c.id);
      selectedHistory.push({
        unit: module.id,
        paths: [
          ...new Set(
            candidates.flatMap((c) => c.sourceModule?.sourceFiles ?? []),
          ),
        ],
      });
      return candidates;
    },
    generate: async (module, run, hooks) => {
      const root = files.output(run);
      const unit = task.modules.find((u) => u.name === module.id);
      const language = unit
        ? targetLanguage(unit)
        : [...new Set(task.modules.map(targetLanguage))].join(", ");
      let scope;
      if (!unit) {
        scope = await prepareIntegrationTranslationScope({
          workspaceRoot: root,
          targetLanguage: language,
          requirement: run.requirement,
          writeFiles: writable,
          readOnlyFiles: protectedFiles,
        });
      } else {
        const args = {
          workspaceRoot: root,
          target: module.target,
          requirement: [
            "You own only the " +
              unit.name +
              " module in this invocation. Implement its part of the project in " +
              unit.path +
              ".",
            unit.description,
            "The pipeline schedules every other module separately, then verifies the assembled project.",
            "Use the shared project specification as background for this module's behavior and interfaces. Another module's pending work is expected.",
          ].join("\n"),
          decisionNotes:
            "Complete the current module when its implementation and configured checks pass.",
          relatedWriteFiles: [],
        };
        if (refs && module.candidates.length) {
          const candidates = module.candidates.map((c) => {
            if (!c.sourceModule)
              throw Error("SAG2 candidate has no frozen module.");
            return {
              ...c.sourceModule,
              sourceFiles: c.sourceModule.sourceFiles ?? [c.path],
              preferredFiles: c.moduleMatch?.previewFiles,
            };
          });
          const historyView = await refs.host.createHistoryModulesView({
            workspaceRoot: root,
            candidates,
          });
          const evidenceScopes = refs.scopes.filter((scope) =>
            candidates.some((c) => c.projectId === scope.projectId),
          );
          scope = await prepareModuleTranslationScope({
            ...args,
            candidates: module.candidates,
            historyView,
            evidenceScopes,
          });
        } else scope = await prepareDirectModuleTranslationScope(args);
        scope.context.push({
          id: "shared-project-spec",
          kind: "summary",
          content:
            "Project-level background shared by all modules:\n" +
            task.requirement,
        });
      }
      module.authorizedFiles = scope.profile.writeFiles;
      await hooks.onCheckpoint?.();
      const combined = AbortSignal.any([hooks.signal, signal]);
      const scopedTest = unit
        ? task.moduleTestCommands?.[unit.name]
        : task.testCommand;
      const runtime = new WorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: compile,
        maxModelTurns: 1000,
        timeoutMs: 7_200_000,
        client: {
          complete: (messages, tools, child) =>
            client.complete(
              messages,
              tools,
              AbortSignal.any([combined, child]),
            ),
        },
        ...(scopedTest
          ? {
              verification: {
                command: publicCommand(scopedTest),
                protectedFiles: protectedCriteria,
              },
            }
          : {}),
      });
      try {
        let record = runtime.start({
          spec: scope.spec,
          sourceLanguage: scope.profile.sourceLanguage,
          targetLanguage: language,
          context: scope.context,
          workspaceFiles: task.readFiles,
          writeFiles: scope.profile.writeFiles,
          evidenceScopes: scope.evidenceScopes,
          historyView: scope.historyView,
          translationMode: scope.translationMode,
          taskKind: scope.taskKind,
        });
        for (;;) {
          while (
            ["analyzing", "translating", "compiling", "testing"].includes(
              record.status,
            )
          ) {
            if (combined.aborted) {
              record = await runtime.cancel(record.id);
              break;
            }
            await sleep(100);
            record = runtime.get(record.id);
          }
          if (
            combined.aborted ||
            !/^Translation (exhausted its 1000-turn budget\. Resume to continue\.|execution timed out\.)$/.test(
              record.error ?? "",
            )
          )
            break;
          record = runtime.resume(record.id);
        }
        translations.push({ unit: module.id, record });
        return record;
      } finally {
        await runtime.shutdown();
      }
    },
    validate: async (run, s) => {
      const root = files.output(run);
      await files.assertWriteScope(run);
      const compilation = await compileWorkspace(root, compile, s);
      const verification = await compileWorkspace(root, test, s);
      const unchanged = await Promise.all(
        protectedFiles.map(async (path) =>
          (await readFile(join(root, path))).equals(
            await readFile(join(sourceRoot, path)),
          ),
        ),
      );
      return {
        compilation,
        verification,
        protectedFilesUnchanged: unchanged.every(Boolean),
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
  const cancel = () => {
    if (pipeline.current && pipeline.busy) pipeline.cancel(pipeline.current.id);
  };
  try {
    signal.throwIfAborted();
    pipeline.start({
      repositoryId: task.id,
      projectId: task.id,
      requirement: task.requirement,
      topK: 3,
    });
    signal.addEventListener("abort", cancel, { once: true });
    await pipeline.idle();
    const projectRun = pipeline.current!;
    const commit =
      projectRun.status === "completed" &&
      projectRun.acceptance === "behavior-verified"
        ? (projectRun.commit ?? null)
        : null;
    return {
      outputRoot: projectRun.outputRoot ?? null,
      commit,
      error: commit
        ? null
        : (projectRun.error ??
          "Workflow did not deliver a public-test-passing project"),
      indexMs,
      runtime: {
        projectRun,
        selectedHistory,
        translations,
        baselineCommit: projectRun.baselineCommit,
        indexFiles: refs?.indexedFiles,
        sqliteFile: refs?.databasePath,
      },
    };
  } finally {
    signal.removeEventListener("abort", cancel);
    await refs?.close();
  }
}
