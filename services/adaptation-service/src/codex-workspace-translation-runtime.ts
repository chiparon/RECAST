import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type {
  WorkspaceCompilation, WorkspaceCompileCommand, WorkspaceHistoryView,
  WorkspaceTranslationPlan, WorkspaceTranslationRequest,
  WorkspaceTranslationRun, WorkspaceVerificationFeedback,
} from "@forexplore/contracts";
import { compileWorkspace, validateWorkspaceCompileCommand } from "./workspace-compiler";
import { TranslationWorkspaceFiles } from "./workspace-translation-files";
import { object, parseWorkspaceTranslationPlan, validateWorkspaceTranslationRequest } from "./workspace-translation-agent";

export interface CodexWorkspaceTranslationRuntimeOptions {
  workspaceRoot: string;
  compileCommand: WorkspaceCompileCommand;
  verification?: { command: WorkspaceCompileCommand; protectedFiles: string[] };
  /** Executable name or absolute path; defaults to `codex`. */
  codexCommand?: string;
  /** Passed as `codex exec --model`; production supplies the isolated DeepSeek model. */
  codexModel?: string;
  /** Optional isolated Codex configuration directory, passed as CODEX_HOME. */
  codexHome?: string;
  maxModelTurns?: number;
  timeoutMs?: number;
  maxVerificationRepairs?: number;
  /** Extra environment is useful for a host-owned Codex provider adapter. */
  environment?: NodeJS.ProcessEnv;
}

export class CodexWorkspaceTranslationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const runningStatuses = new Set<WorkspaceTranslationRun["status"]>(["analyzing", "translating", "compiling", "testing"]);
const terminalStatuses = new Set<WorkspaceTranslationRun["status"]>(["completed", "failed", "cancelled", "interrupted", "rolled-back"]);
const hash = (value: string | null): string | null => value === null ? null : createHash("sha256").update(value).digest("hex");
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const maxCodexOutput = 4 * 1024 * 1024;
const maxRecordedAnalyzerOutput = 64 * 1024;
const generatedDirectoryNames = new Set([".git", ".forexpore", ".codex", ".claude", ".translation-verifier-tests", "node_modules", "bin", "obj", "target", "build", "dist", "test", "tests", "__tests__", "evaluation"]);
const sensitiveFileNames = new Set([".env", ".env.local", ".env.production", ".npmrc", "id_rsa", "id_ed25519"]);
const codexMetadataDirectories = new Set([".agents", ".aws", ".codex", ".git"]);
type CodexStage = "analyzer" | "translator";
type CodexSandbox = "read-only" | "workspace-write";
interface CodexInvocation {
  startedAt: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  lastMessage: string;
  outputChars: number;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
}

/**
 * Codex's final response is the only channel an Analyzer may use to hand its
 * plan to the host.  Supplying a schema to `codex exec` keeps the model from
 * returning a prose wrapper or an incomplete plan that can never be applied.
 * The host still runs parseWorkspaceTranslationPlan afterwards; the schema is
 * a transport guard, not a trust boundary.
 */
const analyzerOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "mappings", "dependencies", "steps"],
  properties: {
    summary: { type: "string", minLength: 1 },
    mappings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "targetPath", "targetSymbol"],
        properties: {
          source: { type: "string", minLength: 1 },
          targetPath: { type: "string", minLength: 1 },
          targetSymbol: { type: "string", minLength: 1 },
        },
      },
    },
    dependencies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "strategy", "detail"],
        properties: {
          name: { type: "string", minLength: 1 },
          strategy: { type: "string", enum: ["reuse", "replace", "adapt", "translate"] },
          detail: { type: "string", minLength: 1 },
        },
      },
    },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "files", "dependsOn"],
        properties: {
          id: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          files: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
          dependsOn: { type: "array", items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
} as const;

/**
 * Workspace translation backed by the installed Codex CLI.  Codex edits only
 * a disposable staging copy.  The host computes a strict allow-listed diff,
 * applies it through TranslationWorkspaceFiles, and owns every compile/test
 * command.  This keeps the existing HTTP/UI contract while replacing the
 * bespoke tool-calling loop for production runs.
 */
export class CodexWorkspaceTranslationRuntime {
  private readonly files: TranslationWorkspaceFiles;
  private readonly command: WorkspaceCompileCommand;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly codexCommand: string;
  private readonly codexModel?: string;
  private readonly maxVerificationRepairs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private closing = false;
  private active?: { run: WorkspaceTranslationRun; controller: AbortController; done: Promise<void>; child?: ChildProcess };

  constructor(private readonly options: CodexWorkspaceTranslationRuntimeOptions) {
    validateWorkspaceCompileCommand(options.compileCommand);
    this.command = structuredClone(options.compileCommand);
    this.files = new TranslationWorkspaceFiles(options.workspaceRoot);
    this.codexCommand = options.codexCommand?.trim() || "codex";
    this.codexModel = options.codexModel?.trim() || undefined;
    this.environment = {
      ...(options.environment ?? {}),
      ...(options.codexHome?.trim() ? { CODEX_HOME: options.codexHome.trim() } : {}),
    };
    this.maxTurns = options.maxModelTurns ?? 4;
    this.timeoutMs = options.timeoutMs ?? 1_800_000;
    this.maxVerificationRepairs = options.maxVerificationRepairs ?? 2;
    if (!Number.isInteger(this.maxTurns) || this.maxTurns < 2 || this.maxTurns > 1000 ||
        !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 7_200_000) {
      throw new Error("Invalid Codex workspace translation execution budget.");
    }
    if (options.verification) {
      validateWorkspaceCompileCommand(options.verification.command);
      if (!options.verification.protectedFiles.length || options.verification.protectedFiles.length > 100) {
        throw new Error("Verification requires 1..100 protected criteria files.");
      }
      for (const path of options.verification.protectedFiles) {
        if (this.files.read(path) === null) throw new Error(`Verification criteria missing: ${path}`);
      }
    }
  }

  configuration(): { workspaceRoot: string; behavioralVerification: boolean; agent: "codex"; model?: string } {
    return { workspaceRoot: this.files.root, behavioralVerification: Boolean(this.options.verification), agent: "codex", ...(this.codexModel ? { model: this.codexModel } : {}) };
  }

  start(input: unknown): WorkspaceTranslationRun {
    this.requireIdle();
    try { validateWorkspaceTranslationRequest(input); }
    catch (error) { throw new CodexWorkspaceTranslationError(400, errorMessage(error)); }
    const request = structuredClone(input);
    for (const path of new Set([...request.workspaceFiles, ...request.writeFiles])) this.files.read(path);
    this.validateHistoryView(request.historyView);
    if (this.options.verification && request.writeFiles.some(path => this.options.verification!.protectedFiles.some(protectedPath => path.toLowerCase() === protectedPath.toLowerCase()))) {
      throw new CodexWorkspaceTranslationError(400, "Verification criteria cannot be included in writeFiles.");
    }
    const now = new Date().toISOString();
    const run: WorkspaceTranslationRun = {
      id: randomUUID(), workspaceRoot: this.files.root, request, status: "analyzing", createdAt: now, updatedAt: now,
      completedSteps: [], changes: [], compilations: [], evidenceQueries: [], modelTurns: 0,
      acceptance: "compilation-only", agent: {
        kind: "codex", command: this.codexCommand, ...(this.codexModel ? { model: this.codexModel } : {}), startedAt: now,
        ...(request.historyView ? { historyView: historyViewAudit(request.historyView) } : {}),
        stages: [],
      }, events: [{ at: now, phase: "analyzing", message: "Codex 翻译任务已启动，使用受限 staging workspace" }],
      ...(this.options.verification ? { verification: { command: structuredClone(this.options.verification.command), criteria: this.options.verification.protectedFiles.map(path => ({ path, hash: hash(this.files.read(path))! })), runs: [] } } : {}),
    };
    this.save(run);
    return this.launch(run);
  }

  get(id: string): WorkspaceTranslationRun {
    if (this.active?.run.id === id) return structuredClone(this.active.run);
    let value: unknown;
    try { value = this.files.load(id); } catch (error) { throw new CodexWorkspaceTranslationError(400, errorMessage(error)); }
    if (!value) throw new CodexWorkspaceTranslationError(404, "Translation run was not found.");
    const run = this.validateRecord(value, id);
    if (runningStatuses.has(run.status)) { run.status = "interrupted"; run.error = "Execution was interrupted. Resume to continue."; }
    return run;
  }

  async cancel(id: string): Promise<WorkspaceTranslationRun> {
    const active = this.active;
    if (active?.run.id === id) { active.controller.abort(new Error("Translation cancelled.")); active.child?.kill("SIGTERM"); await active.done; }
    return this.get(id);
  }

  resume(id: string): WorkspaceTranslationRun {
    this.requireIdle();
    const run = this.get(id);
    if (!["failed", "cancelled", "interrupted"].includes(run.status)) throw new CodexWorkspaceTranslationError(409, "Only failed, cancelled or interrupted runs can resume.");
    this.assertVerification(run);
    this.reconcile(run);
    run.status = "analyzing"; run.acceptance = "compilation-only"; delete run.error;
    run.events ??= []; run.events.push({ at: new Date().toISOString(), phase: "analyzing", message: "Codex 翻译任务已恢复" });
    this.save(run);
    return this.launch(run);
  }

  /** Re-enter the existing run's Translator with host-observed verifier facts. */
  repairAfterVerification(id: string, feedback: WorkspaceVerificationFeedback): WorkspaceTranslationRun {
    this.requireIdle();
    const run = this.get(id);
    if (run.status !== "completed") throw new CodexWorkspaceTranslationError(409, "Only a completed translation can receive verifier repair feedback.");
    if (!feedback || feedback.status !== "failure" || !Number.isInteger(feedback.attempt) || feedback.attempt < 1) {
      throw new CodexWorkspaceTranslationError(400, "Invalid verifier repair feedback.");
    }
    const repairs = run.verificationRepairs ?? [];
    if (repairs.length >= this.maxVerificationRepairs) {
      throw new CodexWorkspaceTranslationError(409, `Maximum verifier repair attempts (${this.maxVerificationRepairs}) reached.`);
    }
    if (!run.plan) throw new CodexWorkspaceTranslationError(409, "The completed run has no Translator plan to repair.");
    run.latestVerificationFeedback = structuredClone(feedback);
    run.verificationRepairs = [...repairs, { at: new Date().toISOString(), attempt: feedback.attempt, feedback: structuredClone(feedback), status: "requested" }];
    run.status = "translating";
    run.acceptance = "compilation-only";
    delete run.error;
    run.events ??= [];
    run.events.push({ at: new Date().toISOString(), phase: "translating", message: `宿主 verifier 反馈第 ${feedback.attempt} 轮失败，交由同一 Translator 修复` });
    this.save(run);
    return this.launch(run);
  }

  rollback(id: string): WorkspaceTranslationRun {
    this.requireIdle();
    const run = this.get(id);
    if (run.status === "rolled-back") return run;
    this.reconcile(run, true);
    run.status = "rolling-back"; run.acceptance = "compilation-only"; this.save(run);
    try {
      for (const change of [...run.changes].reverse()) {
        if (change.rolledBack) continue;
        const current = this.files.read(change.path);
        if (current !== change.after) throw new CodexWorkspaceTranslationError(409, `File changed after translation: ${change.path}`);
        this.files.write(change.path, change.after, change.before);
        change.rolledBack = true;
        this.save(run);
      }
      run.status = "rolled-back"; delete run.error; this.save(run);
    } catch (error) { run.error = errorMessage(error); this.save(run); throw error; }
    return structuredClone(run);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const active = this.active;
    if (!active) return;
    active.controller.abort(new Error("Translation interrupted by service shutdown."));
    active.child?.kill("SIGTERM");
    await active.done;
  }

  private launch(run: WorkspaceTranslationRun): WorkspaceTranslationRun {
    const controller = new AbortController();
    const active = { run, controller, done: Promise.resolve() } as { run: WorkspaceTranslationRun; controller: AbortController; done: Promise<void>; child?: ChildProcess };
    this.active = active;
    active.done = Promise.resolve().then(async () => {
      const timeout = setTimeout(() => controller.abort(new Error("Codex translation timed out.")), this.timeoutMs);
      try { await this.execute(run, controller.signal, active); }
      catch (error) {
        run.status = controller.signal.aborted ? "cancelled" : "failed";
        run.error = errorMessage(controller.signal.aborted ? controller.signal.reason : error);
        if (run.verificationRepairs?.length) run.verificationRepairs[run.verificationRepairs.length - 1].status = "failed";
        this.event(run, run.status, `Codex 任务结束：${run.error.slice(0, 400)}`);
        this.save(run);
      } finally { clearTimeout(timeout); this.active = undefined; }
    });
    void active.done.catch((error) => console.error("Codex translation persistence failed:", error));
    return structuredClone(run);
  }

  private async execute(run: WorkspaceTranslationRun, signal: AbortSignal, active: { child?: ChildProcess }): Promise<void> {
    this.assertVerification(run);
    let direct = run.request.translationMode === "direct-translator";
    const repair = Boolean(run.latestVerificationFeedback);
    if (direct) {
      run.plan = this.directTranslationPlan(run.request);
      run.completedSteps = [];
      run.status = "translating";
      this.event(run, "translating", "没有可用历史候选，使用需求直实现 Translator 兜底");
      this.save(run);
    } else if (!repair && !run.plan) {
      // Reserve one invocation for planning; the remaining configured budget is
      // shared by Translator implementation and compiler-repair attempts.
      run.status = "analyzing";
      run.modelTurns++;
      this.event(run, "analyzing", "Codex Analyzer：只读目标工程和 history-view，输出结构化 implementation plan");
      this.save(run);
      const analysisStage = await this.createStaging(run.request, signal, undefined, true);
      try {
        const schemaPath = join(analysisStage.root, "CODEX_ANALYZER_SCHEMA.json");
        await writeFile(schemaPath, JSON.stringify(analyzerOutputSchema, null, 2) + "\n", { mode: 0o444 });
        const prompt = this.analyzerPrompt(run.request, analysisStage.historyRoot);
        const result = await this.invokeCodex(analysisStage.root, prompt, signal, active, "read-only", "analyzer", schemaPath);
        this.recordInvocation(run, "analyzer", "read-only", prompt, result, run.request.historyView?.files ?? []);
        const analyzerStage = run.agent?.stages?.at(-1);
        if (analyzerStage) analyzerStage.analyzerOutput = boundedAnalyzerOutput(result.lastMessage).value;
        if (analyzerStage && boundedAnalyzerOutput(result.lastMessage).truncated) analyzerStage.analyzerOutputTruncated = true;
        await this.assertStagingUnchanged(analysisStage);
        let accepted = false;
        const fallback = (reason: string): void => {
          if (analyzerStage) {
            analyzerStage.analyzerOutputError = reason;
            analyzerStage.analyzerStatus = "fallback";
            analyzerStage.analyzerFallbackReason = reason;
          }
          // A malformed, context-exhausted, or non-zero Analyzer run must not
          // leave a module untranslated. The Analyzer is advisory; the host can
          // still give the Translator the complete target scope and requirement.
          direct = true;
          run.request.translationMode = "direct-translator";
          run.plan = this.directTranslationPlan(run.request);
          run.completedSteps = [];
          run.status = "translating";
          this.event(run, "translating", `Analyzer 未提交可用计划，切换需求直实现 Translator 兜底：${reason.slice(0, 240)}`);
          this.save(run);
        };
        if (result.exitCode !== 0) {
          fallback(`Codex Analyzer exited with code ${result.exitCode}: ${result.stderr.slice(0, 600)}`);
        } else {
          try {
            run.plan = this.parseAnalyzerPlan(result, run.request);
            accepted = true;
            if (analyzerStage) analyzerStage.analyzerStatus = "accepted";
          } catch (error) {
            fallback(errorMessage(error));
          }
        }
        if (accepted) {
          run.completedSteps = [];
          this.event(run, "analyzing", `Codex Analyzer 已提交 ${run.plan!.steps.length} 个实现步骤`);
          this.save(run);
        }
      } finally {
        await removeStagingTree(analysisStage.root);
      }
    }

    let lastCompile: WorkspaceCompilation | undefined;
    const translatorBudget = Math.max(1, this.maxTurns - (direct ? 0 : 1));
    for (let attempt = 0; attempt < translatorBudget; attempt++) {
      signal.throwIfAborted();
      run.status = "translating"; run.modelTurns++;
      this.event(run, "translating", `Codex Translator 第 ${attempt + 1} 轮：读取 plan、目标工程和 history-view，写回范围 ${run.request.writeFiles.length} 个文件`);
      this.save(run);
      const stage = await this.createStaging(run.request, signal, run.plan, false);
      try {
        const prompt = direct
          ? this.directTranslatorPrompt(run.request, stage.historyRoot, run.plan!, lastCompile)
          : this.translatorPrompt(run.request, stage.historyRoot, run.plan!, lastCompile, run.latestVerificationFeedback);
        const result = await this.invokeCodex(stage.root, prompt, signal, active, "workspace-write", "translator");
        this.recordInvocation(run, "translator", "workspace-write", prompt, result, run.request.historyView?.files ?? []);
        if (result.exitCode !== 0) throw new Error(`Codex Translator exited with code ${result.exitCode}: ${result.stderr.slice(0, 600)}`);
        const changes = await this.diffStaging(stage, run.request.writeFiles);
        if (!changes.length) {
          const feedbackKind = run.latestVerificationFeedback?.issue?.kind;
          const feedbackReason = run.latestVerificationFeedback?.reason;
          const testEnvironmentOnly = repair && (
            feedbackKind === "test" || feedbackKind === "environment" ||
            feedbackReason === "test-environment-failure" || feedbackReason === "coverage-unavailable"
          );
          if (!testEnvironmentOnly) {
            const reason = repair
              ? "Codex Translator completed without changing an allowed source file after production verifier feedback."
              : "Codex Translator completed without changing an allowed source file.";
            throw new Error(reason);
          }
          // Verification repairs may only fix a Host-owned test harness or
          // fixture. Those files are deliberately outside the Codex staging
          // copy and are never part of writeFiles, so a successful repair can
          // legitimately produce no production diff. Keep the existing
          // implementation, record the distinction, and let the caller rerun
          // the real verifier against the repaired harness.
          const repairRecord = run.verificationRepairs?.at(-1);
          if (repairRecord) repairRecord.disposition = "test-environment";
          this.event(run, "translating", "verifier 修复轮未产生生产代码 diff，按测试环境修复处理");
        } else {
          const repairRecord = run.verificationRepairs?.at(-1);
          if (repairRecord) repairRecord.disposition = "production-code";
          this.applyChanges(run, changes);
        }
      } finally {
        await removeStagingTree(stage.root);
      }
      this.reconcile(run);
      run.status = "compiling"; this.event(run, "compiling", "Codex Translator 变更已由宿主应用，开始编译检查"); this.save(run);
      const compilation = await compileWorkspace(this.files.root, this.command, signal);
      lastCompile = compilation; run.compilations.push(compilation);
      this.event(run, "translating", `编译检查${compilation.success ? "通过" : "失败"}`); this.save(run);
      if (!compilation.success) {
        if (attempt + 1 >= this.maxTurns - 1) throw new Error(`Compilation failed after ${run.modelTurns} Codex attempts.`);
        continue;
      }
      const before = this.snapshot(run);
      if (run.verification) {
        run.status = "testing"; this.event(run, "testing", "开始宿主控制的行为验收（测试内容不会进入 Codex workspace）"); this.save(run);
        const tested = await compileWorkspace(this.files.root, run.verification.command, signal);
        const unchanged = before === this.snapshot(run);
        run.verification.runs.push({ ...tested, sourceSnapshot: hash(before)!, planHash: hash(JSON.stringify(run.plan))!, filesUnchanged: unchanged });
        this.assertVerification(run);
        if (!tested.success || !unchanged) throw new Error("Host behavioral verification failed after Codex translation.");
        run.acceptance = "behavior-verified";
      } else run.acceptance = "compilation-only";
      if (run.verificationRepairs?.length) run.verificationRepairs[run.verificationRepairs.length - 1].status = "completed";
      run.status = "completed"; this.event(run, "completed", "Codex Translator 修复完成，宿主编译与验收通过"); this.save(run); return;
    }
    throw new Error("Codex translation exhausted its model-turn budget.");
  }

  private analyzerPrompt(request: WorkspaceTranslationRequest, historyRoot: string): string {
    const visible = request.workspaceFiles.length ? request.workspaceFiles.join(", ") : "（目标工程可见文件）";
    return [
      "You are the Analyzer Codex for a RECAST module translation task.",
      "You have read-only access to target/ and history-view/. Do not write, create, delete, rename, or chmod any file.",
      "Inspect the target write files first. For each selected history module, read only two or three files relevant to the requirement; use short targeted reads rather than bulk cat. The modules may cover complementary parts of one requirement. Keep mappings.source as a string containing the candidate prefix and source path; the plan JSON format is unchanged.",
      this.historyInventory(request),
      "The history-view can contain many large files. Read manifest.json first: omittedFiles lists files deliberately outside this bounded view, and omission is not evidence that the historical module lacks that behavior. Reading every available file is a failure mode: stay within a small evidence sample and rely on file names, interfaces, and the requirement for the remaining mapping.",
      "Return only one JSON object with summary, mappings, dependencies, and ordered steps. Do not return Markdown or source code.",
      "Every step must use only the exact allowed writeFiles. The plan must be concrete enough for a separate Translator Codex to implement without query_evidence.",
      `Requirement:\n${request.spec.replaceAll(this.files.root, "<target>")}`,
      `Target files in target/: ${visible}`,
      `Allowed writeFiles: ${request.writeFiles.join(", ")}`,
      `Read-only history-view path: ${historyRoot}/source`,
      "The host will validate this plan and hand the same plan to Translator Codex. Do not make any file changes.",
    ].join("\n\n");
  }

  private directTranslatorPrompt(request: WorkspaceTranslationRequest, historyRoot: string, plan: WorkspaceTranslationPlan, compilation?: WorkspaceCompilation, feedback?: WorkspaceVerificationFeedback): string {
    const visible = request.workspaceFiles.length ? request.workspaceFiles.join(", ") : "（目标工程可见文件）";
    const allowed = request.writeFiles.join(", ");
    return [
      "You are the Direct Translator Codex for a RECAST module translation task.",
      "The Analyzer plan is unavailable or was deliberately bypassed. Implement the requirement directly from the target workspace and task specification.",
      "A read-only history-view may be present as optional evidence; use it when useful, but do not wait for an Analyzer plan, invent a historical source, or attempt to access files outside this staging workspace.",
      "Read the target files before writing. Work only under target/ and modify only the exact allowed write files. Do not create build artifacts or change tests, build configuration, or verification criteria.",
      "Temporary patches or scripts may be stored in .agent-tmp/; only the allowed target source changes are applied back.",
      this.historyInventory(request),
      "Preserve existing public contracts and compiler settings. Implement complete behavior required by the specification; do not add stubs or weaken validation.",
      `Requirement:\n${request.spec.replaceAll(this.files.root, "<staging-workspace>")}`,
      `Target files in target/: ${visible}`,
      `Allowed write files (the only files that may differ): ${allowed}`,
      `Synthetic implementation scope (there is no history plan):\n${JSON.stringify(plan, null, 2)}`,
      `Optional read-only history-view path: ${historyRoot}`,
      compilation ? `The host compiler failed after the previous attempt. Repair these diagnostics:\n${this.safeDiagnostics(compilation.output)}` : "Implement the requirement now and finish after the source implementation is complete.",
      feedback ? `The host verifier rejected the previous implementation. Repair the same module using these observed facts:\n${JSON.stringify(feedback, null, 2)}` : "",
    ].join("\n\n");
  }

  private directTranslationPlan(request: WorkspaceTranslationRequest): WorkspaceTranslationPlan {
    const files = [...request.writeFiles];
    return {
      summary: "No usable historical candidate was available; implement the module directly from its requirement and target contracts.",
      mappings: files.map((path) => ({ source: "direct requirement", targetPath: path, targetSymbol: basename(path) })),
      dependencies: [],
      steps: [{ id: "direct-implementation", description: "Implement the complete requirement directly in the target module files.", files, dependsOn: [] }],
    };
  }

  private translatorPrompt(request: WorkspaceTranslationRequest, historyRoot: string, plan: WorkspaceTranslationPlan, compilation?: WorkspaceCompilation, feedback?: WorkspaceVerificationFeedback): string {
    const visible = request.workspaceFiles.length ? request.workspaceFiles.join(", ") : "（目标工程可见文件）";
    const allowed = request.writeFiles.join(", ");
    return [
      "You are the Translator Codex for a RECAST module translation task.",
      "Work only under target/. Read target files, CODEX_IMPLEMENTATION_PLAN.json, and the read-only history-view/source directory.",
      "The host will apply only changes to the exact allowed write files; do not edit any other file, do not create build artifacts, and do not modify history-view.",
      "Temporary patches or scripts may be stored in .agent-tmp/; only the allowed target source changes are applied back. Use the selected history modules for complementary behaviors as indicated by the plan, reading relevant files on demand.",
      this.historyInventory(request),
      "Implement the validated Analyzer plan completely in dependency order. Preserve public contracts and compiler settings. Do not add stubs or weaken validation.",
      `Requirement:\n${request.spec.replaceAll(this.files.root, "<staging-workspace>")}`,
      `Target files in target/: ${visible}`,
      `Allowed write files (the only files that may differ): ${allowed}`,
      `Implementation plan:\n${JSON.stringify(plan, null, 2)}`,
      `Read-only history-view path: ${historyRoot}/source`,
      compilation ? `The host compiler failed after the previous attempt. Repair these diagnostics:\n${this.safeDiagnostics(compilation.output)}` : "Start by inspecting the target files and implement the plan.",
      feedback ? `The host verifier rejected the previous implementation. This is feedback from the real Host test run, not a request to change tests or criteria. Repair the same module and compile again:\n${JSON.stringify(feedback, null, 2)}` : "",
      "Do not inspect or attempt to access files outside this staging workspace. Finish after the source implementation is complete.",
    ].join("\n\n");
  }

  private historyInventory(request: WorkspaceTranslationRequest): string {
    const candidates = request.historyView?.candidates;
    return candidates?.length ? `Selected read-only history modules (one task, one plan):\n${candidates.map(candidate =>
      `${candidate.prefix}: ${candidate.name ?? candidate.moduleId} (${candidate.language ?? "source"}) — history-view/source/${candidate.prefix}/`).join("\n")}` : "";
  }

  private safeDiagnostics(output: string): string {
    let value = output.replaceAll(this.files.root, "<workspace>").slice(0, 12_000);
    for (const protectedPath of this.options.verification?.protectedFiles ?? []) value = value.replaceAll(protectedPath, "<protected-file>");
    return value;
  }

  private async invokeCodex(root: string, prompt: string, signal: AbortSignal, active: { child?: ChildProcess }, sandbox: CodexSandbox, stage: CodexStage, outputSchema?: string): Promise<CodexInvocation> {
    const lastMessage = join(root, ".codex-last-message.txt");
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", sandbox, "--cd", root, "--json", "--output-last-message", lastMessage];
    if (outputSchema) args.push("--output-schema", outputSchema);
    if (this.codexModel) args.push("--model", this.codexModel);
    args.push(prompt);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const childEnvironment = { ...process.env, ...this.environment };
    // Keep ordinary translator scratch files out of the host and project
    // directories. The staging root is disposable, so these files are safe
    // to discard after the allow-listed target diff has been collected.
    if (sandbox === "workspace-write") {
      const scratch = join(root, ".agent-tmp");
      childEnvironment.TMPDIR = scratch;
      childEnvironment.TMP = scratch;
      childEnvironment.TEMP = scratch;
    }
    // CODEX_MODEL is a project-local compatibility variable, not part of the
    // Codex runtime contract. Never let a user's shell setting override the
    // explicit ADAPTATION_CODEX_MODEL (or the Codex config selected by HOME).
    if (!Object.prototype.hasOwnProperty.call(this.environment, "CODEX_MODEL")) delete childEnvironment.CODEX_MODEL;
    const child = spawn(this.codexCommand, args, { cwd: root, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    active.child = child;
    let stdout = ""; let stderr = "";
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (target === "stdout") stdout = (stdout + chunk.toString("utf8")).slice(-maxCodexOutput);
      else stderr = (stderr + chunk.toString("utf8")).slice(-maxCodexOutput);
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code) => resolveExit(code));
      }).finally(() => signal.removeEventListener("abort", abort));
    } catch (error) {
      stderr = `${stderr}\n${errorMessage(error)}`.slice(-maxCodexOutput);
      exitCode = null;
    }
    active.child = undefined;
    let finalMessage = "";
    try {
      const messageStat = await lstat(lastMessage);
      if (messageStat.isSymbolicLink() || !messageStat.isFile()) throw new Error("Codex output-last-message is not a regular file.");
      finalMessage = await readFile(lastMessage, "utf8");
    } catch (error) {
      if (error instanceof Error && error.message.includes("not a regular file")) throw error;
      /* Codex may have failed before writing a final message. */
    }
    const usage = parseCodexUsage(stdout);
    // stdout is a JSONL transport stream when --json is enabled. It is kept
    // separately so the Analyzer parser can inspect event envelopes, but it
    // must never be presented as the final assistant message. An absent
    // output-last-message is a real "no final response" condition.
    return { startedAt, exitCode, stderr, stdout, lastMessage: finalMessage, outputChars: stdout.length + finalMessage.length, durationMs: Date.now() - started, ...(usage ? { usage } : {}) };
  }

  private async createStaging(request: WorkspaceTranslationRequest, signal: AbortSignal, plan: WorkspaceTranslationPlan | undefined, analyzer: boolean): Promise<{ root: string; historyRoot: string; baseline: Map<string, string>; historyBaseline: Map<string, string>; planHash?: string }> {
    const root = await mkdtemp(join(tmpdir(), `forexplore-codex-${randomUUID()}-`));
    const baseline = new Map<string, string>();
    try {
      const targetRoot = join(root, "target");
      await mkdir(targetRoot, { recursive: true });
      if (!analyzer) await mkdir(join(root, ".agent-tmp"), { recursive: true, mode: 0o700 });
      await copyVisibleTree(this.files.root, targetRoot, this.options.verification?.protectedFiles ?? [], baseline, signal);
      const historyRoot = join(root, "history-view");
      await this.copyHistoryView(request.historyView, historyRoot, signal);
      const historyBaseline = new Map<string, string>();
      await collectHistoryFiles(historyRoot, "", historyBaseline);
      let planHash: string | undefined;
      if (!analyzer && plan) {
        const planText = JSON.stringify(plan, null, 2) + "\n";
        await writeFile(join(root, "CODEX_IMPLEMENTATION_PLAN.json"), planText, { mode: 0o444 });
        planHash = createHash("sha256").update(planText).digest("hex");
      }
      return { root, historyRoot, baseline, historyBaseline, ...(planHash ? { planHash } : {}) };
    } catch (error) { await removeStagingTree(root); throw error; }
  }

  private async copyHistoryView(view: WorkspaceHistoryView | undefined, destination: string, signal: AbortSignal): Promise<void> {
    if (!view) { await mkdir(destination, { recursive: true }); return; }
    this.validateHistoryView(view);
    const resolvedViewRoot = await realpath(view.root).catch(() => { throw new Error("History view root does not exist."); });
    const workspaceHistoryRoot = resolve(this.files.root, ".forexpore", "history-views");
    const temporaryRoot = resolve(tmpdir());
    const workspacePrefix = workspaceHistoryRoot.endsWith(sep) ? workspaceHistoryRoot : `${workspaceHistoryRoot}${sep}`;
    const temporaryPrefix = temporaryRoot.endsWith(sep) ? temporaryRoot : `${temporaryRoot}${sep}`;
    const resolvedWorkspaceRoot = await realpath(workspaceHistoryRoot).catch(() => workspaceHistoryRoot);
    const resolvedWorkspacePrefix = resolvedWorkspaceRoot.endsWith(sep) ? resolvedWorkspaceRoot : `${resolvedWorkspaceRoot}${sep}`;
    const resolvedTemporaryPrefix = temporaryRoot.endsWith(sep) ? temporaryRoot : `${temporaryRoot}${sep}`;
    const allowedResolved = (resolvedViewRoot.startsWith(resolvedWorkspacePrefix) && resolvedViewRoot.slice(resolvedWorkspacePrefix.length).split(sep).length === 1) ||
      (resolvedViewRoot.startsWith(resolvedTemporaryPrefix) && resolvedViewRoot.slice(resolvedTemporaryPrefix.length).split(sep).length === 1);
    if (!allowedResolved || (!resolvedViewRoot.startsWith(workspacePrefix) && !resolvedViewRoot.startsWith(temporaryPrefix))) throw new Error("History view root symlink escapes its allowlist.");
    await mkdir(destination, { recursive: true });
    const manifestPath = join(view.root, "manifest.json");
    let manifest: unknown;
    try {
      const manifestStat = await lstat(manifestPath);
      if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error("manifest is not a regular file");
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch { throw new Error("History view manifest is missing or invalid."); }
    const manifestObject = manifest as {
      repositoryId?: unknown; analysisRevision?: unknown; projectId?: unknown; moduleId?: unknown;
      runId?: unknown; generatedAt?: unknown; files?: unknown; omittedFiles?: unknown; candidates?: unknown;
    };
    if (manifestObject.repositoryId !== view.repositoryId || manifestObject.analysisRevision !== view.analysisRevision ||
        manifestObject.moduleId !== view.moduleId || (view.projectId ?? undefined) !== (manifestObject.projectId ?? undefined) ||
        (view.runId ?? undefined) !== (manifestObject.runId ?? undefined) || (view.generatedAt ?? undefined) !== (manifestObject.generatedAt ?? undefined) ||
        !Array.isArray(manifestObject.files)) throw new Error("History view manifest metadata mismatch.");
    if (JSON.stringify(manifestObject.candidates ?? null) !== JSON.stringify(view.candidates ?? null)) throw new Error("History view candidate metadata mismatch.");
    if (manifestObject.omittedFiles !== undefined &&
        (!Array.isArray(manifestObject.omittedFiles) || manifestObject.omittedFiles.some((file) => typeof file !== "string"))) {
      throw new Error("Invalid omitted history-view file list.");
    }
    await writeFile(join(destination, "manifest.json"), JSON.stringify(manifestObject, null, 2) + "\n", { mode: 0o444 });
    const manifestFiles = new Map<string, string>();
    for (const item of manifestObject.files) {
      const value = item as { path?: unknown; sha256?: unknown };
      if (typeof value.path !== "string" || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256)) throw new Error("Invalid history view manifest entry.");
      manifestFiles.set(value.path, value.sha256);
    }
    if (manifestFiles.size !== view.files.length || view.files.some(file => !manifestFiles.has(file))) throw new Error("History view manifest file list mismatch.");
    const entries: Array<[string, string]> = [];
    for (const file of view.files) {
      signal.throwIfAborted();
      const source = await safeExternalFile(view.root, join("source", ...file.split("/")));
      const bytes = await readFile(source);
      // Keep the same source/ layout as the host-owned view. The Analyzer and
      // Translator prompts intentionally point at history-view/source, while
      // manifest.json stays at the history-view root.
      const target = join(destination, "source", ...file.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      await chmod(target, 0o444);
      const fileHash = createHash("sha256").update(bytes).digest("hex");
      if (manifestFiles.get(file) !== fileHash) throw new Error(`History view file hash mismatch: ${file}`);
      entries.push([file, fileHash]);
    }
    entries.sort(([left], [right]) => left.localeCompare(right));
    const manifestHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    if (manifestHash !== view.manifestHash) throw new Error("History view manifest changed before Codex started.");
    await writeFile(join(destination, "README.txt"), "Read-only history evidence. Do not modify this directory.\n", { mode: 0o444 });
    await chmodReadonlyTree(destination);
  }

  private async diffStaging(stage: { root: string; baseline: Map<string, string>; historyBaseline: Map<string, string>; planHash?: string }, writeFiles: readonly string[]): Promise<Array<{ path: string; before: string | null; after: string }>> {
    // Translator scratch artifacts (for example a unified diff saved as
    // patch.txt) are disposable and must not block a valid target diff.
    await this.assertControlFilesUnchanged(stage, true);
    const after = new Map<string, string>();
    await collectTargetFiles(stage.root, after);
    const allowed = new Set(writeFiles);
    const changed: Array<{ path: string; before: string | null; after: string }> = [];
    for (const [path, content] of after) {
      const before = stage.baseline.get(path);
      if (before === content) continue;
      if (!allowed.has(path)) throw new Error(`Codex modified a file outside writeFiles: ${path}`);
      changed.push({ path, before: before ?? null, after: content });
    }
    for (const path of stage.baseline.keys()) {
      if (after.has(path)) continue;
      if (allowed.has(path)) throw new Error(`Codex deleted an allowed file; deletions are not accepted: ${path}`);
      throw new Error(`Codex deleted a file outside writeFiles: ${path}`);
    }
    return changed.sort((left, right) => left.path.localeCompare(right.path));
  }

  private applyChanges(run: WorkspaceTranslationRun, changes: Array<{ path: string; before: string | null; after: string }>): void {
    if (!run.plan) throw new Error("Translator returned changes without an Analyzer plan.");
    run.completedSteps = [];
    for (const change of changes) {
      if (change.after.startsWith("\0binary:")) throw new Error(`Codex changed a non-text file, which is outside the supported write scope: ${change.path}`);
      const current = this.files.read(change.path);
      if (current !== change.before) throw new Error(`File changed while Codex was running: ${change.path}`);
      const existing = run.changes.find(item => item.path === change.path);
      this.files.write(change.path, current, change.after);
      run.changes = run.changes.filter(item => item.path !== change.path);
      if (!existing || existing.before !== change.after) {
        run.changes.push({ path: change.path, before: existing?.before ?? current, after: change.after, applied: true });
      }
    }
    run.completedSteps = run.plan.steps.map(step => step.id);
    if (run.agent) run.agent.incrementalLines = run.changes.reduce((sum, change) => sum + changedLineCount(change.before, change.after), 0);
  }

  private recordInvocation(run: WorkspaceTranslationRun, stage: CodexStage, sandbox: CodexSandbox, prompt: string, result: CodexInvocation, historyFiles: readonly string[]): void {
    const entry: NonNullable<NonNullable<WorkspaceTranslationRun["agent"]>["stages"]>[number] = {
      stage, sandbox, command: this.codexCommand, ...(this.codexModel ? { model: this.codexModel } : {}),
      startedAt: result.startedAt, durationMs: result.durationMs, exitCode: result.exitCode,
      inputChars: prompt.length, outputChars: result.outputChars,
      ...(result.usage ? { usage: result.usage } : {}),
      readFiles: [...new Set([...run.request.workspaceFiles.map(path => `target/${path}`), ...historyFiles.map(path => `history-view/source/${path}`)])].sort(),
      commands: codexCommands(result.stdout),
    };
    const agent = run.agent ?? { kind: "codex" as const, command: this.codexCommand, ...(this.codexModel ? { model: this.codexModel } : {}), startedAt: result.startedAt, stages: [] };
    run.agent = agent;
    agent.stages ??= [];
    agent.stages.push(entry);
    const stages = agent.stages;
    agent.durationMs = stages.reduce((total, item) => total + item.durationMs, 0);
    agent.outputChars = stages.reduce((total, item) => total + (item.outputChars ?? 0), 0);
    agent.inputChars = stages.reduce((total, item) => total + (item.inputChars ?? 0), 0);
    // Recompute totals from the stage records. Starting the reduction with the
    // previously stored aggregate would add all earlier stages a second time
    // whenever a later invocation is recorded (e.g. analyzer + translator).
    const usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } = {};
    for (const item of stages) {
      if (usage.inputTokens !== undefined || item.usage?.inputTokens !== undefined) {
        usage.inputTokens = (usage.inputTokens ?? 0) + (item.usage?.inputTokens ?? 0);
      }
      if (usage.outputTokens !== undefined || item.usage?.outputTokens !== undefined) {
        usage.outputTokens = (usage.outputTokens ?? 0) + (item.usage?.outputTokens ?? 0);
      }
      if (usage.cacheReadTokens !== undefined || item.usage?.cacheReadTokens !== undefined) {
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (item.usage?.cacheReadTokens ?? 0);
      }
    }
    agent.usage = usage;
    agent.exitCode = result.exitCode;
  }

  private parseAnalyzerPlan(result: CodexInvocation, request: WorkspaceTranslationRequest): WorkspaceTranslationPlan {
    // `codex exec --json` is a JSONL event stream. Depending on the provider,
    // --output-last-message may contain that stream instead of the final text,
    // and the actual assistant response can be nested under item.text/content.
    // Collect both the direct payloads and those transport-wrapped strings.
    const candidates: string[] = [];
    const collect = (value: unknown): void => collectAnalyzerPayloads(value, candidates);
    collect(result.lastMessage);
    for (const line of result.stdout.split(/\r?\n/).reverse()) {
      const text = line.trim();
      if (!text) continue;
      candidates.push(text);
      try { collect(JSON.parse(text)); } catch { /* human-readable or partial JSONL */ }
    }
    let lastError: unknown;
    for (const raw of candidates) {
      const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      if (!text) continue;
      try { return parseWorkspaceTranslationPlan(JSON.parse(text), request); } catch (error) { lastError = error; /* Try the next JSON event/final message. */ }
      const start = text.indexOf("{"); const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return parseWorkspaceTranslationPlan(JSON.parse(text.slice(start, end + 1)), request); } catch (error) { lastError = error; /* Continue searching. */ }
      }
    }
    throw new Error(`Codex Analyzer did not return a valid implementation plan JSON object${lastError ? `: ${errorMessage(lastError)}` : "."}`);
  }

  private async assertStagingUnchanged(stage: { root: string; baseline: Map<string, string>; historyBaseline: Map<string, string>; planHash?: string }): Promise<void> {
    await this.assertControlFilesUnchanged(stage);
    if (await pathExists(join(stage.root, "CODEX_IMPLEMENTATION_PLAN.json"))) throw new Error("Codex Analyzer wrote an implementation-plan file; Analyzer output must be returned through its final message.");
    const after = new Map<string, string>();
    await collectTargetFiles(stage.root, after);
    if (after.size !== stage.baseline.size) throw new Error("Codex Analyzer changed the target file set.");
    for (const [path, content] of stage.baseline) if (after.get(path) !== content) throw new Error(`Codex Analyzer modified target file: ${path}`);
  }

  private async assertControlFilesUnchanged(stage: { root: string; baseline: Map<string, string>; historyBaseline: Map<string, string>; planHash?: string }, allowTransientRootFiles = false): Promise<void> {
    const entries = await readdir(stage.root, { withFileTypes: true });
    // Codex CLI may create its empty local agent metadata directory in the
    // staging root. It is outside both visible trees and is never copied back
    // to the target; keep the scope check strict for every other root entry.
    const allowed = new Set(["target", "history-view", "CODEX_IMPLEMENTATION_PLAN.json", "CODEX_ANALYZER_SCHEMA.json", ".codex-last-message.txt", ...(allowTransientRootFiles ? [".agent-tmp"] : []), ...codexMetadataDirectories]);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Codex created a symbolic link in staging: ${entry.name}`);
      // A translator may leave a regular temporary artifact at the staging
      // root. It is never copied back; only target/ is diffed below. Keep
      // rejecting unknown directories so a new tree cannot hide writes.
      if (!allowed.has(entry.name)) {
        if (allowTransientRootFiles && entry.isFile()) continue;
        throw new Error(`Codex created an out-of-scope staging entry: ${entry.name}`);
      }
      if (codexMetadataDirectories.has(entry.name) && !entry.isDirectory()) throw new Error(`Codex metadata entry must be a directory: ${entry.name}`);
    }
    const history = join(stage.root, "history-view");
    const currentHistory = new Map<string, string>();
    await collectHistoryFiles(history, "", currentHistory);
    if (currentHistory.size !== stage.historyBaseline.size) throw new Error("Codex changed the history-view file set.");
    for (const [path, content] of stage.historyBaseline) if (currentHistory.get(path) !== content) throw new Error(`Codex modified read-only history-view file: ${path}`);
    if (stage.planHash) {
      const planPath = join(stage.root, "CODEX_IMPLEMENTATION_PLAN.json");
      const bytes = await readFile(planPath);
      if (createHash("sha256").update(bytes).digest("hex") !== stage.planHash) throw new Error("Codex modified CODEX_IMPLEMENTATION_PLAN.json.");
    }
  }

  private validateHistoryView(view: WorkspaceHistoryView | undefined): void {
    if (!view) return;
    const root = resolve(view.root);
    const temporaryRoot = resolve(tmpdir());
    const temporaryPrefix = temporaryRoot.endsWith(sep) ? temporaryRoot : `${temporaryRoot}${sep}`;
    const workspaceHistoryRoot = resolve(this.files.root, ".forexpore", "history-views");
    const workspacePrefix = workspaceHistoryRoot.endsWith(sep) ? workspaceHistoryRoot : `${workspaceHistoryRoot}${sep}`;
    const isWorkspaceView = root.startsWith(workspacePrefix) && root.slice(workspacePrefix.length).split(sep).length === 1;
    const isTemporaryView = root.startsWith(temporaryPrefix) && root.slice(temporaryPrefix.length).split(sep).length === 1 && root.slice(temporaryPrefix.length).startsWith("forexplore-history-view-");
    if (!view.root || !isAbsolute(view.root) || (!isWorkspaceView && !isTemporaryView) ||
        !Array.isArray(view.files) || !view.files.length ||
        !view.repositoryId || !view.analysisRevision || !view.moduleId || !/^[a-f0-9]{64}$/i.test(view.manifestHash)) throw new Error("Invalid history view.");
    if (isWorkspaceView && view.runId && root.slice(workspacePrefix.length) !== view.runId) throw new Error("History view runId does not match its root.");
    for (const file of view.files) {
      const normalized = file.replaceAll("\\", "/");
      if (!normalized || normalized.startsWith("/") || normalized.split("/").some(part => !part || part === "." || part === "..") || sensitiveFileNames.has(normalized.split("/").at(-1)!.toLowerCase())) throw new Error(`Invalid history view file: ${file}`);
    }
  }

  private reconcile(run: WorkspaceTranslationRun, rollback = false): void {
    for (const change of run.changes) {
      const current = this.files.read(change.path);
      if (change.rolledBack) { if (current !== change.before) throw new CodexWorkspaceTranslationError(409, `File changed after rollback: ${change.path}`); }
      else if (current === change.after) change.applied = true;
      else if (current === change.before && (rollback || !change.applied)) change.applied = false;
      else throw new CodexWorkspaceTranslationError(409, `File changed outside this task: ${change.path}`);
    }
  }

  private assertVerification(run: WorkspaceTranslationRun): void {
    const configured = this.options.verification;
    if (Boolean(configured) !== Boolean(run.verification)) throw new Error("Verification policy changed; start a new translation run.");
    if (configured && run.verification && JSON.stringify(configured.command) !== JSON.stringify(run.verification.command)) throw new Error("Verification policy changed; start a new translation run.");
    for (const criterion of run.verification?.criteria ?? []) if (hash(this.files.read(criterion.path)) !== criterion.hash) throw new Error(`Verification criteria changed: ${criterion.path}`);
  }

  private snapshot(run: WorkspaceTranslationRun): string {
    return JSON.stringify([...new Set([...run.request.workspaceFiles, ...run.request.writeFiles, ...(run.verification?.criteria.map(item => item.path) ?? [])])].sort().map(path => [path, hash(this.files.read(path))]));
  }

  private event(run: WorkspaceTranslationRun, phase: WorkspaceTranslationRun["status"], message: string): void {
    run.events ??= []; run.events.push({ at: new Date().toISOString(), phase, message }); if (run.events.length > 300) run.events.splice(0, run.events.length - 300); run.updatedAt = new Date().toISOString();
  }

  private save(run: WorkspaceTranslationRun): void { run.updatedAt = new Date().toISOString(); this.files.save(run.id, run); }
  private requireIdle(): void { if (this.closing) throw new CodexWorkspaceTranslationError(503, "Workspace translation is shutting down."); if (this.active) throw new CodexWorkspaceTranslationError(409, "A translation is already running in this workspace."); }

  private validateRecord(value: unknown, id: string): WorkspaceTranslationRun {
    const record = object(value); validateWorkspaceTranslationRequest(record.request);
    const run = record as unknown as WorkspaceTranslationRun;
    if (run.id !== id || run.workspaceRoot !== this.files.root || !terminalStatuses.has(run.status) && !runningStatuses.has(run.status) || !Array.isArray(run.changes) || !Array.isArray(run.compilations) || !Array.isArray(run.completedSteps)) throw new Error("Invalid translation record.");
    return run;
  }
}

/**
 * Pull likely final-message payloads out of Codex JSONL transport events.
 * Command output is intentionally excluded: it can contain hundreds of
 * kilobytes of source text and is never an implementation plan.
 */
function collectAnalyzerPayloads(value: unknown, output: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return;
    output.push(text);
    if ((text.startsWith("{") || text.startsWith("[")) && text.length <= maxCodexOutput) {
      try { collectAnalyzerPayloads(JSON.parse(text), output, depth + 1); } catch { /* ordinary message text */ }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAnalyzerPayloads(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const objectValue = value as Record<string, unknown>;
  if (["summary", "mappings", "dependencies", "steps"].every((key) => key in objectValue)) {
    output.push(JSON.stringify(objectValue));
  }
  // These are the fields used by Codex's JSONL event variants for an
  // assistant message. Do not recurse into aggregated_output/command fields.
  for (const key of ["text", "content", "output_text", "message", "lastMessage", "finalMessage", "response", "result", "item", "data", "parts"]) {
    if (key in objectValue) collectAnalyzerPayloads(objectValue[key], output, depth + 1);
  }
}

function historyViewAudit(view: WorkspaceHistoryView): NonNullable<WorkspaceTranslationRun["agent"]>["historyView"] {
  return { repositoryId: view.repositoryId, analysisRevision: view.analysisRevision, moduleId: view.moduleId, files: view.files.length, manifestHash: view.manifestHash,
    ...(view.runId ? { runId: view.runId } : {}), ...(view.generatedAt ? { generatedAt: view.generatedAt } : {}),
    ...(view.candidates ? { candidates: structuredClone(view.candidates) } : {}) };
}

function codexCommands(stdout: string): Array<{ command: string; exitCode?: number | null }> {
  const commands: Array<{ command: string; exitCode?: number | null }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const item = event.type === "item.completed" ? event.item : undefined;
      if (item?.type === "command_execution" && typeof item.command === "string") {
        commands.push({ command: item.command.slice(0, 4000), ...(item.exit_code !== undefined ? { exitCode: item.exit_code } : {}) });
      }
    } catch { /* partial or non-JSON output */ }
  }
  return commands.slice(-40);
}

/** chmod makes the host-owned read-only evidence removable on Linux too. */
async function removeStagingTree(root: string): Promise<void> {
  async function writable(directory: string): Promise<void> {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(join(directory, entry.name));
    }
  }
  await writable(root).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

async function copyVisibleTree(source: string, destination: string, protectedFiles: readonly string[], baseline: Map<string, string>, signal: AbortSignal): Promise<void> {
  const protectedSet = new Set(protectedFiles.map(path => path.replaceAll("\\", "/")));
  await walkTree(source, "", async (relativePath, absolutePath) => {
    signal.throwIfAborted();
    if (protectedSet.has(relativePath)) return;
    const target = join(destination, ...relativePath.split("/")); await mkdir(dirname(target), { recursive: true });
    const content = await readFile(absolutePath);
    await writeFile(target, content);
    baseline.set(relativePath, snapshotBytes(content));
  });
}

async function walkTree(root: string, prefix: string, visit: (relativePath: string, absolutePath: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(join(root, ...(prefix ? prefix.split("/") : [])), { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Both spellings exist in deployed workspaces. Run journals contain prior
    // implementation snapshots and verification evidence, never Agent input.
    if (generatedDirectoryNames.has(entry.name) || entry.name.startsWith(".forexpore") || entry.name.startsWith(".forexplore") || sensitiveFileNames.has(entry.name.toLowerCase()) || /(?:\.test|\.spec)\.[^.]+$/i.test(entry.name)) continue;
    const absolute = join(root, ...relativePath.split("/"));
    if (entry.isDirectory()) await walkTree(root, relativePath, visit);
    else if (entry.isFile()) {
      const info = await stat(absolute);
      if (info.size <= 2 * 1024 * 1024) await visit(relativePath, absolute);
    }
  }
}

async function collectTargetFiles(root: string, result: Map<string, string>): Promise<void> {
  await rejectSymlinks(join(root, "target"), "");
  await collectAllFiles(join(root, "target"), "", result);
}

async function collectAllFiles(root: string, prefix: string, result: Map<string, string>): Promise<void> {
  for (const entry of await readdir(join(root, ...(prefix ? prefix.split("/") : [])), { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(root, ...relativePath.split("/"));
    if (entry.isDirectory()) {
      // Build/test tools commonly leave bin/obj/node_modules in the staging
      // copy. They are deliberately invisible to the Agent and must not turn
      // an otherwise valid source diff into an out-of-scope edit.
      if (generatedDirectoryNames.has(entry.name) || entry.name.startsWith(".forexpore") || entry.name.startsWith(".forexplore")) continue;
      await collectAllFiles(root, relativePath, result);
    }
    else if (entry.isFile()) result.set(relativePath, snapshotBytes(await readFile(absolute)));
  }
}

async function rejectSymlinks(root: string, prefix: string): Promise<void> {
  for (const entry of await readdir(join(root, ...(prefix ? prefix.split("/") : [])), { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Codex created a symbolic link in staging: ${relativePath}`);
    if (entry.isDirectory()) await rejectSymlinks(root, relativePath);
  }
}

function snapshotBytes(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return !bytes.includes(0) && Buffer.from(text, "utf8").equals(bytes)
    ? text
    : `\0binary:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function collectHistoryFiles(root: string, prefix: string, result: Map<string, string>): Promise<void> {
  const directory = join(root, ...(prefix ? prefix.split("/") : []));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collectHistoryFiles(root, relativePath, result);
    else if (entry.isFile()) {
      const bytes = await readFile(join(directory, entry.name));
      result.set(relativePath, createHash("sha256").update(bytes).digest("hex"));
    } else throw new Error(`Unexpected history-view entry: ${relativePath}`);
  }
}

async function chmodReadonlyTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link in read-only history view: ${entry.name}`);
    if (entry.isDirectory()) await chmodReadonlyTree(child);
    await chmod(child, entry.isDirectory() ? 0o555 : 0o444);
  }
  await chmod(root, 0o555);
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function changedLineCount(before: string | null, after: string): number {
  const left = (before ?? "").split(/\r?\n/);
  const right = after.split(/\r?\n/);
  const rows = left.length + 1; const cols = right.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = 1; i < rows; i++) for (let j = 1; j < cols; j++) lcs[i][j] = left[i - 1] === right[j - 1] ? lcs[i - 1][j - 1] + 1 : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
  return Math.max(0, left.length - lcs[rows - 1][cols - 1]) + Math.max(0, right.length - lcs[rows - 1][cols - 1]);
}

async function safeExternalFile(root: string, relativePath: string): Promise<string> {
  const resolvedRoot = await realpath(root); const candidate = resolve(root, ...relativePath.replaceAll("\\", "/").split("/"));
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (!candidate.startsWith(prefix)) throw new Error(`History view path escapes its root: ${relativePath}`);
  const link = await lstat(candidate); if (link.isSymbolicLink() || !link.isFile()) throw new Error(`History view entry is not a regular file: ${relativePath}`);
  const resolvedCandidate = await realpath(candidate);
  if (!resolvedCandidate.startsWith(prefix)) throw new Error(`History view path escapes its root: ${relativePath}`);
  const info = await stat(candidate); if (!info.isFile()) throw new Error(`History view entry is not a file: ${relativePath}`); return candidate;
}

function parseCodexUsage(output: string): { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined {
  let usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined;
  for (const line of output.split("\n")) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const candidate = (value.usage ??
        (value.response as Record<string, unknown> | undefined)?.usage ??
        (value.result as Record<string, unknown> | undefined)?.usage ??
        (value.item as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
      if (!candidate) continue;
      const input = Number(candidate.input_tokens ?? candidate.inputTokens ?? candidate.prompt_tokens);
      const outputTokens = Number(candidate.output_tokens ?? candidate.outputTokens ?? candidate.completion_tokens);
      const cache = Number(candidate.cache_read_input_tokens ?? candidate.cacheReadTokens ?? candidate.cache_read_tokens);
      usage = { ...(Number.isFinite(input) ? { inputTokens: input } : {}), ...(Number.isFinite(outputTokens) ? { outputTokens } : {}), ...(Number.isFinite(cache) ? { cacheReadTokens: cache } : {}) };
    } catch { /* Codex emits both JSON events and human-readable lines. */ }
  }
  return usage;
}

function boundedAnalyzerOutput(value: string): { value: string; truncated: boolean } {
  if (value.length <= maxRecordedAnalyzerOutput) return { value, truncated: false };
  return { value: `${value.slice(0, maxRecordedAnalyzerOutput)}\n...[Analyzer output truncated]`, truncated: true };
}
