import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveTestEnvironment } from '../src/host/testing/test-environment.js';
import { bindFunctionGroupTestRunner, bindTestRunner } from '../src/host/testing/test-runner.js';
import { runFunctionGroupTests } from '../src/host/tools/run-function-group-tests.js';
import { createTestHistory } from '../src/host/verification/test-history.js';
import type { ToolContext } from '../src/host/tools/common.js';
import { buildModuleFunctionMapping, discoverExecutableFunctions } from '../../../scripts/module-function-mapping.js';
import { compileTargetIntegrated, compileTargetStandalone } from '../../adaptation-service/src/compiler.js';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suite = process.env.RECAST_NATIVE_E2E === '1' ? describe : describe.skip;
suite('real CMake/GCC behavior verification', () => {
  it('resolves an explicit C++ library and its C dependency instead of guessing between multiple libraries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recast-mixed-'));
    let environment: Awaited<ReturnType<typeof resolveTestEnvironment>> | undefined;
    try {
      await writeFile(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.21)\nproject(Mixed LANGUAGES C CXX)\nadd_library(support support.c)\nadd_library(api api.cpp)\ntarget_link_libraries(api PUBLIC support)\n');
      await writeFile(join(root, 'support.c'), 'int factor(void) {return 2;}\n');
      await writeFile(join(root, 'api.cpp'), 'extern "C" int factor(void);\nint calculate(int x) {return x * factor();}\n');
      environment = await resolveTestEnvironment({ targetLanguage: 'C++', targetProjectPath: root });
      const path = `${environment.testRoots[0]}/mixed.cpp`;
      await writeFile(join(root, path), 'int calculate(int);\nint main() {return calculate(3) == 6 ? 0 : 1;}\n');
      const bound = { runtime: { sourceLanguage: 'C++', targetLanguage: 'C++', sourceProjectPath: root, targetProjectPath: root,
        sourceDirectory: '.', targetDirectory: '.', sourcePath: 'api.cpp', targetPath: 'api.cpp', targetFunction: { path: 'api.cpp', name: 'calculate', startLine: 2 },
        testRunner: environment.framework, testRoots: environment.testRoots, targetTest: environment.targetTest } };
      const ambiguous = await bindTestRunner(bound).run(path);
      expect(ambiguous.status).toBe('failure');
      expect(ambiguous.stderr).toContain('explicit testTargets');
      await writeFile(join(root, '.recast-native.json'), JSON.stringify({ testTargets: ['api'] }));
      const selected = await bindTestRunner(bound).run(path);
      expect(selected, JSON.stringify(selected)).toMatchObject({ status: 'success', tests: { executed: 1, passed: 1 }, coverage: { status: 'available', targetFunction: { executed: true } } });
    } finally { await environment?.cleanup?.(); await rm(root, { recursive: true, force: true }); }
  }, 120_000);
  it.each(['C', 'C++'])('%s: passes real assertions, rejects unrelated green tests, retains failures and builds fresh', async language => {
    const root = await mkdtemp(join(tmpdir(), 'recast native-'));
    let environment: Awaited<ReturnType<typeof resolveTestEnvironment>> | undefined;
    const put = async (file: string, content: string) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), content); };
    try {
      const cpp = language === 'C++', sourcePath = cpp ? 'src/price.cxx' : 'src/price.c';
      const header = cpp ? 'price.hxx' : 'price.h';
      const source = cpp
        ? '#include "price.hxx"\nnamespace shop {\nint Price::calculate(int value) {\n if(value > 0) return value * 2;\n return 0;\n}\ndouble Price::calculate(double value) { return value * 3; }\n}\n'
        : '#include "price.h"\nint calculate(int value) {\n if(value > 0) return value * 2;\n return 0;\n}\nint unused(void) { return 4; }\n';
      await put('CMakeLists.txt', `cmake_minimum_required(VERSION 3.21)\nproject(Price LANGUAGES ${cpp ? 'CXX' : 'C'})\nset(CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS ON)\nadd_library(price ${cpp ? 'SHARED' : 'STATIC'} ${sourcePath})\ntarget_include_directories(price PUBLIC include)\n`);
      await put(`include/${header}`, cpp ? 'namespace shop { class Price { public: static int calculate(int value); static double calculate(double value); }; }\n' : 'int calculate(int value);\nint unused(void);\n');
      await put(sourcePath, source);
      expect(compileTargetStandalone(cpp ? 'C++' : 'C', 'int calculate(int value) {return value * 2;}', 'price').success).toBe(true);
      expect(compileTargetStandalone(cpp ? 'C++' : 'C', 'int calculate( {', 'price').success).toBe(false);
      // Exercise the actual packaged default build entry point, not a substitute command.
      const buildScript = join(root, 'workspace-compile.cjs');
      await build({ entryPoints: [fileURLToPath(new URL('../../../apps/vscode-extension/src/workspace-compile.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', outfile: buildScript });
      expect(() => execFileSync(process.execPath, [buildScript], { cwd: root, windowsHide: true, timeout: 30_000, stdio: 'pipe' })).not.toThrow();
      const integrated = compileTargetIntegrated(cpp ? 'C++' : 'C', source, root, sourcePath);
      expect(integrated, JSON.stringify(integrated)).toMatchObject({ success: true });
      expect(compileTargetIntegrated(cpp ? 'C++' : 'C', '#error intentionally invalid translation', root, sourcePath).success).toBe(false);
      expect(await readFile(join(root, sourcePath), 'utf8')).toBe(source);
      const discovered = discoverExecutableFunctions({ [sourcePath]: source });
      const mapping = buildModuleFunctionMapping({ id: 'price', name: 'Price', kind: 'feature', description: 'Price API', sourceFiles: [sourcePath], symbolKeys: [], evidenceIds: [], dependsOn: [] }, undefined, { [sourcePath]: source }, discovered);
      const functions = mapping.unmatchedFunctions;
      expect(functions).toEqual(discovered);
      expect(functions.length, JSON.stringify(functions)).toBe(2);
      environment = await resolveTestEnvironment({ targetLanguage: language, targetProjectPath: root });
      const testPath = `${environment.testRoots[0]}/price_test.${cpp ? 'cpp' : 'c'}`;
      const target = functions[0]!;
      const input = { schemaVersion: '3.1' as const, mode: 'requirement' as const, targetLanguage: language, sourceLanguage: language,
        targetProjectPath: root, requirement: 'Positive integers are doubled; nonpositive integers yield zero.', functions: functions.map(target => ({ target })) };
      const bound: Omit<ToolContext, 'runner'> = { state: {}, runtime: { ...input, sourceProjectPath: root, sourcePath, targetPath: sourcePath,
        targetFunction: target, sourceDirectory: 'src', targetDirectory: 'src', testRoots: environment.testRoots,
        testRunner: environment.framework, targetTest: environment.targetTest, functionGroup: input } };
      const context: ToolContext = { ...bound, runner: bindTestRunner(bound), functionGroupRunner: bindFunctionGroupTestRunner(bound) };
      context.testHistory = createTestHistory(context, async () => ({ approved: false, note: 'An assertion was changed.' }));
      const run = () => runFunctionGroupTests(context, { paths: [testPath] });
      const call = cpp ? 'shop::Price::calculate' : 'calculate';
      const good = `#include "${header}"\nint main(void) { return (${call}(3) == 6 && ${call}(0) == 0) ? 0 : 1; }\n`;
      await put(testPath, good);
      const positive = await run();
      expect(positive, JSON.stringify(positive)).toMatchObject({ status: 'success', tests: { executed: 1, passed: 1, failed: 0 }, functions: [
        { status: 'passed', executed: true, lineCoverage: 100 }, { status: 'unverified', reason: 'not-executed', executed: false },
      ] });
      expect(positive.reportPaths).toHaveLength(2);
      for (const report of positive.reportPaths!) expect((await readFile(join(root, report), 'utf8')).length).toBeGreaterThan(0);
      await put(testPath, 'int main(void) { return 0; }\n');
      const unrelated = await run();
      // Static libraries need not be linked at all for unrelated tests. Missing
      // gcov evidence must remain unavailable, never become a passed function.
      expect(unrelated.status).toBe('success');
      expect(unrelated.tests.executed).toBe(1);
      expect(unrelated.functions.every(fn => fn.status === 'unverified' && !fn.executed)).toBe(true);
      await put(testPath, good.replace('== 6', '== 7'));
      const failing = await run();
      expect(failing).toMatchObject({ status: 'failure', tests: { failed: 1 } });
      expect(failing.functions[0]).toMatchObject({ status: 'unverified', reason: 'test-failed' });
      expect(context.state?.testEvidence?.failures.some(failure => failure.status === 'unresolved')).toBe(true);
      await put(testPath, good);
      const repaired = await run();
      expect(repaired.status).toBe('success');
      expect(context.state?.testEvidence?.failures.some(failure => failure.status === 'unresolved')).toBe(true);
      // Compiler errors report no executed tests and cannot reuse earlier XML.
      await put(testPath, '#error intentional compile failure\n');
      const broken = await run();
      expect(broken.status).toBe('failure');
      expect(broken.tests.executed).toBe(0);
      expect(await readdir(join(root, '.translation-verifier-scripts'))).toEqual([]);
    } finally { await environment?.cleanup?.(); await rm(root, { recursive: true, force: true }); }
  }, 180_000);
});
