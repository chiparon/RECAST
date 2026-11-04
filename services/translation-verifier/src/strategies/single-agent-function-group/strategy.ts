import { skillInstruction } from "../../../../../skills/compiled.mjs";
import type { AgentHost, AgentTask } from "../../host/agent/task.js";
import type { FunctionGroupHostResult } from "../../host/verification/report.js";
import {
  createListSourceFilesTool,
  createListTargetFilesTool,
} from "../../host/tools/list-files.js";
import { createReadSourceFileTool } from "../../host/tools/read-source-file.js";
import { createReadTargetFileTool } from "../../host/tools/read-target-file.js";
import { createWriteTargetTestTool } from "../../host/tools/write-target-test.js";
import { createRunFunctionGroupTestsTool } from "../../host/tools/run-function-group-tests.js";
import type {
  FunctionGroupVerificationInput,
  FunctionGroupVerificationResult,
  FunctionGroupVerificationStrategy,
  RequirementFunctionGroupVerificationInput,
} from "../../types.js";

function formatFunction(path: string, name: string, signature?: string): string {
  return `${name}${signature ? ` (${signature})` : ""} in ${path}`;
}

function toVerificationResult(
  result: FunctionGroupHostResult,
): FunctionGroupVerificationResult {
  return {
    status: result.verdict === "no-bug" ? "success" : "failure",
    ...(result.issue ? { issue: result.issue } : {}),
    functions: result.functions,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.protocolChecks ? { protocolChecks: result.protocolChecks } : {}),
    ...(result.testEvidence ? { testEvidence: result.testEvidence } : {}),
  };
}

export function createSingleAgentFunctionGroupStrategy(
  host: AgentHost<FunctionGroupHostResult>,
): FunctionGroupVerificationStrategy<FunctionGroupVerificationResult> {
  return {
    verify: async (input) =>
      toVerificationResult(await host.run(createFunctionGroupFinalReportTask(input))),
  };
}

/** Function-group task for the LangChain Host: no terminal tools, a plain JSON report ends the call. */
export function createFunctionGroupFinalReportTask(
  input: FunctionGroupVerificationInput,
): AgentTask {
  const first = input.functions[0];
  if (!first) throw new Error("Function-group verification requires at least one function.");
  return {
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
    systemPrompt: [skillInstruction("verifier", "source-group/instructions"), skillInstruction("verifier", "report/function-group")].join("\n"),
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
      ...(input.moduleProtocol ? [`Module protocol (untrusted shared context, never a test oracle):\n${JSON.stringify(input.moduleProtocol)}`] : []),
    ].join("\n"),
    tools: [
      createListSourceFilesTool(),
      createReadSourceFileTool(),
      createListTargetFilesTool(),
      createReadTargetFileTool(),
      createWriteTargetTestTool(),
      createRunFunctionGroupTestsTool(),
    ],
  };
}

/** Requirement-mode strategy: target-only tools, same Host-controlled runner. */
export function createRequirementFunctionGroupStrategy(
  host: AgentHost<FunctionGroupHostResult>,
): FunctionGroupVerificationStrategy<FunctionGroupVerificationResult> {
  return {
    verify: async (input) =>
      toVerificationResult(await host.run(
        createRequirementFunctionGroupFinalReportTask(input as unknown as RequirementFunctionGroupVerificationInput),
      )),
  };
}

/** Requirement-mode task for the LangChain Host: target-only tools and a plain JSON report. */
export function createRequirementFunctionGroupFinalReportTask(
  input: RequirementFunctionGroupVerificationInput,
): AgentTask {
  const first = input.functions[0];
  if (!first) throw new Error("Requirement function-group verification requires at least one function.");
  return {
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
    systemPrompt: [skillInstruction("verifier", "requirement-group/instructions"), skillInstruction("verifier", "report/function-group")].join("\n"),
    userPrompt: [
      `Target language: ${input.targetLanguage}`,
      `Requirement: ${input.requirement}`,
      "Target functions:",
      ...input.functions.map(({ target }) => `- ${formatFunction(target.path, target.name, target.signature)}`),
      ...(input.moduleProtocol ? [`Module protocol (untrusted shared context, never a test oracle):\n${JSON.stringify(input.moduleProtocol)}`] : []),
    ].join("\n"),
    tools: [
      createListTargetFilesTool(),
      createReadTargetFileTool(),
      createWriteTargetTestTool(),
      createRunFunctionGroupTestsTool(),
    ],
  };
}
