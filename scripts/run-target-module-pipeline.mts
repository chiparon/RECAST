/**
 * Runs the RECAST module pipeline for a real target project, offline.
 *
 * The workbench normally drives this chain by hand: index the target, review its
 * module tree, pick a module, let retrieval propose a history candidate, confirm the
 * candidate, and translate. This command performs the same chain for every module of
 * the target project without a window, so an enterprise dataset can be measured
 * end to end:
 *
 *   index target -> module plan -> Top-1 history candidate when available
 *   (otherwise direct Translator fallback) -> translation scope ->
 *   host-created history-view -> CodexWorkspaceTranslationRuntime ->
 *   host compile/verification gates
 *
 *   npx tsx scripts/run-target-module-pipeline.mts --target experiments/enterprise-asset-upgrade/target-project --dry-run
 *   npx tsx scripts/run-target-module-pipeline.mts --target <path> --top-k 1 --out results/module-pipeline.json
 *
 * Options
 *   --target <path>      target project root (required)
 *   --database <name>    SeekDB database (default forexplore_asset_upgrade_20261004)
 *   --top-k <n>          retrieval width; Top-1 means 1 (default 1)
 *   --max-modules <n>    stop after n modules (default 0 = every module)
 *   --module <text>      translate only modules whose name or id contains text
 *   --repos <a,b,c>      retrieval scope; default every indexed asset repository.
 *                        The dataset's tasks each name two to four assets, and a
 *                        narrower scope also keeps one module search inside the
 *                        production 60s budget while another repository is indexing.
 *   --dry-run            plan + retrieval only: no translation, no writes to the target
 *   --out <json>         report path (default results/target-module-pipeline.json)
 *
 * Gates. Nothing here shortens a host gate. The compile command is the one
 * ADAPTATION_WORKSPACE_COMPILE_COMMAND carries when it is set — the same variable the
 * extension passes to its backend — and otherwise it is derived from the target's own
 * build file. Behavioural verification is active only when
 * ADAPTATION_WORKSPACE_VERIFICATION is set, exactly as in production, where the host
 * declares criteria and the runtime may never supply its own; without it the module
 * is compilation-gated only and the report says so. Every real module run is
 * snapshotted before rollback, so the target returns to its skeleton after the
 * module-level verifier and its repair loop. The global hidden acceptance suite
 * is therefore deliberately skipped for this mode; evaluate the immutable
 * module snapshots instead of scoring an empty skeleton.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { chmod, cp, mkdir, readdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { parse as parseEnvironmentFile } from 'dotenv';
import type { Language, ModuleTarget, ProjectModule, ProjectModuleProposal, SearchCandidate, WorkspaceCompileCommand, WorkspaceTranslationPlan, WorkspaceTranslationRun } from '@forexplore/contracts';
import {
  CodeIntelligenceHost,
  codeIntelligenceRuntimeOptionsFromEnvironment,
  codeIntelligenceHostInternals,
  type RepositoryIdentityStore,
} from '../apps/vscode-extension/src/code-intelligence-host.js';
import { requestSemanticModuleMigrationProposal } from '../apps/vscode-extension/src/module-plan-client.js';
import { HttpModuleHierarchyPlanner } from '../apps/vscode-extension/src/module-hierarchy-client.js';
import { prepareDirectModuleTranslationScope, prepareModuleTranslationScope } from '../apps/vscode-extension/src/module-translation-handoff.js';
import { WorkspaceTranslationHost } from '../apps/vscode-extension/src/workspace-translation-host.js';
import { CodexWorkspaceTranslationRuntime } from '../services/adaptation-service/src/codex-workspace-translation-runtime.js';
import { prepareDeepSeekCodexHome } from '../services/adaptation-service/src/codex-experiment-home.js';
import { createHttpServer } from '../services/adaptation-service/src/http-server.js';
import { createAgentHost } from '../services/translation-verifier/src/host/runtime.js';
import { createTranslationVerifierModelClient } from '../services/translation-verifier/src/host/model-client.js';
import { createFunctionGroupVerifier } from '../services/translation-verifier/src/function-group-verify.js';
import type { SingleAgentFunctionGroupTerminalResult } from '../services/translation-verifier/src/strategies/single-agent-function-group/strategy.js';
import type { FunctionGroupVerificationInput, FunctionGroupVerificationResult } from '../services/translation-verifier/src/types.js';
import { buildModuleFunctionMapping, expandClassLevelFunctions, type ModuleFunctionMapping } from './module-function-mapping.js';

const argument = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

if (flag('help')) {
  console.log('usage: npx tsx scripts/run-target-module-pipeline.mts --target <path> [--database <name>] ' +
    '[--top-k <n>] [--max-modules <n>] [--module <text>] [--dry-run] [--out <json>]');
  process.exit(0);
}

const targetArgument = argument('target');
if (!targetArgument) throw new Error('--target <path> is required.');
const targetRoot = resolve(targetArgument);
if (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) throw new Error(`Target project root is not a directory: ${targetRoot}`);
const database = argument('database', process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE ?? 'forexplore_asset_upgrade_20261004')!;
const topK = Number(argument('top-k', '1'));
if (!Number.isInteger(topK) || topK < 1 || topK > 10) throw new Error('--top-k must be between 1 and 10 (Top-1 means 1).');
const maxModules = Number(argument('max-modules', '0'));
if (!Number.isInteger(maxModules) || maxModules < 0) throw new Error('--max-modules must be a non-negative integer.');
const moduleFilter = argument('module')?.trim().toLocaleLowerCase();
const dryRun = flag('dry-run');
const outputPath = resolve(argument('out', 'results/target-module-pipeline.json')!);
const adaptationApiUrl = argument('adaptation', process.env.ADAPTATION_API_URL ?? 'http://127.0.0.1:8788')!;
const semanticPort = Number(argument('semantic-port', process.env.FOREXPLORE_SEMANTIC_QUERY_PORT ?? '8790'));
const assetRoot = resolve('experiments/enterprise-asset-upgrade/source-repositories');

function classifyVerifierFailure(description: string): {
  reason: 'agent-timeout' | 'model-failure' | 'test-environment-failure';
  kind: 'environment' | 'unknown';
} {
  const text = description.toLowerCase();
  if (text.includes('exhausted its') || text.includes('turn budget') || text.includes('tool-call budget') || text.includes('time budget')) {
    return { reason: 'agent-timeout', kind: 'unknown' };
  }
  if (text.includes('model request') || text.includes('invalid completion') || text.includes('api key')) {
    return { reason: 'model-failure', kind: 'unknown' };
  }
  return { reason: 'test-environment-failure', kind: 'environment' };
}

/** History views are intentionally read-only while an Agent can see them. */
async function removeReadOnlyTree(root: string): Promise<void> {
  try {
    await chmod(root, 0o755);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = join(root, entry.name);
      if (entry.isDirectory()) await removeReadOnlyTree(child);
      else await chmod(child, 0o644);
    }
    await rm(root, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; the verifier result remains valid if the host
    // process cannot remove an already detached temporary tree.
  }
}

/**
 * SeekDB may have been populated by the Windows extension host while this
 * driver is running under WSL.  Repository rows then carry an E:\\... path,
 * which is semantically the same checkout as the current Linux workspace but
 * cannot be passed directly to existsSync or the indexer.  Resolve the known
 * workspace suffix against the current checkout first, then fall back to the
 * conventional /mnt/<drive> mapping.
 */
function resolveRegisteredPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const workspaceMarker = /[\\/]weichai[\\/]/i.exec(normalized);
  if (workspaceMarker && workspaceMarker.index !== undefined) {
    const suffix = normalized.slice(workspaceMarker.index + workspaceMarker[0].length);
    const local = resolve(process.cwd(), suffix);
    if (existsSync(local)) return local;
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized[0]!.toLowerCase();
    const local = resolve(`/mnt/${drive}${normalized.slice(2)}`);
    if (existsSync(local)) return local;
  }
  return resolve(value);
}

// The model key normally arrives through the service environment file; keep the
// offline driver independent of a shell that exported it.
const environmentFile = resolve('services/adaptation-service/.env');
if (existsSync(environmentFile)) {
  for (const [key, value] of Object.entries(parseEnvironmentFile(readFileSync(environmentFile)))) {
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}
// Resolve model settings once for the retrieval/rerank side. The translation
// Agent itself is Codex CLI and uses the user's Codex credential/configuration.
const modelApiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? readEnvironmentFileValue('DEEPSEEK_API_KEY');
const workspaceAgent = process.env.ADAPTATION_WORKSPACE_AGENT?.trim().toLowerCase() || 'codex';
if (!dryRun && workspaceAgent === 'legacy' && !modelApiKey) throw new Error('A configured DEEPSEEK_API_KEY is required for the legacy workspace Agent loop.');
function readEnvironmentFileValue(key: string): string | undefined {
  if (!existsSync(environmentFile)) return undefined;
  return parseEnvironmentFile(readFileSync(environmentFile))[key]?.trim();
}

process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE = database;
process.env.CODE_INTELLIGENCE_EMBEDDING_URL ??= 'http://127.0.0.1:4021/v1/embeddings';
process.env.CODE_INTELLIGENCE_EMBEDDING_MODEL ??= 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78';
process.env.CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS ??= 'false';
process.env.CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX ??= 'query: ';
process.env.CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX ??= 'passage: ';
process.env.CODE_INTELLIGENCE_EMBEDDING_VARIANT ??= 'dml-fp16';
process.env.CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION ??= '384';

/** The runtime between modules; every gap is a chance for SeekDB to checkpoint. */
async function waitForSeekDb(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reachable = await new Promise<boolean>((resolveProbe) => {
      const socket = connect({ host: '127.0.0.1', port: 2881 });
      socket.once('connect', () => { socket.destroy(); resolveProbe(true); });
      socket.once('error', () => { socket.destroy(); resolveProbe(false); });
      socket.setTimeout(5_000, () => { socket.destroy(); resolveProbe(false); });
    });
    if (reachable) return;
    if (Date.now() >= deadline) throw new Error('SeekDB is not listening on 127.0.0.1:2881.');
    console.log('    waiting for SeekDB on 127.0.0.1:2881 ...');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
  }
}

/**
 * Host-owned command resolution. The extension passes JSON through these two
 * variables; when no compile command is configured the driver derives one from the
 * target's own build file rather than inventing a no-op gate.
 */
function resolveCompileCommand(): WorkspaceCompileCommand {
  const configured = process.env.ADAPTATION_WORKSPACE_COMPILE_COMMAND?.trim();
  if (configured) {
    const parsed = JSON.parse(configured) as WorkspaceCompileCommand;
    if (!parsed?.executable || !Array.isArray(parsed.args)) throw new Error('ADAPTATION_WORKSPACE_COMPILE_COMMAND must carry executable and args.');
    return parsed;
  }
  const entries = readdirSync(targetRoot);
  const solution = entries.find((name) => name.endsWith('.sln'));
  const project = entries.find((name) => name.endsWith('.csproj')) ??
    readdirSync(targetRoot).map((name) => join('src', name)).find((candidate) => existsSync(join(targetRoot, candidate, '')) );
  if (solution) return { executable: 'dotnet', args: ['build', solution, '--nologo', '--verbosity', 'quiet'], timeoutMs: 900_000 };
  if (project && !project.includes('/') && entries.includes(project)) return { executable: 'dotnet', args: ['build', project, '--nologo', '--verbosity', 'quiet'], timeoutMs: 900_000 };
  if (entries.includes('pom.xml')) return { executable: 'mvn', args: ['-q', '-DskipTests', 'package'], timeoutMs: 1_200_000 };
  if (entries.includes('package.json')) return { executable: 'npm', args: ['run', '--silent', 'build'], timeoutMs: 900_000 };
  throw new Error(`No compile command is configured and none could be derived from ${targetRoot}. ` +
    'Set ADAPTATION_WORKSPACE_COMPILE_COMMAND, the same variable the extension passes to its backend.');
}

function resolveVerification(): { command: WorkspaceCompileCommand; protectedFiles: string[] } | undefined {
  const configured = process.env.ADAPTATION_WORKSPACE_VERIFICATION?.trim();
  if (!configured) return undefined;
  const parsed = JSON.parse(configured) as { command?: WorkspaceCompileCommand; protectedFiles?: unknown };
  if (!parsed?.command?.executable || !Array.isArray(parsed.command.args)) throw new Error('ADAPTATION_WORKSPACE_VERIFICATION must carry a command.');
  if (!Array.isArray(parsed.protectedFiles) || !parsed.protectedFiles.length || parsed.protectedFiles.some((path) => typeof path !== 'string')) {
    throw new Error('ADAPTATION_WORKSPACE_VERIFICATION must carry a non-empty protectedFiles list.');
  }
  return { command: parsed.command, protectedFiles: parsed.protectedFiles as string[] };
}

/** Normalize project-analysis language labels before constructing a ModuleTarget. */
function targetLanguage(value: string | undefined, sourceFiles: readonly string[]): Language {
  const normalized = value?.trim().toLowerCase();
  const aliases: Record<string, Language> = {
    typescript: 'TypeScript', javascript: 'TypeScript',
    python: 'Python', java: 'Java',
    csharp: 'C#', 'c#': 'C#', cs: 'C#',
    rust: 'Rust', go: 'Go',
  };
  if (normalized && aliases[normalized]) return aliases[normalized]!;
  const extensionAliases: Record<string, Language> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'TypeScript', jsx: 'TypeScript',
    py: 'Python', java: 'Java', cs: 'C#', rs: 'Rust', go: 'Go',
  };
  for (const file of sourceFiles) {
    const extension = file.split('.').at(-1)?.toLowerCase();
    if (extension && extensionAliases[extension]) return extensionAliases[extension]!;
  }
  throw new Error(`Unsupported module language: ${value ?? 'unknown'}`);
}

/**
 * Dependency/plan order over the modules that actually own files. Split nodes carry
 * no file list of their own, so only leaves become translation targets; a dependency
 * cycle keeps the traversal order instead of failing the whole plan.
 */
function orderModules(modules: readonly ProjectModule[]): ProjectModule[] {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const leaves = modules.filter((module) => (module.sourceFiles ?? []).length > 0);
  const ordered: ProjectModule[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (module: ProjectModule) => {
    const seen = state.get(module.id);
    if (seen === 'done' || seen === 'visiting') return;
    state.set(module.id, 'visiting');
    for (const dependency of module.dependsOn ?? []) {
      const next = byId.get(dependency);
      if (next && (next.sourceFiles ?? []).length > 0) visit(next);
    }
    state.set(module.id, 'done');
    ordered.push(module);
  };
  for (const module of leaves) visit(module);
  return ordered;
}

interface ModuleReport {
  moduleId: string;
  module: string;
  language?: string;
  sourceFiles: string[];
  requirement: string;
  writeFiles?: string[];
  candidate?: { repository: string; name: string; moduleId: string; language: string; score: number; hybrid?: number; rerank?: number; title: string };
  candidatesConsidered?: number;
  translationMode?: 'analyzer-translator' | 'direct-translator';
  fallbackReason?: string;
  /** Set when the first history search hit the store's query budget and was retried. */
  retrievalRetry?: string;
  status: 'planned' | 'retrieved' | 'completed' | 'failed' | 'skipped';
  turns?: number;
  acceptance?: string;
  changedPaths?: string[];
  /** Why a still-running module was stopped early, e.g. an accepted-plan/change drought. */
  stoppedEarly?: string;
  /** Runtime event tail, kept for non-completed runs: tool choice, tool failure, nudges. */
  events?: string[];
  wallMs?: number;
  error?: string;
  functionMapping?: Pick<ModuleFunctionMapping, 'functions' | 'unmatchedFunctions' | 'diagnostics'>;
  translationVerification?: FunctionGroupVerificationResult;
  translationVerificationAttempts?: FunctionGroupVerificationResult[];
  verificationMode?: 'translation-fidelity' | 'requirement';
  agent?: WorkspaceTranslationRun['agent'];
  /** Analyzer's structured plan, retained for completeness review. */
  plan?: WorkspaceTranslationPlan;
  /** Immutable translated result captured before the workspace is restored. */
  snapshot?: {
    directory: string;
    manifest: string;
    codeDirectory: string;
    changedPaths: string[];
  };
  /** Host rollback state. A false value is a hard stop for the module loop. */
  rollback?: {
    requested: boolean;
    status?: WorkspaceTranslationRun['status'];
    restored: boolean;
    baselineMatches?: boolean;
    error?: string;
  };
  baselineHashes?: Record<string, string | null>;
}

function safeSnapshotSegment(value: string): string {
  const normalized = value.trim().replaceAll(/[^a-zA-Z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '');
  return normalized || 'module';
}

function targetFilePath(root: string, relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:[\\/]/.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`不安全的目标文件路径：${relativePath}`);
  }
  const absolute = resolve(root, normalized);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolute !== root && !absolute.startsWith(rootPrefix)) throw new Error(`目标文件越界：${relativePath}`);
  return absolute;
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function captureBaselineHashes(root: string, files: readonly string[]): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const relativePath of files) {
    const absolute = targetFilePath(root, relativePath);
    result[relativePath] = existsSync(absolute) ? fileHash(absolute) : null;
  }
  return result;
}

async function compareBaselineHashes(root: string, baseline: Record<string, string | null>): Promise<string[]> {
  const mismatches: string[] = [];
  for (const [relativePath, expected] of Object.entries(baseline)) {
    const absolute = targetFilePath(root, relativePath);
    const actual = existsSync(absolute) ? fileHash(absolute) : null;
    if (actual !== expected) mismatches.push(`${relativePath} expected=${expected ?? '<missing>'} actual=${actual ?? '<missing>'}`);
  }
  return mismatches;
}

async function captureModuleSnapshot(args: {
  root: string;
  snapshotRoot: string;
  index: number;
  module: ProjectModule;
  entry: ModuleReport;
  run: WorkspaceTranslationRun;
  baselineHashes: Record<string, string | null>;
}): Promise<NonNullable<ModuleReport['snapshot']>> {
  const directory = join(args.snapshotRoot, `${String(args.index + 1).padStart(2, '0')}-${safeSnapshotSegment(args.module.name || args.module.id)}`);
  const codeDirectory = join(directory, 'code');
  await mkdir(codeDirectory, { recursive: true });
  const copied: string[] = [];
  for (const relativePath of args.entry.writeFiles ?? []) {
    const source = targetFilePath(args.root, relativePath);
    if (!existsSync(source)) continue;
    const destination = join(codeDirectory, relativePath.replaceAll('\\', '/'));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    copied.push(relativePath);
  }
  const afterHashes = await captureBaselineHashes(args.root, Object.keys(args.baselineHashes));
  const manifestPath = join(directory, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    moduleId: args.entry.moduleId,
    module: args.entry.module,
    requirement: args.entry.requirement,
    language: args.entry.language,
    writeFiles: args.entry.writeFiles ?? [],
    changedPaths: args.entry.changedPaths ?? [],
    copiedPaths: copied,
    runId: args.run.id,
    createdAt: new Date().toISOString(),
    status: args.entry.status,
    error: args.entry.error,
    baselineHashes: args.baselineHashes,
    afterHashes,
    compile: args.run.compilations,
    plan: args.run.plan,
    verifier: args.entry.translationVerification,
    verifierAttempts: args.entry.translationVerificationAttempts,
    agent: args.entry.agent,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifest: manifestPath, codeDirectory, changedPaths: [...(args.entry.changedPaths ?? [])] };
}

const report = {
  generatedAt: new Date().toISOString(),
  dryRun,
  database,
  targetRoot,
  topK,
  gates: {} as { compile: string; verification: string | undefined; hiddenSuite: string },
  target: {} as { repositoryId?: string; analysisRevision?: string; projectId?: string; project?: string; modules?: number; hierarchy?: unknown },
  modules: [] as ModuleReport[],
};
const snapshotRoot = resolve(`${outputPath}.snapshots`);
await rm(snapshotRoot, { recursive: true, force: true });
await mkdir(snapshotRoot, { recursive: true });

await waitForSeekDb(Number(argument('wait-db', '600')) * 1000);
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database, connectionLimit: 2 });
await pool.query('SET SESSION ob_query_timeout = 120000000');

/** Stands in for `context.globalState`: registered paths keep their repository identity. */
class MemoryState implements RepositoryIdentityStore {
  readonly values = new Map<string, string>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: string): Promise<void> { this.values.set(key, value); }
}

const [registered] = await pool.query<Array<RowDataPacket & { repositoryId: string; localPath: string; activeRevision: string | null; displayName: string; role: string }>>(
  `SELECT repository_id AS repositoryId, local_path AS localPath, active_revision AS activeRevision,
     display_name AS displayName, role FROM repositories`);
const identityStore = new MemoryState();
const nativeIdentityKeys = new Set<string>();
// A previous WSL run may have left a second POSIX registration with no active
// revision next to the Windows-hosted row. Prefer the active persisted row when
// both resolve to the same local checkout, otherwise the null revision would
// shadow the usable historical identity.
const identityRows = [...registered].sort((left, right) => Number(Boolean(right.activeRevision)) - Number(Boolean(left.activeRevision)));
for (const row of identityRows) {
  // Preserve the persisted identity across Windows-hosted database rows and
  // the WSL path that the current process can actually open.
  identityStore.values.set(codeIntelligenceHostInternals.stableIdentityKey(row.localPath), row.repositoryId);
  const localPath = resolveRegisteredPath(row.localPath);
  const localKey = codeIntelligenceHostInternals.stableIdentityKey(localPath);
  // Prefer a path written by the current platform when the shared database
  // also contains a translated path from the other worktree. This matters for
  // a target that was first indexed by Windows: retaining that ID here would
  // make the WSL scanner reopen the inaccessible E:\\ path.
  const normalizedStored = row.localPath.replaceAll('\\', '/');
  const nativePath = process.platform === 'win32'
    ? normalizedStored.length >= 3 && normalizedStored[1] === ':' && normalizedStored[2] === '/'
    : normalizedStored.startsWith('/');
  if (!identityStore.values.has(localKey) || (nativePath && !nativeIdentityKeys.has(localKey))) {
    identityStore.values.set(localKey, row.repositoryId);
    if (nativePath) nativeIdentityKeys.add(localKey);
  }
}

// Retrieval may only draw on history revisions that are actually queryable; a
// repository that is mid-scan has no active revision and cannot serve candidates.
const historyRepositories = registered
  .map((row) => ({ ...row, localPath: resolveRegisteredPath(row.localPath) }))
  .filter((row) => row.role === 'history' && row.activeRevision && existsSync(row.localPath))
  .map((row) => ({ localPath: row.localPath, displayName: row.displayName, repositoryId: row.repositoryId }));
const assetNames = argument('repos')?.split(',').map((value) => value.trim()).filter(Boolean);
const assets = historyRepositories.filter((row) => row.localPath.startsWith(assetRoot) &&
  (!assetNames || assetNames.includes(row.localPath.replaceAll('\\', '/').split('/').at(-1) ?? '')));
if (assetNames) {
  const availableAssets = historyRepositories.filter((row) => row.localPath.startsWith(assetRoot))
    .map((row) => row.localPath.replaceAll('\\', '/').split('/').at(-1));
  const unknown = assetNames.filter((name) => !availableAssets.includes(name));
  if (unknown.length) throw new Error(`--repos names repositories without an active revision: ${unknown.join(', ')}. Indexed assets: ${availableAssets.join(', ')}`);
}
// Retrieval draws on exactly the repositories named by --repos (or every indexed
// asset). The target is not a retrieval source, so it is never in this list.
const retrievalRepositories = assetNames ? assets : historyRepositories;
console.log(`database=${database}  history repositories=${historyRepositories.length}（asset ${assets.length}）`);
for (const row of assets) console.log(`  asset: ${row.displayName}`);

let semanticEndpoint: string | undefined;
const codeIntelligence = new CodeIntelligenceHost({
  runtimeOptions: codeIntelligenceRuntimeOptionsFromEnvironment(process.env, { allowInMemory: false }),
  identityStore,
  planProject: async (scope) => {
    // The revision-scoped query port must exist before the service will plan; the
    // workbench starts it the same way before asking for a plan.
    semanticEndpoint = await codeIntelligence.startSemanticQueryServer({
      port: semanticPort,
      bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN?.trim() || undefined,
    });
    return requestSemanticModuleMigrationProposal(adaptationApiUrl, scope, undefined, AbortSignal.timeout(600_000));
  },
  hierarchyPlanner: new HttpModuleHierarchyPlanner(() => adaptationApiUrl),
  output: { appendLine: (line: string) => console.log(`    ${line}`) },
});

const cleanups: Array<() => Promise<unknown>> = [];
try {
  // The target registers and scans first; the assets are only made visible so
  // retrieval can see them, which is why they are synchronized without a scan.
  console.log('\n=== target: register/index ===');
  await codeIntelligence.synchronize({ repositories: [{ localPath: targetRoot, role: 'target' }], scan: true });
  // Read the registered row back from the database: the presentation payload is a
  // panel view, while the registry row carries the identity this run must pin.
  const [targetRows] = await pool.query<Array<RowDataPacket & { repositoryId: string; localPath: string; activeRevision: string | null; displayName: string; analysisStatus: string }>>(
    `SELECT repository_id AS repositoryId, local_path AS localPath, active_revision AS activeRevision, display_name AS displayName,
       analysis_status AS analysisStatus FROM repositories WHERE role='target'`);
  // The shared SeekDB may contain the same checkout registered by Windows and
  // WSL. Compare the host-resolved paths instead of the persisted spelling.
  const targetRepositoryId = identityStore.get<string>(codeIntelligenceHostInternals.stableIdentityKey(targetRoot));
  const targetRepository = targetRows.find((row) => row.repositoryId === targetRepositoryId) ??
    targetRows.find((row) => resolveRegisteredPath(row.localPath) === targetRoot);
  if (!targetRepository) throw new Error('The target project was not registered.');
  console.log(`  ${targetRepository.displayName} status=${targetRepository.analysisStatus} revision=${targetRepository.activeRevision ?? '(none)'}`);
  if (!targetRepository.activeRevision) throw new Error(`The target project has no active revision after indexing (status ${targetRepository.analysisStatus}).`);

  if (retrievalRepositories.length) {
    // scan:false is essential here. Synchronization defaults to scanning, and a scan
    // of seven large assets (camel alone is 8,265 files) would run for a very long
    // time just to make them visible to retrieval.
    await codeIntelligence.synchronize({
      repositories: retrievalRepositories.map((row) => ({ localPath: row.localPath, role: 'history' as const })),
      scan: false,
    });
    const visible = await codeIntelligence.explorerData();
    console.log(`  可见仓库：${visible.map((entry) => `${entry.repository.displayName}:${entry.repository.repositoryId}:${entry.repository.activeRevision ?? 'none'}`).join(', ')}`);
  }

  const targetScope = { repositoryId: targetRepository.repositoryId, analysisRevision: targetRepository.activeRevision };
  const [projectRows] = await pool.query<Array<RowDataPacket & { projectId: string; displayName: string | null; files: number }>>(
    `SELECT p.project_id AS projectId, p.display_name AS displayName, COUNT(f.file_id) AS files
     FROM projects p LEFT JOIN files f ON f.project_id = p.project_id AND f.analysis_revision = p.analysis_revision
     WHERE p.repository_id=? AND p.analysis_revision=? GROUP BY p.project_id, p.display_name ORDER BY files DESC`,
    [targetScope.repositoryId, targetScope.analysisRevision]);
  // The synthetic bucket holds files no project claims. It is only a target of last
  // resort, because a real project always describes the implementation better.
  const real = projectRows.filter((project) => !/未归属|unassigned/i.test(project.displayName ?? ''));
  const chosen = (real.length ? real : projectRows)[0];
  if (!chosen) throw new Error('The target revision has no project to plan.');
  console.log(`  project: ${chosen.displayName ?? chosen.projectId}（${chosen.files} 文件）`);

  console.log('\n=== target: module plan ===');
  const projectScope = { ...targetScope, projectId: chosen.projectId };
  const [previousPlanRows] = await pool.query<Array<RowDataPacket & { updatedAt: string }>>(
    `SELECT updated_at AS updatedAt FROM module_artifacts
       WHERE repository_id=? AND analysis_revision=? AND module_artifact_id=? AND status='current'`,
    [targetScope.repositoryId, targetScope.analysisRevision, `project-job:${chosen.projectId}:code-understanding/v1`]);
  const previousPlanUpdatedAt = previousPlanRows[0]?.updatedAt ? String(previousPlanRows[0].updatedAt) : undefined;
  await codeIntelligence.retryProject(projectScope, true);
  // retryProject schedules the analysis and returns; waitForProjects() can observe an
  // empty run set before the scheduled run registers itself, so the published record
  // is polled for instead of trusting a single idle() call.
  const planDeadline = Date.now() + Number(argument('plan-timeout-ms', '1200000'));
  let record: { projectId?: string; state?: string; error?: string; proposal?: ProjectModuleProposal; updatedAt?: string } | undefined;
  for (;;) {
    const [artifactRows] = await pool.query<Array<RowDataPacket & { payload: unknown; updatedAt: string }>>(
      `SELECT payload, updated_at AS updatedAt FROM module_artifacts WHERE repository_id=? AND analysis_revision=?
         AND kind IN ('module-summary', 'other') AND status='current' ORDER BY updated_at DESC`,
      [targetScope.repositoryId, targetScope.analysisRevision]);
    record = artifactRows
      .map((row) => ({ ...(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
        projectId?: string; state?: string; error?: string; proposal?: ProjectModuleProposal;
      }, updatedAt: String(row.updatedAt) }))
      .find((payload) => payload?.projectId === chosen.projectId);
    if (record && (record.state === 'ready' || record.state === 'failed') && record.updatedAt !== previousPlanUpdatedAt) break;
    if (Date.now() >= planDeadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  if (!record || record.state !== 'ready' || !record.proposal) {
    throw new Error(`Module plan did not publish for ${chosen.projectId}: ${record?.error ?? record?.state ?? 'no artifact'}`);
  }
  const proposal = record.proposal;
  const ordered = orderModules(proposal.modules ?? []);
  report.target = { repositoryId: targetScope.repositoryId, analysisRevision: targetScope.analysisRevision,
    projectId: chosen.projectId, project: chosen.displayName ?? chosen.projectId,
    modules: ordered.length, hierarchy: proposal.hierarchy };
  console.log(`  模块 ${proposal.modules?.length ?? 0} 个，其中有文件清单（可翻译）${ordered.length} 个`);
  console.log(`  层级: ${JSON.stringify(proposal.hierarchy)}`);

  const filtered = moduleFilter
    ? ordered.filter((module) => `${module.name} ${module.id}`.toLocaleLowerCase().includes(moduleFilter))
    : ordered;
  const selected = maxModules > 0 ? filtered.slice(0, maxModules) : filtered;
  if (moduleFilter) console.log(`  模块过滤：${moduleFilter}（匹配 ${selected.length} 个）`);
  const compileCommand = resolveCompileCommand();
  const verification = resolveVerification();
  report.gates = { compile: `${compileCommand.executable} ${compileCommand.args.join(' ')}`,
    verification: verification ? `${verification.command.executable} ${verification.command.args.join(' ')}` : undefined,
    hiddenSuite: 'skipped: each module is snapshotted and rolled back; evaluate module snapshots separately' };
  console.log(`\n  编译门槛: ${report.gates.compile}`);
  console.log(`  行为验证: ${report.gates.verification ?? '未配置（使用模块级 verifier；每个模块结束后恢复骨架）'}`);

  // The translation side is built once and reused, exactly like the backend the
  // extension owns; it is only created for a real run.
  let translation: { host: WorkspaceTranslationHost } | undefined;
  if (!dryRun) {
    if (workspaceAgent !== 'codex') throw new Error(`Unsupported pipeline workspace agent: ${workspaceAgent}. Set ADAPTATION_WORKSPACE_AGENT=codex.`);
    const codexHome = await prepareDeepSeekCodexHome({
      explicitHome: process.env.ADAPTATION_CODEX_HOME?.trim() || undefined,
      apiKey: modelApiKey,
      model: process.env.ADAPTATION_CODEX_MODEL?.trim() || 'deepseek-v4-pro',
      baseUrl: process.env.ADAPTATION_CODEX_BASE_URL?.trim() || process.env.DEEPSEEK_API_BASE?.trim(),
    });
    // Cleanup order is reverse registration: stop Codex before deleting its
    // temporary configuration directory.
    cleanups.push(() => codexHome.cleanup());
    const runtime = new CodexWorkspaceTranslationRuntime({
      workspaceRoot: targetRoot,
      compileCommand,
      ...(verification ? { verification } : {}),
      codexCommand: process.env.ADAPTATION_CODEX_COMMAND?.trim() || 'codex',
      codexModel: process.env.ADAPTATION_CODEX_MODEL?.trim() || 'deepseek-v4-pro',
      codexHome: codexHome.path,
      maxModelTurns: Number(process.env.ADAPTATION_WORKSPACE_MAX_TURNS ?? 4),
      timeoutMs: Number(process.env.ADAPTATION_WORKSPACE_TIMEOUT_MS ?? 1_800_000),
      // A verifier run consists of one test-generation attempt plus repair
      // attempts. Keep the runtime repair budget aligned with the pipeline's
      // five-round verifier cap.
      maxVerificationRepairs: Number.isInteger(Number(process.env.TRANSLATION_VERIFIER_MAX_ATTEMPTS ?? 5))
        ? Math.max(0, Math.min(4, Number(process.env.TRANSLATION_VERIFIER_MAX_ATTEMPTS ?? 5) - 1))
        : 4,
    });
    cleanups.push(() => runtime.shutdown());
    const token = randomBytes(32).toString('hex');
    const server = createHttpServer({ adapter: { adapt: async () => { throw new Error('Not used by workspace translation'); } },
      workspaceTranslation: { runtime, bearerToken: token } });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    cleanups.push(() => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())));
    translation = { host: new WorkspaceTranslationHost(() => ({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token })) };
  }

  console.log(`\n=== module pipeline（${dryRun ? 'dry-run' : 'real'}，topK=${topK}，模块 ${selected.length}）===`);
  let stopAfterRollbackFailure = false;
  for (const [index, module] of selected.entries()) {
    const started = Date.now();
    const language = targetLanguage(module.language, module.sourceFiles);
    const requirement = [module.purpose ?? module.description, `目标语言：${language}`, `目标工程：${report.target.project}`]
      .filter(Boolean).join('\n');
    const entry: ModuleReport = { moduleId: module.id, module: module.name, language, sourceFiles: module.sourceFiles,
      requirement, status: 'planned' };
    report.modules.push(entry);
    console.log(`\n[${index + 1}/${selected.length}] ${module.name}（${module.sourceFiles.length} 文件, ${language}）`);
    try {
      const target: ModuleTarget = {
        id: module.id, name: module.name, kind: 'module', path: module.sourceFiles[0]!, language,
        signature: module.coreApis?.[0] ?? module.name,
        module: { repositoryId: targetScope.repositoryId, analysisRevision: targetScope.analysisRevision,
          projectId: chosen.projectId, sourceFiles: module.sourceFiles, coreApis: module.coreApis ?? [], dependsOn: module.dependsOn ?? [] },
      };
      // The first search in a fresh process can exceed the store's 60s query budget
      // while the query embedding and module index warm up. Retry that specific
      // timeout once and record it, so the fragility stays visible instead of
      // looking like a missing candidate.
      let candidates: SearchCandidate[] = [];
      const retrievalStart = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          candidates = await codeIntelligence.searchHistoricalImplementations({ target, requirement, topK });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt > 0 || !/timeout|aborted/i.test(message)) throw error;
          entry.retrievalRetry = message.slice(0, 200);
          console.log(`    ! 首次检索超时，重试一次：${message.slice(0, 120)}`);
          await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
        }
      }
      entry.candidatesConsidered = candidates.length;
      entry.retrievalMs = Date.now() - retrievalStart;
      // A parent/subsystem hit can carry no concrete files in an older module
      // projection. It cannot produce a history-view, so select the first
      // usable module within the requested retrieval width. If none exists,
      // continue through the direct Translator fallback instead of dropping
      // the target module entirely.
      const top = candidates.find((candidate) => candidate.kind === 'module' &&
        Boolean(candidate.sourceModule?.sourceFiles?.length));
      if (!top) {
        entry.status = 'retrieved';
        entry.translationMode = 'direct-translator';
        entry.fallbackReason = 'no history candidate with source files';
        console.log('  ! 没有可读取的历史候选，切换到需求直实现 Translator 兜底');
      } else {
        if (top.kind !== 'module' || !top.sourceModule) { entry.status = 'skipped'; entry.error = `candidate kind ${top.kind}`; console.log(`  ✗ 候选不是模块：${top.kind}`); continue; }
        entry.translationMode = 'analyzer-translator';
        entry.candidate = { repository: top.repository, name: top.sourceModule.name, moduleId: top.sourceModule.moduleId,
          language: top.language, score: top.score.overall, ...(top.score.hybrid === undefined ? {} : { hybrid: top.score.hybrid }),
          ...(top.score.rerank === undefined ? {} : { rerank: top.score.rerank }), title: top.title };
        console.log(`  Top-1: ${top.repository} / ${top.sourceModule.name}  score=${top.score.overall.toFixed(3)}` +
          `${top.score.hybrid === undefined ? '' : ` hybrid=${top.score.hybrid.toFixed(3)}`}（候选 ${candidates.length}）`);
      }

      let verifierSourceRoot: string | undefined;
      let historyViewRoot: string | undefined;
      let activeRun: WorkspaceTranslationRun | undefined;
      try {
        let scope: Awaited<ReturnType<typeof prepareModuleTranslationScope>>;
        if (top) {
          let historyUnavailable = false;
          let historyView: Awaited<ReturnType<typeof codeIntelligence.createHistoryModuleView>> | undefined;
          try {
            historyView = dryRun ? undefined : await codeIntelligence.createHistoryModuleView({
            workspaceRoot: targetRoot,
            repositoryId: top.sourceModule!.repositoryId,
            analysisRevision: top.sourceModule!.analysisRevision,
            projectId: top.sourceModule!.projectId,
            moduleId: top.sourceModule!.moduleId,
            sourceFiles: top.sourceModule!.sourceFiles ?? [top.path],
            relevanceTerms: [
              target.name, target.path, target.signature,
              ...(target.module?.sourceFiles ?? []), ...(target.module?.coreApis ?? []),
              top.sourceModule!.name, top.sourceModule!.purpose ?? '',
              ...(top.sourceModule!.coreApis ?? []),
            ],
            });
          } catch (error) {
            const description = error instanceof Error ? error.message : String(error);
            if (!/有效的源文件清单|source files|source file/i.test(description)) throw error;
            historyUnavailable = true;
            entry.translationMode = 'direct-translator';
            entry.fallbackReason = 'history candidate source files unavailable';
            console.log(`  ! Top-1 历史候选文件已不可读，切换到需求直实现 Translator 兜底：${description.slice(0, 180)}`);
          }
          if (!historyUnavailable) {
          historyViewRoot = historyView?.root;
          // Keep a separate read-only copy for the post-translation #44
          // verifier; it contains only the selected module files.
          verifierSourceRoot = historyView ? await mkdtemp(join(tmpdir(), 'forexplore-verifier-history-')) : undefined;
          if (historyView && verifierSourceRoot) await cp(join(historyView.root, 'source'), verifierSourceRoot, { recursive: true });
          try {
            scope = await prepareModuleTranslationScope({ workspaceRoot: targetRoot, target, candidate: top,
              requirement, decisionNotes: '',
              evidenceScopes: [{ repositoryId: top.sourceModule!.repositoryId, analysisRevision: top.sourceModule!.analysisRevision }],
              ...(historyView ? { historyView } : {}) });
          } catch (error) {
            const description = error instanceof Error ? error.message : String(error);
            if (!/有效的源文件清单|source files|source file/i.test(description)) throw error;
            entry.translationMode = 'direct-translator';
            entry.fallbackReason = 'history candidate source files unavailable';
            console.log(`  ! 历史视图没有可读取源文件，切换到需求直实现 Translator 兜底：${description.slice(0, 180)}`);
            scope = await prepareDirectModuleTranslationScope({ workspaceRoot: targetRoot, target, requirement, decisionNotes: '' });
          }
          } else {
            scope = await prepareDirectModuleTranslationScope({ workspaceRoot: targetRoot, target, requirement, decisionNotes: '' });
          }
        } else {
          scope = await prepareDirectModuleTranslationScope({ workspaceRoot: targetRoot, target, requirement, decisionNotes: '' });
        }
      // Experiment hook, off by default. The product scope makes the module's own files the
      // only readable ones, so an Analyzer cannot read the types those files reference and
      // reports a blocker. RECAST_EXPERIMENT_WIDEN_READ_SCOPE=1 adds the rest of the target
      // project as readable while the write scope stays the module's own files (variant A1).
      if (process.env.RECAST_EXPERIMENT_WIDEN_READ_SCOPE === '1') {
        const [projectFiles] = await pool.query<Array<{ relativePath: string }>>(
          `SELECT f.relative_path AS relativePath FROM files f
           JOIN repositories r ON r.repository_id = f.repository_id
           WHERE r.local_path = ? AND f.analysis_revision = r.active_revision`, [targetRoot]);
        const known = new Set(scope.workspaceFiles ?? []);
        const extra = projectFiles.map((row) => row.relativePath).filter((path) => !known.has(path));
        (scope as { workspaceFiles?: string[] }).workspaceFiles = [...(scope.workspaceFiles ?? []), ...extra];
        console.log(`    [experiment A1] 读范围放宽到整个工程：+${extra.length} 文件（写范围不变）`);
      }
      entry.writeFiles = scope.profile.writeFiles;
      if (entry.writeFiles.length === 0) { entry.status = 'skipped'; entry.error = 'empty write scope'; console.log('  ✗ 写范围为空'); continue; }

      // Capture the exact pre-translation state. The runtime journal is the
      // authoritative rollback mechanism, while these hashes prove that the
      // next module starts from the same skeleton.
      const baselineHashes = await captureBaselineHashes(targetRoot, entry.writeFiles);
      entry.baselineHashes = baselineHashes;

      if (dryRun) {
        entry.wallMs = Date.now() - started;
        console.log(`  ✓ 范围已准备：writeFiles=${entry.writeFiles.join(', ')}`);
        for (const warning of scope.warnings ?? []) console.log(`    ! ${warning}`);
        continue;
      }

      const host = translation!.host;
      const moduleScopeId = host.rememberModuleScope(scope);
      const described = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: `describe-${index}`, action: 'describe', moduleScopeId });
      if (described.type !== 'WORKSPACE_TRANSLATION_RESULT' || !described.profile) throw new Error(`describe failed: ${JSON.stringify(described)}`);
      const startedRun = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: `start-${index}`, action: 'start',
        moduleScopeId, profileId: described.profile.profileId });
      if (startedRun.type !== 'WORKSPACE_TRANSLATION_RESULT' || !startedRun.run) throw new Error(`start failed: ${JSON.stringify(startedRun)}`);
      let run = startedRun.run;
      activeRun = run;
      const deadline = Date.now() + Number(process.env.ADAPTATION_WORKSPACE_TIMEOUT_MS ?? 1_800_000);
      // The runtime records every tool choice, tool failure and no-tool-call nudge in
      // run.events, but nothing surfaced them, so a zero-change run could only be read
      // as "budget exhausted". A drought of turns with neither an accepted plan nor a
      // file change is not going to recover; on a 65-module target it would burn hours.
      const noProgressTurns = Number(process.env.ADAPTATION_WORKSPACE_NO_PROGRESS_TURNS ?? 24);
      let lastProgress = '';
      while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
        const polled = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: `read-${index}`, action: 'read', runId: run.id });
        if (polled.type !== 'WORKSPACE_TRANSLATION_RESULT' || !polled.run) throw new Error(`read failed: ${JSON.stringify(polled)}`);
        run = polled.run;
        activeRun = run;
        const progress = `${run.status} turns=${run.modelTurns} changes=${run.changes.length}${run.plan ? ` plan=${run.plan.steps.length}` : ''}`;
        if (progress !== lastProgress) { console.log(`    ${progress}`); lastProgress = progress; }
        if (noProgressTurns > 0 && run.modelTurns >= noProgressTurns && !run.plan && run.changes.length === 0) {
          if (run.events?.length) for (const event of run.events.slice(-8)) console.log(`      · ${event.phase}: ${event.message}`);
          const cancelled = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: `cancel-${index}`, action: 'cancel', runId: run.id });
          if (cancelled.type === 'WORKSPACE_TRANSLATION_RESULT' && cancelled.run) run = cancelled.run;
          entry.stoppedEarly = `stopped after ${run.modelTurns} turns with no accepted plan and no file change`;
          console.log(`    ⏹ ${entry.stoppedEarly}`);
          break;
        }
      }
      entry.status = run.status === 'completed' ? 'completed' : 'failed';
      entry.turns = run.modelTurns;
      entry.acceptance = run.acceptance;
      entry.changedPaths = [...new Set(run.changes.map((change) => change.path))];
      entry.agent = run.agent;
      entry.plan = run.plan;
      // The runtime marks a run completed only after its host compile gate, but
      // keep the explicit check here so a verifier can never run on a record
      // with a missing or failed compilation.
      const lastCompilation = run.compilations.at(-1);
      if (run.status === 'completed' && (!lastCompilation || !lastCompilation.success)) {
        entry.error = '翻译运行状态已完成，但没有成功的宿主编译记录；跳过函数组验证。';
        console.log(`    ! ${entry.error}`);
      }
      if (run.status === 'completed' && lastCompilation?.success && modelApiKey) {
        // Prefer source/target fidelity verification when at least one safe
        // mapping exists. Otherwise verify the target directly against the
        // requirement instead of disabling the verifier altogether.
        const mapping = buildModuleFunctionMapping(module, top?.sourceModule);
        // Indexers may expose an exported class as a core API. Coverage is
        // method-based, so expand those target-only subjects before creating
        // the requirement verifier input.
        const expandedUnmatched = expandClassLevelFunctions(
          mapping.unmatchedFunctions,
          (path) => {
            try { return readFileSync(join(targetRoot, path), 'utf8'); } catch { return undefined; }
          },
        );
        // Assign even when only the signature changed (for example a
        // qualified `Type.Method` name with no parameter list). Coverage
        // matching depends on that normalization too.
        mapping.unmatchedFunctions = expandedUnmatched;
        entry.functionMapping = mapping;
        console.log(`    函数映射：matched=${mapping.functions.length} unmatched=${mapping.unmatchedFunctions.length}`);
        for (const diagnostic of mapping.diagnostics.slice(0, 12)) {
          console.log(`      ! ${diagnostic.targetApi}: ${diagnostic.reason}`);
        }
        const useTranslationVerification = mapping.functions.length > 0 && Boolean(verifierSourceRoot && top?.sourceModule);
        entry.verificationMode = useTranslationVerification ? 'translation-fidelity' : 'requirement';
        const requirementFunctions = mapping.unmatchedFunctions.length > 0
          ? mapping.unmatchedFunctions
          : mapping.functions.map(({ target }) => target);
        if (!useTranslationVerification && requirementFunctions.length === 0) {
          entry.translationVerification = {
            status: 'failure', reason: 'mapping-invalid',
            issue: { kind: 'translation', description: '目标模块没有可用于需求验证的函数清单。' },
            functions: [],
          };
          console.log('    函数组验证：跳过（目标模块没有可验证函数）');
        } else {
        const verificationHost = createAgentHost<SingleAgentFunctionGroupTerminalResult>({
          modelClient: createTranslationVerifierModelClient({
            apiKey: () => modelApiKey!,
            apiBase: process.env.DEEPSEEK_API_BASE,
            model: process.env.DEEPSEEK_MODEL,
          }),
          limits: {
            maxDurationMs: Number(process.env.TRANSLATION_VERIFIER_MAX_DURATION_MS ?? 300_000),
            maxTurns: Number(process.env.TRANSLATION_VERIFIER_MAX_TURNS ?? 32),
            // A verifier may need a compile/fix/re-run cycle.  Keep this
            // bounded, but leave enough room for one focused test file and
            // its diagnostics instead of cutting the Agent off mid-repair.
            maxToolCalls: Number(process.env.TRANSLATION_VERIFIER_MAX_TOOL_CALLS ?? 160),
            maxToolCallsPerTurn: 8,
          },
        });
        const verifyFunctionGroup = createFunctionGroupVerifier(verificationHost);
        const verificationInput: FunctionGroupVerificationInput | import('../services/translation-verifier/src/types.js').RequirementFunctionGroupVerificationInput = useTranslationVerification
          ? {
            schemaVersion: '3.1', sourceLanguage: top!.language, targetLanguage: language,
            sourceProjectPath: verifierSourceRoot!, targetProjectPath: targetRoot, requirement,
            functions: mapping.functions,
            ...(mapping.unmatchedFunctions.length ? { unmatchedFunctions: mapping.unmatchedFunctions } : {}),
          }
          : {
            schemaVersion: '3.1', mode: 'requirement', sourceLanguage: language, targetLanguage: language,
            targetProjectPath: targetRoot, requirement,
            functions: requirementFunctions.map((target) => ({ target })),
          };
        const verificationStrategy = useTranslationVerification ? 'single-agent-function-group' as const : 'requirement-function-group' as const;
        const configuredAttempts = Number(process.env.TRANSLATION_VERIFIER_MAX_ATTEMPTS ?? 5);
        const maxAttempts = Number.isInteger(configuredAttempts) && configuredAttempts >= 1 ? Math.min(configuredAttempts, 5) : 5;
        for (let verifierAttempt = 1; verifierAttempt <= maxAttempts; verifierAttempt++) {
          try {
            entry.translationVerification = await verifyFunctionGroup(verificationInput, verificationStrategy, 'verify');
          } catch (error) {
            const description = error instanceof Error ? error.message : String(error);
            const classification = classifyVerifierFailure(description);
            entry.translationVerification = {
              status: 'failure', reason: classification.reason,
              issue: { kind: classification.kind, description: `函数组验证器未能完成：${description.slice(0, 600)}` },
              functions: verificationInput.functions.map((mapping) => ({
                ...('source' in mapping ? { source: mapping.source } : {}),
                target: mapping.target, status: 'unverified' as const, executed: false,
                lineCoverage: null, branchCoverage: null, reason: classification.reason,
              })),
          };
          }
          (entry.translationVerificationAttempts ??= []).push(entry.translationVerification);
          console.log(`    #44 函数组验证第${verifierAttempt}轮：${entry.translationVerification.status}`);
          if (entry.translationVerification.status === 'success' || verifierAttempt >= maxAttempts) break;
          if (entry.translationVerification.issue?.kind === 'environment' || entry.translationVerification.reason === 'test-environment-failure') {
            console.log('    ! verifier 环境不可用，不把环境故障误交给 Translator 修改');
            break;
          }
          // A verifier Agent budget/model failure has no test evidence and
          // must not be sent to the Translator as a code defect. Retry the
          // verifier with a fresh test harness; only Host-observed test
          // failures are valid Translator feedback.
          if (entry.translationVerification.reason === 'agent-timeout' || entry.translationVerification.reason === 'model-failure') {
            console.log('    ↻ verifier Agent 未产出可用测试证据，重新启动 verifier');
            continue;
          }
          const feedback = {
            attempt: verifierAttempt,
            status: 'failure' as const,
            ...(entry.translationVerification.reason ? { reason: entry.translationVerification.reason } : {}),
            ...(entry.translationVerification.issue ? { issue: entry.translationVerification.issue } : {}),
            functions: entry.translationVerification.functions,
            ...(mapping.unmatchedFunctions.length ? { unmatchedFunctions: mapping.unmatchedFunctions } : {}),
          };
          console.log(`    ↻ verifier 失败，反馈同一 Translator 修复（第${verifierAttempt}轮）`);
          await translation.host.repairAfterVerification(run.id, feedback);
          const repairDeadline = Date.now() + Number(process.env.ADAPTATION_WORKSPACE_TIMEOUT_MS ?? 1_800_000);
          while (Date.now() < repairDeadline) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
            const polled = await translation.host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: `repair-read-${index}-${verifierAttempt}`, action: 'read', runId: run.id });
            if (polled.type !== 'WORKSPACE_TRANSLATION_RESULT' || !polled.run) throw new Error(`repair read failed: ${JSON.stringify(polled)}`);
            run = polled.run;
            activeRun = run;
            if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) break;
          }
          if (run.status !== 'completed') {
            entry.error = `verifier repair translator ${run.status}: ${run.error ?? 'unknown error'}`;
            break;
          }
          const repairedCompilation = run.compilations.at(-1);
          if (!repairedCompilation?.success) {
            entry.error = 'verifier repair completed without a successful compilation';
            break;
          }
        }
        entry.status = run.status === 'completed' ? 'completed' : 'failed';
        entry.turns = run.modelTurns;
        entry.acceptance = run.acceptance;
        entry.changedPaths = [...new Set(run.changes.map((change) => change.path))];
        entry.agent = run.agent;
        entry.plan = run.plan;
        if (entry.translationVerification?.status === 'failure' && !entry.error) {
          entry.status = 'failed';
          entry.error = `verifier remained failed after ${entry.translationVerificationAttempts?.length ?? 1} attempt(s)`;
        }
        console.log(`    #44 函数组验证：${entry.translationVerification.status}（${entry.translationVerification.functions.map((item) => `${item.target.name}:${item.executed ? 'executed' : 'unverified'}`).join(', ')}）`);
        }
      }
      if (run.error) entry.error = run.error;
      if (run.status !== 'completed' && run.events?.length) {
        entry.events = run.events.map((event) => `${event.phase}: ${event.message}`).slice(-40);
        console.log('    事件尾巴（运行时的逐轮记录）:');
        for (const line of entry.events.slice(-10)) console.log(`      ${line.slice(0, 200)}`);
      }
      entry.wallMs = Date.now() - started;
      console.log(`  ${entry.status === 'completed' ? '✓' : '✗'} ${entry.status} turns=${run.modelTurns} acceptance=${run.acceptance ?? '-'} ` +
        `files=${entry.changedPaths.join(',')} ${(entry.wallMs / 1000).toFixed(0)}s`);
      } finally {
        // Preserve the translated implementation before restoring the shared
        // target skeleton. Always attempt rollback even when snapshotting
        // fails, because a dirty workspace must never reach the next module.
        if (activeRun && translation) {
          let snapshotFailure: string | undefined;
          if (!['completed', 'failed', 'cancelled', 'interrupted', 'rolled-back'].includes(activeRun.status)) {
            try {
              const cancelled = await translation.host.handle({
                type: 'WORKSPACE_TRANSLATION', requestId: `cancel-before-rollback-${index}`, action: 'cancel', runId: activeRun.id,
              });
              if (cancelled.type === 'WORKSPACE_TRANSLATION_RESULT' && cancelled.run) activeRun = cancelled.run;
              else snapshotFailure = `无法停止仍在运行的翻译：${cancelled.type === 'WORKSPACE_TRANSLATION_ERROR' ? cancelled.message : JSON.stringify(cancelled)}`;
            } catch (error) {
              snapshotFailure = `无法先停止仍在运行的翻译：${error instanceof Error ? error.message : String(error)}`;
            }
          }
          try {
            if (!snapshotFailure) {
              entry.snapshot = await captureModuleSnapshot({
                root: targetRoot, snapshotRoot, index, module, entry, run: activeRun,
                baselineHashes: entry.baselineHashes ?? {},
              });
            }
          } catch (error) {
            snapshotFailure = error instanceof Error ? error.message : String(error);
            stopAfterRollbackFailure = true;
            entry.status = 'failed';
            entry.error = `模块 snapshot 失败：${snapshotFailure}`;
            console.log(`    ✗ ${entry.error}`);
          }
          if (snapshotFailure && !entry.error) {
            stopAfterRollbackFailure = true;
            entry.status = 'failed';
            entry.error = `模块 snapshot 失败：${snapshotFailure}`;
            console.log(`    ✗ ${entry.error}`);
          }
          try {
            const rolledBack = await translation.host.handle({
              type: 'WORKSPACE_TRANSLATION', requestId: `rollback-${index}`, action: 'rollback', runId: activeRun.id,
            });
            if (rolledBack.type !== 'WORKSPACE_TRANSLATION_RESULT' || !rolledBack.run) {
              throw new Error(`rollback failed: ${JSON.stringify(rolledBack)}`);
            }
            activeRun = rolledBack.run;
            const mismatches = await compareBaselineHashes(targetRoot, entry.baselineHashes ?? {});
            entry.rollback = {
              requested: true,
              status: rolledBack.run.status,
              restored: rolledBack.run.status === 'rolled-back' && mismatches.length === 0,
              baselineMatches: mismatches.length === 0,
              ...(mismatches.length ? { error: `rollback baseline mismatch: ${mismatches.join('; ')}` } : {}),
            };
            if (!entry.rollback.restored) throw new Error(entry.rollback.error ?? `rollback returned ${rolledBack.run.status}`);
            if (!snapshotFailure) console.log(`    ↩ 已保存 snapshot，模块已恢复骨架（${entry.snapshot?.directory}）`);
          } catch (error) {
            const description = error instanceof Error ? error.message : String(error);
            entry.rollback = { requested: true, restored: false, error: description };
            stopAfterRollbackFailure = true;
            entry.status = 'failed';
            entry.error = `模块回滚失败，已停止后续模块：${description}`;
            console.log(`    ✗ ${entry.error}`);
          }
          if (entry.snapshot) {
            try {
              const snapshotManifest = JSON.parse(readFileSync(entry.snapshot.manifest, 'utf8')) as Record<string, unknown>;
              snapshotManifest.rollback = entry.rollback;
              snapshotManifest.rollbackRecordedAt = new Date().toISOString();
              await writeFile(entry.snapshot.manifest, `${JSON.stringify(snapshotManifest, null, 2)}\n`);
            } catch (error) {
              stopAfterRollbackFailure = true;
              entry.status = 'failed';
              entry.error = `模块 snapshot manifest 更新失败：${error instanceof Error ? error.message : String(error)}`;
              console.log(`    ✗ ${entry.error}`);
            }
          }
        }
        if (verifierSourceRoot) await removeReadOnlyTree(verifierSourceRoot);
        if (historyViewRoot) await removeReadOnlyTree(historyViewRoot);
      }
    } catch (error) {
      entry.status = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
      entry.wallMs = Date.now() - started;
      console.log(`  ✗ ${entry.error.slice(0, 240)}`);
    }
    if (stopAfterRollbackFailure) {
      console.log('  ⏹ 模块 snapshot/回滚未能确认，停止后续模块以避免污染。');
      break;
    }
  }
} finally {
  codeIntelligence.dispose();
  for (const cleanup of cleanups.reverse()) await cleanup();
  await pool.end();
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
const completed = report.modules.filter((module) => module.status === 'completed').length;
const failed = report.modules.filter((module) => module.status === 'failed').length;
console.log(`\n模块 ${report.modules.length} 个：completed ${completed}，failed ${failed}，其余为 dry-run/跳过`);
console.log(`报告: ${outputPath}`);
if (failed) process.exitCode = 1;
