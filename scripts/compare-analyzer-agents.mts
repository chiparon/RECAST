/**
 * Compare the legacy tool-calling Analyzer loop with the Codex Analyzer on the
 * same target modules, requirements and bounded Top-1 history views.
 *
 * This experiment stops both runtimes immediately after a plan is accepted. It
 * therefore measures the Analyzer task itself and never changes the real target
 * checkout. Each run uses a disposable copy restored from HEAD for the two
 * files changed by the earlier translation smoke run.
 */
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import mysql from "mysql2/promise";
import { parse as parseEnv } from "dotenv";
import type {
  ModuleTarget, ProjectModule, SearchCandidate, WorkspaceEvidencePort,
  WorkspaceEvidenceQueryRequest, WorkspaceEvidenceResult, WorkspaceTranslationRequest,
  WorkspaceTranslationPlan,
} from "@forexplore/contracts";
import {
  CodeIntelligenceHost, codeIntelligenceRuntimeOptionsFromEnvironment,
  type RepositoryIdentityStore,
} from "../apps/vscode-extension/src/code-intelligence-host.js";
import { prepareModuleTranslationScope } from "../apps/vscode-extension/src/module-translation-handoff.js";
import { WorkspaceTranslationRuntime } from "../services/adaptation-service/src/workspace-translation-runtime.js";
import {
  createWorkspaceTranslationModelClient,
  type WorkspaceTranslationModelClient,
} from "../services/adaptation-service/src/workspace-translation-agent.js";
import {
  CodexWorkspaceTranslationRuntime,
} from "../services/adaptation-service/src/codex-workspace-translation-runtime.js";
import { prepareDeepSeekCodexHome } from "../services/adaptation-service/src/codex-experiment-home.js";
import type { DeepSeekToolCompletion } from "../services/adaptation-service/src/deepseek-client.js";

const targetRoot = resolve("experiments/enterprise-asset-upgrade/target-project");
const assetRoot = resolve("experiments/enterprise-asset-upgrade/reference-sources");
const database = process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE ?? "forexplore_asset_upgrade_20261004";
const output = resolve(process.env.ANALYZER_COMPARE_OUT ?? "experiments/enterprise-asset-upgrade/results/analyzer-agent-comparison-20261007.json");
const model = "deepseek-v4-pro";
const envPath = resolve("services/adaptation-service/.env");
const envFile = parseEnv(await readFile(envPath, "utf8"));
for (const [key, value] of Object.entries(envFile)) if (!process.env[key]?.trim()) process.env[key] = value;
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required in services/adaptation-service/.env.");
process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE = database;
process.env.CODE_INTELLIGENCE_EMBEDDING_URL ??= "http://127.0.0.1:4021/v1/embeddings";
process.env.CODE_INTELLIGENCE_EMBEDDING_MODEL ??= "Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78";
process.env.CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS ??= "false";
process.env.CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX ??= "query: ";
process.env.CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX ??= "passage: ";
process.env.CODE_INTELLIGENCE_EMBEDDING_VARIANT ??= "dml-fp16";
process.env.CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION ??= "384";

const historyRepositories = ["flowable-engine", "apache-camel", "apscheduler", "bullmq", "commons-fileupload", "keycloak", "nopcommerce"];
const selectedModuleNames = (process.env.ANALYZER_COMPARE_MODULES?.split(",").map((value) => value.trim()).filter(Boolean) ?? ["契约与端口定义", "领域模型", "业务策略"]);
const restoreFiles = [
  "experiments/enterprise-asset-upgrade/target-project/src/AssetUpgradeGateway/ExtendedContracts.cs",
  "experiments/enterprise-asset-upgrade/target-project/src/AssetUpgradeGateway/Ports/ExtendedPorts.cs",
];

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };
type CallRecord = { startedAt: string; durationMs: number; usage?: Usage; toolCalls: Array<{ name: string; arguments: unknown }> };

function emptyUsage(): Usage { return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; }
function addUsage(target: Usage, value: Usage | undefined): void {
  if (!value) return;
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.cacheReadTokens += value.cacheReadTokens;
}
function parseUsage(value: any): Usage | undefined {
  const raw = value?.usage ?? value?.response?.usage ?? value?.result?.usage ?? value?.item?.usage;
  if (!raw || typeof raw !== "object") return undefined;
  const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? raw.inputTokens ?? 0);
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? raw.outputTokens ?? 0);
  const cache = Number(raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens ?? raw.cache_read_tokens ?? raw.cacheReadTokens ?? 0);
  return { inputTokens: Number.isFinite(input) ? input : 0, outputTokens: Number.isFinite(output) ? output : 0, cacheReadTokens: Number.isFinite(cache) ? cache : 0 };
}

function measuredClient(calls: CallRecord[], usage: Usage): WorkspaceTranslationModelClient {
  const request: typeof globalThis.fetch = async (input, init) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const response = await globalThis.fetch(input, init);
    const text = await response.text();
    let payload: any;
    try { payload = JSON.parse(text); } catch { payload = undefined; }
    const callUsage = parseUsage(payload);
    addUsage(usage, callUsage);
    // Keep the production client contract intact after consuming the body.
    const toolCalls = Array.isArray(payload?.choices?.[0]?.message?.tool_calls)
      ? payload.choices[0].message.tool_calls.map((call: any) => ({ name: String(call?.function?.name ?? ""), arguments: parseJson(call?.function?.arguments) }))
      : [];
    calls.push({ startedAt, durationMs: Date.now() - started, ...(callUsage ? { usage: callUsage } : {}), toolCalls });
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const base = createWorkspaceTranslationModelClient({
    apiKey: () => apiKey!, modelConfig: { apiBase: process.env.DEEPSEEK_API_BASE ?? "https://api.deepseek.com/v1", model },
    temperature: 0, request,
  });
  return {
    complete: async (messages, tools, signal): Promise<DeepSeekToolCompletion> => {
      const result = await base.complete(messages, tools, signal);
      // Anthropic-compatible responses are not expected here, but recording
      // tool calls from the returned value covers any provider adapter too.
      const last = calls.at(-1);
      if (last && !last.toolCalls.length) last.toolCalls = (result.toolCalls ?? []).map((call) => ({ name: call.name, arguments: parseJson(call.arguments) }));
      return result;
    },
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function identityStore(): RepositoryIdentityStore {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key, value) => { values.set(key, value); } };
}

async function copyBaseline(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forexplore-analyzer-target-"));
  await cp(targetRoot, root, { recursive: true, filter: (source) => !source.includes(`${resolve(targetRoot)}/.forexplore`) && !source.includes(`${resolve(targetRoot)}/bin`) && !source.includes(`${resolve(targetRoot)}/obj`) });
  for (const file of restoreFiles) {
    const content = execFileSync("git", ["show", `HEAD:${file}`], { cwd: resolve("."), encoding: "utf8" });
    const destination = join(root, file.replace("experiments/enterprise-asset-upgrade/target-project/", ""));
    await (await import("node:fs/promises")).writeFile(destination, content);
  }
  return root;
}

class LocalHistoryEvidence implements WorkspaceEvidencePort {
  constructor(private readonly root: string, private readonly files: readonly string[]) {}
  async query(request: WorkspaceEvidenceQueryRequest): Promise<WorkspaceEvidenceResult> {
    const evidence = [];
    for (const relativePath of this.files.slice(0, request.limit)) {
      const content = await readFile(join(this.root, "source", ...relativePath.split("/")), "utf8");
      evidence.push({ id: `local:${relativePath}`, repositoryId: request.scopes[0]?.repositoryId ?? "history", analysisRevision: request.scopes[0]?.analysisRevision ?? "local", relativePath, content: content.slice(0, 12_000), truncated: content.length > 12_000 });
    }
    return { evidence, characters: evidence.reduce((sum, item) => sum + item.content.length, 0) };
  }
}

async function waitForPlan<T extends { plan?: WorkspaceTranslationPlan; status: string }>(runtime: { get(id: string): T; cancel(id: string): Promise<T> }, id: string, timeoutMs = 900_000): Promise<{ run: T; wallMs: number }> {
  const started = Date.now();
  let run = runtime.get(id);
  while (!run.plan && !["completed", "failed", "cancelled", "interrupted"].includes(run.status) && Date.now() - started < timeoutMs) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    run = runtime.get(id);
  }
  if (run.plan && !["completed", "failed", "cancelled", "interrupted"].includes(run.status)) run = await runtime.cancel(id);
  return { run, wallMs: Date.now() - started };
}

function placeholderNames(root: string, files: readonly string[]): string[] {
  const names: string[] = [];
  for (const file of files) {
    const content = readFileSync(join(root, file), "utf8");
    for (const match of content.matchAll(/([A-Za-z_]\w*)\s*(?:=>|\([^\n]*\)\s*\{)[^{}\n]{0,500}?(?:NotImplementedException)/gs)) {
      const name = match[1]; if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function evaluatePlan(plan: WorkspaceTranslationPlan | undefined, request: WorkspaceTranslationRequest, baselineRoot: string): Record<string, unknown> {
  if (!plan) return { accepted: false, requiredCoverage: 0, requiredTotal: placeholderNames(baselineRoot, request.writeFiles).length };
  const covered = new Set(plan.steps.flatMap((step) => step.files));
  const required = placeholderNames(baselineRoot, request.writeFiles);
  const planText = JSON.stringify(plan);
  const coveredRequired = required.filter((name) => planText.includes(name));
  const mappingChecks = plan.mappings.map((mapping) => {
    const target = readFileSync(join(baselineRoot, mapping.targetPath), "utf8");
    const symbol = String(mapping.targetSymbol).split(/[.#]/).at(-1) ?? String(mapping.targetSymbol);
    return { targetPath: mapping.targetPath, targetSymbol: mapping.targetSymbol, validPath: covered.has(mapping.targetPath), symbolMentioned: target.includes(symbol) };
  });
  return {
    accepted: true, steps: plan.steps.length, mappings: plan.mappings.length, dependencies: plan.dependencies.length,
    writeFiles: request.writeFiles.length, coveredWriteFiles: [...new Set(covered)].filter((file) => request.writeFiles.includes(file)).length,
    requiredTotal: required.length, requiredCovered: coveredRequired.length, requiredNames: required,
    invalidMappings: mappingChecks.filter((item) => !item.validPath || !item.symbolMentioned).length, mappingChecks,
  };
}

async function main(): Promise<void> {
  const pool = await mysql.createPool({ host: "127.0.0.1", port: 2881, user: "root", password: "", database, connectionLimit: 4 });
  const store = identityStore();
  const host = new CodeIntelligenceHost({
    runtimeOptions: codeIntelligenceRuntimeOptionsFromEnvironment(process.env, { allowInMemory: false }),
    identityStore: store,
    output: { appendLine: (line) => console.log(line) },
  });
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), model, targetRoot, modules: [] };
  const cleanups: Array<() => Promise<void>> = [];
  try {
    const [targetRows] = await pool.query<any[]>("select r.repository_id as repositoryId, r.local_path as localPath, r.active_revision as activeRevision from repositories r where r.role='target' and exists (select 1 from module_artifacts a where a.repository_id=r.repository_id and a.analysis_revision=r.active_revision and a.status='current') order by r.updated_at desc");
    const targetRow = targetRows.find((row) => String(row.localPath).replaceAll("\\", "/").toLowerCase().endsWith("/target-project"));
    if (!targetRow?.repositoryId || !targetRow.activeRevision) throw new Error("No persisted target repository with an active revision.");
    const [historyRows] = await pool.query<any[]>("select repository_id as repositoryId, local_path as localPath, display_name as displayName from repositories where role='history'");
    const historyInputs = historyRepositories.map((name) => {
      const row = historyRows.find((item) => String(item.localPath).replaceAll("\\", "/").toLowerCase().endsWith(`/reference-sources/${name}`) || String(item.displayName).toLowerCase().includes(name));
      if (!row?.repositoryId) throw new Error(`No persisted history repository: ${name}`);
      return { localPath: join(assetRoot, name), repositoryId: row.repositoryId, role: "history" as const };
    });
    await host.synchronize({ repositories: [{ localPath: targetRoot, repositoryId: targetRow.repositoryId, role: "target" }], scan: false });
    await host.synchronize({ repositories: historyInputs, scan: false });
    const targetScope = await host.activeScopeForPath(targetRoot);
    const [artifactRows] = await pool.query<any[]>("select payload from module_artifacts where repository_id=? and analysis_revision=? and kind in ('module-summary','other') and status='current' order by updated_at desc limit 10", [targetScope.repositoryId, targetScope.analysisRevision]);
    const artifact = artifactRows.map((row) => typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload).find((row) => row?.proposal?.modules?.length);
    if (!artifact?.proposal?.modules) throw new Error("No current target module proposal found.");
    const [projectRows] = await pool.query<any[]>("select project_id as projectId from projects where repository_id=? and analysis_revision=? order by project_id limit 1", [targetScope.repositoryId, targetScope.analysisRevision]);
    const projectId = projectRows[0]?.projectId;
    for (const name of selectedModuleNames) {
      const module = artifact.proposal.modules.find((item: ProjectModule) => item.name === name) as ProjectModule | undefined;
      if (!module) throw new Error(`Module not found: ${name}`);
      const language = module.language ?? "C#";
      const requirement = [module.description, module.purpose, `目标语言：${language}`, "目标工程：AssetUpgradeGateway"].filter(Boolean).join("\n");
      const target: ModuleTarget = { id: module.id, name: module.name, kind: "module", path: module.sourceFiles[0]!, language: language as any, signature: module.coreApis?.[0] ?? module.name, module: { repositoryId: targetScope.repositoryId, analysisRevision: targetScope.analysisRevision, ...(projectId ? { projectId } : {}), moduleId: module.id, purpose: module.purpose, description: module.description, sourceFiles: module.sourceFiles, coreApis: module.coreApis ?? [], dependsOn: module.dependsOn ?? [] } };
      const candidates = await host.searchHistoricalImplementations({ target, requirement, topK: 1 }, AbortSignal.timeout(180_000));
      const candidate = candidates.find((item) => item.kind === "module" && (item.sourceModule?.sourceFiles?.some((file) => typeof file === "string" && file.trim()) || typeof item.path === "string"));
      if (!candidate?.sourceModule) {
        console.log(`skip: ${name} 没有带源文件的可用 Top-1 候选`);
        (report.modules as any[]).push({ module: name, status: "skipped", candidates: candidates.map((item) => ({ title: item.title, kind: item.kind, repository: item.repository })) });
        await writeFile(output, JSON.stringify(report, null, 2) + "\n");
        continue;
      }
      const moduleRoot = await copyBaseline();
      // Keep the host view inside this disposable workspace. Codex validates
      // the .forexpore/history-views/<runId> relationship before mounting it.
      const viewBase = moduleRoot;
      cleanups.push(() => rm(moduleRoot, { recursive: true, force: true }));
      const source = candidate.sourceModule;
      const candidateFiles = (source.sourceFiles ?? []).filter((file) => typeof file === "string" && file.trim() && !file.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(file));
      // Some historical "domain" modules contain hundreds of files. The
      // production history view is bounded, so pin the same candidate to a
      // deterministic 256-file manifest before materialization.
      const historyFiles = (candidateFiles.length ? candidateFiles : (candidate.path?.trim() ? [candidate.path] : [])).slice(0, 256);
      if (!historyFiles.length) {
        console.log(`skip: ${name} 候选文件清单为空`);
        (report.modules as any[]).push({ module: name, status: "skipped", reason: "candidate source files empty" });
        await writeFile(output, JSON.stringify(report, null, 2) + "\n");
        await rm(moduleRoot, { recursive: true, force: true });
        continue;
      }
      const candidateForTask: SearchCandidate = { ...candidate, sourceModule: { ...source, sourceFiles: historyFiles } };
      const historyView = await host.createHistoryModuleView({ workspaceRoot: viewBase, repositoryId: source.repositoryId, analysisRevision: source.analysisRevision, projectId: source.projectId, moduleId: source.moduleId, sourceFiles: historyFiles, relevanceTerms: [target.name, target.path, target.signature, ...(target.module?.sourceFiles ?? []), ...(target.module?.coreApis ?? []), source.name, source.purpose ?? "", ...(source.coreApis ?? [])] });
      const scope = await prepareModuleTranslationScope({ workspaceRoot: moduleRoot, target, candidate: candidateForTask, requirement, decisionNotes: "", evidenceScopes: [{ repositoryId: source.repositoryId, analysisRevision: source.analysisRevision }], historyView });
      const request: WorkspaceTranslationRequest = { spec: scope.spec, sourceLanguage: scope.profile.sourceLanguage, targetLanguage: scope.profile.targetLanguage, context: scope.context, workspaceFiles: scope.profile.workspaceFiles, writeFiles: scope.profile.writeFiles, evidenceScopes: scope.evidenceScopes, historyView: scope.historyView };
      const common = { module: name, targetFiles: module.sourceFiles, candidate: { repository: candidate.repository, name: source.name, files: source.sourceFiles, score: candidate.score.overall }, historyFiles: historyView.files, historyBytes: (await Promise.all(historyView.files.map(async (file) => (await stat(join(historyView.root, "source", ...file.split("/")))).size))).reduce((a, b) => a + b, 0) };
      console.log(`\n=== ${name} | ${candidate.repository}/${source.name} | ${historyView.files.length} history files ===`);

      const oldCalls: CallRecord[] = []; const oldUsage = emptyUsage();
      const oldRuntime = new WorkspaceTranslationRuntime({ workspaceRoot: moduleRoot, compileCommand: { executable: "dotnet", args: ["build", "AssetUpgradeGateway.sln", "--nologo", "--verbosity", "quiet"], timeoutMs: 900_000 }, client: measuredClient(oldCalls, oldUsage), evidence: { port: new LocalHistoryEvidence(historyView.root, historyView.files) }, maxModelTurns: 80, timeoutMs: 900_000 });
      const oldStarted = oldRuntime.start(request); const oldMeasured = await waitForPlan(oldRuntime, oldStarted.id); const oldRun = oldMeasured.run;
      await oldRuntime.shutdown();
      const oldPlan = oldRun.plan;
      const oldResult = { ...common, status: oldRun.status, modelTurns: oldRun.modelTurns, wallMs: oldMeasured.wallMs, usage: oldUsage, calls: oldCalls, evidenceQueries: oldRun.evidenceQueries ?? [], toolEvents: oldRun.events?.filter((event) => /工具|Analyzer/.test(event.message)).slice(-80) ?? [], quality: evaluatePlan(oldPlan, request, moduleRoot), plan: oldPlan };
      console.log(`legacy: status=${oldRun.status} plan=${Boolean(oldPlan)} turns=${oldRun.modelTurns} wall=${oldMeasured.wallMs}ms tokens=${oldUsage.inputTokens}/${oldUsage.outputTokens}`);

      const codexHome = await prepareDeepSeekCodexHome({ apiKey, model, baseUrl: process.env.DEEPSEEK_API_BASE });
      const codexRuntime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: moduleRoot, compileCommand: { executable: "dotnet", args: ["build", "AssetUpgradeGateway.sln", "--nologo", "--verbosity", "quiet"], timeoutMs: 900_000 }, codexCommand: process.env.ADAPTATION_CODEX_COMMAND?.trim() || "codex", codexModel: model, codexHome: codexHome.path, environment: codexHome.environment, maxModelTurns: 2, timeoutMs: 900_000 });
      const codexStarted = codexRuntime.start(request); const codexMeasured = await waitForPlan(codexRuntime, codexStarted.id); const codexRun = codexMeasured.run;
      await codexRuntime.shutdown(); await codexHome.cleanup();
      const analyzerStage = codexRun.agent?.stages?.find((stage) => stage.stage === "analyzer");
      const codexResult = { ...common, status: codexRun.status, modelTurns: codexRun.modelTurns, wallMs: codexMeasured.wallMs, usage: analyzerStage?.usage ?? {}, calls: undefined, analyzerOutputChars: analyzerStage?.outputChars, analyzerStatus: analyzerStage?.analyzerStatus, readFiles: analyzerStage?.readFiles ?? [], quality: evaluatePlan(codexRun.plan, request, moduleRoot), plan: codexRun.plan };
      console.log(`codex: status=${codexRun.status} plan=${Boolean(codexRun.plan)} turns=${codexRun.modelTurns} wall=${codexMeasured.wallMs}ms tokens=${analyzerStage?.usage?.inputTokens ?? 0}/${analyzerStage?.usage?.outputTokens ?? 0}`);
      (report.modules as any[]).push({ module: name, legacy: oldResult, codex: codexResult });
    }
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(`Report: ${output}`);
  } finally {
    await writeFile(output, JSON.stringify(report, null, 2) + "\n").catch(() => undefined);
    host.dispose(); await pool.end();
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
