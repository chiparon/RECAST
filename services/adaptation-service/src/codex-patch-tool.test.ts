import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveCodexCommand } from './codex-command';
import { codexPatchToolFile, writeCodexPatchTool } from './codex-patch-tool';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'recast patch 空格-')); roots.push(root);
  await mkdir(join(root, '.agent-tmp'));
  await mkdir(join(root, 'target'));
  return root;
}
const patch = '*** Begin Patch\n*** Add File: target/文件 name.cs\n+public const string Text = "租户 \\ path $value `tick";\n*** End Patch';

it('preserves patch bytes across the actual platform shell and a Node CLI launcher', async () => {
  const root = await fixture();
  const cli = join(root, 'capture.cjs');
  await writeFile(cli, "require('node:fs').writeFileSync('captured.txt', process.argv[3]);");
  await writeCodexPatchTool(root, { executable: process.execPath, args: [cli] });
  await writeFile(join(root, 'change.patch'), '\uFEFF' + patch.replaceAll('\n', '\r\n') + '\r\n');
  const script = process.platform === 'win32' ? join(root, 'invoke.ps1') : join(root, 'invoke.sh');
  const quote = (value: string) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : `'"'"'`)}'`;
  await writeFile(script, `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${codexPatchToolFile} change.patch\n${process.platform === 'win32' ? 'exit $LASTEXITCODE' : ''}`);
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-File', script], { cwd: root, encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', [script], { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(join(root, 'captured.txt'), 'utf8')).toBe(patch);
});

it('retains the real patch failure and nonzero exit code for diagnosis', async () => {
  const root = await fixture();
  const cli = join(root, 'failure.cjs');
  await writeFile(cli, "process.stderr.write('Failed to find expected lines: original context');process.exitCode=17;");
  await writeCodexPatchTool(root, { executable: process.execPath, args: [cli] });
  await writeFile(join(root, 'change.patch'), patch);
  const result = spawnSync(process.execPath, [codexPatchToolFile, 'change.patch'], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(17);
  expect(JSON.parse(await readFile(join(root, '.agent-tmp/recast-patch-results.jsonl'), 'utf8'))).toMatchObject({ exitCode: 17, error: expect.stringContaining('original context') });
});

it.runIf(process.env.RECAST_CODEX_NATIVE_TEST === '1')('applies quoted Unicode source through the installed Codex patch engine', async () => {
  const root = await fixture();
  const launcher = await resolveCodexCommand(process.env.RECAST_CODEX_COMMAND || 'codex', { cwd: root, environment: process.env });
  await writeCodexPatchTool(root, launcher);
  await writeFile(join(root, 'change.patch'), patch);
  const result = spawnSync(process.execPath, [codexPatchToolFile, 'change.patch'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(join(root, 'target/文件 name.cs'), 'utf8')).toBe('public const string Text = "租户 \\ path $value `tick";\n');
});
