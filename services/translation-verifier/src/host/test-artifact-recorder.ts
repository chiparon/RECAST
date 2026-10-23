import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { prepareNativeTests } from './native-test.js';
import { readProjectFile, resolveSafePath, type ToolRuntimeContext, type ToolState } from './tools/common.js';
import { readRetainedTestSuite, retainedTestDirectory, RETAINED_TEST_README, RETAINED_TEST_RUNNER } from './test-artifacts.js';
import type { RetainedTestSuite, TestRetention } from '../types.js';
const ignored = new Set(['bin', 'obj', 'build', 'target', 'coverage', '__pycache__', '.pytest_cache', 'node_modules', 'results']);
const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

/** Called after writes/runs and in finally, before a disposable harness is cleaned. */
export function createTestArtifactRecorder(runtime: ToolRuntimeContext, state: ToolState, retention: TestRetention) {
  const directory = retainedTestDirectory(retention.id);
  return async () => {
    const previous = await readRetainedTestSuite(runtime.targetProjectPath, retention.id, false);
    const testPaths = [...new Set([...(previous?.testPaths ?? []), ...(state.functionGroupTests ?? []).flatMap(run => run.testPaths)])].sort();
    const paths = new Set<string>();
    const scan = async (folder: string): Promise<void> => {
      for (const entry of await readdir(resolveSafePath(runtime.targetProjectPath, folder), { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const path = `${folder}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`Linked test artifacts are not allowed: ${path}`);
        if (entry.isDirectory()) await scan(path);
        else if (entry.isFile()) paths.add(path);
      }
    };
    for (const root of runtime.testRoots) await scan(root);
    for (const arg of runtime.targetTest.args) if (arg.startsWith(`${directory}/`) && /(?:pom\.xml|\.csproj)$/.test(arg)) paths.add(arg);
    const put = async (path: string, text: string) => {
      const absolute = resolveSafePath(runtime.targetProjectPath, path);
      await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, text, 'utf8'); paths.add(path);
    };
    await put(`${directory}/.gitignore`, 'bin/\nobj/\nbuild/\ntarget/\nresults/\n__pycache__/\n.pytest_cache/\ntests.xml\ngcov.json\n');
    if (runtime.testRunner === 'pytest') await put(`${directory}/requirements.txt`, 'pytest>=8,<10\npytest-cov>=5,<8\n');
    if (runtime.testRunner === 'cmake' && testPaths.length) {
      await prepareNativeTests(runtime, testPaths, join(runtime.targetProjectPath, directory), true);
      paths.add(`${directory}/CMakeLists.txt`); paths.add(`${directory}/run-native.cjs`);
    }
    await put(`${directory}/run.cjs`, suiteRunner(runtime, directory, testPaths));
    const last = state.functionGroupTests?.at(-1);
    const unresolved = state.testEvidence?.failures.some(failure => failure.status === 'unresolved');
    const lastEvidence = state.testEvidence?.runs.at(-1);
    const suite: RetainedTestSuite = {
      schemaVersion: 1, id: retention.id, directory, framework: runtime.testRunner, testRoots: [...runtime.testRoots], testPaths,
      files: await Promise.all([...paths].sort().map(async path => ({ path, sha256: digest(await readProjectFile(runtime.targetProjectPath, path)) }))),
      status: !last ? 'not-run' : last.status === 'failure' ? 'failed' : unresolved || lastEvidence?.revisionCount !== state.testEvidence?.revisions.length ? 'unverified' : 'passed',
      command: `node ${directory}/run.cjs`,
    };
    await writeFile(resolveSafePath(runtime.targetProjectPath, `${directory}/manifest.json`), JSON.stringify(suite, null, 2) + '\n');
    await writeFile(resolveSafePath(runtime.targetProjectPath, '.recast-tests/run.cjs'), RETAINED_TEST_RUNNER);
    await writeFile(resolveSafePath(runtime.targetProjectPath, '.recast-tests/README.md'), RETAINED_TEST_README);
    await retention.onUpdate?.(runtime.targetProjectPath, suite, state.testEvidence ? structuredClone(state.testEvidence) : undefined);
  };
}

function suiteRunner(runtime: ToolRuntimeContext, directory: string, testPaths: string[]): string {
  // Commands are Host-generated. Paths are data; nothing is interpolated into a shell.
  const baseArgs = [...runtime.targetTest.args];
  const executable = runtime.targetTest.executable;
  const portableExecutable = executable.includes('/') || executable.includes('\\')
    ? executable.startsWith('./') ? executable : runtime.testRunner === 'pytest' ? 'python' : executable
    : executable;
  return `'use strict';
const fs=require('node:fs'), path=require('node:path'), {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'), tests=${JSON.stringify(testPaths)}, framework=${JSON.stringify(runtime.testRunner)}, args=${JSON.stringify(baseArgs)};
const results=path.join(__dirname,'results');fs.mkdirSync(results,{recursive:true});
function run(exe,argv) {
 if(process.platform==='win32' && (/^(mvn|gradle)$/.test(exe) || /\\.cmd$/.test(exe))) {
  if(argv.some(arg=>/[&|<>^%!'"\\r\\n]/.test(arg))) throw new Error('Unsafe batch argument; use a project wrapper with safe paths.');
  const result=spawnSync('cmd.exe',['/d','/s','/c',exe.replace(/(?:\\.cmd)?$/,'.cmd')+' '+argv.map(arg=>'"'+arg+'"').join(' ')],{cwd:root,stdio:'inherit',windowsHide:true,shell:false});
  if(result.error) throw result.error;if(result.status!==0) throw new Error(exe+' failed: '+result.status);return;
 }
 const result=spawnSync(exe,argv,{cwd:root,stdio:'inherit',windowsHide:true,shell:false,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 if(result.error) throw result.error;if(result.status!==0) throw new Error(exe+' failed: '+result.status);
}
try {
 if(!tests.length) throw new Error('This retained suite has no executed test selection; regenerate or resume verification.');
 if(framework==='cmake') run(process.execPath,[path.join(__dirname,'run-native.cjs')]);
 else if(framework==='jest'||framework==='vitest') {
  const pkg=path.dirname(require.resolve(framework+'/package.json',{paths:[root]}));
  const report=path.join(results,'tests.json');fs.rmSync(report,{force:true});
  run(process.execPath,[path.join(pkg,framework==='jest'?'bin/jest.js':'vitest.mjs'),...(framework==='jest'?['--runInBand','--runTestsByPath',...tests,'--roots',root,'--json','--outputFile',report]:['run',...tests,'--reporter=json','--outputFile='+report])]);
  const counts=JSON.parse(fs.readFileSync(report,'utf8'));if(!(counts.numPassedTests>0)||counts.numFailedTests>0) throw new Error('No passing executed tests, or test failures remain.');
 } else if(framework==='pytest') {
  const local=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  run(process.env.PYTHON_COMMAND || (fs.existsSync(local)?local:process.platform==='win32'?'python.exe':'python3'),['-m','pytest',...tests,'--junitxml='+path.join(results,'tests.xml'),'-o','cache_dir='+path.join(results,'cache')]);
 } else if(framework==='dotnet') {
  const report=path.join(results,'tests.trx');fs.rmSync(report,{force:true});
  const classes=tests.flatMap(file=>{const source=fs.readFileSync(path.join(root,file),'utf8');const ns=source.match(/\\bnamespace\\s+([\\w.]+)/)?.[1];return [...source.matchAll(/\\bclass\\s+(\\w+)/g)].map(match=>[ns,match[1]].filter(Boolean).join('.'));});
  if(!classes.length) throw new Error('No test classes in retained suite.');
  run('dotnet',[...args,'--filter',classes.map(name=>'FullyQualifiedName~'+name).join('|'),'--results-directory',results,'--logger','trx;LogFileName=tests.trx']);
  const xml=fs.readFileSync(report,'utf8');if(!/<Counters\\b[^>]*executed="[1-9]/.test(xml)||/<Counters\\b[^>]*failed="[1-9]/.test(xml)) throw new Error('No executed tests, or test failures remain.');
 } else {
  let command=${JSON.stringify(portableExecutable)};
  if(command.startsWith('./')) command=process.platform==='win32'?command+'.cmd':command;
  const names=tests.map(file=>path.basename(file).replace(/\\.(java|kt)$/,''));
  if(framework==='maven') {
   if(args.includes('-f')) run(command,['-DskipTests','package']);
   const prefix=args.includes('-f')?args.slice(0,2):[];
   run(command,[...prefix,'test','-Dtest='+names.join(','),'-DfailIfNoTests=true']);
  } else run(command,[...args,...names.flatMap(name=>['--tests','*.'+name]),'--rerun-tasks','--no-build-cache']);
 }
 console.log('Retained RECAST suite passed: '+${JSON.stringify(runtime.testRunner)});
} catch(error) {console.error(error.message);process.exitCode=1;}
`;
}
