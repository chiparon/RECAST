import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRunFunctionGroupTestsTool } from "./run-function-group-tests.js";
import { createFinishFunctionGroupTool } from "./finish-function-group.js";
import type { ToolContext } from "./common.js";

describe("function-group tools", () => {
  it("runs multiple authorized test files and records the Host result", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-function-group-"));
    try {
      await mkdir(join(root, "tests"), { recursive: true });
      await writeFile(join(root, "tests", "one.test.py"), "");
      await writeFile(join(root, "tests", "two.test.py"), "");
      const result = {
        status: "success" as const,
        testPaths: ["tests/one.test.py", "tests/two.test.py"],
        tests: { executed: 2, passed: 2, failed: 0, skipped: 0 },
        functions: [{
          source: { path: "src/a.py", name: "a" },
          target: { path: "src/A.py", name: "a" },
          status: "passed" as const,
          executed: true,
          lineCoverage: 100,
          branchCoverage: null,
        }],
        failures: [],
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      };
      const context: ToolContext = {
        state: {},
        runtime: {
          sourceLanguage: "Python",
          targetLanguage: "Python",
          sourceProjectPath: root,
          targetProjectPath: root,
          sourcePath: "src/a.py",
          targetPath: "src/A.py",
          targetFunction: { path: "src/A.py", name: "a" },
          sourceDirectory: "src",
          targetDirectory: "src",
          testRoots: ["tests"],
          testRunner: "pytest",
          targetTest: { executable: "python3", args: ["-m", "pytest"] },
        },
        runner: { run: async () => { throw new Error("unused"); } },
        functionGroupRunner: { run: async (paths) => ({ ...result, testPaths: [...paths] }) },
      };
      const tool = createRunFunctionGroupTestsTool()(context);
      const actual = await tool.execute(tool.parse({ paths: ["tests/one.test.py", "tests/two.test.py"] }));
      expect(actual.testPaths).toEqual(["tests/one.test.py", "tests/two.test.py"]);
      expect(context.state.lastFunctionGroupTest).toEqual(actual);
      expect(context.state.functionGroupTests).toEqual([actual]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires every target function to pass before a successful finish", async () => {
    const context = {
      state: {
        functionGroupTests: [{
          status: "success" as const,
          testPaths: ["tests/all.test.py"],
          tests: { executed: 1, passed: 1, failed: 0, skipped: 0 },
          functions: [{
            source: { path: "src/a.py", name: "a" },
            target: { path: "src/A.py", name: "a" },
            status: "unverified" as const,
            executed: false,
            lineCoverage: null,
            branchCoverage: null,
          }],
          failures: [],
          stdout: "",
          stderr: "",
          exitCode: 0,
        }],
      },
      runtime: {
        sourceLanguage: "Python",
        targetLanguage: "Python",
        sourceProjectPath: "/tmp/source",
        targetProjectPath: "/tmp/target",
        sourcePath: "src/a.py",
        targetPath: "src/A.py",
        targetFunction: { path: "src/A.py", name: "a" },
        sourceDirectory: "src",
        targetDirectory: "src",
        testRoots: ["tests"],
        testRunner: "pytest" as const,
        targetTest: { executable: "python3", args: ["-m", "pytest"] },
      },
      runner: { run: async () => { throw new Error("unused"); } },
    } satisfies ToolContext;
    const tool = createFinishFunctionGroupTool()(context);
    await expect(tool.execute(tool.parse({ testExecutionStatus: "success", translationStatus: "success" })))
      .rejects.toThrow("every target function");
  });

  it("merges results from separate test-file runs by target function", async () => {
    const base = {
      source: { path: "src/a.py", name: "a" },
      target: { path: "src/A.py", name: "a" },
      lineCoverage: 100,
      branchCoverage: null,
    };
    const context = {
      state: {
        functionGroupTests: [
          {
            status: "success" as const,
            testPaths: ["tests/a.test.py"],
            tests: { executed: 1, passed: 1, failed: 0, skipped: 0 },
            functions: [{ ...base, status: "passed" as const, executed: true }],
            failures: [],
            stdout: "",
            stderr: "",
            exitCode: 0,
          },
          {
            status: "success" as const,
            testPaths: ["tests/b.test.py"],
            tests: { executed: 1, passed: 1, failed: 0, skipped: 0 },
            functions: [{
              source: { path: "src/b.py", name: "b" },
              target: { path: "src/B.py", name: "b" },
              status: "passed" as const,
              executed: true,
              lineCoverage: 90,
              branchCoverage: null,
            }],
            failures: [],
            stdout: "",
            stderr: "",
            exitCode: 0,
          },
        ],
      },
      runtime: {
        sourceLanguage: "Python", targetLanguage: "Python", sourceProjectPath: "/tmp/source", targetProjectPath: "/tmp/target",
        sourcePath: "src/a.py", targetPath: "src/A.py", targetFunction: base.target,
        sourceDirectory: "src", targetDirectory: "src", testRoots: ["tests"], testRunner: "pytest" as const,
        targetTest: { executable: "python3", args: ["-m", "pytest"] },
      },
      runner: { run: async () => { throw new Error("unused"); } },
    } satisfies ToolContext;
    const tool = createFinishFunctionGroupTool()(context);
    const result = await tool.execute(tool.parse({ testExecutionStatus: "success", translationStatus: "success" }));
    expect(result.functionGroupTest.functions.map(({ target }) => target.name).sort()).toEqual(["a", "b"]);
    expect(result.functionGroupTest.testPaths).toEqual(["tests/a.test.py", "tests/b.test.py"]);
    expect(result.functionGroupTest.tests).toEqual({ executed: 2, passed: 2, failed: 0, skipped: 0 });
  });

  it("uses the newest result when an agent reruns the same test file", async () => {
    const target = { path: "src/A.py", name: "a" };
    const context = {
      state: {
        functionGroupTests: [
          {
            status: "failure" as const,
            testPaths: ["tests/all.test.py"],
            tests: { executed: 2, passed: 0, failed: 2, skipped: 0 },
            functions: [{ target, status: "unverified" as const, executed: false, lineCoverage: null, branchCoverage: null }],
            failures: [{ message: "test authoring assertion" }],
            stdout: "",
            stderr: "",
            exitCode: 1,
          },
          {
            status: "success" as const,
            testPaths: ["tests/all.test.py"],
            tests: { executed: 2, passed: 2, failed: 0, skipped: 0 },
            functions: [{ target, status: "passed" as const, executed: true, lineCoverage: 100, branchCoverage: null }],
            failures: [],
            stdout: "ok",
            stderr: "",
            exitCode: 0,
          },
        ],
      },
      runtime: {
        sourceLanguage: "Python", targetLanguage: "Python", sourceProjectPath: "/tmp/source", targetProjectPath: "/tmp/target",
        sourcePath: "src/a.py", targetPath: target.path, targetFunction: target,
        sourceDirectory: "src", targetDirectory: "src", testRoots: ["tests"], testRunner: "pytest" as const,
        targetTest: { executable: "python3", args: ["-m", "pytest"] },
      },
      runner: { run: async () => { throw new Error("unused"); } },
    } satisfies ToolContext;
    const tool = createFinishFunctionGroupTool()(context);
    await expect(tool.execute(tool.parse({ testExecutionStatus: "success", translationStatus: "success" })))
      .resolves.toMatchObject({ functionGroupTest: { status: "success", tests: { executed: 2, passed: 2, failed: 0 } } });
  });

  it("treats a complete final test set as authoritative after a broken fixture", async () => {
    const target = { path: "src/A.py", name: "a" };
    const context = {
      state: {
        functionGroupTests: [
          {
            status: "failure" as const,
            testPaths: ["tests/old.test.py"],
            tests: { executed: 0, passed: 0, failed: 1, skipped: 0 },
            functions: [{ target, status: "unverified" as const, executed: false, lineCoverage: null, branchCoverage: null }],
            failures: [{ message: "fixture did not compile" }], stdout: "", stderr: "compile error", exitCode: 1,
          },
          {
            status: "success" as const,
            testPaths: ["tests/repaired.test.py"],
            tests: { executed: 1, passed: 1, failed: 0, skipped: 0 },
            functions: [{ target, status: "passed" as const, executed: true, lineCoverage: 100, branchCoverage: null }],
            failures: [], stdout: "ok", stderr: "", exitCode: 0,
          },
        ],
      },
      runtime: {
        sourceLanguage: "Python", targetLanguage: "Python", sourceProjectPath: "/tmp/source", targetProjectPath: "/tmp/target",
        sourcePath: "src/a.py", targetPath: target.path, targetFunction: target,
        sourceDirectory: "src", targetDirectory: "src", testRoots: ["tests"], testRunner: "pytest" as const,
        targetTest: { executable: "python3", args: ["-m", "pytest"] },
      },
      runner: { run: async () => { throw new Error("unused"); } },
    } satisfies ToolContext;
    const tool = createFinishFunctionGroupTool()(context);
    const result = await tool.execute(tool.parse({ testExecutionStatus: "success", translationStatus: "success" }));
    expect(result.functionGroupTest).toMatchObject({ status: "success", reason: "verified", failures: [], testPaths: ["tests/repaired.test.py"] });
  });
});
