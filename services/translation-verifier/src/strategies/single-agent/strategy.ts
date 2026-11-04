import { skillInstruction } from "../../../../../skills/compiled.mjs";
import type { AgentHost, AgentTask } from "../../host/agent/task.js";
import type { AgentHostResult } from "../../host/verification/report.js";
import {
  createListSourceFilesTool,
  createListTargetFilesTool,
} from "../../host/tools/list-files.js";
import { createReadSourceFileTool } from "../../host/tools/read-source-file.js";
import { createReadTargetFileTool } from "../../host/tools/read-target-file.js";
import { createRunTargetTestsTool } from "../../host/tools/run-target-tests.js";
import { createWriteTargetTestTool } from "../../host/tools/write-target-test.js";
import type {
  VerificationInput,
  VerificationResult,
  VerificationStrategy,
} from "../../types.js";

function formatEntity(entity: { path: string; name: string; signature?: string }): string {
  const signature = entity.signature ? ` (${entity.signature})` : "";
  return `${entity.name}${signature} in ${entity.path}`;
}

function toVerificationResult(
  result: AgentHostResult,
): VerificationResult {
  return {
    status: result.verdict === "no-bug" ? "success" : "failure",
    ...(result.issue ? { issue: result.issue } : {}),
    ...(result.targetFunction ? { targetFunction: { ...result.targetFunction } } : {}),
    ...(result.testEvidence ? { testEvidence: result.testEvidence } : {}),
  };
}

/** Task for the LangChain Host: the Agent ends with a plain JSON report. */
export function createFinalReportTask(input: VerificationInput): AgentTask {
  return {
    taskContext: {
      requirement: input.subject.requirement,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      sourceProjectPath: input.sourceProjectPath,
      targetProjectPath: input.targetProjectPath,
      sourcePath: input.subject.sourceFunction.path,
      targetPath: input.subject.targetFunction.path,
      targetFunction: { ...input.subject.targetFunction },
    },
    systemPrompt: skillInstruction("verifier", "source-function/instructions"),
    userPrompt: [
      `Source reference function: ${formatEntity(input.subject.sourceFunction)}`,
      `Target function to verify: ${formatEntity(input.subject.targetFunction)}`,
      `Source language: ${input.sourceLanguage}`,
      `Target language: ${input.targetLanguage}`,
      `Requirement: ${input.subject.requirement}`,
      "Use the analysis report and migration plan as supporting evidence, but validate behavior with the target test.",
      `Analysis report: ${JSON.stringify(input.analysisReport)}`,
      `Migration plan: ${JSON.stringify(input.migrationPlan)}`,
      `Translation round: ${input.translation.round}`,
    ].join("\n"),
    tools: [
      createListSourceFilesTool(),
      createReadSourceFileTool(),
      createListTargetFilesTool(),
      createReadTargetFileTool(),
      createWriteTargetTestTool(),
      createRunTargetTestsTool(),
    ],
  };
}

/** The minimal strategy: compare source and target, test the target, then report. */
export function createSingleAgentStrategy(
  host: AgentHost<AgentHostResult>,
): VerificationStrategy<VerificationResult> {
  return {
    verify: async (input) => {
      return toVerificationResult(await host.run(createFinalReportTask(input)));
    },
  };
}
