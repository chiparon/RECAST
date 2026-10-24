/** Packaged, host-owned default syntax/build check. Never claims behavioral verification. */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { nativeCmakeSettings } from '../../../scripts/native-cmake.mjs';

const root = process.cwd();
const sources: string[] = [];
function walk(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'target', 'build', '__pycache__'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) sources.push(full);
  }
}
walk(root);
let command: string, args: string[];
if (existsSync(path.join(root, 'CMakeLists.txt'))) {
  const settings = nativeCmakeSettings(root);
  command = settings.command;
  args = ['-S', root, '-B', path.join(root, '.recast-build'), ...settings.configureArgs];
}
else if (existsSync(path.join(root, 'Cargo.toml'))) { command = 'cargo'; args = ['check']; }
else if (existsSync(path.join(root, 'pom.xml'))) {
  // Java targets use the installed Maven executable; Windows batch wrappers need a shell.
  command = process.platform === 'win32' ? 'mvn.cmd' : 'mvn'; args = ['-B', '-DskipTests', 'compile'];
}
else if (existsSync(path.join(root, 'go.mod'))) { command = 'go'; args = ['test', './...']; }
else if (sources.some(file => /\.(csproj|sln)$/.test(file))) { command = 'dotnet'; args = ['build', '--nologo']; }
else if (sources.some(file => file.endsWith('.py'))) { command = 'python'; args = ['-m', 'compileall', '-q', root]; }
else {
  console.error('No default build command for this target. Configure forexplore.backend.compileCommand in User Settings.');
  process.exit(1);
}
const child = spawn(command, args, { cwd: root, shell: process.platform === 'win32' && command === 'mvn.cmd', windowsHide: true, stdio: 'inherit' });
child.once('error', () => { console.error('Build executable is unavailable. Configure forexplore.backend.compileCommand.'); process.exitCode = 1; });
child.once('exit', code => {
  if (code !== 0 || !existsSync(path.join(root, 'CMakeLists.txt'))) { process.exitCode = code ?? 1; return; }
  const build = spawn(command, ['--build', path.join(root, '.recast-build'), '--config', 'Debug', '--parallel', '4'], { cwd: root, shell: false, windowsHide: true, stdio: 'inherit' });
  build.once('error', error => { console.error(error.message); process.exitCode = 1; });
  build.once('exit', result => { process.exitCode = result ?? 1; });
});
