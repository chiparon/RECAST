import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Skip npm's shell and JS launchers on Windows: the JS launcher spawns the
 * native CLI without windowsHide, so hiding only its parent is insufficient. */
export async function resolveCodexCommand(
  command: string,
  options: { cwd: string; environment: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string },
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
      if (!await isFile(entry)) continue;
      const executable = await resolveWindowsNativeCodex(entry, options.arch ?? process.arch);
      if (executable) return { executable, args: [] };
      return { executable: process.execPath, args: [resolve(entry)] };
    }
  }
  return { executable: command, args: [] };
}

async function resolveWindowsNativeCodex(entry: string, arch: string): Promise<string | undefined> {
  const target = arch === 'x64' ? 'x86_64-pc-windows-msvc'
    : arch === 'arm64' ? 'aarch64-pc-windows-msvc' : undefined;
  if (!target) return undefined;
  // Resolve from the installed package (including pnpm symlinks), not RECAST's
  // dependencies. npm may nest or hoist the optional platform package.
  const canonicalEntry = await realpath(entry);
  const bundledExecutable = resolve(dirname(canonicalEntry), '..', 'vendor', target, 'bin', 'codex.exe');
  if (await isFile(bundledExecutable)) return bundledExecutable;
  let vendorRoot: string;
  try {
    const manifest = createRequire(canonicalEntry).resolve(`@openai/codex-win32-${arch}/package.json`);
    vendorRoot = join(dirname(manifest), 'vendor');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    return undefined;
  }
  const executable = resolve(vendorRoot, target, 'bin', 'codex.exe');
  return await isFile(executable) ? executable : undefined;
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
