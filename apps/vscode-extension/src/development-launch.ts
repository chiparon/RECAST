import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Remote VS Code may retain its first server environment across CLI launches. */
export function applyDevelopmentLaunchEnvironment(extensionPath: string, development: boolean,
  environment: NodeJS.ProcessEnv = process.env): void {
  if (!development) return;
  const file = path.resolve(extensionPath, '../../output/recast-startup/current-launch.json');
  let launch;
  try { launch = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (launch?.version !== 1 || !launch.environment || typeof launch.environment !== 'object') {
    throw new Error('RECAST development launch configuration is invalid; rerun npm run dev:extension.');
  }
  for (const [name, value] of Object.entries(launch.environment)) {
    if (typeof value === 'string' && /^(?:FOREXPLORE_|CODE_INTELLIGENCE_|RECAST_|ADAPTATION_PORT$)/.test(name) &&
        !/(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)/i.test(name)) environment[name] = value;
  }
}
