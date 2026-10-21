import { writeFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanRepositoryStructuralIndex } from './repository-scan.js';
import { indexTreeSitterFile } from './tree-sitter-indexer.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('scanRepositoryStructuralIndex', () => {
  it('reports snapshot verification and rejects source changed after capture', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-indexer-snapshot-verification-'));
    temporaryRoots.push(root);
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(path.join(root, `file${i}.ts`), `export const value${i} = ${i};`)));
    const progress: Array<{ stage: string; completed?: number; total?: number }> = [];
    const request = { repositoryId: 'verification', analysisRevision: 'one', repositoryRoot: root };
    const result = await scanRepositoryStructuralIndex({ ...request, onProgress: update => progress.push(update) });
    expect(result.index.files).toHaveLength(40);
    const verification = progress.filter(update => update.stage === 'snapshot-verify');
    expect(verification[0]?.completed).toBe(0);
    expect(verification[0]?.total).toBeGreaterThanOrEqual(result.index.files.length);
    expect(verification.at(-1)?.completed).toBe(verification[0]?.total);
    expect(verification.map(update => update.completed)).toEqual([...verification.map(update => update.completed)].sort((a, b) => a! - b!));
    await expect(scanRepositoryStructuralIndex({ ...request, analysisRevision: 'changed', onProgress: update => {
      if (update.stage === 'snapshot-verify' && update.completed === 0) writeFileSync(path.join(root, 'file0.ts'), 'export const changedAfterCapture = true;');
    } })).rejects.toThrow('Repository changed during source snapshot capture');
  });
  it('preserves complete and incremental indexes across background assembly and the injected parser path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-indexer-assembly-equality-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'main.ts'), 'export function sample() { return 1; }');
    await writeFile(path.join(root, 'other.ts'), 'import { sample } from "./main"; export const value = sample();');
    const request = { repositoryRoot: root, repositoryId: 'equality', analysisRevision: 'one', retainSourceTexts: false };
    const background = await scanRepositoryStructuralIndex(request);
    const injected = await scanRepositoryStructuralIndex({ ...request, indexFile: indexTreeSitterFile });
    try {
      expect(background.index).toEqual(injected.index);
      await writeFile(path.join(root, 'main.ts'), 'export function changed() { return 2; }');
      const next = { ...request, analysisRevision: 'two', previousIndex: background.index };
      const incremental = await scanRepositoryStructuralIndex(next);
      const expected = await scanRepositoryStructuralIndex({ ...next, indexFile: indexTreeSitterFile });
      try {
        expect(incremental.index).toEqual(expected.index);
        expect(incremental.stats.reusedFileCount).toBe(1);
        expect(await background.sourceReader!.read('main.ts')).toContain('sample');
        expect(await incremental.sourceReader!.read('main.ts')).toContain('changed');
      } finally { await incremental.sourceReader!.dispose(); await expected.sourceReader!.dispose(); }
    } finally { await background.sourceReader!.dispose(); await injected.sourceReader!.dispose(); }
  });

  it('keeps the host event loop responsive while the real background builder processes thousands of declarations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-indexer-assembly-responsive-'));
    temporaryRoots.push(root);
    const source = Array.from({ length: 1500 }, (_, i) => `export function sample${i}() { return ${i}; }`).join('\n');
    await Promise.all([0, 1, 2, 3].map(i => writeFile(path.join(root, `source${i}.ts`), source)));
    const fork = childProcess.fork;
    let building = false;
    let ticksWhileBuilding = 0;
    const spy = vi.spyOn(childProcess, 'fork').mockImplementation((...args) => {
      const child = fork(...args);
      if (String(args[0]).includes('structural-assembly-worker')) {
        child.on('message', (message: { type?: string }) => {
          if (message.type === 'building') building = true;
          if (message.type === 'complete') building = false;
        });
      }
      return child;
    });
    syncBuiltinESMExports();
    const timer = setInterval(() => { if (building) ticksWhileBuilding++; }, 10);
    try {
      const result = await scanRepositoryStructuralIndex({ repositoryRoot: root, repositoryId: 'responsive',
        analysisRevision: 'one', retainSourceTexts: false, isolatedParsing: false });
      try {
        expect(result.index.symbols).toHaveLength(6000);
        expect(ticksWhileBuilding).toBeGreaterThan(3);
      } finally { await result.sourceReader!.dispose(); }
    } finally {
      clearInterval(timer); spy.mockRestore(); syncBuiltinESMExports();
    }
  }, 20_000);

  it.each(['abort', 'exit'] as const)('stops background assembly and removes the immutable spool on %s', async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-indexer-assembly-stop-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'source.ts'), Array.from({ length: 5000 }, (_, i) => `export const sample${i} = ${i};`).join('\n'));
    const controller = new AbortController();
    const fork = childProcess.fork;
    let worker: ChildProcess | undefined;
    let spool = '';
    const spy = vi.spyOn(childProcess, 'fork').mockImplementation((...args) => {
      const child = fork(...args);
      if (String(args[0]).includes('structural-assembly-worker')) {
        worker = child;
        spool = path.dirname((args[1] as string[])[0]!);
        child.on('message', (message: { type?: string }) => {
          if (message.type !== 'building') return;
          if (mode === 'abort') controller.abort(new Error('assembly cancelled by test'));
          else child.kill();
        });
      }
      return child;
    });
    syncBuiltinESMExports();
    try {
      await expect(scanRepositoryStructuralIndex({ repositoryRoot: root, repositoryId: 'stop', analysisRevision: 'one',
        retainSourceTexts: false, isolatedParsing: false, signal: controller.signal }))
        .rejects.toThrow(mode === 'abort' ? 'assembly cancelled by test' : 'Structural assembly process exited');
      expect(worker).toBeDefined();
      expect(worker!.exitCode !== null || worker!.signalCode !== null).toBe(true);
      await expect(access(spool)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  }, 10_000);

  it('keeps production source bytes on disk and reports files beyond the parsing limit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-indexer-stream-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'small.ts'), 'export const original = 1;');
    await writeFile(path.join(root, 'large.ts'), 'x'.repeat(256));
    const result = await scanRepositoryStructuralIndex({ repositoryId: 'stream', analysisRevision: 'one', repositoryRoot: root,
      retainSourceTexts: false, isolatedParsing: true, maxFileBytes: 128 });
    try {
      expect(result.sourceFiles.size).toBe(0);
      expect(result.index.symbols.some((symbol) => symbol.name === 'original')).toBe(true);
      expect(result.stats.parserResources?.workers).toBe(1);
      expect(result.index.files.find((file) => file.relativePath === 'large.ts')).toMatchObject({ parseStatus: 'failed', sizeBytes: 256 });
      expect(result.index.diagnostics).toContainEqual(expect.objectContaining({ relativePath: 'large.ts', code: 'SOURCE_CONTENT_UNAVAILABLE' }));
      await writeFile(path.join(root, 'small.ts'), 'export const changed = 2;');
      expect(await result.sourceReader!.read('small.ts')).toBe('export const original = 1;');
      expect(await result.sourceReader!.read('large.ts')).toBeNull();
    } finally { await result.sourceReader!.dispose(); }
    await expect(result.sourceReader!.read('small.ts')).rejects.toThrow();
  });

  it('parses large Java input through bounded native input buffers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-indexer-java-'));
    temporaryRoots.push(root);
    const source = 'public class Large {\n' + Array.from({ length: 1200 }, (_, index) => `public int method${index}() { return ${index}; }`).join('\n') + '\n}';
    await writeFile(path.join(root, 'Large.java'), source);
    const result = await scanRepositoryStructuralIndex({ repositoryId: 'large-java', analysisRevision: 'one', repositoryRoot: root });
    expect(source.length).toBeGreaterThan(32768);
    expect(result.index.symbols).toHaveLength(1201);
    expect(result.index.diagnostics).toEqual([]);
  });

  it('captures only indexable source/manifests beneath the registered root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-indexer-scan-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"name":"scan-fixture"}');
    await writeFile(path.join(root, 'src', 'main.ts'), 'export class Main {}');
    await writeFile(path.join(root, 'node_modules', 'ignored', 'dependency.ts'), 'export class Ignored {}');
    await writeFile(path.join(root, '.git', 'hidden.ts'), 'export class Hidden {}');
    await writeFile(path.join(root, 'README.md'), 'not structural source');

    const result = await scanRepositoryStructuralIndex({
      repositoryId: 'history-scan',
      analysisRevision: 'scan-revision',
      repositoryRoot: root,
    });

    expect(result.index.files.map((file) => file.relativePath)).toEqual([
      'package.json',
      'src/main.ts',
    ]);
    expect(result.sourceFiles.get('src/main.ts')).toBe('export class Main {}');
    expect(result.index.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Main', relativePath: 'src/main.ts' }),
    ]));
    expect([...result.sourceFiles.keys()]).not.toContain('node_modules/ignored/dependency.ts');
  });
});
