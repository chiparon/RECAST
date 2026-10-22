import { createHash, randomUUID } from "node:crypto";
import type {
  WorkspaceCompilation, WorkspaceCompileCommand, WorkspaceEvidenceQuery, WorkspaceTranslationRequest, WorkspaceTranslationRun,
} from "@forexplore/contracts";
import type { DeepSeekToolMessage } from "./deepseek-client";
import { compileWorkspace, validateWorkspaceCompileCommand } from "./workspace-compiler";
import { applyWorkspaceEdits, parseWorkspaceEdits } from "./workspace-translation-edits";
import { TranslationWorkspaceFiles, maxWorkspaceFileChars } from "./workspace-translation-files";
import type { WorkspaceEvidencePort } from "./workspace-evidence-port";
import {
  object, parseWorkspaceTranslationPlan, validateWorkspaceTranslationRequest,
  workspaceAnalyzerPrompt, workspaceAnalyzerTools, workspaceTranslatorPrompt, workspaceTranslatorTools,
  type WorkspaceTranslationModelClient,
} from "./workspace-translation-agent";

export interface WorkspaceTranslationRuntimeOptions {
  workspaceRoot: string;
  compileCommand: WorkspaceCompileCommand;
  /** Host-owned immutable test harness and all its criteria/configuration files. */
  verification?: { command: WorkspaceCompileCommand; protectedFiles: string[] };
  client: WorkspaceTranslationModelClient;
  /**
   * Optional read-only history index. When present and the run carries
   * evidenceScopes, the agents may query it themselves with a bounded budget.
   */
  evidence?: {
    port: WorkspaceEvidencePort;
    maxQueries?: number;
    maxExcerptsPerQuery?: number;
    maxTotalChars?: number;
  };
  /** Budget per start/resume, including Analyzer and repair turns. */
  maxModelTurns?: number;
  timeoutMs?: number;
}

const evidenceDefaults = { maxQueries: 6, maxExcerptsPerQuery: 6, maxTotalChars: 60_000 } as const;
const maxEvidenceRequirementChars = 600;

export class WorkspaceTranslationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const runningStatuses = new Set(["analyzing", "translating", "compiling", "testing"]);
const hash = (content: string | null) => content === null ? null : createHash("sha256").update(content).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One writer per configured workspace; durable before-images support restart and rollback. */
export class WorkspaceTranslationRuntime {
  private readonly files: TranslationWorkspaceFiles;
  private readonly command: WorkspaceCompileCommand;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private evidenceBudget?: { maxQueries: number; maxExcerptsPerQuery: number; maxTotalChars: number };
  /** Excerpts already delivered to a run, so a repeated query cannot re-feed them. */
  readonly #deliveredEvidence = new Map<string, Set<string>>();
  private closing = false;
  private active?: { run: WorkspaceTranslationRun; controller: AbortController; done: Promise<void> };

  constructor(private readonly options: WorkspaceTranslationRuntimeOptions) {
    validateWorkspaceCompileCommand(options.compileCommand);
    this.command = structuredClone(options.compileCommand);
    this.maxTurns = options.maxModelTurns ?? 80;
    this.timeoutMs = options.timeoutMs ?? 1_800_000;
    if (!Number.isInteger(this.maxTurns) || this.maxTurns < 1 || this.maxTurns > 1000 ||
      !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 7_200_000) {
      throw new Error("Invalid workspace translation execution budget.");
    }
    this.files = new TranslationWorkspaceFiles(options.workspaceRoot);
    if (options.evidence) {
      const { maxQueries, maxExcerptsPerQuery, maxTotalChars } = { ...evidenceDefaults, ...options.evidence };
      if (![maxQueries, maxExcerptsPerQuery, maxTotalChars].every((value) => Number.isInteger(value) && value > 0) ||
        maxQueries > 32 || maxExcerptsPerQuery > 20 || maxTotalChars > 512_000) {
        throw new Error("Invalid on-demand evidence budget.");
      }
      this.evidenceBudget = { maxQueries, maxExcerptsPerQuery, maxTotalChars };
    }
    if (options.verification) {
      validateWorkspaceCompileCommand(options.verification.command);
      if (!options.verification.protectedFiles.length || options.verification.protectedFiles.length > 100) throw new Error("Verification requires 1..100 protected criteria files.");
      options.verification = structuredClone(options.verification);
      for (const path of options.verification.protectedFiles) if (this.files.read(path) === null) throw new Error(`Verification criteria missing: ${path}`);
    }
  }

  configuration(): { workspaceRoot: string; behavioralVerification: boolean } {
    return { workspaceRoot: this.files.root, behavioralVerification: Boolean(this.options.verification) };
  }

  start(input: unknown): WorkspaceTranslationRun {
    this.requireIdle();
    try { validateWorkspaceTranslationRequest(input); }
    catch (error) { throw new WorkspaceTranslationError(400, message(error)); }
    const request = structuredClone(input);
    for (const path of new Set([...request.workspaceFiles, ...request.writeFiles])) this.files.read(path);
    const verification = this.options.verification;
    if (verification && request.writeFiles.some(path => verification.protectedFiles.some(protectedPath => path.toLowerCase() === protectedPath.toLowerCase()))) {
      throw new WorkspaceTranslationError(400, "Verification criteria cannot be included in writeFiles.");
    }
    const now = new Date().toISOString();
    const run: WorkspaceTranslationRun = {
      id: randomUUID(), workspaceRoot: this.files.root, request, status: "analyzing",
      createdAt: now, updatedAt: now, completedSteps: [], changes: [], compilations: [], evidenceQueries: [],
      modelTurns: 0, acceptance: "compilation-only",
      events: [{ at: now, phase: "analyzing", message: "翻译任务已启动，等待 Analyzer" }],
      ...(verification ? { verification: { command: structuredClone(verification.command),
        criteria: verification.protectedFiles.map(path => {
          const value = hash(this.files.read(path));
          if (!value) throw new WorkspaceTranslationError(409, `Verification criteria missing: ${path}`);
          return { path, hash: value };
        }), runs: [] } } : {}),
    };
    this.save(run);
    return this.launch(run);
  }

  get(id: string): WorkspaceTranslationRun {
    if (this.active?.run.id === id) return structuredClone(this.active.run);
    let value: unknown;
    try { value = this.files.load(id); }
    catch (error) { throw new WorkspaceTranslationError(400, message(error)); }
    if (!value) throw new WorkspaceTranslationError(404, "Translation run was not found.");
    const run = this.validateRecord(value, id);
    if (runningStatuses.has(run.status)) {
      run.status = "interrupted";
      run.error = "Execution was interrupted. Resume to revalidate and continue.";
    }
    return run;
  }

  async cancel(id: string): Promise<WorkspaceTranslationRun> {
    const active = this.active;
    if (active?.run.id === id) {
      active.controller.abort(new Error("Translation cancelled."));
      await active.done;
    }
    return this.get(id);
  }

  resume(id: string): WorkspaceTranslationRun {
    this.requireIdle();
    const run = this.get(id);
    if (!["failed", "cancelled", "interrupted"].includes(run.status)) {
      throw new WorkspaceTranslationError(409, "Only failed, cancelled or interrupted runs can resume.");
    }
    this.assertVerification(run);
    this.reconcile(run);
    run.acceptance = "compilation-only";
    run.status = run.plan ? "translating" : "analyzing";
    delete run.error;
    run.events ??= [];
    run.events.push({ at: new Date().toISOString(), phase: run.status, message: "翻译任务已恢复" });
    if (run.events.length > 300) run.events.splice(0, run.events.length - 300);
    this.save(run);
    return this.launch(run);
  }

  rollback(id: string): WorkspaceTranslationRun {
    this.requireIdle();
    const run = this.get(id);
    if (run.status === "rolled-back") return run;
    // Preflight every file before restoring any of them. Later user edits are never overwritten.
    this.reconcile(run, true);
    run.acceptance = "compilation-only";
    run.status = "rolling-back";
    this.save(run);
    try {
      for (const change of [...run.changes].reverse()) {
        if (change.rolledBack) continue;
        const current = this.files.read(change.path);
        if (current !== change.before) this.files.write(change.path, change.after, change.before);
        change.rolledBack = true;
        this.save(run);
      }
      run.status = "rolled-back";
      delete run.error;
      this.save(run);
    } catch (error) {
      run.error = message(error);
      this.save(run);
      throw error;
    }
    return structuredClone(run);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    const active = this.active;
    if (!active) return;
    active.controller.abort(new Error("Translation interrupted by service shutdown."));
    await active.done;
  }

  /**
   * Bounded on-demand evidence. The agent chooses what to look up; the host
   * index decides what exists, and this method enforces the per-run budget,
   * deduplicates repeated excerpts and keeps an auditable record.
   */
  async #queryEvidence(
    run: WorkspaceTranslationRun,
    args: Record<string, unknown>,
    scopes: readonly NonNullable<WorkspaceTranslationRequest["evidenceScopes"]>[number][],
    signal: AbortSignal,
  ): Promise<unknown> {
    const evidence = this.options.evidence;
    const budget = this.evidenceBudget;
    if (!evidence || !budget) throw new Error("On-demand history evidence is not configured.");
    const requirement = typeof args.requirement === "string" ? args.requirement.trim() : "";
    if (!requirement || requirement.length > maxEvidenceRequirementChars) {
      throw new Error(`query_evidence needs a requirement of 1..${maxEvidenceRequirementChars} characters.`);
    }
    const limit = args.limit === undefined ? budget.maxExcerptsPerQuery : args.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > budget.maxExcerptsPerQuery) {
      throw new Error(`query_evidence limit must be an integer in 1..${budget.maxExcerptsPerQuery}.`);
    }
    const records = run.evidenceQueries ?? (run.evidenceQueries = []);
    if (records.length >= budget.maxQueries) {
      throw new Error(`Evidence budget exhausted: at most ${budget.maxQueries} queries per run.`);
    }
    const remaining = budget.maxTotalChars - records.reduce((sum, item) => sum + item.characters, 0);
    if (remaining <= 0) throw new Error("Evidence budget exhausted: no excerpt characters remain.");
    const record: WorkspaceEvidenceQuery = {
      at: new Date().toISOString(), requirement,
      repositoryIds: [...new Set(scopes.map((scope) => scope.repositoryId))], excerptCount: 0, characters: 0,
    };
    if (records.some((item) => item.requirement === requirement && !item.error)) {
      // A repeated natural-language query cannot produce new evidence in an
      // immutable revision. Do not spend another HTTP/SeekDB round trip; the
      // model receives a clear result and can choose a more concrete symbol.
      records.push(record);
      this.save(run);
      return {
        evidence: [], characters: 0,
        remainingQueries: budget.maxQueries - records.length,
        remainingCharacters: remaining,
        notes: ["DUPLICATE_EVIDENCE_QUERY_USE_A_CONCRETE_SYMBOL"],
      };
    }
    try {
      const result = await evidence.port.query({ requirement, limit: limit as number, scopes }, signal);
      const seen = this.#deliveredEvidence.get(run.id) ?? new Set<string>();
      this.#deliveredEvidence.delete(run.id);
      this.#deliveredEvidence.set(run.id, seen);
      while (this.#deliveredEvidence.size > 8) {
        const oldest = this.#deliveredEvidence.keys().next().value;
        if (oldest === undefined || oldest === run.id) break;
        this.#deliveredEvidence.delete(oldest);
      }
      const fresh = result.evidence.filter((item) => !seen.has(item.id)).slice(0, limit as number);
      const excerpts: Array<Record<string, unknown>> = [];
      let characters = 0;
      for (const item of fresh) {
        if (characters >= remaining) break;
        seen.add(item.id);
        const content = item.content.slice(0, remaining - characters);
        characters += content.length;
        excerpts.push({
          id: item.id, repository: item.repositoryId, revision: item.analysisRevision, path: item.relativePath,
          content, truncated: item.truncated || content.length < item.content.length,
        });
      }
      record.excerptCount = excerpts.length;
      record.characters = characters;
      records.push(record);
      this.save(run);
      return {
        evidence: excerpts,
        characters,
        remainingQueries: budget.maxQueries - records.length,
        remainingCharacters: remaining - characters,
        notes: [
          ...(result.notes ?? []),
          ...(excerpts.length < fresh.length || characters >= remaining ? ["EVIDENCE_BUDGET_TRUNCATED"] : []),
        ],
      };
    } catch (error) {
      record.error = message(error);
      records.push(record);
      this.save(run);
      throw error;
    }
  }

  private requireIdle(): void {
    if (this.closing) throw new WorkspaceTranslationError(503, "Workspace translation is shutting down.");
    if (this.active) throw new WorkspaceTranslationError(409, "A translation is already running in this workspace.");
  }

  private save(run: WorkspaceTranslationRun): void {
    run.updatedAt = new Date().toISOString();
    this.files.save(run.id, run);
  }

  private validateRecord(value: unknown, id: string): WorkspaceTranslationRun {
    const record = object(value);
    validateWorkspaceTranslationRequest(record.request);
    const run = record as unknown as WorkspaceTranslationRun;
    if (run.id !== id || run.workspaceRoot !== this.files.root || !["compilation-only", "behavior-verified"].includes(run.acceptance) ||
      ![...runningStatuses, "completed", "failed", "cancelled", "interrupted", "rolling-back", "rolled-back"].includes(run.status) ||
      !Array.isArray(run.changes) || !Array.isArray(run.compilations) || !Array.isArray(run.completedSteps) ||
      !Number.isInteger(run.modelTurns) || run.modelTurns < 0) throw new Error("Invalid translation record.");
    if (run.verification && (!Array.isArray(run.verification.criteria) || !run.verification.criteria.length || !Array.isArray(run.verification.runs))) throw new Error("Invalid verification record.");
    if (run.evidenceQueries !== undefined && (!Array.isArray(run.evidenceQueries) || run.evidenceQueries.some((item) =>
      !item || typeof item.at !== "string" || typeof item.requirement !== "string" || !Array.isArray(item.repositoryIds) ||
      !Number.isInteger(item.excerptCount) || !Number.isInteger(item.characters) ||
      (item.error !== undefined && typeof item.error !== "string")))) throw new Error("Invalid evidence query record.");
    if (run.events !== undefined && (!Array.isArray(run.events) || run.events.length > 300 || run.events.some((item) =>
      !item || typeof item.at !== "string" || typeof item.phase !== "string" || typeof item.message !== "string"))) {
      throw new Error("Invalid translation event record.");
    }
    const paths = new Set<string>();
    for (const change of run.changes) {
      if (!change || !run.request.writeFiles.includes(change.path) || paths.has(change.path) ||
        (change.before !== null && typeof change.before !== "string") || typeof change.after !== "string" ||
        (change.pendingBefore !== undefined && change.pendingBefore !== null && typeof change.pendingBefore !== "string") ||
        typeof change.applied !== "boolean") throw new Error("Invalid translation file record.");
      paths.add(change.path);
    }
    if (run.plan) run.plan = parseWorkspaceTranslationPlan(run.plan, run.request);
    if (run.completedSteps.some((id) => !run.plan?.steps.some((step) => step.id === id))) {
      throw new Error("Invalid completed translation steps.");
    }
    return run;
  }

  private reconcile(run: WorkspaceTranslationRun, rollback = false): void {
    for (const change of run.changes) {
      const current = this.files.read(change.path);
      if (change.rolledBack) {
        if (current !== change.before) throw new WorkspaceTranslationError(409, `File changed after rollback: ${change.path}`);
      } else if (current === change.after) {
        change.applied = true;
        delete change.pendingBefore;
      } else if (change.pendingBefore !== undefined && current === change.pendingBefore) {
        if (current !== null) change.after = current;
        change.applied = current !== null;
        delete change.pendingBefore;
      } else if (current === change.before && (rollback || !change.applied)) {
        change.applied = false;
      } else {
        throw new WorkspaceTranslationError(409, `File changed outside this task: ${change.path}`);
      }
    }
  }

  private launch(run: WorkspaceTranslationRun): WorkspaceTranslationRun {
    const controller = new AbortController();
    const active = { run, controller, done: Promise.resolve() };
    this.active = active;
    active.done = Promise.resolve().then(async () => {
      const timeout = setTimeout(() => controller.abort(new Error("Translation execution timed out.")), this.timeoutMs);
      try {
        await this.execute(run, controller.signal);
      } catch (error) {
        run.status = controller.signal.aborted ? "cancelled" : "failed";
        run.error = message(controller.signal.aborted ? controller.signal.reason : error);
        this.save(run);
      } finally {
        clearTimeout(timeout);
        this.active = undefined;
      }
    });
    // Keep asynchronous persistence failures observable without an unhandled rejection.
    void active.done.catch((error) => console.error("Translation persistence failed:", error));
    return structuredClone(run);
  }

  private assertVerification(run: WorkspaceTranslationRun): void {
    const current = this.options.verification;
    if (Boolean(current) !== Boolean(run.verification) || current && run.verification &&
      (JSON.stringify(current.command) !== JSON.stringify(run.verification.command) ||
       JSON.stringify(current.protectedFiles) !== JSON.stringify(run.verification.criteria.map(item => item.path)))) {
      throw new Error("Verification policy changed; start a new translation run.");
    }
    for (const criterion of run.verification?.criteria ?? []) {
      if (run.request.writeFiles.some(path => path.toLowerCase() === criterion.path.toLowerCase()) || hash(this.files.read(criterion.path)) !== criterion.hash) {
        throw new Error(`Verification criteria changed: ${criterion.path}`);
      }
    }
  }

  private snapshot(run: WorkspaceTranslationRun): string {
    return JSON.stringify([...new Set([...run.request.workspaceFiles, ...run.request.writeFiles, ...(run.verification?.criteria.map(item => item.path) ?? [])])]
      .sort().map((path) => [path, hash(this.files.read(path))]));
  }

  private async execute(run: WorkspaceTranslationRun, signal: AbortSignal): Promise<void> {
    const log = (message: string) => { run.events ??= []; run.events.push({ at: new Date().toISOString(), phase: run.status, message }); if (run.events.length > 300) run.events.splice(0, run.events.length - 300); this.save(run); };
    this.assertVerification(run);
    let analyzer = !run.plan;
    let revisionReason = "";
    let successfulSnapshot: string | undefined;
    let verifiedSnapshot: string | undefined;
    const readHashes = new Map<string, string | null>();
    const readable = new Set([...run.request.workspaceFiles, ...run.request.writeFiles]);
    // On-demand history evidence exists only when the host put history revisions
    // in scope and a read-only index port is configured.
    const evidenceScopes = run.request.evidenceScopes ?? [];
    const evidenceAvailable = Boolean(this.options.evidence) && evidenceScopes.length > 0;
    const toolsFor = (): typeof workspaceAnalyzerTools => (analyzer ? workspaceAnalyzerTools : workspaceTranslatorTools)
      .filter((tool) => evidenceAvailable || tool.name !== "query_evidence");
    const makeMessages = (): DeepSeekToolMessage[] => [
      { role: "system", content: analyzer ? workspaceAnalyzerPrompt : workspaceTranslatorPrompt },
      { role: "user", content: JSON.stringify({
        request: run.request, plan: run.plan, completedSteps: run.completedSteps,
        changes: run.changes.map(({ path, applied }) => ({ path, applied })),
        latestCompilation: run.compilations.at(-1), verificationRequired: Boolean(run.verification), latestVerification: run.verification?.runs.at(-1), revisionReason,
        evidenceQueriesUsed: run.evidenceQueries?.length ?? 0,
        evidenceQueriesRemaining: this.evidenceBudget ? Math.max(0, this.evidenceBudget.maxQueries - (run.evidenceQueries?.length ?? 0)) : 0,
      }) },
    ];
    /**
     * The single write path for a whole-file write and for an anchored edit: plan
     * scope, read hash, change record, step invalidation and the verification reset
     * must hold identically however the new content was produced. The producer runs
     * only after those checks, so an edit can never report whether text exists in a
     * file this task may not read.
     */
    const applyWrite = (
      path: unknown,
      expectedHash: unknown,
      produce: (before: string | null) => unknown,
      logLine: (path: string) => string,
    ): { path: string; hash: string | null } => {
      if (typeof path !== "string" || !run.request.writeFiles.includes(path) ||
        !run.plan?.steps.some((step) => step.files.includes(path))) throw new Error("File is outside the implementation plan.");
      if (!readHashes.has(path) || expectedHash !== readHashes.get(path)) throw new Error("Read the file before writing and supply its hash.");
      const beforeWrite = this.files.read(path);
      if (hash(beforeWrite) !== expectedHash) throw new Error(`File changed since read: ${path}`);
      const content = produce(beforeWrite);
      if (typeof content !== "string" || content.length > maxWorkspaceFileChars) throw new Error("Invalid file content.");
      let change = run.changes.find((item) => item.path === path);
      if (change && beforeWrite !== (change.applied ? change.after : change.before)) throw new Error(`File changed outside this task: ${path}`);
      const previous = change ? structuredClone(change) : undefined;
      if (!change) {
        change = { path, before: beforeWrite, after: content, applied: false };
        run.changes.push(change);
      } else {
        change.after = content;
        change.applied = false;
      }
      change.pendingBefore = beforeWrite;
      successfulSnapshot = undefined;
      verifiedSnapshot = undefined;
      run.acceptance = "compilation-only";
      // A shared-file repair invalidates its steps and every dependent step.
      const invalid = new Set(run.plan!.steps.filter((step) => step.files.includes(path)).map((step) => step.id));
      for (const step of run.plan!.steps) if (step.dependsOn.some((id) => invalid.has(id))) invalid.add(step.id);
      run.completedSteps = run.completedSteps.filter((id) => !invalid.has(id));
      this.save(run);
      try { this.files.write(path, beforeWrite, content); }
      catch (error) {
        if (previous) {
          delete change.pendingBefore;
          Object.assign(change, previous);
        }
        else run.changes = run.changes.filter((item) => item !== change);
        this.save(run);
        throw error;
      }
      change.applied = true;
      delete change.pendingBefore;
      readHashes.delete(path);
      log(logLine(path));
      return { path, hash: hash(content) };
    };
    let messages = makeMessages();
    for (let turn = 0; turn < this.maxTurns; turn++) {
      signal.throwIfAborted();
      run.status = analyzer ? "analyzing" : "translating";
      run.modelTurns++;
      log(`${analyzer ? 'Analyzer' : 'Translator'} 第 ${run.modelTurns} 轮模型调用`);
      this.save(run);
      const completion = await this.options.client.complete(messages, toolsFor(), signal);
      signal.throwIfAborted();
      const calls = completion.toolCalls ?? [];
      if (calls.length > 32) throw new Error("Model returned too many tool calls in one turn.");
      messages.push({ role: "assistant", content: completion.content ?? "", toolCalls: calls });
      if (!calls.length) {
        log(`${analyzer ? 'Analyzer' : 'Translator'} 未返回工具调用，继续请求下一轮`);
        messages.push({ role: "user", content: "Continue using the supplied tools, or describe the unresolved scope in a plan revision." });
        continue;
      }
      let transition = false;
      for (const call of calls) {
        log(`${analyzer ? 'Analyzer' : 'Translator'} 调用工具：${call.name}`);
        signal.throwIfAborted();
        let result: unknown;
        try {
          const args = object(JSON.parse(call.arguments));
          if (transition) throw new Error("Agent phase changed; retry this tool in the next phase.");
          const available = toolsFor();
          const definition = available.find((tool) => tool.name === call.name);
          if (!definition) throw new Error(`Tool is unavailable in this phase: ${call.name}`);
          const properties = definition.inputSchema.properties as Record<string, unknown>;
          const required = definition.inputSchema.required as string[];
          if (Object.keys(args).some((key) => !(key in properties)) || required.some((key) => !(key in args))) {
            throw new Error("Tool arguments do not match its schema.");
          }
          switch (call.name) {
            case "report_blocker": {
              if (typeof args.reason !== "string" || !args.reason.trim()) throw new Error("A blocker requires a reason.");
              run.status = "failed";
              run.error = args.reason;
              log(`${analyzer ? 'Analyzer' : 'Translator'} 报告阻塞：${args.reason.slice(0, 240)}`);
              this.save(run);
              return;
            }
            case "query_evidence": {
              // The agent decides what to look up; the host index decides what
              // exists and the budget below bounds how much can be pulled in.
              result = await this.#queryEvidence(run, args, evidenceScopes, signal);
              break;
            }
            case "read_file": {
              if (typeof args.path !== "string" || !readable.has(args.path)) {
                const requested = typeof args.path === "string" ? args.path : "(missing path)";
                const allowed = [...readable].sort();
                const requestedPath = typeof args.path === "string" ? args.path : undefined;
                const sameDirectory = requestedPath
                  ? allowed.filter((path) => path.slice(0, path.lastIndexOf("/")) === requestedPath.slice(0, requestedPath.lastIndexOf("/"))).slice(0, 4)
                  : [];
                throw new Error(`File is outside the requested read scope: ${requested}. `
                  + `Use read_file only for target workspaceFiles; ${allowed.length} files are allowed.`
                  + (sameDirectory.length ? ` Nearby allowed files: ${sameDirectory.join(", ")}.` : ""));
              }
              const content = this.files.read(args.path);
              readHashes.set(args.path, hash(content));
              result = { path: args.path, content, hash: hash(content) };
              break;
            }
            case "submit_plan": {
              run.plan = parseWorkspaceTranslationPlan(args, run.request);
              run.completedSteps = [];
              analyzer = false;
              transition = true;
              log(`Analyzer 提交适配计划，共 ${run.plan.steps.length} 个步骤`);
              result = { accepted: true };
              break;
            }
            case "write_file": {
              result = applyWrite(args.path, args.expectedHash, () => args.content, (path) => `Translator 写入文件：${path}`);
              break;
            }
            case "edit_file": {
              const path = args.path;
              if (typeof path !== "string") throw new Error("File is outside the implementation plan.");
              const edits = parseWorkspaceEdits(args.edits);
              result = applyWrite(path, args.expectedHash, (before) => {
                if (before === null) throw new Error(`edit_file needs an existing file: ${path}. Use write_file to create it.`);
                return applyWorkspaceEdits(before, edits);
              }, (target) => `Translator 局部修改文件：${target}（${edits.length} 处）`);
              break;
            }
            case "complete_step": {
              const step = run.plan?.steps.find((step) => step.id === args.stepId);
              if (!step || step.dependsOn.some((id) => !run.completedSteps.includes(id)) ||
                step.files.some((path) => !run.changes.some((change) => change.path === path && change.applied))) {
                throw new Error("Complete dependencies and write every step file before completing this step.");
              }
              if (!run.completedSteps.includes(step.id)) run.completedSteps.push(step.id);
              result = { completedSteps: run.completedSteps };
              break;
            }
            case "get_changes": result = run.changes; break;
            case "compile": {
              this.assertVerification(run);
              this.reconcile(run);
              verifiedSnapshot = undefined;
              run.acceptance = "compilation-only";
              run.status = "compiling";
              log("开始编译检查");
              this.save(run);
              const before = this.snapshot(run);
              const compilation: WorkspaceCompilation = await compileWorkspace(this.files.root, this.command, signal);
              run.compilations.push(compilation);
              successfulSnapshot = compilation.success && before === this.snapshot(run) ? before : undefined;
              run.status = "translating";
              log(`编译检查${compilation.success ? '通过' : '失败'}`);
              result = { ...compilation, filesUnchanged: successfulSnapshot !== undefined };
              break;
            }
            case "run_tests": {
              this.assertVerification(run);
              this.reconcile(run);
              if (!run.verification) throw new Error("No host verification suite is configured.");
              const before = this.snapshot(run);
              if (!successfulSnapshot || before !== successfulSnapshot) throw new Error("Compile the latest files before running behavioral tests.");
              verifiedSnapshot = undefined;
              run.acceptance = "compilation-only";
              run.status = "testing";
              log("开始行为测试");
              this.save(run);
              const resultRun = await compileWorkspace(this.files.root, run.verification.command, signal);
              const filesUnchanged = before === this.snapshot(run);
              run.verification.runs.push({ ...resultRun, sourceSnapshot: hash(before)!, planHash: hash(JSON.stringify(run.plan))!, filesUnchanged });
              this.assertVerification(run);
              if (resultRun.success && filesUnchanged) verifiedSnapshot = before;
              run.status = "translating";
              log(`行为测试${resultRun.success && filesUnchanged ? '通过' : '失败'}`);
              result = { ...resultRun, filesUnchanged };
              break;
            }
            case "revise_plan": {
              if (typeof args.reason !== "string" || !args.reason.trim()) throw new Error("Plan revision requires a reason.");
              revisionReason = args.reason;
              analyzer = true;
              delete run.plan;
              run.completedSteps = [];
              successfulSnapshot = undefined;
              verifiedSnapshot = undefined;
              run.acceptance = "compilation-only";
              transition = true;
              log(`Translator 请求 Analyzer 修订计划：${args.reason.slice(0, 240)}`);
              result = { accepted: true };
              break;
            }
            case "finish": {
              this.assertVerification(run);
              this.reconcile(run);
              if (run.verification && verifiedSnapshot !== this.snapshot(run)) throw new Error("Finish requires a passing behavioral verification after the latest changes.");
              if (!run.plan || run.plan.steps.some((step) => !run.completedSteps.includes(step.id)) ||
                successfulSnapshot === undefined || successfulSnapshot !== this.snapshot(run)) {
                throw new Error("Finish requires all plan steps and a passing compilation after the latest file changes.");
              }
              signal.throwIfAborted();
              run.acceptance = run.verification ? "behavior-verified" : "compilation-only";
              run.status = "completed";
              log("翻译完成，验证通过");
              this.save(run);
              return;
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          result = { error: message(error) };
          log(`${analyzer ? 'Analyzer' : 'Translator'} 工具执行失败：${message(error).slice(0, 240)}`);
        }
        this.save(run);
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
      }
      if (transition) {
        readHashes.clear();
        messages = makeMessages();
      } else if (messages.reduce((size, item) => size + item.content.length, 0) > 1_500_000) {
        // Restart from durable state instead of retaining unbounded file/diagnostic history.
        readHashes.clear();
        messages = makeMessages();
      }
    }
    throw new Error(`Translation exhausted its ${this.maxTurns}-turn budget. Resume to continue.`);
  }
}
