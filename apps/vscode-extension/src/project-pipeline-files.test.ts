// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { projectPipelineMarkdown } from './project-pipeline';
import { ProjectPipelineFiles } from './project-pipeline-files';
import type { ProjectPipelineRun } from './project-pipeline-types';

vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
const renameMock = vi.mocked(rename);
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const run: ProjectPipelineRun = {
  id: randomUUID(), repositoryId: 'repo', projectId: 'project', analysisRevision: 'rev',
  projectName: 'initial', requirement: 'build', stage: 'modeling', status: 'running',
  createdAt: '', updatedAt: '', modules: [], events: [], acceptance: 'unverified', reportAvailable: false,
};
let root: string, files: ProjectPipelineFiles;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'recast-pipeline-save-'));
  files = new ProjectPipelineFiles(root);
  renameMock.mockReset();
  await files.save(run);
  renameMock.mockClear();
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', originalPlatform);
  await rm(root, { recursive: true, force: true });
});

it.each([['EPERM', 'acceptance-report.md'], ['EBUSY', 'run.json']])(
  'atomically retries the same snapshot on Windows %s replacing %s', async (code, name) => {
    const next = { ...run, projectName: 'updated' };
    const directory = files.directory(run.id), target = path.join(directory, name);
    const old = await readFile(target, 'utf8');
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let locked = true;
    renameMock.mockImplementation(async (from, to) => {
      if (locked && to === target) {
        locked = false;
        expect(await readFile(target, 'utf8')).toBe(old);
        throw Object.assign(new Error('temporary sharing violation'), { code });
      }
      return real.rename(from, to);
    });
    await files.save(next);
    const attempts = renameMock.mock.calls.filter(([, to]) => to === target);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'))).toEqual(next);
    expect(await readFile(path.join(directory, 'acceptance-report.md'), 'utf8')).toBe(projectPipelineMarkdown(next));
  });

it('preserves the last report and rejects after persistent Windows sharing violations', async () => {
  const directory = files.directory(run.id), target = path.join(directory, 'acceptance-report.md');
  const previous = await readFile(target, 'utf8'), locked = Object.assign(new Error('still locked'), { code: 'EPERM' });
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  renameMock.mockImplementation(async (from, to) => {
    if (to === target) throw locked;
    return real.rename(from, to);
  });
  await expect(files.save({ ...run, projectName: 'updated' })).rejects.toBe(locked);
  expect(renameMock.mock.calls.filter(([, to]) => to === target)).toHaveLength(6);
  expect(await readFile(target, 'utf8')).toBe(previous);
  expect((await readdir(directory)).sort()).toEqual(['acceptance-report.md', 'run.json']);
});
