import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindTestRunner, bindFunctionGroupTestRunner } from "./test-runner.js";
import { MAX_TEST_OUTPUT_CHARS, type ToolRuntimeContext } from "./tools/common.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(script: string, timeoutMs = 5_000) {
  const root = await mkdtemp(join(tmpdir(), "verifier-runner-"));
  roots.push(root);
  await writeFile(join(root, "fake-runner.cjs"), script);
  const runtime: ToolRuntimeContext = {
    sourceLanguage: "Java", targetLanguage: "Java", sourceProjectPath: root, targetProjectPath: root,
    sourcePath: "src/Order.java", targetPath: "src/Order.java",
    targetFunction: { path: "src/Order.java", name: "calculatePrice" },
    sourceDirectory: "src", targetDirectory: "src", testRoots: ["tests"], testRunner: "maven",
    targetTest: { executable: process.execPath, args: ["fake-runner.cjs"], timeoutMs },
  };
  return { root, runtime, runner: bindTestRunner({ runtime }) };
}

async function expectClean(root: string) {
  expect(await readdir(join(root, "target/translation-verifier-coverage"))).toEqual([]);
}

describe("bound test runner", () => {
  it("does not mark an executed function passed when its assertions failed", async () => {
    const { root, runtime } = await fixture(`const fs = require('node:fs');
const args = process.argv.slice(2);
const value = key => args.find(arg => arg.startsWith(key + '=')).slice(key.length + 1);
const reports = value('-Dsurefire.reportsDirectory'), coverage = value('-Djacoco.outputDirectory');
fs.mkdirSync(reports, {recursive: true}); fs.mkdirSync(coverage, {recursive: true});
fs.writeFileSync(reports + '/TEST-Order.xml', '<testsuite tests="1" failures="1" errors="0" skipped="0"/>');
fs.writeFileSync(coverage + '/jacoco.xml', '<report><package name=""><class name="Order" sourcefilename="Order.java"><method name="calculatePrice" desc="()I"><counter type="METHOD" missed="0" covered="1"/></method></class></package></report>');
process.exitCode = 1;`);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/Order.java"), "public class Order { public int calculatePrice() { return 1; } }");
    runtime.functionGroup = { schemaVersion: "3.1", mode: "requirement", sourceLanguage: "Java", targetLanguage: "Java",
      targetProjectPath: root, requirement: "Calculate correctly", functions: [{ target: runtime.targetFunction }] };
    const result = await bindFunctionGroupTestRunner({ runtime }).run(["tests/OrderTest.java"]);
    expect(result.functions[0]).toMatchObject({ status: "unverified", executed: true, reason: "test-failed" });
    expect(result.status).toBe("failure");
  });

  it("preserves covered functions when another group member cannot be located", async () => {
    const { root, runtime } = await fixture(`const fs = require('node:fs');
const args = process.argv.slice(2);
const directory = args[args.indexOf('--results-directory') + 1];
fs.mkdirSync(directory + '/00000000-0000-0000-0000-000000000001', {recursive: true});
fs.writeFileSync(directory + '/tests.trx', '<TestRun><ResultSummary><Counters total="1" executed="1" passed="1"/></ResultSummary></TestRun>');
fs.writeFileSync(directory + '/00000000-0000-0000-0000-000000000001/coverage.cobertura.xml', '<coverage><packages><package><classes><class name="Order" filename="src/Order.cs"><methods><method name="Run" signature="()"><lines><line number="1" hits="1"/></lines></method></methods></class></classes></package></packages></coverage>');`);
    runtime.targetLanguage = "C#";
    runtime.testRunner = "dotnet";
    runtime.targetTest.args.push("tests/AgentTests.csproj");
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests/OrderTest.cs"), "public class OrderTest { private sealed class FakeClock {} }");
    const functions = [{ path: "src/Order.cs", name: "Run" }, { path: "src/Order.cs", name: "Missing" }];
    runtime.functionGroup = { schemaVersion: "3.1", mode: "requirement", sourceLanguage: "C#", targetLanguage: "C#",
      targetProjectPath: root, requirement: "Run the order", functions: functions.map(target => ({ target })) };
    const result = await bindFunctionGroupTestRunner({ runtime }).run(["tests/OrderTest.cs"]);
    expect(result.tests).toEqual({ executed: 1, passed: 1, failed: 0, skipped: 0 });
    expect(result.functions[0]).toMatchObject({ status: "passed", executed: true, lineCoverage: 100 });
    expect(result.functions[1]).toMatchObject({ status: "unverified", reason: "coverage-unavailable" });
  });
  it("retains structured failed assertions even when no coverage report was produced", async () => {
    const { root, runtime } = await fixture(`const fs = require('node:fs');
const args = process.argv.slice(2);
const reports = args.find(arg => arg.startsWith('-Dsurefire.reportsDirectory=')).split('=')[1];
fs.mkdirSync(reports, {recursive: true});
fs.writeFileSync(reports + '/TEST-Order.xml', '<testsuite name="OrderTest" tests="2" failures="1" errors="0" skipped="0"><testcase classname="OrderTest" name="ok"/><testcase classname="OrderTest" name="boundary"><failure message="expected rejection">assertion trace</failure></testcase></testsuite>');
process.exitCode = 1;`);
    runtime.functionGroup = { schemaVersion: "3.1", mode: "requirement", sourceLanguage: "Java", targetLanguage: "Java",
      targetProjectPath: root, requirement: "Reject invalid input", functions: [{ target: runtime.targetFunction }] };
    const result = await bindFunctionGroupTestRunner({ runtime }).run(["tests/OrderTest.java"]);
    expect(result).toMatchObject({ status: "failure", tests: { executed: 2, failed: 1 }, testCases: [
      { id: "OrderTest#ok", status: "passed" }, { id: "OrderTest#boundary", status: "failed", message: "expected rejection\nassertion trace" },
    ] });
    expect(result.functions[0]?.reason).toBe("test-failed");
  });
  it("clears old Maven reports, isolates execution data and cleans each completed run", async () => {
    const { root, runtime, runner } = await fixture("process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    await mkdir(join(root, "target/site/jacoco"), { recursive: true });
    await mkdir(join(root, "target/surefire-reports"), { recursive: true });
    const oldReport = join(root, "target/site/jacoco/jacoco.xml");
    await writeFile(oldReport, "old coverage");
    await writeFile(join(root, "target/surefire-reports/TEST-old.xml"), '<testsuite tests="1" failures="0" errors="0" skipped="0"/>');
    // Changes to the caller's command cannot replace an already-bound runner.
    runtime.targetTest.executable = "invalid-after-binding";
    runtime.targetTest.args = [];
    const first = await runner.run("tests/OrderTest.java");
    const second = await runner.run("tests/OrderTest.java");
    expect(first).toMatchObject({ status: "success", coverage: { status: "unavailable" } });
    expect(first.tests).toBeUndefined();
    await expect(readFile(oldReport)).rejects.toMatchObject({ code: "ENOENT" });
    const firstArgs: string[] = JSON.parse(first.stdout), secondArgs: string[] = JSON.parse(second.stdout);
    expect(firstArgs).toContain("-Dtest=OrderTest");
    expect(firstArgs).toContain("-Djacoco.append=false");
    const dataFile = (args: string[]) => args.find(arg => arg.startsWith("-Djacoco.destFile="))!.split("=")[1];
    expect(dataFile(firstArgs)).not.toBe(dataFile(secondArgs));
    await expect(readdir(dirname(dataFile(firstArgs)))).rejects.toMatchObject({ code: "ENOENT" });
    await expectClean(root);
  });

  it("cleans a failed preparation and an invalid Host command", async () => {
    const { root, runtime, runner } = await fixture("");
    await expect(runner.run("tests/OrderTest.txt")).rejects.toThrow("Java test selector");
    await expectClean(root);
    runtime.targetTest.executable = "";
    await expect(bindTestRunner({ runtime }).run("tests/OrderTest.java")).rejects.toThrow("Host target test command is invalid");
    await expectClean(root);
  });

  it("returns process launch errors and nonzero exits as failures and cleans the run", async () => {
    const { root, runtime, runner } = await fixture("process.stderr.write('assertion failed'); process.exitCode = 1");
    expect(await runner.run("tests/OrderTest.java")).toMatchObject({ status: "failure", exitCode: 1, stderr: "assertion failed" });
    await expectClean(root);
    runtime.targetTest.executable = join(root, "missing-executable");
    expect(await bindTestRunner({ runtime }).run("tests/OrderTest.java")).toMatchObject({ status: "failure", exitCode: null, timedOut: false });
    await expectClean(root);
  });

  it("retains timeout and output limits inside the runner", async () => {
    const { root, runner } = await fixture("process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)", 300);
    const result = await runner.run("tests/OrderTest.java");
    expect(result).toMatchObject({ status: "failure", timedOut: true });
    expect(result.stdout).toHaveLength(MAX_TEST_OUTPUT_CHARS);
    await expectClean(root);
  });

  it("retains failed test counts when fresh coverage is unavailable, even with exit code zero", async () => {
    const { root, runner } = await fixture(`const fs = require('node:fs');
fs.mkdirSync('target/surefire-reports', {recursive: true});
fs.writeFileSync('target/surefire-reports/TEST-Order.xml', '<testsuite tests="2" failures="1" errors="0" skipped="0"/>');`);
    expect(await runner.run("tests/OrderTest.java")).toMatchObject({
      status: "failure", exitCode: 0, tests: { executed: 2, passed: 1, failed: 1, skipped: 0 },
      coverage: { status: "unavailable" },
    });
    await expectClean(root);
  });
});
