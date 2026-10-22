// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { applyDevelopmentLaunchEnvironment } from './development-launch';

it('uses this launch configuration even when the remote server retained older environment values', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-launch-contract-'));
  try {
    await mkdir(path.join(root, 'output/recast-startup'), { recursive: true });
    await writeFile(path.join(root, 'output/recast-startup/current-launch.json'), JSON.stringify({ version: 1, environment: {
      FOREXPLORE_STARTUP_REPORT: '/new/ready.json', FOREXPLORE_PRELOADED: '0',
      CODE_INTELLIGENCE_SEEKDB_DATABASE: 'current_database', CODE_INTELLIGENCE_SEEKDB_PASSWORD: 'file-password',
      NODE_OPTIONS: '--inspect',
    } }));
    const environment = { FOREXPLORE_STARTUP_REPORT: '/old/ready.json', FOREXPLORE_PRELOADED: '1',
      CODE_INTELLIGENCE_SEEKDB_PASSWORD: 'inherited-password' };
    const extension = path.join(root, 'apps/vscode-extension');
    applyDevelopmentLaunchEnvironment(extension, false, environment);
    expect(environment.FOREXPLORE_STARTUP_REPORT).toBe('/old/ready.json');
    applyDevelopmentLaunchEnvironment(extension, true, environment);
    expect(environment).toEqual({ FOREXPLORE_STARTUP_REPORT: '/new/ready.json', FOREXPLORE_PRELOADED: '0',
      CODE_INTELLIGENCE_SEEKDB_DATABASE: 'current_database', CODE_INTELLIGENCE_SEEKDB_PASSWORD: 'inherited-password' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
