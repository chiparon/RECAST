import type { BoundTestRunner } from "../test-runner.js";
import type {
  FunctionGroupVerificationInput,
  FunctionGroupFunctionResult,
  RequirementFunctionGroupVerificationInput,
  TargetFunctionCoverage,
  VerificationFunction,
  VerificationReason,
  VerificationTestCase,
  VerificationTestEvidence,
} from "../../types.js";
import type { AgentRunBudget } from "../agent.js";

export { MAX_TEXT_FILE_CHARS, relativePath, assertTestPath, resolveSafePath, readProjectFile } from "./project-files.js";
export const MAX_TEST_OUTPUT_CHARS = 64_000;

export type HostTool<Input, Output> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parse(input: unknown): Input;
  execute(input: Input): Promise<Output>;
};

export type HostToolFactory = (context: ToolContext) => HostTool<any, any>;

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
  tests?: TestSummary;
  coverage?: TargetCoverageResult;
};

export type FunctionGroupTestRun = {
  status: "success" | "failure";
  testPaths: string[];
  tests: TestSummary;
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
  testEvidence?: VerificationTestEvidence;
};

export type FunctionGroupTestRunner = {
  run(testPaths: readonly string[]): Promise<FunctionGroupTestRun>;
};

export type AgentTaskContext = {
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

export type ToolState = {
  lastTargetTest?: TargetTestResult;
  lastFunctionGroupTest?: FunctionGroupTestRun;
  functionGroupTests?: FunctionGroupTestRun[];
  testEvidence?: VerificationTestEvidence;
};

export type ToolContext = {
  state: ToolState;
  budget?: AgentRunBudget;
  runtime: ToolRuntimeContext;
  runner: BoundTestRunner;
  functionGroupRunner?: FunctionGroupTestRunner;
  /** Trusted Host callback, never controlled by tool arguments or Agent claims. */
  reviewTestCorrection?: import("../test-evidence.js").TestCorrectionReviewer;
};
