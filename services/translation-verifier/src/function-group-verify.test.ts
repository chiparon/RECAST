import { describe, expect, it } from "vitest";
import { createFunctionGroupVerifier } from "./function-group-verify.js";
import type { AgentTask } from "./host/agent.js";
import type { FunctionGroupVerificationInput, RequirementFunctionGroupVerificationInput } from "./types.js";
import { createRequirementFunctionGroupTask, createSingleAgentFunctionGroupTask } from "./strategies/single-agent-function-group/strategy.js";

const input: FunctionGroupVerificationInput = {
  schemaVersion: "3.1",
  sourceLanguage: "C#",
  targetLanguage: "Java",
  sourceProjectPath: "/tmp/source",
  targetProjectPath: "/tmp/target",
  requirement: "Preserve price calculation behavior.",
  functions: [
    {
      source: { path: "src/OrderService.cs", name: "CalculatePrice" },
      target: { path: "src/OrderService.java", name: "calculatePrice" },
    },
    {
      source: { path: "src/PriceRule.cs", name: "Apply" },
      target: { path: "src/PriceRule.java", name: "apply" },
    },
  ],
};

describe("createFunctionGroupVerifier", () => {
  it("keeps execution evidence without labeling an uncertain requirement verified", async () => {
    const verify = createFunctionGroupVerifier({ run: async () => ({
      outcome: "uncertain" as const, testExecutionStatus: "success" as const,
      issue: { kind: "unknown" as const, description: "A public requirement remains ambiguous." },
      functionGroupTest: { status: "success" as const, reason: "verified" as const, testPaths: ["tests/group.py"],
        tests: { executed: 1, passed: 1, failed: 0, skipped: 0 },
        functions: input.functions.map(({ target }) => ({ target, status: "passed" as const,
          executed: true, lineCoverage: 100, branchCoverage: null })),
        failures: [], stdout: "", stderr: "", exitCode: 0 },
    }) });
    const result = await verify(input, "single-agent-function-group", "verify");
    expect(result.status).toBe("failure");
    expect(result.reason).toBeUndefined();
    expect(result.functions.every(fn => fn.executed)).toBe(true);
  });

  it("dispatches the function-group single-agent strategy", async () => {
    let task: AgentTask | undefined;
    const verify = createFunctionGroupVerifier({
      run: (value) => {
        task = value;
        return {
          testExecutionStatus: "success" as const,
          translationStatus: "success" as const,
          functionGroupTest: {
            status: "success" as const,
            testPaths: ["tests/all.test.py"],
            tests: { executed: 1, passed: 1, failed: 0, skipped: 0 },
            functions: input.functions.map(({ source, target }) => ({
            source,
            target,
            status: "passed" as const,
            executed: true,
            lineCoverage: 100,
            branchCoverage: null,
            })),
            failures: [],
            stdout: "",
            stderr: "",
            exitCode: 0,
          },
        };
      },
    });

    await expect(
      verify(input, "single-agent-function-group", "verify"),
    ).resolves.toMatchObject({ status: "success" });
    expect(task?.functionGroup).toEqual(input);
    expect(task?.userPrompt).toContain("calculatePrice");
    expect(task?.userPrompt).toContain("apply");
  });

  it("does not accept the function-level strategy name", async () => {
    const verify = createFunctionGroupVerifier({ run: async () => ({
      testExecutionStatus: "failure",
      translationStatus: "failure",
      issue: { kind: "unknown", description: "failed" },
      functionGroupTest: {
        status: "failure",
        testPaths: [],
        tests: { executed: 0, passed: 0, failed: 0, skipped: 0 },
        functions: [],
        failures: [],
        stdout: "",
        stderr: "",
        exitCode: 1,
      },
    }) });

    await expect(
      verify(input, "single-agent" as "single-agent-function-group", "verify"),
    ).rejects.toThrow("Unknown function-group verification strategy: single-agent");
  });

  it("rejects an empty or duplicate function group before invoking the Agent", async () => {
    const verify = createFunctionGroupVerifier({ run: async () => {
      throw new Error("Agent should not run");
    } });
    await expect(verify({ ...input, functions: [] }, "single-agent-function-group", "verify"))
      .rejects.toThrow("at least one function");
    await expect(verify({ ...input, functions: [input.functions[0]!, input.functions[0]!] }, "single-agent-function-group", "verify"))
      .rejects.toThrow("Duplicate target function");
  });

  it("exposes the function-group tool set without changing function-level names", () => {
    const task = createSingleAgentFunctionGroupTask(input);
    expect(task.tools.map((factory) => factory({
      state: {},
      runtime: {
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        sourceProjectPath: input.sourceProjectPath,
        targetProjectPath: input.targetProjectPath,
        sourcePath: input.functions[0]!.source.path,
        targetPath: input.functions[0]!.target.path,
        targetFunction: input.functions[0]!.target,
        functionGroup: input,
        sourceDirectory: "src",
        targetDirectory: "src",
        testRoots: ["tests"],
        testRunner: "pytest" as const,
        targetTest: { executable: "python3", args: ["-m", "pytest"] },
      },
      runner: { run: async () => { throw new Error("unused"); } },
      functionGroupRunner: { run: async () => { throw new Error("unused"); } },
    })).map((tool) => tool.name)).toEqual([
      "list_source_files",
      "read_source_file",
      "list_target_files",
      "read_target_file",
      "write_target_test",
      "run_function_group_tests",
      "finish_function_group",
      "report_uncertain",
    ]);
  });

  it("runs requirement-only verification without source tools", async () => {
    const requirementInput: RequirementFunctionGroupVerificationInput = {
      schemaVersion: "3.1",
      mode: "requirement",
      sourceLanguage: "C#",
      targetLanguage: "C#",
      targetProjectPath: "/tmp/target",
      requirement: "Reject expired tenant scopes.",
      functions: [{ target: { path: "src/TenantScope.cs", name: "IsExpired" } }],
    };
    let task: AgentTask | undefined;
    const verify = createFunctionGroupVerifier({
      run: (value) => {
        task = value;
        return {
          testExecutionStatus: "success" as const,
          translationStatus: "success" as const,
          functionGroupTest: {
            status: "success" as const,
            testPaths: ["tests/TenantScope.test.cs"],
            tests: { executed: 1, passed: 1, failed: 0, skipped: 0 },
            functions: [{ target: requirementInput.functions[0]!.target, status: "passed" as const, executed: true, lineCoverage: 100, branchCoverage: null }],
            failures: [],
            stdout: "",
            stderr: "",
            exitCode: 0,
          },
        };
      },
    });
    await expect(verify(requirementInput, "requirement-function-group", "verify"))
      .resolves.toMatchObject({ status: "success" });
    expect(task?.userPrompt).toContain("Reject expired tenant scopes.");
    expect(task?.tools.map((factory) => factory({
      state: {},
      runtime: {
        sourceLanguage: "C#", targetLanguage: "C#", sourceProjectPath: "/tmp/target", targetProjectPath: "/tmp/target",
        sourcePath: "src/TenantScope.cs", targetPath: "src/TenantScope.cs",
        targetFunction: requirementInput.functions[0]!.target, functionGroup: requirementInput,
        sourceDirectory: "src", targetDirectory: "src", testRoots: ["tests"], testRunner: "dotnet" as const,
        targetTest: { executable: "dotnet", args: ["test"] },
      },
      runner: { run: async () => { throw new Error("unused"); } },
      functionGroupRunner: { run: async () => { throw new Error("unused"); } },
    })).map((tool) => tool.name)).toEqual([
      "list_target_files", "read_target_file", "write_target_test",
      "run_function_group_tests", "finish_function_group", "report_uncertain",
    ]);
  });
});
