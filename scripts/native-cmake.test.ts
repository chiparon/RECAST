import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmakeLiteral, nativeCmakeSettings } from './native-cmake.mjs';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('accepts explicit native library targets and definitions without turning them into shell commands', async () => {
  vi.stubEnv('CMAKE_GENERATOR', 'Ninja');
  const root = await mkdtemp(join(tmpdir(), 'recast-cmake-')); roots.push(root);
  await writeFile(join(root, '.recast-native.json'), JSON.stringify({ testTargets: ['shop::core'], configureArgs: ['-DBUILD_EXAMPLES=OFF', '-DTITLE:STRING=a value with spaces'] }));
  expect(nativeCmakeSettings(root)).toMatchObject({ testTargets: ['shop::core'], configureArgs: ['-DBUILD_EXAMPLES=OFF', '-DTITLE:STRING=a value with spaces'] });
  await writeFile(join(root, '.recast-native.json'), JSON.stringify({ configureArgs: ['-S', '../other-project'] }));
  expect(() => nativeCmakeSettings(root)).toThrow('only -D');
  await writeFile(join(root, '.recast-native.json'), JSON.stringify({ testTargets: ['x)\nexecute_process(COMMAND bad)'] }));
  expect(() => nativeCmakeSettings(root)).toThrow('target names');
});
it('quotes CMake literals with paths, variable expressions and closing bracket delimiters intact', () => {
  expect(cmakeLiteral('C:\\a b\\${literal}]===]file')).toBe('[=[C:/a b/${literal}]===]file]=]');
  expect(cmakeLiteral('a]=]b')).toBe('[==[a]=]b]==]');
});
