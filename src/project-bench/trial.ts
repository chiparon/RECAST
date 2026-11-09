import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProjectPipelineFiles } from "../../../weichai/apps/vscode-extension/src/project-pipeline-files.ts";
import { compileWorkspace } from "../../../weichai/services/adaptation-service/src/workspace-compiler.ts";
import { createProjectClient, type ProjectModel } from "./providers.ts";
import { materializeTask, gradeTask } from "./tasks.ts";
import type { ProjectTask } from "./fixture-format.ts";
import { publicCompileCommand, publicTestCommand } from "./commands.ts";
import { runRawAgent } from "./raw.ts";
import { runWorkflow } from "./workflow.ts";

export const arms = ["recast", "sag2sql", "rawagent"] as const;
export type Arm = (typeof arms)[number];
export const protocol = {
  version: 1,
  maxTurns: 64,
  maxTokens: 160000,
  maxOutputTokens: 8192,
  timeoutMs: 600000,
};
const execute = promisify(execFile);
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function publicProject(task: ProjectTask) {
  const { acceptance, ...project } = task;
  return project;
}
async function rawRun(
  project: Omit<ProjectTask, "acceptance">,
  sourceRoot: string,
  runRoot: string,
  client: ReturnType<typeof createProjectClient>,
  signal: AbortSignal,
) {
  const files = new ProjectPipelineFiles(runRoot);
  const { outputRoot, baselineCommit } = await files.snapshot(
    sourceRoot,
    randomUUID(),
    signal,
  );
  const writable = project.modules.map((m) => m.path);
  const readable = Object.keys(project.files);
  const testFiles = [
    ...project.modules.map((m) => "tests/" + m.name + ".mjs"),
    "tests/all.mjs",
  ];
  const compile = (path?: string) => {
    if (path !== undefined && !writable.includes(path))
      throw Error("Unknown production module");
    const command =
      path === undefined
        ? publicCompileCommand()
        : {
            executable: process.execPath,
            args: ["--check", path],
            timeoutMs: 20000,
          };
    return compileWorkspace(outputRoot, command, signal);
  };
  const test = (path = "tests/all.mjs") => {
    if (!testFiles.includes(path)) throw Error("Unknown public test");
    return compileWorkspace(
      outputRoot,
      publicTestCommand(outputRoot, path),
      signal,
    );
  };
  const agent = await runRawAgent({
    client,
    signal,
    maxTurns: protocol.maxTurns,
    requirement: project.requirement,
    files: readable,
    writeFiles: writable,
    testFiles,
    read: async (path: string) => {
      if (!readable.includes(path)) throw Error("File outside task scope");
      return readFile(join(outputRoot, path), "utf8");
    },
    write: async (path: string, content: string) => {
      if (!writable.includes(path)) throw Error("File outside write scope");
      await writeFile(join(outputRoot, path), content);
    },
    compile,
    test,
  });
  let commit: string | null = null,
    publicationError: string | null = null;
  if (agent.status === "completed") {
    const build = await compile(),
      suite = build.success ? await test() : null;
    if (build.success && suite?.success) {
      await execute("git", ["-C", outputRoot, "add", "--", ...writable], {
        windowsHide: true,
      });
      await execute(
        "git",
        [
          "-C",
          outputRoot,
          "-c",
          "user.name=RECAST",
          "-c",
          "user.email=recast@localhost",
          "-c",
          "core.hooksPath=",
          "commit",
          "--no-gpg-sign",
          "--allow-empty",
          "-m",
          "Raw agent project delivery",
        ],
        { windowsHide: true },
      );
      commit = (
        await execute("git", ["-C", outputRoot, "rev-parse", "HEAD"], {
          windowsHide: true,
        })
      ).stdout.trim();
    } else
      publicationError =
        "Final public build/test failed: " +
        (suite ?? build).output.slice(-1500);
  }
  return { outputRoot, commit, baselineCommit, agent, publicationError };
}
export async function runTrial(
  task: ProjectTask,
  arm: Arm,
  model: ProjectModel,
  runRoot: string,
) {
  await mkdir(runRoot, { recursive: true });
  const sourceRoot = join(runRoot, "starter"),
    project = publicProject(task);
  await materializeTask(task, sourceRoot);
  const signal = AbortSignal.timeout(protocol.timeoutMs);
  const client = createProjectClient(model, {
    ...protocol,
    signal,
    onCall: (c) =>
      appendFileSync(join(runRoot, "calls.ndjson"), JSON.stringify(c) + "\n"),
  });
  const startedAt = new Date().toISOString(),
    start = performance.now();
  let outputRoot: string | undefined,
    commit: string | null = null,
    error: string | null = null;
  let runtime: unknown = null,
    indexMs: number | null = null,
    repairAttempts: number | null = null;
  try {
    if (arm === "rawagent") {
      const raw = await rawRun(project, sourceRoot, runRoot, client, signal);
      outputRoot = raw.outputRoot;
      commit = raw.commit;
      runtime = raw;
      if (!commit)
        error =
          raw.publicationError ??
          raw.agent.error ??
          "Agent did not deliver a public-test-passing project";
    } else {
      const workflow = await runWorkflow({
        mode: arm,
        project,
        sourceRoot,
        runRoot,
        client,
        signal,
        maxTurns: protocol.maxTurns,
      });
      outputRoot = workflow.outputRoot;
      runtime = workflow;
      const r = workflow.projectRun;
      if (r?.status === "completed" && r.acceptance === "behavior-verified")
        commit = r.commit ?? null;
      if (!commit)
        error =
          r?.error ?? "Workflow did not deliver a public-test-passing project";
      indexMs = workflow.indexMs;
      repairAttempts =
        r?.modules?.filter((m) =>
          m.id.startsWith("pipeline-integration-repair"),
        ).length ?? 0;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const executionMs = performance.now() - start;
  let grade: Awaited<ReturnType<typeof gradeTask>> | null = null;
  if (outputRoot) {
    try {
      grade = await gradeTask(task, outputRoot, AbortSignal.timeout(120000));
    } catch (e) {
      error =
        (error ? error + "; " : "") +
        "External grader: " +
        (e instanceof Error ? e.message : String(e));
    }
  }
  const wallMs = performance.now() - start;
  const passed = Boolean(commit && grade?.passed && !error);
  if (!passed && !error) error = "External acceptance failed";
  await writeFile(
    join(runRoot, "runtime.json"),
    JSON.stringify(runtime, null, 2),
  );
  return {
    arm,
    model,
    taskId: task.id,
    startedAt,
    status: passed ? "passed" : "failed",
    error,
    publicDelivered: Boolean(commit),
    passed,
    commit,
    outputRoot: outputRoot ?? null,
    inputHash: hash(project),
    gradingHash: hash(task.acceptance),
    indexMs,
    repairAttempts,
    executionMs,
    wallMs,
    timeToVerifiedMs: passed ? wallMs : null,
    grade,
    usage: client.usage(),
    calls: client.trace,
    toolCalls: client.trace.reduce((n, c) => n + c.tools.length, 0),
  };
}
