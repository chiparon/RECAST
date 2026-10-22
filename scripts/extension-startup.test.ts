import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { waitForExtensionStartup } from './extension-startup.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function reportPath() {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-launch-')); roots.push(root);
  return path.join(root, 'ready.json');
}
it('waits for the extension to confirm readiness after the editor opens', async () => {
  const file = await reportPath();
  const pending = waitForExtensionStartup(file, 2000);
  await writeFile(file, JSON.stringify({ status: 'ready', adaptationUrl: 'http://127.0.0.1:12345' }));
  expect(await pending).toMatchObject({ status: 'ready' });
});
it('fails the command when the extension reports a backend startup failure', async () => {
  const file = await reportPath();
  await writeFile(file, JSON.stringify({ status: 'error', message: 'database unavailable' }));
  await expect(waitForExtensionStartup(file)).rejects.toThrow('database unavailable');
});
it('does not claim success when the editor never starts the extension services', async () => {
  await expect(waitForExtensionStartup(await reportPath(), 10)).rejects.toThrow('did not confirm');
});
