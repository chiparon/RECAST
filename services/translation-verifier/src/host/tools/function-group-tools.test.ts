import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRunFunctionGroupTestsTool } from "./run-function-group-tests.js";
import { createReadTargetFileTool } from "./read-target-file.js";
import { createWriteTargetTestTool } from "./write-target-test.js";
import { createFinishFunctionGroupTool } from "./finish-function-group.js";
import type { FunctionGroupTestRun, ToolContext } from "./common.js";

const roots: string[] = [];

function expectContinue<T>(tool: { isTerminal?: (output: T) => boolean }, output: T, feedback: string) {
  expect(output).toMatchObject({ outcome: "continue", feedback: expect.arrayContaining([expect.stringContaining(feedback)]) });
  expect(tool.isTerminal?.(output)).toBe(false);
}
const testRoot = "tests/translation-verifier";
const firstTest = `${testRoot}/test_one.py`;
const secondTest = `${testRoot}/nested/test_two.py`;
const firstTarget = { path: "src/A.py", name: "a" };
const secondTarget = { path: "src/B.py", name: "b" };

async function fixture(targets = [firstTarget]) {
  const root = await mkdtemp(join(tmpdir(), "translation-verifier-function-group-"));
  roots.push(root);
  await mkdir(join(root, testRoot, "nested"), { recursive: true });
  await writeFile(join(root, firstTest), "def test_one(): pass");
  await writeFile(join(root, secondTest), "def test_two(): pass");
  const result: FunctionGroupTestRun = {
    status: "success", testPaths: [firstTest, secondTest], reportPaths: ["tests.xml"],
    tests: { executed: 2, passed: 2, failed: 0, skipped: 0 },
    functions: targets.map(target => ({ target, status: "passed", executed: true, lineCoverage: 100, branchCoverage: null })),
    failures: [], stdout: "ok", stderr: "", exitCode: 0,
  };
  const calls: string[][] = [];
  const context: ToolContext = {
    state: {},
    runtime: {
      sourceLanguage: "Python", targetLanguage: "Python", sourceProjectPath: root, targetProjectPath: root,
      sourcePath: "src/a.py", targetPath: firstTarget.path, targetFunction: firstTarget,
      sourceDirectory: "src", targetDirectory: "src", testRoots: [testRoot], testRunner: "pytest",
      targetTest: { executable: "python3", args: ["-m", "pytest"] },
      functionGroup: {
        schemaVersion: "3.1", sourceLanguage: "Python", targetLanguage: "Python",
        sourceProjectPath: root, targetProjectPath: root, requirement: "Each function preserves its public behavior.",
        functions: targets.map(target => ({ source: target, target })),
      },
    },
    runner: { run: async () => { throw new Error("unused"); } },
    functionGroupRunner: { run: async paths => {
      calls.push([...paths]);
      return structuredClone({ ...result, testPaths: [...paths] });
    } },
  };
  return { root, result, context, calls };
}

const success = { testExecutionStatus: "success", translationStatus: "success" } as const;
const defect = {
  testExecutionStatus: "failure", translationStatus: "failure",
  issue: { kind: "translation", description: "The implementation violates the public requirement." },
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("function-group tools", () => {
  it.each([null, { kind: "none", description: "All tests passed." }])("accepts a no-issue success sentinel without trusting it as test evidence: %j", async issue => {
    const { context, result, calls } = await fixture();
    const tool = createFinishFunctionGroupTool()(context);
    const input = tool.parse({ ...success, issue });
    expect(input.issue).toBeUndefined();
    const accepted = await tool.execute(input);
    expect(accepted.functionGroupTest.tests.passed).toBe(2);
    expect(tool.isTerminal?.(accepted)).toBe(true);
    expect(calls).toEqual([[secondTest, firstTest]]);
    result.functions[0]!.status = "unverified";
    result.functions[0]!.executed = false;
    const uncovered = await tool.execute(input);
    expectContinue(tool, uncovered, "every requested target function");
    expect(uncovered.functionGroupTest.functions[0]!.executed).toBe(false);
    result.status = "failure";
    expectContinue(tool, await tool.execute(input), "compile and execute");
  });

  it("runs and updates pre-existing files inside the dedicated folder and rejects sibling tests", async () => {
    const { root, context, calls } = await fixture();
    await writeFile(join(root, "tests/outside.test.py"), "outside");
    await writeFile(join(root, "tests.xml"), "test report");
    const tool = createRunFunctionGroupTestsTool()(context);
    const paths = [firstTest, secondTest];
    const actual = await tool.execute(tool.parse({ paths }));
    expect(actual.testPaths).toEqual(paths);
    expect(actual.reportPaths).toEqual(["tests.xml"]);
    const reader = createReadTargetFileTool()(context);
    expect(await reader.execute(reader.parse({ path: actual.reportPaths![0] })))
      .toEqual({ path: "tests.xml", content: "test report" });
    expect(context.state.lastFunctionGroupTest).toEqual(actual);
    await createWriteTargetTestTool()(context).execute({ path: firstTest, content: "def test_updated(): pass" });
    expect(context.state.lastFunctionGroupTest).toBeUndefined();
    expect((await reader.execute({ path: firstTest })).content).toBe("def test_updated(): pass");
    await expect(tool.execute({ paths })).resolves.toMatchObject({ testPaths: paths });
    calls.length = 0;
    await expect(tool.execute({ paths: ["tests/outside.test.py"] })).rejects.toThrow("outside the authorized test roots");
    await expect(tool.execute({ paths: [firstTest, "tests/outside.test.py"] })).rejects.toThrow("outside the authorized test roots");
    expect(calls).toEqual([]);
  });

  it("returns fresh failures to the Agent and allows another finish after debugging", async () => {
    const { context, result, calls } = await fixture([firstTarget, secondTarget]);
    result.status = "failure";
    result.tests = { executed: 2, passed: 1, failed: 1, skipped: 0 };
    result.exitCode = 1;
    result.failures = [{ message: "expected 1, received 2", testPath: secondTest, suspectedFunctions: [secondTarget] }];
    const tool = createFinishFunctionGroupTool()(context);
    const first = await tool.execute(success);
    expectContinue(tool, first, "testExecutionStatus does not match the Host result");
    expect(first.functionGroupTest).toMatchObject({
      tests: { failed: 1 }, failures: [{ message: "expected 1, received 2" }], reportPaths: ["tests.xml"],
    });
    expectContinue(tool, await tool.execute({ testExecutionStatus: "failure", translationStatus: "success" }),
      "translationStatus does not match the Host result");
    result.status = "success";
    result.tests = { executed: 2, passed: 2, failed: 0, skipped: 0 };
    result.exitCode = 0;
    result.failures = [];
    const repaired = await tool.execute(success);
    expect(tool.isTerminal?.(repaired)).toBe(true);
    expect(repaired.functionGroupTest).toMatchObject({ status: "success", tests: { failed: 0 } });
    expect(calls).toEqual([[secondTest, firstTest], [secondTest, firstTest], [secondTest, firstTest]]);
  });

  it("runs all current tests when paths are omitted", async () => {
    const { context, calls } = await fixture([firstTarget, secondTarget]);
    const tool = createRunFunctionGroupTestsTool()(context);
    expect(tool.parse({})).toEqual({});
    await expect(tool.execute(tool.parse({}))).resolves.toMatchObject({ testPaths: [secondTest, firstTest] });
    expect(calls).toEqual([[secondTest, firstTest]]);
  });

  it("rejects skipped tests when claiming complete-suite success", async () => {
    const { context, result } = await fixture();
    result.tests.skipped = 1;
    const tool = createFinishFunctionGroupTool()(context);
    const output = await tool.execute(success);
    expectContinue(tool, output, "without skipped tests");
    expect(output.functionGroupTest.tests.skipped).toBe(1);
  });

  it("allows an empty first baseline without invoking the runner", async () => {
    const { root, context, calls } = await fixture();
    await rm(join(root, testRoot), { recursive: true });
    await expect(createRunFunctionGroupTestsTool()(context).execute({ paths: [testRoot] }))
      .resolves.toMatchObject({ status: "success", tests: { executed: 0 }, testPaths: [], reportPaths: [] });
    expect(calls).toEqual([]);
  });

  it("expands authorized directories, deduplicates overlapping selections, and rejects outside directories before execution", async () => {
    const { root, context, calls } = await fixture();
    await writeFile(join(root, testRoot, "nested/fixture.txt"), "fixture");
    await mkdir(join(root, "tests/translation-verifier-other"));
    const tool = createRunFunctionGroupTestsTool()(context);
    const result = await tool.execute({ paths: [testRoot, firstTest, `${testRoot}/nested`] });
    expect(result.testPaths).toEqual([secondTest, firstTest]);
    expect(calls).toEqual([[secondTest, firstTest]]);
    calls.length = 0;
    await tool.execute({ paths: [`${testRoot}/nested`] });
    expect(calls).toEqual([[secondTest]]);
    calls.length = 0;
    for (const outside of ["tests", "tests/translation-verifier-other"]) {
      await expect(tool.execute({ paths: [testRoot, outside] })).rejects.toThrow("outside the authorized test roots");
    }
    expect(calls).toEqual([]);
  });

  it("requires every upstream target to execute, including targets omitted by a runner result", async () => {
    const { context, result } = await fixture([firstTarget, secondTarget]);
    const tool = createFinishFunctionGroupTool()(context);
    result.functions[1]!.status = "unverified";
    result.functions[1]!.executed = false;
    expectContinue(tool, await tool.execute(success), "every requested target function");
    result.functions.pop();
    const omitted = await tool.execute(success);
    expectContinue(tool, omitted, "every requested target function");
    expect(omitted.functionGroupTest.functions).toHaveLength(1);
  });

  it("runs the entire current test folder instead of trusting an earlier selected run", async () => {
    const { context, calls } = await fixture([firstTarget, secondTarget]);
    await createRunFunctionGroupTestsTool()(context).execute({ paths: [firstTest] });
    calls.length = 0;
    const tool = createFinishFunctionGroupTool()(context);
    const actual = await tool.execute(tool.parse(success));
    expect(calls).toEqual([[secondTest, firstTest]]);
    expect(actual.functionGroupTest.functions.map(({ target }) => target.name).sort()).toEqual(["a", "b"]);
    expect(actual.functionGroupTest.testPaths).toEqual([secondTest, firstTest]);
    expect(actual.functionGroupTest.tests).toEqual({ executed: 2, passed: 2, failed: 0, skipped: 0 });
    expect(tool.isTerminal?.(actual)).toBe(true);
    for (const status of ["failed", "ambiguous"]) {
      const feedback = await tool.execute(tool.parse({ ...success,
        protocolChecks: [{ ruleId: "public-boundary", status }] }));
      expectContinue(tool, feedback, "Cannot claim verification success");
      expect(feedback.functionGroupTest.tests.passed).toBe(2);
    }
  });

  it("uses the fresh full-suite result after earlier assertion failures", async () => {
    const { context, result } = await fixture();
    result.status = "failure";
    result.tests = { executed: 2, passed: 0, failed: 2, skipped: 0 };
    result.failures = [{ message: "old assertion", suspectedFunctions: [firstTarget] }];
    result.exitCode = 1;
    await createRunFunctionGroupTestsTool()(context).execute({ paths: [firstTest] });
    expect(context.state.lastFunctionGroupTest?.status).toBe("failure");
    result.status = "success";
    result.tests = { executed: 2, passed: 2, failed: 0, skipped: 0 };
    result.failures = [];
    result.exitCode = 0;
    const tool = createFinishFunctionGroupTool()(context);
    await expect(tool.execute(tool.parse(success)))
      .resolves.toMatchObject({ translationStatus: "success", functionGroupTest: { status: "success", tests: { executed: 2, passed: 2, failed: 0 } } });
  });

  it("treats a newly validated complete suite as authoritative after a broken fixture", async () => {
    const { context, result } = await fixture();
    result.status = "failure";
    result.tests = { executed: 0, passed: 0, failed: 0, skipped: 0 };
    result.failures = [{ message: "fixture did not compile", suspectedFunctions: [] }];
    result.stderr = "compile error";
    result.exitCode = 1;
    await createRunFunctionGroupTestsTool()(context).execute({ paths: [firstTest] });
    expect(context.state.lastFunctionGroupTest?.tests.executed).toBe(0);
    result.status = "success";
    result.tests = { executed: 2, passed: 2, failed: 0, skipped: 0 };
    result.failures = [];
    result.stderr = "";
    result.exitCode = 0;
    const tool = createFinishFunctionGroupTool()(context);
    const actual = await tool.execute(tool.parse(success));
    expect(actual.functionGroupTest).toMatchObject({ status: "success", failures: [], testPaths: [secondTest, firstTest] });
  });

  it("rejects a reported defect if any suite test cannot compile", async () => {
    const { context, result } = await fixture();
    result.status = "failure";
    result.tests = { executed: 0, passed: 0, failed: 0, skipped: 0 };
    result.stderr = "test collection failed: SyntaxError";
    result.exitCode = 1;
    const tool = createFinishFunctionGroupTool()(context);
    const output = await tool.execute(defect);
    expectContinue(tool, output, "compile and execute");
    expect(output.functionGroupTest).toMatchObject({ stderr: "test collection failed: SyntaxError", tests: { executed: 0 } });
  });

  it("allows a real assertion failure to report a defect after the complete suite executes every target", async () => {
    const { context, result, calls } = await fixture([firstTarget, secondTarget]);
    result.status = "failure";
    result.tests = { executed: 2, passed: 1, failed: 1, skipped: 0 };
    result.exitCode = 1;
    result.functions.forEach(item => { item.status = "unverified"; });
    result.failures = [{ message: "expected result differs", testPath: secondTest, suspectedFunctions: [secondTarget] }];
    const tool = createFinishFunctionGroupTool()(context);
    const accepted = await tool.execute(tool.parse(defect));
    expect(accepted).toMatchObject({
      translationStatus: "failure", issue: { kind: "translation" },
      functionGroupTest: { tests: { executed: 2, failed: 1 }, testPaths: [secondTest, firstTest] },
    });
    expect(tool.isTerminal?.(accepted)).toBe(true);
    expect(calls).toEqual([[secondTest, firstTest]]);
    result.executionErrors = 1;
    expectContinue(tool, await tool.execute(defect), "compile and execute");
    result.executionErrors = 0;
    result.tests.skipped = 1;
    expectContinue(tool, await tool.execute(defect), "without skipped tests");
    result.tests.skipped = 0;
    result.functions[1]!.executed = false;
    expectContinue(tool, await tool.execute(defect), "every requested target function");
  });
});
