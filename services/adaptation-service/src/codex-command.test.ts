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
      // Keep unrelated installations in ancestor node_modules out of this
      // fixture: this platform package deliberately has no native binary.
      const platformRoot = join(root, 'node_modules', '@openai', `codex-win32-${process.arch}`);
      await mkdir(platformRoot, { recursive: true });
      await writeFile(join(platformRoot, 'package.json'), '{}');
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

  it.each([
    { layout: 'nested', arch: 'x64' },
    { layout: 'hoisted', arch: 'x64' },
    { layout: 'legacy', arch: 'x64' },
    { layout: 'nested', arch: 'arm64' },
  ])('bypasses the npm JS launcher for $layout / $arch native installs', async ({ layout, arch }) => {
    const root = await mkdtemp(join(tmpdir(), 'codex-native-npm-'));
    try {
      const packageRoot = join(root, 'node_modules', '@openai', 'codex');
      const entry = join(packageRoot, 'bin', 'codex.js');
      const platformRoot = layout === 'nested'
        ? join(packageRoot, 'node_modules', '@openai', `codex-win32-${arch}`)
        : join(root, 'node_modules', '@openai', `codex-win32-${arch}`);
      const vendorRoot = join(layout === 'legacy' ? packageRoot : platformRoot, 'vendor');
      const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
      const executable = join(vendorRoot, target, 'bin', 'codex.exe');
      await mkdir(dirname(entry), { recursive: true });
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(join(root, 'codex.cmd'), 'npm shim');
      await writeFile(entry, 'throw new Error("The JS launcher would open a console window")');
      await writeFile(executable, 'native fixture');
      if (layout !== 'legacy') {
        await writeFile(join(platformRoot, 'package.json'), JSON.stringify({ name: `@openai/codex-win32-${arch}` }));
      }
      const expected = { executable, args: [] };
      expect(await resolveCodexCommand('codex', { cwd: root, environment: { PATH: root }, platform: 'win32', arch }))
        .toEqual(expected);
      expect(await resolveCodexCommand(join(root, 'codex.cmd'), { cwd: root, environment: {}, platform: 'win32', arch }))
        .toEqual(expected);
      // Local .bin shims must use the same direct executable.
      const localBin = join(root, 'node_modules', '.bin');
      await mkdir(localBin, { recursive: true });
      await writeFile(join(localBin, 'codex.cmd'), 'npm shim');
      expect(await resolveCodexCommand('codex', { cwd: root, environment: { Path: localBin }, platform: 'win32', arch }))
        .toEqual(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
