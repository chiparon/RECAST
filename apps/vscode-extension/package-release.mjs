import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVSIX } from '@vscode/vsce';
import { build } from 'vite';

// The development dist may be in use by an extension host, or may contain
// workers from another branch. Build the release in a fresh directory.
const root = fileURLToPath(new URL('.', import.meta.url));
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });
const staging = await mkdtemp(path.join(dist, 'release-'));
try {
  for (const entry of ['package.json', 'README.md', 'media']) {
    await cp(path.join(root, entry), path.join(staging, entry), { recursive: true });
  }
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    if (existsSync(path.join(root, name))) await cp(path.join(root, name), path.join(staging, name));
  }
  await build({
    configFile: path.join(root, 'vite.config.ts'),
    build: { outDir: path.join(staging, 'dist/webview') },
  });
  execFileSync(process.execPath, [path.join(root, 'esbuild.mjs'), '--release'], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, FOREXPLORE_EXTENSION_OUTPUT_DIRECTORY: path.join(staging, 'dist/extension') },
  });
  const archive = path.join(staging, 'recast.vsix');
  await createVSIX({ cwd: staging, packagePath: archive, dependencies: false, allowMissingRepository: true });
  await rename(archive, path.join(dist, 'recast.vsix'));
  console.log(`Release package: ${path.join(dist, 'recast.vsix')}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
