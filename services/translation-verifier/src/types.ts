import type { AnalysisReport, FilePatch } from "@forexplore/contracts";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type VerificationFunction = {
  /** Project-relative file path containing the function. */
  path: string;
  name: string;
  signature?: string;
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
};

export type RequirementFunctionGroupVerificationInput = {
  schemaVersion: "3.1";
  mode: "requirement";
  sourceLanguage: string;
  targetLanguage: string;
  targetProjectPath: string;
  requirement: string;
  functions: RequirementFunctionGroupVerificationFunction[];
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
  | "model-failure";

export type TargetFunctionCoverage = {
  name: string;
  executed: boolean;
  /** Percentage from 0 to 100; null when no lines can be measured. */
  lineCoverage: number | null;
  /** Percentage from 0 to 100; null when the function has no branches. */
  branchCoverage: number | null;
};

export type VerificationResult = {
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
};

export type FunctionGroupVerificationResult = {
  status: "success" | "failure";
  issue?: VerificationIssue;
  functions: FunctionGroupFunctionResult[];
  reason?: VerificationReason;
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
