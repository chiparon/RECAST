#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stateFile = '.recast-platform-sync.json';
const areas = ['apps', 'packages', 'services', 'scripts', 'docs', 'tests', 'tooling', 'fixtures', 'experiments', 'web', '.github', '.claude'];
const excluded = new Set(['node_modules', 'dist', 'bin', 'obj', 'target', 'coverage', 'results', 'results_副本', 'output', 'tmp', '__pycache__', '.git', '.forexplore', '.forexpore', '.recast-build', '.translation-verifier-tests', '.translation-verifier-coverage', '.vscode-test', '.vscode-test-user', '.apikey', '.codex', 'source-repositories', 'reference-sources']);

function included(file) {
  const parts = file.split('/');
  // These dated directories contain experiment runs, snapshots and Maven caches.
  const historicalRun = /^experiments\/enterprise-asset-upgrade\/(?:full-coverage|history-assisted|history-blocked|history-isolated|no-history)-java(?:-[^/]+)?-\d{8}\//.test(file);
  return !historicalRun && !parts.some(part => excluded.has(part)) &&
    !/\.(?:log|vsix|zip|pyc)$/.test(file) && !parts.some(part => part === '.env' || part.startsWith('.env.') && part !== '.env.example') &&
    !file.startsWith('.recast-platform') && file !== '.claude/settings.local.json';
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
}

function inventory(root) {
  // ls-files reads Git's inventory; it does not walk ignored model caches or dependencies.
  const tracked = git(root, ['ls-files', '-z']).toString().split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...areas, '*.json', '*.mjs', '*.md', '*.sh', '*.ps1']).toString().split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter(included);
}

function checkedPath(root, file) {
  if (path.isAbsolute(file) || file.split('/').some(part => part === '..' || !part)) throw new Error(`Unsafe path: ${file}`);
  const result = path.join(root, file);
  let current = root;
  for (const part of file.split('/')) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink is excluded from synchronization: ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

function content(root, file) {
  const full = checkedPath(root, file);
  try { return readFileSync(full); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function normalized(bytes) {
  return bytes && !bytes.includes(0) && isUtf8(bytes) ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')) : bytes;
}

function hash(bytes) {
  return bytes === null ? null : createHash('sha256').update(normalized(bytes)).digest('hex');
}

function loadState(root) {
  const file = path.join(root, stateFile);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

function writeAtomic(file, bytes, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.recast-sync-${process.pid}`;
  writeFileSync(temporary, bytes, { mode });
  renameSync(temporary, file);
}

export function syncWorktrees(source, target, { dryRun = false, normalizeLineEndings = false } = {}) {
  source = realpathSync(source); target = realpathSync(target);
  if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep)) throw new Error('Source and target must be separate workspaces.');
  const head = git(source, ['rev-parse', 'HEAD']).toString().trim();
  if (git(target, ['rev-parse', 'HEAD']).toString().trim() !== head) {
    throw new Error('两个 worktree 的 Git HEAD 不一致；先通过 Git 合并/同步提交，再同步未提交源码。');
  }
  const sourceState = loadState(source);
  const targetState = loadState(target);
  if (Boolean(sourceState) !== Boolean(targetState) || sourceState && JSON.stringify(sourceState) !== JSON.stringify(targetState)) {
    throw new Error('同步基线不一致，已停止；请保留两边改动并检查 .recast-platform-sync.json。');
  }
  const state = sourceState;
  if (state && (!state.roots.includes(source) || !state.roots.includes(target))) throw new Error('同步基线属于其他工作目录。');
  const tree = new Map(git(source, ['ls-tree', '-rz', 'HEAD']).toString().split('\0').filter(Boolean).map(entry => {
    const [metadata, file] = entry.split('\t');
    const [mode, , oid] = metadata.split(' ');
    return [file, { mode, oid }];
  }));
  const files = [...new Set([...inventory(source), ...inventory(target), ...Object.keys(state?.files ?? {})])].filter(included).sort();
  const next = {};
  const writes = [];
  const conflicts = [];
  let targetOnly = 0;
  for (const file of files) {
    const from = content(source, file);
    const to = content(target, file);
    const sourceHash = hash(from); const targetHash = hash(to);
    if (sourceHash === targetHash) {
      next[file] = sourceHash;
      // The Linux checkout keeps LF endings even when Windows checks out CRLF.
      if (to && normalizeLineEndings && !to.equals(normalized(to))) writes.push({ file, bytes: normalized(to) });
      continue;
    }
    const metadata = tree.get(file);
    const baseline = state && Object.hasOwn(state.files, file) ? state.files[file]
      : metadata ? hash(git(source, ['cat-file', 'blob', metadata.oid])) : null;
    if (targetHash !== baseline) {
      if (sourceHash === baseline) { next[file] = baseline; targetOnly++; continue; }
      conflicts.push(file); continue;
    }
    next[file] = sourceHash;
    writes.push({ file, bytes: normalizeLineEndings ? normalized(from) : from });
  }
  if (conflicts.length) throw new Error(`两边同时修改了以下文件，已停止，未同步任何文件：\n${conflicts.join('\n')}`);
  const result = { source, target, files: files.length, updated: writes.length, targetOnly, dependenciesChanged: writes.some(item => /(^|\/)package(?:-lock)?\.json$/.test(item.file)), dryRun };
  if (dryRun) return result;
  // Recheck planned changes before touching the destination.
  for (const item of writes) item.before = hash(content(target, item.file));
  for (const item of writes) {
    if (hash(content(target, item.file)) !== item.before) throw new Error(`目标文件在同步期间变化：${item.file}`);
    const full = checkedPath(target, item.file);
    if (item.bytes === null) rmSync(full);
    else writeAtomic(full, item.bytes, tree.get(item.file)?.mode === '100755' ? 0o755 : 0o644);
  }
  const saved = { version: 1, roots: state?.roots ?? [source, target], head, files: next };
  for (const root of [source, target]) writeAtomic(path.join(root, stateFile), JSON.stringify(saved, null, 2) + '\n', 0o600);
  return result;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(readFileSync(path.join(root, '.recast-platforms.json'), 'utf8'));
  const args = process.argv.slice(2);
  const destination = args[args.indexOf('--to') + 1];
  if (!args.includes('--to') || !['windows', 'wsl'].includes(destination) || args.some(arg => !['--to', 'windows', 'wsl', '--dry-run'].includes(arg))) {
    throw new Error('Usage: npm run workspace:sync -- --to wsl|windows [--dry-run]');
  }
  if (process.platform === 'win32') {
    // Linux owns this operation so its /home worktree and the /mnt drive are both accessible.
    const command = ['--distribution', config.wslDistribution, '--cd', config.windowsMountRoot, '--exec', 'node', 'scripts/sync-platform-worktrees.mjs', ...args];
    const child = spawnSync('wsl.exe', command, { stdio: 'inherit', shell: false });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  const source = destination === 'wsl' ? config.windowsMountRoot : config.wslRoot;
  const target = destination === 'wsl' ? config.wslRoot : config.windowsMountRoot;
  const result = syncWorktrees(source, target, { dryRun: args.includes('--dry-run'), normalizeLineEndings: destination === 'wsl' });
  console.log(`${result.dryRun ? 'Dry run' : 'Source synchronized'}: ${result.source} → ${result.target}`);
  console.log(`${result.updated} files updated; ${result.targetOnly} destination edits preserved. node_modules and dist are excluded.`);
  if (result.dependenciesChanged) console.log(`依赖清单已变化，请在目标平台目录 ${target} 执行 npm ci。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
