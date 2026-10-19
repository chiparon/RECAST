import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCodexCommand } from './codex-command';

describe('Codex command launch', () => {
  it('runs a Node entry point through Node on either platform', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(await resolveCodexCommand('agent.mjs', { cwd: tmpdir(), environment: {}, platform }))
        .toEqual({ executable: process.execPath, args: [resolve(tmpdir(), 'agent.mjs')] });
    }
  });

  it('preserves native Unix commands', async () => {
    expect(await resolveCodexCommand('codex', { cwd: tmpdir(), environment: {}, platform: 'linux' }))
      .toEqual({ executable: 'codex', args: [] });
  });

  it.each(['global', 'local'] as const)('resolves the %s Windows npm shim without a command shell', async layout => {
    const root = await mkdtemp(join(tmpdir(), 'codex-launch-'));
    try {
      const directory = layout === 'global' ? root : join(root, 'node_modules', '.bin');
      const entry = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      await mkdir(directory, { recursive: true });
      await mkdir(dirname(entry), { recursive: true });
      await writeFile(join(directory, 'codex.cmd'), 'npm shim');
      await writeFile(entry, 'process.exit(0)');
      const expected = { executable: process.execPath, args: [resolve(entry)] };
      expect(await resolveCodexCommand('codex', { cwd: tmpdir(), environment: { Path: directory }, platform: 'win32' }))
        .toEqual(expected);
      expect(await resolveCodexCommand(join(directory, 'codex.cmd'), { cwd: tmpdir(), environment: {}, platform: 'win32' }))
        .toEqual(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('prefers a native Windows Codex executable on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-native-'));
    try {
      const executable = join(root, 'codex.exe');
      await writeFile(executable, 'native fixture');
      expect(await resolveCodexCommand('codex', { cwd: tmpdir(), environment: { PATH: root }, platform: 'win32' }))
        .toEqual({ executable, args: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
