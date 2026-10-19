import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncWorktrees } from './sync-platform-worktrees.mjs';

function write(root, file, text) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'recast-platform-sync-'));
  const source = path.join(base, 'windows'); const target = path.join(base, 'wsl');
  mkdirSync(source);
  const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git(['init', '-q']); git(['config', 'core.autocrlf', 'false']);
  git(['config', 'user.email', 'sync-test@example.invalid']); git(['config', 'user.name', 'Sync test']);
  write(source, '.gitignore', 'node_modules/\ndist/\n.recast-platform*.json\n.env\n');
  write(source, 'services/a.js', 'export const value = 1;\n');
  write(source, 'services/b.js', 'export const other = 1;\n');
  write(source, 'package.json', '{"private":true}\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  git(['worktree', 'add', '--detach', target, 'HEAD']);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { source, target };
}

test('copies current uncommitted source in both directions', t => {
  const { source, target } = fixture(t);
  write(source, 'services/a.js', 'export const value = 2;\n');
  write(source, 'scripts/new.mjs', 'console.log(1);\n');
  syncWorktrees(source, target);
  assert.equal(readFileSync(path.join(target, 'services/a.js'), 'utf8'), 'export const value = 2;\n');
  assert.equal(readFileSync(path.join(target, 'scripts/new.mjs'), 'utf8'), 'console.log(1);\n');
  write(target, 'services/a.js', 'export const value = 3;\n');
  syncWorktrees(target, source);
  assert.equal(readFileSync(path.join(source, 'services/a.js'), 'utf8'), 'export const value = 3;\n');
});

test('preserves destination edits and stops before any write on conflict', t => {
  const { source, target } = fixture(t);
  syncWorktrees(source, target);
  write(target, 'services/a.js', 'destination edit\n');
  assert.equal(syncWorktrees(source, target).targetOnly, 1);
  assert.equal(readFileSync(path.join(target, 'services/a.js'), 'utf8'), 'destination edit\n');
  write(source, 'services/a.js', 'source edit\n');
  write(source, 'services/b.js', 'should not be copied\n');
  assert.throws(() => syncWorktrees(source, target), /services\/a.js/);
  assert.equal(readFileSync(path.join(target, 'services/b.js'), 'utf8'), 'export const other = 1;\n');
});

test('keeps dependency binaries, build output and credentials out of synchronization', t => {
  const { source, target } = fixture(t);
  write(source, 'node_modules/native.node', 'WINDOWS'); write(target, 'node_modules/native.node', 'LINUX');
  write(source, 'dist/extension.js', 'WINDOWS'); write(target, 'dist/extension.js', 'LINUX');
  write(source, '.env', 'credential');
  write(source, 'services/obj/generated.json', 'generated');
  syncWorktrees(source, target);
  assert.equal(readFileSync(path.join(target, 'node_modules/native.node'), 'utf8'), 'LINUX');
  assert.equal(readFileSync(path.join(target, 'dist/extension.js'), 'utf8'), 'LINUX');
  assert.equal(existsSync(path.join(target, '.env')), false);
  assert.equal(existsSync(path.join(target, 'services/obj/generated.json')), false);
});

test('normalizes CRLF in the Linux checkout without corrupting binary files', t => {
  const { source, target } = fixture(t);
  write(source, 'services/a.js', 'export const value = 1;\r\n');
  write(source, 'services/image.dat', Buffer.from([255, 13, 10, 254]));
  syncWorktrees(source, target, { normalizeLineEndings: true });
  assert.equal(readFileSync(path.join(target, 'services/a.js'), 'utf8'), 'export const value = 1;\n');
  assert.deepEqual(readFileSync(path.join(target, 'services/image.dat')), Buffer.from([255, 13, 10, 254]));
});

test('dry run writes nothing, and deletions follow the source only when safe', t => {
  const { source, target } = fixture(t);
  rmSync(path.join(source, 'services/a.js'));
  assert.equal(syncWorktrees(source, target, { dryRun: true }).updated, 1);
  assert.equal(existsSync(path.join(target, 'services/a.js')), true);
  assert.equal(existsSync(path.join(source, '.recast-platform-sync.json')), false);
  syncWorktrees(source, target);
  assert.equal(existsSync(path.join(target, 'services/a.js')), false);
});

test('reports manifest updates that require a destination install', t => {
  const { source, target } = fixture(t);
  write(source, 'package.json', '{"private":true,"version":"1.0.0"}\n');
  assert.equal(syncWorktrees(source, target).dependenciesChanged, true);
});


test('excludes historical experiment outputs and caches, including old baseline entries', t => {
  const { source, target } = fixture(t);
  const run = 'experiments/enterprise-asset-upgrade/history-isolated-java-repeat2-20261012';
  write(source, `${run}/runs/generated.java`, 'generated source');
  write(source, `${run}/maven-cache-seed/dependency.jar`, 'runtime cache');
  write(source, `${run}/skeleton/source.java`, 'run snapshot');
  write(target, `${run}/runs/generated.java`, 'destination output');
  write(source, 'experiments/enterprise-asset-upgrade/java-target-project/Source.java', 'dataset source');
  write(source, 'experiments/cross-language-module-retrieval-50/targets/Source.java', 'new dataset');
  const baseline = { version: 1, roots: [source, target], files: { [`${run}/runs/generated.java`]: null } };
  for (const root of [source, target]) write(root, '.recast-platform-sync.json', JSON.stringify(baseline));
  syncWorktrees(source, target);
  assert.equal(readFileSync(path.join(target, `${run}/runs/generated.java`), 'utf8'), 'destination output');
  assert.equal(existsSync(path.join(target, `${run}/maven-cache-seed/dependency.jar`)), false);
  assert.equal(existsSync(path.join(target, `${run}/skeleton/source.java`)), false);
  assert.equal(readFileSync(path.join(target, 'experiments/enterprise-asset-upgrade/java-target-project/Source.java'), 'utf8'), 'dataset source');
  assert.equal(readFileSync(path.join(target, 'experiments/cross-language-module-retrieval-50/targets/Source.java'), 'utf8'), 'new dataset');
});
