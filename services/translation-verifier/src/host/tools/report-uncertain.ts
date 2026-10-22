import {
  type HostTool,
  type HostToolFactory,
  type FunctionGroupTestRun,
  type TargetTestResult,
  type ToolContext,
} from "./common.js";
import { type FinishIssue } from "./finish.js";

export type ReportUncertainInput = {
  issue: FinishIssue;
};

type FunctionReportUncertainResult = {
  outcome: "uncertain";
  testExecutionStatus: TargetTestResult["status"];
  issue: FinishIssue;
  targetTest: TargetTestResult;
};

type FunctionGroupReportUncertainResult = {
  outcome: "uncertain";
  testExecutionStatus: FunctionGroupTestRun["status"];
  issue: FinishIssue;
  functionGroupTest: FunctionGroupTestRun;
};

export type ReportUncertainResult = FunctionReportUncertainResult | FunctionGroupReportUncertainResult;

function parseReportUncertainInput(value: unknown): ReportUncertainInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("issue" in value)
  ) {
    throw new Error("report_uncertain requires an issue.");
  }
  const raw = value as { issue: unknown };
  if (
    typeof raw.issue !== "object" ||
    raw.issue === null ||
    Array.isArray(raw.issue)
  ) {
    throw new Error("report_uncertain.issue must contain kind and description.");
  }
  const issue = raw.issue as { kind?: unknown; description?: unknown };
  if (
    !["translation", "test", "environment", "unknown"].includes(
      String(issue.kind),
    ) ||
    typeof issue.description !== "string" ||
    !issue.description.trim()
  ) {
    throw new Error("report_uncertain.issue is invalid.");
  }
  if (
    Object.keys(issue).some((key) => key !== "kind" && key !== "description")
  ) {
    throw new Error("report_uncertain.issue contains unknown fields.");
  }
  return {
    issue: {
      kind: issue.kind as FinishIssue["kind"],
      description: issue.description,
    },
  };
}

export function createReportUncertainTool(): HostToolFactory {
  return (context: ToolContext): HostTool<ReportUncertainInput, ReportUncertainResult> => ({
    name: "report_uncertain",
    description: `Report uncertainty for ${context.runtime.sourceLanguage} to ${context.runtime.targetLanguage} verification when the target test result cannot establish translation correctness.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue"],
      properties: {
        issue: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "description"],
          properties: {
            kind: {
              enum: ["translation", "test", "environment", "unknown"],
            },
            description: { type: "string" },
          },
        },
      },
    },
    parse: parseReportUncertainInput,
    async execute(input) {
      if (context.runtime.functionGroup !== undefined) {
        const functionGroupTest = context.state.lastFunctionGroupTest;
        if (functionGroupTest === undefined) {
          throw new Error("Run run_function_group_tests before report_uncertain.");
        }
        return {
          outcome: "uncertain" as const,
          testExecutionStatus: functionGroupTest.status,
          issue: { ...input.issue },
          functionGroupTest,
        };
      }
      const targetTest = context.state.lastTargetTest;
      if (targetTest !== undefined) {
        return {
          outcome: "uncertain" as const,
          testExecutionStatus: targetTest.status,
          issue: { ...input.issue },
          targetTest,
        };
      }
      throw new Error("Run run_target_tests before report_uncertain.");
    },
  });
}
