import type { ProtocolCheck, VerificationIssue, VerificationReason } from "../../types.js";
import { hasUnresolvedTestFailures, snapshotTest, testEvidence } from "../test-evidence.js";
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
  protocolChecks?: ProtocolCheck[];
};

export type FinishFunctionGroupResult = FinishFunctionGroupInput & {
  functionGroupTest: FunctionGroupTestRun;
  testEvidence?: import("../../types.js").VerificationTestEvidence;
};

function mergeFunctionGroupTests(runs: readonly FunctionGroupTestRun[]): FunctionGroupTestRun {
  const latest = runs[runs.length - 1];
  if (!latest) throw new Error("Run run_function_group_tests before finish_function_group.");
  // Merge current execution/coverage separately from immutable failure history.
  // A green latest run cannot discharge historical failures in testEvidence.
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
        byFunction.set(key, { ...previous, ...item });
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
  if (Object.keys(input).some((key) => !["testExecutionStatus", "translationStatus", "issue", "protocolChecks"].includes(key))) {
    throw new Error("finish_function_group contains unknown fields.");
  }
  const noIssue = input.issue === null || (
    input.testExecutionStatus === "success" && input.translationStatus === "success" &&
    typeof input.issue === "object" && input.issue !== null && !Array.isArray(input.issue) &&
    (input.issue as Record<string, unknown>).kind === "none" &&
    Object.keys(input.issue).every(key => key === "kind" || key === "description")
  );
  // Some providers include a no-issue sentinel even when this optional field
  // should be omitted. It adds no facts; execution still checks Host evidence.
  const issue = parseIssue(noIssue ? undefined : input.issue);
  const translationStatus = input.translationStatus as "success" | "failure";
  if (translationStatus === "success" && issue !== undefined) {
    throw new Error("A successful function-group verification cannot include an issue.");
  }
  if (translationStatus === "failure" && issue === undefined) {
    throw new Error("finish_function_group.issue is required when translationStatus is failure.");
  }
  const protocolChecks = input.protocolChecks === undefined ? undefined : parseProtocolChecks(input.protocolChecks);
  return {
    testExecutionStatus: input.testExecutionStatus as "success" | "failure",
    translationStatus,
    ...(issue ? { issue } : {}),
    ...(protocolChecks ? { protocolChecks } : {}),
  };
}

function parseProtocolChecks(value: unknown): ProtocolCheck[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error("finish_function_group.protocolChecks must contain at most three checks.");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid protocol check.");
    const item = raw as Record<string, unknown>;
    if (typeof item.ruleId !== "string" || !item.ruleId.trim() || !["passed", "failed", "ambiguous", "not-applicable"].includes(String(item.status))) throw new Error("Invalid protocol check.");
    if (item.testName !== undefined && typeof item.testName !== "string") throw new Error("Invalid protocol check testName.");
    if (item.note !== undefined && typeof item.note !== "string") throw new Error("Invalid protocol check note.");
    return { ruleId: item.ruleId.trim().slice(0, 200), status: item.status as ProtocolCheck["status"], ...(typeof item.testName === "string" ? { testName: item.testName.slice(0, 200) } : {}), ...(typeof item.note === "string" ? { note: item.note.slice(0, 500) } : {}) };
  });
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
    description: `Finish ${context.runtime.sourceLanguage} to ${context.runtime.targetLanguage} verification after reporting the Host-observed result for every target function. On success pass testExecutionStatus and translationStatus. Include up to three protocolChecks when the task supplies a module protocol.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["testExecutionStatus", "translationStatus"],
      properties: {
        testExecutionStatus: { enum: ["success", "failure"] },
        translationStatus: { enum: ["success", "failure"] },
        issue: { anyOf: [{ type: "null" }, {
          type: "object", additionalProperties: false, required: ["kind", "description"],
          properties: {
            kind: { enum: ["translation", "test", "environment", "unknown"] },
            description: { type: "string", minLength: 1 },
          },
        }] },
        protocolChecks: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["ruleId", "status"], properties: { ruleId: { type: "string", minLength: 1 }, status: { enum: ["passed", "failed", "ambiguous", "not-applicable"] }, testName: { type: "string" }, note: { type: "string" } } } },
      },
    },
    parse: parseFinishFunctionGroupInput,
    async execute(input) {
      const result = mergeFunctionGroupTests(context.state.functionGroupTests ?? []);
      const evidence = testEvidence(context);
      for (const path of result.testPaths) {
        const observed = evidence.runs.findLast(run => run.versions.some(version => version.path === path))?.versions.find(version => version.path === path);
        if (observed && (await snapshotTest(context, path)).sha256 !== observed.sha256) {
          throw new Error("Tests changed after their last Host run. Execute the current version before finishing.");
        }
      }
      if (input.testExecutionStatus !== result.status) {
        throw new Error(`finish_function_group.testExecutionStatus does not match the Host result: expected ${result.status}.`);
      }
      if (hasUnresolvedTestFailures(evidence) && result.status === "success") {
        return {
          ...input, translationStatus: "failure" as const,
          issue: { kind: "unknown" as const, description: "Host-observed test failures remain unresolved. A later green run does not establish requirement compliance; review the retained failing versions and correction evidence." },
          functionGroupTest: result, testEvidence: structuredClone(evidence),
        };
      }
      if (input.translationStatus !== result.status) {
        throw new Error(`finish_function_group.translationStatus does not match the Host result: expected ${result.status}.`);
      }
      if (input.translationStatus === "success") {
        if (input.protocolChecks?.some(check => check.status === "failed" || check.status === "ambiguous")) {
          throw new Error("Cannot claim verification success with failed or ambiguous requirement checks. Retain the failing assertion or report_uncertain.");
        }
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
        testEvidence: structuredClone(evidence),
      };
    },
  });
}
