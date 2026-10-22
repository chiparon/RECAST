import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import type { WorkspaceTranslationContext, WorkspaceTranslationPlan } from '@forexplore/contracts';

/** Host module records are retained for audit only, never Agent input. */
export interface ProjectIntegrationModule {
  moduleId: string;
  module: string;
  status: string;
  sourceFiles: string[];
  changedPaths?: string[];
  plan?: WorkspaceTranslationPlan;
  error?: string;
  stoppedEarly?: string;
  verificationDisposition?: string;
  functionMapping?: {
    unmatchedFunctions: Array<{ path: string; name: string }>;
    diagnostics: Array<{ targetApi: string; reason: string }>;
  };
  translationVerification?: ProjectIntegrationVerification;
  translationVerificationAttempts?: ProjectIntegrationVerification[];
}

interface ProjectIntegrationVerification {
  status: string;
  reason?: string;
  issue?: { kind: string; description: string };
  functions: Array<{ target: { path: string; name: string }; status: string; executed: boolean; reason?: string }>;
  protocolChecks?: Array<{ ruleId: string; status: string; testName?: string; note?: string }>;
  /** Host-owned execution failures and test revisions; preserved without reinterpreting their schema. */
  testEvidence?: unknown;
}

const productionExtensions = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.cs', '.fs', '.go', '.h', '.hpp', '.java', '.js', '.jsx',
  '.kt', '.kts', '.mjs', '.py', '.rb', '.rs', '.swift', '.ts', '.tsx',
]);
const ignoredDirectories = new Set([
  '.git', '.forexpore', '.forexplore', '.translation-verifier-tests', '.translation-verifier-coverage',
  '.agent-tmp', '.codex', '.claude', 'node_modules', 'bin', 'obj', 'dist', 'build', 'out',
  'target', 'coverage', 'test', 'tests', '__tests__', 'evaluation', 'results', '__pycache__', '.venv', 'venv',
]);
const privateFiles = new Set(['.env', '.npmrc', 'id_rsa', 'id_ed25519']);

/** New production files share the existing source root and language. Public
 * requirements/build files remain protected; temporary tests stay in scratch. */
export function isNewProjectIntegrationSource(path: string, existingSources: readonly string[]): boolean {
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || ignoredDirectories.has(part.toLowerCase()))) return false;
  if (/(?:\.test|\.spec)\.[^.]+$/i.test(path) || /(?:^|[._-])tests?(?:[._-]|$)/i.test(parts.at(-1)!)) return false;
  const extensions = new Set(existingSources.map(file => extname(file).toLowerCase()));
  if (!productionExtensions.has(extname(path).toLowerCase()) || !extensions.has(extname(path).toLowerCase())) return false;
  const root = existingSources[0]?.split('/').slice(0, -1) ?? [];
  for (const file of existingSources.slice(1)) {
    const directory = file.split('/').slice(0, -1);
    while (root.length && root.some((part, index) => directory[index] !== part)) root.pop();
  }
  return root.every((part, index) => parts[index] === part) && parts.length > root.length;
}

/** Complete production inventory; no module ownership or failure keyword
 * filter narrows the Integration Agent's observations or repair scope. */
export async function prepareProjectIntegrationContext(root: string, modules: readonly ProjectIntegrationModule[] = []): Promise<{
  writeFiles: string[]; readOnlyFiles: string[]; requirement: string; context: WorkspaceTranslationContext[];
}> {
  root = await realpath(root);
  const writeFiles: string[] = [];
  const readOnlyFiles: string[] = [];
  const requirements: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const lower = entry.name.toLowerCase();
      if (ignoredDirectories.has(lower) || lower.startsWith('.forexpore') || lower.startsWith('.forexplore') ||
          privateFiles.has(lower) || lower.startsWith('.env.') || lower.endsWith('.pem') || lower.endsWith('.key')) continue;
      if (entry.isDirectory()) { await visit(join(directory, entry.name), path); continue; }
      // Symlinks are not exposed. Hidden/test artifacts are never a source of
      // evidence, including files colocated with production source.
      if (!entry.isFile() || /(?:\.test|\.spec)\.[^.]+$/i.test(lower) || /(?:^|[._-])tests?(?:[._-]|$)/i.test(lower)) continue;
      if ((await stat(join(directory, entry.name))).size > 2 * 1024 * 1024) continue;
      if (productionExtensions.has(extname(lower))) writeFiles.push(path);
      else if (/\.(?:csproj|fsproj|sln|slnx|gradle|groovy|json|md|props|toml|xml|ya?ml)$/.test(lower)) readOnlyFiles.push(path);
      if (/^requirements\/.+\.md$/i.test(path)) requirements.push(`### ${path}\n${await readFile(join(directory, entry.name), 'utf8')}`);
    }
  }
  await visit(root, '');
  if (!writeFiles.length) throw new Error('Project integration requires production source files.');
  // Keep prior plans and verification observations in the Host audit archive.
  // Integration independently reviews current source against public requirements.
  if (modules.length) {
    const rawEvidence = modules.map(module => ({ moduleId: module.moduleId, module: module.module,
      status: module.status, error: module.error, stoppedEarly: module.stoppedEarly,
      verificationDisposition: module.verificationDisposition,
      ...(module.translationVerification ? { verification: module.translationVerification } : {}),
      ...(module.translationVerificationAttempts?.length ? { attempts: module.translationVerificationAttempts } : {}),
      ...(module.functionMapping ? { functionMapping: { unmatchedFunctions: module.functionMapping.unmatchedFunctions,
        diagnostics: module.functionMapping.diagnostics } } : {}),
    }));
    const original = JSON.stringify({ schemaVersion: 1, modules: rawEvidence,
      plans: modules.map(module => ({ moduleId: module.moduleId, plan: module.plan })) });
    const digest = createHash('sha256').update(original).digest('hex');
    const archivePath = join(root, '.forexplore', 'integration-input-evidence', digest + '.json');
    await mkdir(join(root, '.forexplore', 'integration-input-evidence'), { recursive: true });
    try { await writeFile(archivePath, original, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (createHash('sha256').update(await readFile(archivePath)).digest('hex') !== digest) throw new Error('Integration Host audit archive hash mismatch.');
    }
  }
  const publicRequirements = requirements.join('\n\n');
  const requirement = [
    '# Project integration pass',
    'Review the complete assembled production project independently against its public requirements. Trace public entry points through policies, ports, adapters and composition, repair discovered gaps, and preserve public APIs and build settings.',
    'Derive expected behavior from cited public requirement passages and declared public contracts. Distinguish explicit guarantees from assumptions or ambiguity. Global Protocol entries are shared claims to review against those sources.',
    'Create and run your own temporary integration checks under .agent-tmp/integration-checks/. Exercise real call chains, positive and negative cases, required state preconditions, identity and authorization boundaries, repeated operations and retries, time boundaries, concurrency and dependency failures where applicable. Record actual commands, results, unexecuted cases and remaining uncertainty; compilation and green helper suites alone do not prove complete behavior.',
    'All listed production sources may be repaired and compatible production sources may be added under the existing source root. Public requirements and build settings remain read-only.',
    `## Public requirements\n${publicRequirements.length <= 48_000
      ? publicRequirements || 'Read the project README and public source contracts.'
      : 'Read every document listed below directly; complete public text is available in the workspace.\n' + readOnlyFiles.filter(path => /^requirements\//i.test(path)).join('\n')}`,
    `## Public build and test entry files\n${readOnlyFiles.filter(path => /(?:^|\/)(?:pom\.xml|package\.json|Cargo\.toml|build\.gradle(?:\.kts)?|gradle\.properties|pyproject\.toml|Makefile)$|\.(?:csproj|fsproj|sln|slnx)$/i.test(path)).join('\n') || 'Inspect the public build configuration in the project.'}`,
  ].join('\n\n');
  const context: WorkspaceTranslationContext[] = [];
  // Preserve existing spec/context and transport limits. Complete large public
  // requirement documents remain available as read-only workspace files.
  if (requirement.length > 64_000 || context.reduce((total, item) => total + item.content.length, requirement.length) > 512_000 ||
      Buffer.byteLength(JSON.stringify(context)) > 1536 * 1024) throw new Error('Integration public input exceeds the existing bounded input budget.');
  return { writeFiles, readOnlyFiles, requirement, context };
}

/** Agent-authored evidence is retained for review, never treated as a Host
 * verdict or fed into another development Agent as new requirements. */
export async function collectProjectIntegrationEvidence(stagingRoot: string): Promise<{
  files: Array<{ path: string; content: string; truncated: boolean }>;
  omissions: string[];
}> {
  const files: Array<{ path: string; content: string; truncated: boolean }> = [];
  const omissions: string[] = [];
  const evidenceRoot = join(stagingRoot, '.agent-tmp', 'integration-checks');
  let remainingBytes = 256 * 1024;
  try {
    // Do not follow even the scratch root through a symlink.
    for (const path of [join(stagingRoot, '.agent-tmp'), evidenceRoot]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return { files, omissions: ['Integration evidence directory is not a regular directory.'] };
    }
  } catch { return { files, omissions: ['No integration-checks evidence directory was recorded.'] }; }
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (files.length >= 32 || remainingBytes <= 0) { omissions.push('Evidence budget reached; additional files omitted.'); return; }
      if (entry.isSymbolicLink()) { omissions.push(`${path}: symlink omitted`); continue; }
      if (entry.isDirectory()) { await visit(join(directory, entry.name), path); continue; }
      if (!entry.isFile() || !(productionExtensions.has(extname(path).toLowerCase()) || /\.(?:md|log|txt|json|sh|ps1)$/i.test(path))) continue;
      const absolute = join(directory, entry.name);
      if ((await stat(absolute)).size > 2 * 1024 * 1024) { omissions.push(`${path}: oversized evidence omitted`); continue; }
      const bytes = await readFile(absolute);
      const limit = Math.min(productionExtensions.has(extname(path).toLowerCase()) ? 128 * 1024 : 64 * 1024, remainingBytes);
      files.push({ path: `.agent-tmp/integration-checks/${path}`, content: bytes.subarray(0, limit).toString('utf8'), truncated: bytes.length > limit });
      remainingBytes -= Math.min(bytes.length, limit);
    }
  }
  await visit(evidenceRoot);
  return { files, omissions };
}
