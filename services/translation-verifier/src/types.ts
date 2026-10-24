import type { AnalysisReport, FilePatch, ModuleProtocol } from "@forexplore/contracts";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type RetainedTestSuite = {
  schemaVersion: 1;
  id: string;
  directory: string;
  framework: 'maven' | 'gradle' | 'pytest' | 'jest' | 'vitest' | 'cmake' | 'dotnet';
  testRoots: string[];
  testPaths: string[];
  files: Array<{ path: string; sha256: string }>;
  status: 'not-run' | 'passed' | 'failed' | 'unverified';
  command: string;
};

export type TestRetention = {
  /** Stable caller-owned identity, normally a pipeline module ID. */
  id: string;
  onUpdate?(root: string, suite: RetainedTestSuite, evidence?: VerificationTestEvidence): Promise<void>;
};

export type VerificationFunction = {
  /** Project-relative file path containing the function. */
  path: string;
  name: string;
  signature?: string;
  /** Host-discovered declaration location, used to distinguish C++ overloads. */
  startLine?: number;
};

export type VerificationSubject = {
  sourceFunction: VerificationFunction;
  targetFunction: VerificationFunction;
  requirement: string;
};

export type Translation = {
  round: number;
  generatedContent?: string;
  files: FilePatch[];
};

export type VerificationInput = {
  schemaVersion: "2.0";
  sourceLanguage: string;
  targetLanguage: string;
  /** Absolute path to the project containing the source code being translated. */
  sourceProjectPath: string;
  /** Absolute path to the project receiving the translated code. */
  targetProjectPath: string;
  subject: VerificationSubject;
  analysisReport: AnalysisReport;
  migrationPlan: JsonValue;
  translation: Translation;
};

export type FunctionGroupVerificationFunction = {
  source: VerificationFunction;
  target: VerificationFunction;
};

/** A target-only function subject used when no trustworthy source mapping exists. */
export type RequirementFunctionGroupVerificationFunction = {
  target: VerificationFunction;
};

export type FunctionGroupVerificationInput = {
  schemaVersion: "3.1";
  sourceLanguage: string;
  targetLanguage: string;
  sourceProjectPath: string;
  targetProjectPath: string;
  requirement: string;
  functions: FunctionGroupVerificationFunction[];
  /** Target functions for which no trustworthy source reference was found. */
  unmatchedFunctions?: VerificationFunction[];
  /** Bounded shared protocol view; advisory context only. */
  moduleProtocol?: ModuleProtocol;
  /** Host failure facts preserved across module retries. */
  testEvidence?: VerificationTestEvidence;
};

export type RequirementFunctionGroupVerificationInput = {
  schemaVersion: "3.1";
  mode: "requirement";
  sourceLanguage: string;
  targetLanguage: string;
  targetProjectPath: string;
  requirement: string;
  functions: RequirementFunctionGroupVerificationFunction[];
  moduleProtocol?: ModuleProtocol;
  /** Host failure facts preserved across module retries. */
  testEvidence?: VerificationTestEvidence;
};

export type VerificationIssueKind =
  | "translation"
  | "test"
  | "environment"
  | "unknown";

export type VerificationIssue = {
  kind: VerificationIssueKind;
  description: string;
};

export type VerificationReason =
  | "verified"
  | "not-executed"
  | "coverage-unavailable"
  | "test-failed"
  | "test-environment-failure"
  | "mapping-invalid"
  | "agent-timeout"
  | "model-failure"
  | "unresolved-test-failure";

export type TargetFunctionCoverage = {
  name: string;
  executed: boolean;
  /** Percentage from 0 to 100; null when no lines can be measured. */
  lineCoverage: number | null;
  /** Percentage from 0 to 100; null when the function has no branches. */
  branchCoverage: number | null;
};

export type VerificationResult = {
  testEvidence?: VerificationTestEvidence;
  status: "success" | "failure";
  issue?: VerificationIssue;
  targetFunction?: TargetFunctionCoverage;
};

export type FunctionGroupFunctionResult = {
  /** Present for translation-fidelity verification; omitted for requirement-only verification. */
  source?: VerificationFunction;
  target: VerificationFunction;
  status: "passed" | "unverified";
  executed: boolean;
  lineCoverage: number | null;
  branchCoverage: number | null;
  /** Host-derived explanation for the observed function result. */
  reason?: VerificationReason;
  /** Concrete Host diagnostic when per-function coverage could not be collected. */
  coverageIssue?: string;
};

export type ProtocolCheck = {
  ruleId: string;
  status: "passed" | "failed" | "ambiguous" | "not-applicable";
  testName?: string;
  note?: string;
};

export type FunctionGroupVerificationResult = {
  status: "success" | "failure";
  issue?: VerificationIssue;
  functions: FunctionGroupFunctionResult[];
  reason?: VerificationReason;
  protocolChecks?: ProtocolCheck[];
  /** Host failure facts and automatic correction decisions. */
  testEvidence?: VerificationTestEvidence;
};

export type VerificationTestCase = {
  id: string;
  status: "passed" | "failed" | "skipped";
  message?: string;
};

export type VerificationTestVersion = {
  path: string;
  sha256: string;
  /** Immutable Host snapshot, relative to the target project. */
  artifactPath: string;
};

export type VerificationTestCorrection = {
  failureId: string;
  reason: string;
  /** Exact excerpt from the supplied public requirement. */
  requirementEvidence: string;
};

/** Minimal failure history retained for retries and changed-assertion checks. */
export type VerificationTestEvidence = {
  runs: Array<{
    id: string;
    status: "success" | "failure";
    tests: { executed: number; passed: number; failed: number; skipped: number };
    testCases: VerificationTestCase[];
    versions: VerificationTestVersion[];
    /** Host revision count at execution, including auxiliary fixtures written through its tools. */
    revisionCount?: number;
  }>;
  failures: Array<{
    id: string;
    runId: string;
    testId: string;
    message: string;
    versions: VerificationTestVersion[];
    status: "unresolved" | "resolved";
    resolution?: {
      kind: "unchanged-test-replayed" | "reviewed-test-correction" | "suite-revalidated";
      runId: string;
      reason: string;
      requirementEvidence?: string;
      reviewNote?: string;
      replacementTestIds?: string[];
    };
  }>;
  revisions: Array<{
    path: string;
    before?: VerificationTestVersion;
    after: VerificationTestVersion;
    corrections?: Array<VerificationTestCorrection & {
      status: "proposed" | "confirmed" | "unconfirmed";
      reviewNote?: string;
      /** Host-reviewed identities from the actual passing test report. */
      replacementTestIds?: string[];
    }>;
  }>;
};

export type VerificationPhase = "prepare" | "verify";

export type StrategyHandler<Result = unknown> = (
  input: VerificationInput,
) => Result | Promise<Result>;

export type VerificationStrategy<Result = unknown> = Partial<
  Record<VerificationPhase, StrategyHandler<Result>>
>;

export type FunctionGroupVerificationStrategy<Result = unknown> = Partial<
  Record<
    VerificationPhase,
    (input: FunctionGroupVerificationInput) => Result | Promise<Result>
  >
>;
