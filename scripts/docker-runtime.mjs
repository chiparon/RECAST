import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function dockerDesktopCandidates(platform = process.platform, environment = process.env) {
  if (platform !== 'win32') return ['/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe'];
  return [
    path.win32.join(environment.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
    ...(environment.LOCALAPPDATA ? [path.win32.join(environment.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'Docker Desktop.exe')] : []),
  ];
}

/** Start an installed Docker engine without recreating containers or volumes. */
export async function ensureDockerRuntime({ timeoutMs = Number(process.env.RECAST_DOCKER_WAIT_MS || 180_000) } = {}) {
  const ready = () => spawnSync('docker', ['info'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }).status === 0;
  if (ready()) return;
  const desktop = dockerDesktopCandidates().find(candidate => existsSync(candidate));
  if (desktop) {
    console.log('Starting Docker Desktop; waiting for the database engine…');
    const child = spawn(desktop, [], { detached: true, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } else if (process.platform === 'linux') {
    const started = spawnSync('systemctl', ['--user', 'start', 'docker'], { stdio: 'ignore', timeout: 10_000 });
    if (started.status !== 0) throw new Error('Docker is unavailable. Enable Docker Desktop WSL integration or start the configured Docker engine.');
  } else {
    throw new Error('Docker Desktop is not available. Install Docker Desktop or configure an external SeekDB host.');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Docker did not become ready within ${timeoutMs / 1000} seconds; inspect Docker Desktop diagnostics.`);
}
