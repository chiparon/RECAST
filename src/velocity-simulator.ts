import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ProjectPipeline } from "../../weichai/apps/vscode-extension/src/project-pipeline.ts";
import { ProjectPipelineFiles } from "../../weichai/apps/vscode-extension/src/project-pipeline-files.ts";
import { WorkspaceTranslationRuntime } from "../../weichai/services/adaptation-service/src/workspace-translation-runtime.ts";
import { compileWorkspace } from "../../weichai/services/adaptation-service/src/workspace-compiler.ts";
import {
  prepareModuleTranslationScope,
  prepareDirectModuleTranslationScope,
  prepareIntegrationTranslationScope,
} from "../../weichai/apps/vscode-extension/src/module-translation-handoff.ts";
import { target, digest } from "./corpus.ts";
import { retrieve } from "./harness.ts";
import { agentClient } from "./openai.ts";
const node = (...args: string[]) => ({
  executable: process.execPath,
  args,
  timeoutMs: 15000,
});
export async function execute(c, mode, root) {
  const { s } = c,
    files = new ProjectPipelineFiles(root);
  const retrieval = [],
    translations = [];
  let scopePrepMs = 0,
    loopWallMs = 0;
  const units = s.units.map((u) => ({
    id: u.name,
    name: u.name,
    target: target(u),
    dependsOn: u.dependsOn ?? [],
    status: "pending",
    candidates: [],
  }));
  const pipeline = new ProjectPipeline({
    prepare: async (_, signal) => ({
      projectName: s.id,
      analysisRevision: digest(JSON.stringify(s)),
      analysisHash: digest(JSON.stringify(units)),
      modules: units,
      ...(await files.snapshot(c.source, pipeline.current.id, signal)),
    }),
    search: async (m, _, signal) => {
      const { candidates, trace } = await retrieve(
        c,
        s.units.find((u) => u.name === m.id),
        mode,
        signal,
      );
      retrieval.push(trace);
      m.selectedCandidateIds = candidates.slice(0, 3).map((x) => x.id);
      return candidates;
    },
    generate: async (m, run, hooks) => {
      const workspaceRoot = files.output(run),
        u = s.units.find((u) => u.name === m.id),
        selected = m.candidates.slice(0, 3);
      const t = performance.now();
      let scope;
      if (!u)
        scope = await prepareIntegrationTranslationScope({
          workspaceRoot,
          targetLanguage: "JavaScript",
          requirement: run.requirement,
          writeFiles: s.units.map((x) => x.name + ".mjs"),
        });
      else {
        const input = {
          workspaceRoot,
          target: m.target,
          requirement: u.query + "\n" + u.contract,
          decisionNotes: "",
        };
        if (selected.length) {
          const historyView = await c.host.createHistoryModulesView({
            workspaceRoot,
            candidates: selected.map((x) => ({
              ...x.sourceModule,
              preferredFiles: x.moduleMatch?.previewFiles,
            })),
          });
          scope = await prepareModuleTranslationScope({
            ...input,
            candidates: selected,
            historyView,
            evidenceScopes: c.scopes,
          });
        } else scope = await prepareDirectModuleTranslationScope(input);
      }
      m.authorizedFiles = scope.profile.writeFiles;
      const scopeMs = performance.now() - t;
      scopePrepMs += scopeMs;
      await hooks.onCheckpoint?.();
      const api = [],
        { sourceLanguage, targetLanguage, workspaceFiles, writeFiles } =
          scope.profile;
      const request = {
        sourceLanguage,
        targetLanguage,
        workspaceFiles,
        writeFiles,
        spec: scope.spec,
        context: scope.context,
        evidenceScopes: scope.evidenceScopes,
        historyView: scope.historyView,
        translationMode: scope.translationMode,
        taskKind: scope.taskKind,
      };
      const test = u ? "tests/" + u.name + ".mjs" : "tests/all.mjs";
      const runtime = new WorkspaceTranslationRuntime({
        workspaceRoot,
        client: agentClient(api),
        evidence: { port: c.evidence },
        maxModelTurns: 32,
        timeoutMs: 600000,
        compileCommand: u
          ? node("--check", u.name + ".mjs")
          : node("tests/check.mjs"),
        verification: {
          command: node(test),
          protectedFiles: Object.keys(c.suite),
        },
      });
      const start = performance.now();
      try {
        let record = runtime.start(request);
        while (
          ["analyzing", "translating", "compiling", "testing"].includes(
            record.status,
          )
        ) {
          await sleep(80);
          record = runtime.get(record.id);
        }
        const elapsed = performance.now() - start;
        loopWallMs += elapsed;
        translations.push({
          unit: m.id,
          scopePrepMs: scopeMs,
          wallMs: elapsed,
          selected: selected.map((x) => x.sourceModule.moduleId),
          api,
          record,
        });
        return record;
      } finally {
        await runtime.shutdown();
      }
    },
    validate: async (run, signal) => {
      await files.assertWriteScope(run);
      const output = files.output(run);
      const compilation = await compileWorkspace(
        output,
        node("tests/check.mjs"),
        signal,
      );
      const verification = await compileWorkspace(
        output,
        node("tests/all.mjs"),
        signal,
      );
      const protectedFilesUnchanged = (
        await Promise.all(
          Object.entries(c.suite).map(
            async ([f, v]) => (await readFile(join(output, f), "utf8")) === v,
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
    publish: (run, signal) => files.publish(run, signal),
    save: (run) => files.save(run),
    changed: () => {},
  });
  const start = performance.now();
  pipeline.start({
    repositoryId: s.id,
    projectId: s.id,
    requirement: s.units.map((u) => u.contract).join("\n"),
    topK: 4,
  });
  await pipeline.idle();
  const elapsedMs = performance.now() - start,
    project = pipeline.current;
  return {
    scenario: s.id,
    mode,
    elapsedMs,
    e2eDeliveryMs:
      project.status === "completed" &&
      project.acceptance === "behavior-verified" &&
      project.commit
        ? elapsedMs
        : null,
    scopePrepMs,
    loopWallMs,
    retrieval,
    translations,
    project,
    catalog: c.catalog,
    queryPlan: c.plan,
  };
}
