import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readProjectFile, relativePath, resolveSafePath } from './tools/project-files.js';
import type { RetainedTestSuite } from '../types.js';
export type { RetainedTestSuite, TestRetention } from '../types.js';

export const RETAINED_TEST_README = `# RECAST generated tests

Run all retained module suites from the project root:

    node .recast-tests/run.cjs

Each module directory contains manifest.json (file hashes, framework, selected
tests and last generation result), run.cjs, and any required test project files.
Test sources either live here or in a namespaced recast subdirectory of the
project's existing test roots. Existing project tests are not overwritten.

Use Node.js 20+ and install the target project's normal build/test dependencies.
Python requires pytest; Node projects require their declared Jest/Vitest;
Java requires the project's JDK and Maven/Gradle; C# requires its .NET SDK;
C/C++ requires CMake 3.21+, GCC/G++ and matching gcov. CMAKE_COMMAND and
GCOV_COMMAND may select local tools. Native library selection uses the project's
.recast-native.json. Build output, reports and caches are not delivered.

A passed replay proves that the retained tests ran successfully. It does not
replace requirement coverage, unresolved failure evidence or final acceptance.
Failed and interrupted runs retain their tests for diagnosis and continuation.
`;

export const RETAINED_TEST_RUNNER = `'use strict';
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const suites = fs.readdirSync(__dirname).sort().filter(name => /^[a-f0-9]{24}$/.test(name) && fs.existsSync(path.join(__dirname,name,'manifest.json')));
if (!suites.length) { console.error('No retained RECAST test suites.'); process.exit(1); }
for (const suite of suites) {
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,suite,'manifest.json'),'utf8'));
 console.log('Running RECAST test suite: '+manifest.id);
 const result = spawnSync(process.execPath,[path.join(__dirname,suite,'run.cjs')],{cwd:path.dirname(__dirname),stdio:'inherit',shell:false,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 if (result.error) console.error(result.error.message);
 if (result.error || result.status !== 0) {console.error('RECAST_SUITE_FAILED '+JSON.stringify(manifest.id));process.exit(result.status || 1);}
}
`;

export function retainedTestDirectory(id: string): string {
  return `.recast-tests/${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
}
const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

function allowedPath(path: string, suite: Pick<RetainedTestSuite, 'directory' | 'testRoots'>): boolean {
  relativePath(path);
  const key = suite.directory.split('/')[1];
  return path.startsWith(`${suite.directory}/`) || suite.testRoots.some(root =>
    root.endsWith(`/recast/${key}`) && path.startsWith(`${root}/`));
}

/** Read only Host-owned, bounded manifests; no manifest can authorize production files. */
export async function readRetainedTestSuite(root: string, id: string, verifyFiles = true): Promise<RetainedTestSuite | undefined> {
  const directory = retainedTestDirectory(id), manifest = `${directory}/manifest.json`;
  let text: string;
  try { text = await readProjectFile(root, manifest); }
  catch (error) { if (error instanceof Error && error.message === `File does not exist: ${manifest}`) return; throw error; }
  const suite = JSON.parse(text) as RetainedTestSuite;
  if (!suite || suite.schemaVersion !== 1 || suite.id !== id || suite.directory !== directory ||
      !['maven', 'gradle', 'dotnet', 'pytest', 'jest', 'vitest', 'cmake'].includes(suite.framework) ||
      !Array.isArray(suite.testRoots) || !suite.testRoots.length || suite.testRoots.length > 20 ||
      !Array.isArray(suite.testPaths) || suite.testPaths.length > 2000 || !Array.isArray(suite.files) || suite.files.length > 2000 ||
      !suite.testRoots.every(path => typeof path === 'string' && (path === `${directory}/tests` || path.endsWith(`/recast/${directory.split('/')[1]}`)))) {
    throw new Error(`Invalid retained test manifest: ${manifest}`);
  }
  const names = new Set<string>();
  for (const file of suite.files) {
    if (!file || typeof file.path !== 'string' || !allowedPath(file.path, suite) || !/^[a-f0-9]{64}$/.test(file.sha256) || names.has(file.path)) throw new Error(`Invalid retained test file: ${manifest}`);
    names.add(file.path);
    if (verifyFiles && digest(await readProjectFile(root, file.path)) !== file.sha256) throw new Error(`Retained test file changed: ${file.path}`);
  }
  if (!names.has(`${directory}/run.cjs`) || suite.testPaths.some(path => typeof path !== 'string' || !names.has(path) || !suite.testRoots.some(root => path.startsWith(`${root}/`)))) throw new Error(`Invalid retained test selection: ${manifest}`);
  return suite;
}

export function retainedTestFiles(suite: RetainedTestSuite): string[] {
  return [...suite.files.map(file => file.path), '.recast-tests/run.cjs', '.recast-tests/README.md', `${suite.directory}/manifest.json`];
}

const pendingDirectory = (root: string, id: string) => resolveSafePath(root, `.recast-tests-delivery/${retainedTestDirectory(id).split('/')[1]}`);

/** Finish a previously staged delivery after a process crash. Only fixed
 * module namespaces can be recovered; the staged bytes are hash-checked. */
export async function recoverRetainedTestDelivery(root: string, id: string): Promise<void> {
  const pending = pendingDirectory(root, id);
  try { await readFile(join(pending, 'ready')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const staged = join(pending, 'files');
  const suite = await readRetainedTestSuite(staged, id);
  if (!suite) throw new Error('Incomplete retained test delivery.');
  for (const path of retainedTestFiles(suite)) {
    const target = resolveSafePath(root, path), content = await readProjectFile(staged, path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = target + '.recast-tmp'; await writeFile(temporary, content); await rename(temporary, target);
  }
  await rm(pending, { recursive: true, force: true });
}

/** Stage a complete bundle before changing output; the manifest is applied
 * last, and a durable marker allows recovery without the temporary workspace. */
export async function copyRetainedTestSuite(from: string, to: string, suite: RetainedTestSuite): Promise<void> {
  suite = (await readRetainedTestSuite(from, suite.id))!;
  await recoverRetainedTestDelivery(to, suite.id);
  const previous = await readRetainedTestSuite(to, suite.id);
  const previousPaths = new Set(previous ? retainedTestFiles(previous) : []);
  for (const path of retainedTestFiles(suite)) {
    const target = resolveSafePath(to, path);
    if (!previousPaths.has(path)) {
      try {
        const current = await readFile(target, 'utf8');
        if (path === '.recast-tests/run.cjs' && current === RETAINED_TEST_RUNNER || path === '.recast-tests/README.md' && current === RETAINED_TEST_README) continue;
        throw new Error(`Refusing to overwrite an existing project test: ${path}`);
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const pending = pendingDirectory(to, suite.id), staged = join(pending, 'files');
  await mkdir(staged, { recursive: true });
  for (const path of retainedTestFiles(suite)) {
    const target = resolveSafePath(staged, path);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, await readProjectFile(from, path));
  }
  await writeFile(join(pending, 'ready'), suite.id);
  await recoverRetainedTestDelivery(to, suite.id);
}
