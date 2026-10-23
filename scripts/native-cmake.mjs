import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared by packaged builds and verification; arguments never pass through a shell. */
export function nativeCmakeSettings(root) {
  const command = process.env.CMAKE_COMMAND?.trim() || 'cmake';
  const configPath = join(root, '.recast-native.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['configureArgs', 'testTargets'].includes(key))) {
    throw new Error('Invalid .recast-native.json: expected configureArgs and/or testTargets.');
  }
  const configureArgs = config.configureArgs ?? [];
  const testTargets = config.testTargets ?? [];
  if (!Array.isArray(configureArgs) || configureArgs.some(arg => typeof arg !== 'string' || !/^-D[A-Za-z_][\w]*(?::[A-Z]+)?=/.test(arg) || /[\0\r\n]/.test(arg))) {
    throw new Error('.recast-native.json configureArgs must contain only -DNAME=value definitions.');
  }
  if (!Array.isArray(testTargets) || testTargets.some(target => typeof target !== 'string' || !/^[A-Za-z_][\w.:+-]*$/.test(target))) {
    throw new Error('.recast-native.json testTargets must contain CMake library target names.');
  }
  const args = [...configureArgs];
  // Honour an explicit generator. CMake's Windows default otherwise selects
  // Visual Studio even on machines where only MinGW/GCC is installed.
  if (process.platform === 'win32' && !process.env.CMAKE_GENERATOR) {
    try {
      execFileSync(process.env.CC || 'gcc', ['--version'], { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
      args.unshift('-G', 'MinGW Makefiles');
    } catch { /* CMake discovers Visual Studio or emits its own diagnostic. */ }
  }
  return { command, configureArgs: args, testTargets: [...testTargets] };
}

export function cmakeLiteral(value) {
  let equals = '=';
  while (value.includes(`]${equals}]`)) equals += '=';
  return `[${equals}[` + value.replaceAll('\\', '/') + `]${equals}]`;
}
