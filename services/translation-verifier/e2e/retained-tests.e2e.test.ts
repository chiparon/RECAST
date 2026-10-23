import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createAgentHost } from '../src/host/runtime.js';
import { createWriteTargetTestTool } from '../src/host/tools/write-target-test.js';
import { createRunFunctionGroupTestsTool } from '../src/host/tools/run-function-group-tests.js';
import { copyRetainedTestSuite, readRetainedTestSuite } from '../src/host/test-artifacts.js';
import type { AgentModelClient } from '../src/host/model.js';
import type { FunctionGroupTestRun } from '../src/host/tools/common.js';

const exec = promisify(execFile);
const suite = process.env.RECAST_RETAINED_TESTS_E2E === '1' ? describe : describe.skip;
suite('real retained test delivery', () => {
  const languages = process.platform === 'win32' ? ['C', 'C++', 'C#'] : ['C', 'C++', 'C#', 'Java', 'Python'];
  it.each(languages)('%s: Host tests survive cleanup, move with production and detect a real regression', async language => {
    const parent = await mkdtemp(join(tmpdir(), 'recast retained ')), root = join(parent, 'verification'), output = join(parent, 'delivered');
    await mkdir(root);
    try {
      const dotnet = language === 'C#', cpp = language === 'C++', java = language === 'Java', python = language === 'Python';
      const source = dotnet ? 'Price.cs' : java ? 'src/main/java/example/Price.java' : python ? 'price.py' : cpp ? 'price.cpp' : 'price.c';
      const functionName = dotnet ? 'Calculate' : 'calculate';
      const content = dotnet ? 'public static class Price { public static int Calculate(int value) => value * 2; }\n'
        : java ? 'package example;\npublic class Price { public static int calculate(int value) {return value * 2;} }\n'
        : python ? 'def calculate(value):\n    return value * 2\n' : 'int calculate(int value) {return value * 2;}\n';
      await mkdir(dirname(join(root, source)), { recursive: true });
      await writeFile(join(root, source), content);
      if (!python) await writeFile(join(root, dotnet ? 'Price.csproj' : java ? 'pom.xml' : 'CMakeLists.txt'), dotnet
        ? '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
        : java ? '<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>price</artifactId><version>1.0</version><properties><maven.compiler.release>17</maven.compiler.release></properties><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version></plugin></plugins></build></project>'
        : `cmake_minimum_required(VERSION 3.21)\nproject(Price LANGUAGES ${cpp ? 'CXX' : 'C'})\nadd_library(price ${cpp ? 'SHARED' : 'STATIC'} ${source})\nset_target_properties(price PROPERTIES WINDOWS_EXPORT_ALL_SYMBOLS ON)\n`);
      await cp(root, output, { recursive: true });
      if (java) { await mkdir(join(root, 'target/classes'), { recursive: true }); await exec('javac', ['-d', 'target/classes', source], { cwd: root, timeout: 30_000 }); }
      let turn = 0, testPath = '';
      const client: AgentModelClient = { complete: async messages => {
        const current = turn++;
        if (current === 0) {
          const root = messages.find(message => message.role === 'user')!.content.match(/Authorized test roots: ([^\n]+)/)![1];
          testPath = `${root}/${python ? 'test_price.py' : `PriceTest.${dotnet ? 'cs' : java ? 'java' : cpp ? 'cpp' : 'c'}`}`;
          const content = dotnet ? 'using Xunit; public class PriceTest { [Fact] public void Doubles() { Assert.Equal(6, Price.Calculate(3)); } }'
            : java ? 'import org.junit.jupiter.api.Test; import static org.junit.jupiter.api.Assertions.assertEquals; public class PriceTest { @Test public void doubles() { assertEquals(6, example.Price.calculate(3)); } }'
            : python ? 'from price import calculate\ndef test_doubles():\n    assert calculate(3) == 6\n'
            : 'int calculate(int); int main(void) {return calculate(3) == 6 ? 0 : 1;}';
          return { toolCalls: [{ id: 'write', name: 'write_target_test', arguments: JSON.stringify({ path: testPath, content }) }] };
        }
        if (current === 1) return { toolCalls: [{ id: 'run', name: 'run_function_group_tests', arguments: JSON.stringify({ paths: [testPath] }) }] };
        if (current === 2) return { toolCalls: [{ id: 'finish', name: 'finish', arguments: '{}' }] };
        throw new Error('Unexpected model retry');
      } };
      const target = { path: source, name: functionName };
      const group = { schemaVersion: '3.1' as const, mode: 'requirement' as const, sourceLanguage: language, targetLanguage: language, targetProjectPath: root,
        requirement: 'Double the supplied integer.', functions: [{ target }] };
      const host = createAgentHost<FunctionGroupTestRun>({ modelClient: client, limits: { maxDurationMs: 180_000 },
        retainTests: { id: 'price', onUpdate: (from, suite) => copyRetainedTestSuite(from, output, suite) } });
      const result = await host.run({ subject: { requirement: group.requirement, sourceFunction: target, targetFunction: target }, functionGroup: group,
        taskContext: { ...group, sourceProjectPath: root, sourcePath: source, targetPath: source, targetFunction: target, functionGroup: group },
        systemPrompt: 'test', userPrompt: 'test', tools: [createWriteTargetTestTool(), createRunFunctionGroupTestsTool(), context => ({ name: 'finish', description: 'finish', inputSchema: { type: 'object' }, parse: value => value,
          execute: async () => context.state.lastFunctionGroupTest! })], terminalTools: ['finish'] });
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'success', tests: { executed: 1, passed: 1 } });
      const artifact = (await readRetainedTestSuite(output, 'price'))!;
      expect(artifact.status).toBe('passed');
      for (const file of artifact.files) expect(await readFile(join(output, file.path), 'utf8')).not.toContain(root);
      await rm(root, { recursive: true, force: true });
      const replay = await exec(process.execPath, ['.recast-tests/run.cjs'], { cwd: output, windowsHide: true, timeout: 180_000, maxBuffer: 4_000_000 });
      expect(replay.stdout).toContain('Retained RECAST suite passed');
      await writeFile(join(output, source), content.replace('value * 2', 'value * 3'));
      await expect(exec(process.execPath, ['.recast-tests/run.cjs'], { cwd: output, windowsHide: true, timeout: 180_000, maxBuffer: 4_000_000 })).rejects.toMatchObject({ code: 1 });
    } finally { await rm(parent, { recursive: true, force: true }); }
  }, 360_000);
});
