import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Launch Node entry points directly, without putting the prompt through a
 * Windows command shell. npm's Codex .cmd shim is not a native executable. */
export async function resolveCodexCommand(
  command: string,
  options: { cwd: string; environment: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): Promise<{ executable: string; args: string[] }> {
  const platform = options.platform ?? process.platform;
  if (/\.(?:cjs|mjs|js)$/i.test(command)) {
    return { executable: process.execPath, args: [resolve(options.cwd, command)] };
  }
  if (platform !== 'win32') return { executable: command, args: [] };

  const explicitPath = isAbsolute(command) || /[\\/]/.test(command);
  const name = basename(command).replace(/\.(?:cmd|ps1)$/i, '').toLowerCase();
  if (name !== 'codex') return { executable: command, args: [] };
  const path = options.environment.PATH ?? options.environment.Path ?? options.environment.path ?? '';
  const directories = explicitPath
    ? [dirname(resolve(options.cwd, command))]
    : path.split(';').filter(Boolean).map(directory => directory.replace(/^"(.*)"$/, '$1'));
  for (const directory of directories) {
    if (!explicitPath) {
      for (const suffix of ['.exe', '.com']) {
        const executable = join(directory, `codex${suffix}`);
        if (await isFile(executable)) return { executable, args: [] };
      }
    }
    const shim = explicitPath ? resolve(options.cwd, command) : join(directory, 'codex.cmd');
    if (!await isFile(shim)) continue;
    // Global npm shims sit next to node_modules; local shims sit in .bin.
    for (const entry of [
      join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      join(directory, '..', '@openai', 'codex', 'bin', 'codex.js'),
    ]) {
      if (await isFile(entry)) return { executable: process.execPath, args: [resolve(entry)] };
    }
  }
  return { executable: command, args: [] };
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
