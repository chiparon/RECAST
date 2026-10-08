import type { AgentHost, AgentTask } from "../../host/agent.js";
import {
  createListSourceFilesTool,
  createListTargetFilesTool,
} from "../../host/tools/list-files.js";
import { createReadSourceFileTool } from "../../host/tools/read-source-file.js";
import { createReadTargetFileTool } from "../../host/tools/read-target-file.js";
import { createReportUncertainTool } from "../../host/tools/report-uncertain.js";
import { createWriteTargetTestTool } from "../../host/tools/write-target-test.js";
import { createRunFunctionGroupTestsTool } from "../../host/tools/run-function-group-tests.js";
import { createFinishFunctionGroupTool } from "../../host/tools/finish-function-group.js";
import type {
  FunctionGroupVerificationInput,
  FunctionGroupVerificationResult,
  FunctionGroupVerificationStrategy,
  RequirementFunctionGroupVerificationInput,
} from "../../types.js";
import type { ReportUncertainResult } from "../../host/tools/report-uncertain.js";
import type { FinishFunctionGroupResult } from "../../host/tools/finish-function-group.js";

function formatFunction(path: string, name: string, signature?: string): string {
  return `${name}${signature ? ` (${signature})` : ""} in ${path}`;
}

export type SingleAgentFunctionGroupTerminalResult =
  | FinishFunctionGroupResult
  | Extract<ReportUncertainResult, { functionGroupTest: unknown }>;

function toVerificationResult(
  result: SingleAgentFunctionGroupTerminalResult,
): FunctionGroupVerificationResult {
  const test = result.functionGroupTest;
  return {
    status: "translationStatus" in result ? result.translationStatus : "failure",
    ...(test.reason ? { reason: test.reason } : {}),
    ...(result.issue ? { issue: result.issue } : {}),
    functions: test.functions,
  };
}

export function createSingleAgentFunctionGroupTask(
  input: FunctionGroupVerificationInput,
): AgentTask {
  const first = input.functions[0];
  if (!first) throw new Error("Function-group verification requires at least one function.");
  return {
    subject: {
      sourceFunction: first.source,
      targetFunction: first.target,
      requirement: input.requirement,
    },
    taskContext: {
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      sourceProjectPath: input.sourceProjectPath,
      targetProjectPath: input.targetProjectPath,
      sourcePath: first.source.path,
      targetPath: first.target.path,
      targetFunction: { ...first.target },
      functionGroup: input,
    },
    functionGroup: input,
    systemPrompt: [
      "You are a translation verification agent for a group of target functions.",
      "Compare each source function with its mapped target function and determine whether the target preserves the required behavior.",
      "Use only the provided tools and project-relative paths.",
      "Inspect the relevant source and target files before making a judgment.",
      "Create tests for the target function group in authorized target test roots, run run_function_group_tests, and use the Host result as the test status.",
      "The Host records a separate result for every target function; do not infer or invent coverage values.",
      "After the final test run, call finish_function_group with statuses matching the Host result.",
      "If the task cannot be verified reliably, call report_uncertain instead of guessing.",
      "A terminal tool call must be the only call in its turn.",
    ].join("\n"),
    userPrompt: [
      `Source language: ${input.sourceLanguage}`,
      `Target language: ${input.targetLanguage}`,
      `Requirement: ${input.requirement}`,
      "Function mappings:",
      ...input.functions.map(({ source, target }) =>
        `- ${formatFunction(source.path, source.name, source.signature)} -> ${formatFunction(target.path, target.name, target.signature)}`,
      ),
      ...(input.unmatchedFunctions?.length
        ? [`Unmatched target functions (do not claim they were source-verified): ${input.unmatchedFunctions.map((item) => formatFunction(item.path, item.name, item.signature)).join(", ")}`]
        : []),
    ].join("\n"),
    tools: [
      createListSourceFilesTool(),
      createReadSourceFileTool(),
      createListTargetFilesTool(),
      createReadTargetFileTool(),
      createWriteTargetTestTool(),
      createRunFunctionGroupTestsTool(),
      createFinishFunctionGroupTool(),
      createReportUncertainTool(),
    ],
    terminalTools: ["finish_function_group", "report_uncertain"],
  };
}

export function createSingleAgentFunctionGroupStrategy(
  host: AgentHost<SingleAgentFunctionGroupTerminalResult>,
): FunctionGroupVerificationStrategy<FunctionGroupVerificationResult> {
  return {
    verify: async (input) =>
      toVerificationResult(await host.run(createSingleAgentFunctionGroupTask(input))),
  };
}

/**
 * Requirement-only verification used when retrieval cannot establish a
 * trustworthy source/target mapping. It keeps the same Host-controlled test
 * runner, but the Agent judges the target against the requirement and target
 * contracts instead of pretending a historical source exists.
 */
export function createRequirementFunctionGroupTask(
  input: RequirementFunctionGroupVerificationInput,
): AgentTask {
  const first = input.functions[0];
  if (!first) throw new Error("Requirement function-group verification requires at least one function.");
  return {
    subject: {
      // AgentTask keeps a subject for shared host bookkeeping. This synthetic
      // value is never exposed as historical evidence or offered to a source
      // reading tool.
      sourceFunction: first.target,
      targetFunction: first.target,
      requirement: input.requirement,
    },
    taskContext: {
      sourceLanguage: input.targetLanguage,
      targetLanguage: input.targetLanguage,
      sourceProjectPath: input.targetProjectPath,
      targetProjectPath: input.targetProjectPath,
      sourcePath: first.target.path,
      targetPath: first.target.path,
      targetFunction: { ...first.target },
      functionGroup: input,
    },
    functionGroup: input,
    systemPrompt: [
      "You are a requirement verification agent for a group of target functions.",
      "Judge whether the target implementation satisfies the stated requirement and its existing target contracts.",
      "There is no historical source implementation in this mode. Do not claim translation equivalence or invent source evidence.",
      "Use only the provided target and test tools.",
      "Inspect the relevant target files before making a judgment.",
      "Use one test file for this run when possible; inspect the authorized test directory first and update an existing file instead of creating duplicate test classes.",
      "Do not guess a test path such as tests/ or Test/. The Host will state the exact authorized test root in the task message; copy that prefix exactly.",
      "Write the smallest useful test that exercises the listed public functions. Run it immediately after writing it. If compilation fails, use the complete Host stderr to repair the same file; do not create a second test class.",
      "Create tests for the target function group in authorized target test roots, run run_function_group_tests, and use the Host result as the test status.",
      "The Host records a separate result for every target function; do not infer or invent coverage values.",
      "After the final test run, call finish_function_group with statuses matching the Host result.",
      "If the requirement cannot be verified reliably, call report_uncertain instead of guessing.",
      "A terminal tool call must be the only call in its turn.",
    ].join("\n"),
    userPrompt: [
      `Target language: ${input.targetLanguage}`,
      `Requirement: ${input.requirement}`,
      "Target functions:",
      ...input.functions.map(({ target }) => `- ${formatFunction(target.path, target.name, target.signature)}`),
    ].join("\n"),
    tools: [
      createListTargetFilesTool(),
      createReadTargetFileTool(),
      createWriteTargetTestTool(),
      createRunFunctionGroupTestsTool(),
      createFinishFunctionGroupTool(),
      createReportUncertainTool(),
    ],
    terminalTools: ["finish_function_group", "report_uncertain"],
  };
}

export function createRequirementFunctionGroupStrategy(
  host: AgentHost<SingleAgentFunctionGroupTerminalResult>,
): FunctionGroupVerificationStrategy<FunctionGroupVerificationResult> {
  return {
    verify: async (input) =>
      toVerificationResult(await host.run(createRequirementFunctionGroupTask(input as unknown as RequirementFunctionGroupVerificationInput))),
  };
}
