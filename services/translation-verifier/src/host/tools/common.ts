import type { BoundTestRunner } from "../testing/test-runner.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  FunctionGroupVerificationInput,
  FunctionGroupFunctionResult,
  RequirementFunctionGroupVerificationInput,
  TargetFunctionCoverage,
  VerificationFunction,
  VerificationReason,
  VerificationTestCase,
} from "../../types.js";
import type { AgentRunBudget } from "../agent/run-budget.js";

export { MAX_TEXT_FILE_CHARS, relativePath, assertTestPath, resolveSafePath, readProjectFile } from "./project-files.js";
export const MAX_TEST_OUTPUT_CHARS = 64_000;

/** A strategy-selected native LangChain tool bound to this run's Host context. */
export type HostToolFactory = (context: ToolContext) => StructuredToolInterface;

export type TestRunner =
  | "maven"
  | "gradle"
  | "pytest"
  | "jest"
  | "vitest"
  | "cmake"
  | "dotnet";

export type TargetTest = {
  executable: string;
  args: readonly string[];
  timeoutMs?: number;
};

export type TestSummary = {
  /** Tests actually executed, excluding skipped tests. */
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
};

export type TargetCoverageResult =
  | { status: "available"; targetFunction: TargetFunctionCoverage }
  | { status: "unavailable"; reason: string };

export type TargetTestResult = {
  status: "success" | "failure";
  timedOut: boolean;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Host-selected executable test files included in this run. */
  testPaths?: string[];
  tests?: TestSummary;
  /** Compilation, collection, or runner errors, distinct from failed assertions. */
  executionErrors?: number;
  testCases?: VerificationTestCase[];
  coverage?: TargetCoverageResult;
  /** Fresh report files, relative to the target project, readable with read_target_file. */
  reportPaths?: string[];
};

export type FunctionGroupTestRun = {
  status: "success" | "failure";
  /** True when the Host terminated the test process after its deadline. */
  timedOut?: boolean;
  testPaths: string[];
  tests: TestSummary;
  executionErrors?: number;
  functions: FunctionGroupFunctionResult[];
  failures: Array<{
    message: string;
    testPath?: string;
    suspectedFunctions: VerificationFunction[];
  }>;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  reason?: VerificationReason;
  testCases?: VerificationTestCase[];
  /** Fresh report files, relative to the target project, readable with read_target_file. */
  reportPaths?: string[];
};

export type FunctionGroupTestRunner = {
  run(testPaths: readonly string[]): Promise<FunctionGroupTestRun>;
};

export type AgentTaskContext = {
  requirement?: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceProjectPath: string;
  targetProjectPath: string;
  sourcePath: string;
  targetPath: string;
  targetFunction: VerificationFunction;
  /** Present only for the function-group strategy. */
  functionGroup?: FunctionGroupVerificationInput | RequirementFunctionGroupVerificationInput;
};

export type ToolRuntimeContext = AgentTaskContext & {
  sourceDirectory: string;
  targetDirectory: string;
  testRoots: readonly string[];
  testRunner: TestRunner;
  targetTest: TargetTest;
  /** Host-owned cleanup for an ephemeral test harness created for this run. */
  cleanup?: () => Promise<void>;
};

export type ToolContext = {
  budget?: AgentRunBudget;
  state?: ToolState;
  recordArtifacts?: () => Promise<void>;
  testHistory?: import("../verification/test-history.js").TestHistory;
  runtime: ToolRuntimeContext;
  runner: BoundTestRunner;
  functionGroupRunner?: FunctionGroupTestRunner;
};

/** Only Host observations and test delivery state; never model-owned claims. */
export type ToolState = {
  lastFunctionGroupTest?: FunctionGroupTestRun;
  functionGroupTests?: FunctionGroupTestRun[];
  testEvidence?: import("../../types.js").VerificationTestEvidence;
};
