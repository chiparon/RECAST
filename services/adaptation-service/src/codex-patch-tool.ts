import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const codexPatchToolFile = 'RECAST_APPLY_PATCH.cjs';

/** Keep patch text out of PowerShell/.cmd argument parsing. Codex still applies the diff. */
export async function writeCodexPatchTool(root: string, launcher: { executable: string; args: string[] }): Promise<string> {
  const source = `const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const launcher = ${JSON.stringify(launcher)};
const root = __dirname;
const started = Date.now();
let status = 1, stderr = '', stdout = '';
try {
  if (process.argv.length !== 3) throw new Error('Usage: RECAST_APPLY_PATCH.cjs <UTF-8 patch file>');
  const file = path.resolve(root, process.argv[2]);
  const relative = path.relative(root, file);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('Patch file must be inside staging.');
  const bytes = fs.readFileSync(file);
  const patch = bytes.toString('utf8').replace(/^\\uFEFF/, '').replace(/\\r\\n/g, '\\n').trimEnd();
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes) || patch.includes('\\0')) throw new Error('Patch file must be UTF-8 text.');
  if (!patch.startsWith('*** Begin Patch\\n') || !patch.endsWith('\\n*** End Patch')) throw new Error('Patch must have Begin Patch and End Patch markers.');
  if (process.platform === 'win32' && patch.length + JSON.stringify(launcher).length > 24000) throw new Error('Patch exceeds the Windows argument budget. Split it into focused patches below 20000 characters.');
  // Windows restricted-token processes cannot always create libuv named pipes.
  // File descriptors keep the transport shell-free without requiring those pipes.
  const scratch = path.join(root, '.agent-tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const prefix = path.join(scratch, 'patch-' + require('node:crypto').randomUUID());
  const outFile = prefix + '.stdout', errFile = prefix + '.stderr';
  const out = fs.openSync(outFile, 'wx', 0o600), err = fs.openSync(errFile, 'wx', 0o600);
  let result;
  try {
    result = spawnSync(launcher.executable, [...launcher.args, '--codex-run-as-apply-patch', patch], {
      cwd: root, shell: false, windowsHide: true, timeout: 30000, stdio: ['ignore', out, err],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  status = result.status ?? 1;
  stdout = fs.readFileSync(outFile, 'utf8');
  stderr = fs.readFileSync(errFile, 'utf8') + (result.error ? '\\n' + result.error.message : '');
  fs.unlinkSync(outFile); fs.unlinkSync(errFile);
} catch (error) { stderr = error.message; }
try {
  fs.mkdirSync(path.join(root, '.agent-tmp'), { recursive: true });
  fs.appendFileSync(path.join(root, '.agent-tmp', 'recast-patch-results.jsonl'), JSON.stringify({
    exitCode: status, durationMs: Date.now() - started, error: status === 0 ? '' : stderr.slice(-4000)
  }) + '\\n');
} catch (error) { stderr += '\\nCould not retain patch diagnostics: ' + error.message; status = 1; }
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr + '\\n');
process.exitCode = status;
`;
  await writeFile(join(root, codexPatchToolFile), source, { mode: 0o444 });
  return source;
}

export function codexPatchInstructions(): string {
  const quote = (value: string) => process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${codexPatchToolFile} .agent-tmp/change.patch`;
  return `Host patch entry: write a UTF-8 patch file under .agent-tmp/, then run ${command}. ` +
    'Use this entry for shell-based patching; it preserves quotes, Unicode and newlines without PowerShell/.bat argument conversion. ' +
    'The file must contain the usual *** Begin Patch / *** End Patch diff. Use focused patches below 20000 characters. ' +
    'The native apply_patch tool may also be used if exposed directly. Do not invoke apply_patch.bat or pass patch text as a shell argument; do not create replacement patch launchers. ' +
    'The helper reports the real Codex exit code and retains diagnostics in .agent-tmp/recast-patch-results.jsonl. Never modify the host helper.';
}
