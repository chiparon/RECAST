import type { VerificationIssue, VerificationReason } from "../../types.js";
import {
  type FunctionGroupTestRun,
  type HostTool,
  type HostToolFactory,
  type ToolContext,
} from "./common.js";

export type FinishFunctionGroupInput = {
  testExecutionStatus: FunctionGroupTestRun["status"];
  translationStatus: "success" | "failure";
  issue?: VerificationIssue;
};

export type FinishFunctionGroupResult = FinishFunctionGroupInput & {
  functionGroupTest: FunctionGroupTestRun;
};

function mergeFunctionGroupTests(runs: readonly FunctionGroupTestRun[]): FunctionGroupTestRun {
  const latest = runs[runs.length - 1];
  if (!latest) throw new Error("Run run_function_group_tests before finish_function_group.");
  // A verifier may first run a pre-existing/broken fixture and then replace
  // it with one corrected test set. When the final Host run is successful and
  // covers every target function, that final run is the authoritative test
  // environment. Keeping the obsolete failure would turn a test-authoring
  // repair into a production translation failure.
  const allFunctionKeys = new Set(runs.flatMap((run) => run.functions.map((item) =>
    `${item.target.path}\0${item.target.name}\0${item.target.signature ?? ""}`,
  )));
  const latestFunctionKeys = new Set(latest.functions.map((item) =>
    `${item.target.path}\0${item.target.name}\0${item.target.signature ?? ""}`,
  ));
  const latestIsComplete = latest.status === "success" && latest.tests.executed > 0 && latest.tests.failed === 0 &&
    latest.functions.length > 0 && latestFunctionKeys.size === allFunctionKeys.size &&
    [...allFunctionKeys].every((key) => latestFunctionKeys.has(key)) &&
    latest.functions.every((item) => item.status === "passed" && item.executed);
  if (latestIsComplete) {
    return {
      ...latest,
      testPaths: [...latest.testPaths],
      functions: latest.functions.map((item) => ({ ...item })),
      failures: [],
      reason: "verified",
    };
  }
  // An agent commonly reruns the same generated test file after fixing an
  // assertion or a fixture.  That retry supersedes the earlier observation;
  // retaining the old failure would make a final passing run impossible to
  // finish.  Keep separate test-file runs so a function group can still be
  // covered by more than one file, while replacing exact-path retries with
  // their newest Host result.
  const latestByPathSet = new Map<string, FunctionGroupTestRun>();
  for (const run of runs) {
    const key = [...run.testPaths].sort().join("\0");
    latestByPathSet.set(key, run);
  }
  const effectiveRuns = [...latestByPathSet.values()];
  const tests = effectiveRuns.reduce(
    (total, run) => ({
      executed: total.executed + run.tests.executed,
      passed: total.passed + run.tests.passed,
      failed: total.failed + run.tests.failed,
      skipped: total.skipped + run.tests.skipped,
    }),
    { executed: 0, passed: 0, failed: 0, skipped: 0 },
  );
  const byFunction = new Map<string, FunctionGroupTestRun["functions"][number]>();
  for (const run of effectiveRuns) {
    for (const item of run.functions) {
      const key = `${item.target.path}\0${item.target.name}\0${item.target.signature ?? ""}`;
      const previous = byFunction.get(key);
      if (!previous || (item.status === "passed" && previous.status === "unverified")) {
        byFunction.set(key, { ...item });
      } else if (item.executed && !previous.executed) {
        byFunction.set(key, { ...previous, ...item, status: "passed" });
      }
    }
  }
  return {
    ...latest,
    status: effectiveRuns.some((run) => run.status === "failure") ? "failure" : "success",
    tests,
    testPaths: [...new Set(effectiveRuns.flatMap((run) => run.testPaths))],
    functions: [...byFunction.values()],
    failures: effectiveRuns.flatMap((run) => run.failures),
    reason: mergeReason(effectiveRuns, [...byFunction.values()]),
  };
}

function mergeReason(
  runs: readonly FunctionGroupTestRun[],
  functions: readonly FunctionGroupTestRun["functions"][number][],
): VerificationReason {
  if (runs.some((run) => run.reason === "test-failed" || run.status === "failure")) return "test-failed";
  if (functions.some((item) => item.reason === "coverage-unavailable")) return "coverage-unavailable";
  if (functions.some((item) => item.reason === "not-executed" || !item.executed)) return "not-executed";
  return "verified";
}

function parseFinishFunctionGroupInput(value: unknown): FinishFunctionGroupInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("testExecutionStatus" in value) ||
    !("translationStatus" in value)
  ) {
    throw new Error("finish_function_group requires testExecutionStatus and translationStatus.");
  }
  const input = value as Record<string, unknown>;
  if (!(["success", "failure"] as const).includes(input.testExecutionStatus as "success" | "failure")) {
    throw new Error("finish_function_group.testExecutionStatus is invalid.");
  }
  if (!(["success", "failure"] as const).includes(input.translationStatus as "success" | "failure")) {
    throw new Error("finish_function_group.translationStatus is invalid.");
  }
  if (Object.keys(input).some((key) => !["testExecutionStatus", "translationStatus", "issue"].includes(key))) {
    throw new Error("finish_function_group contains unknown fields.");
  }
  const issue = parseIssue(input.issue);
  const translationStatus = input.translationStatus as "success" | "failure";
  if (translationStatus === "success" && issue !== undefined) {
    throw new Error("A successful function-group verification cannot include an issue.");
  }
  if (translationStatus === "failure" && issue === undefined) {
    throw new Error("finish_function_group.issue is required when translationStatus is failure.");
  }
  return {
    testExecutionStatus: input.testExecutionStatus as "success" | "failure",
    translationStatus,
    ...(issue ? { issue } : {}),
  };
}

function parseIssue(value: unknown): VerificationIssue | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("finish_function_group.issue must contain kind and description.");
  }
  const issue = value as Record<string, unknown>;
  if (Object.keys(issue).some((key) => !["kind", "description"].includes(key)) ||
      !["translation", "test", "environment", "unknown"].includes(String(issue.kind)) ||
      typeof issue.description !== "string" || !issue.description.trim()) {
    throw new Error("finish_function_group.issue is invalid.");
  }
  return {
    kind: issue.kind as VerificationIssue["kind"],
    description: issue.description,
  };
}

export function createFinishFunctionGroupTool(): HostToolFactory {
  return (context: ToolContext): HostTool<FinishFunctionGroupInput, FinishFunctionGroupResult> => ({
    name: "finish_function_group",
    description: `Finish ${context.runtime.sourceLanguage} to ${context.runtime.targetLanguage} verification after reporting the Host-observed result for every target function in the function group.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["testExecutionStatus", "translationStatus"],
      properties: {
        testExecutionStatus: { enum: ["success", "failure"] },
        translationStatus: { enum: ["success", "failure"] },
        issue: { type: "object" },
      },
    },
    parse: parseFinishFunctionGroupInput,
    async execute(input) {
      const result = mergeFunctionGroupTests(context.state.functionGroupTests ?? []);
      if (input.testExecutionStatus !== result.status) {
        throw new Error(`finish_function_group.testExecutionStatus does not match the Host result: expected ${result.status}.`);
      }
      if (input.translationStatus !== result.status) {
        throw new Error(`finish_function_group.translationStatus does not match the Host result: expected ${result.status}.`);
      }
      if (input.translationStatus === "success") {
        if (result.tests.executed < 1 || result.tests.failed > 0) {
          throw new Error("Successful function-group verification requires executed, passing tests.");
        }
        const unverified = result.functions.filter((item) => item.status !== "passed" || !item.executed);
        if (unverified.length > 0) {
          throw new Error(`Successful function-group verification requires every target function to pass: ${unverified.map((item) => item.target.name).join(", ")}`);
        }
      }
      return {
        ...input,
        functionGroupTest: result,
      };
    },
  });
}
