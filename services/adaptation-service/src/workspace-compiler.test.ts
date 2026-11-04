import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compileWorkspace, validateWorkspaceCompileCommand } from './workspace-compiler';

it('executes the retained-test replay command with the pipeline two-hour budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recast-replay-budget-'));
  try {
    const result = await compileWorkspace(root, { executable: process.execPath,
      args: ['-e', 'console.log("replay finished")'], timeoutMs: 2 * 60 * 60 * 1000 }, new AbortController().signal);
    expect(result.success).toBe(true);
    expect(result.output).toContain('replay finished');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([999, 7_200_001, NaN, Infinity, 1000.5])('rejects invalid execution deadline %s', timeoutMs => {
  expect(() => validateWorkspaceCompileCommand({ executable: process.execPath, args: [], timeoutMs })).toThrow('timeoutMs');
});
