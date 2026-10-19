import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { VerificationTestCorrection, VerificationTestEvidence } from "../../types.js";
import { recordTestRevision, testEvidence } from "../test-evidence.js";
import {
  assertTestPath,
  relativePath,
  resolveSafePath,
  type HostTool,
  type HostToolFactory,
  type ToolContext,
  MAX_TEXT_FILE_CHARS,
} from "./common.js";

export type WriteTargetTestInput = {
  path: string;
  content: string;
  corrections?: VerificationTestCorrection[];
};

export type WriteTargetTestOutput = {
  path: string;
  testEvidence?: VerificationTestEvidence;
};

function parseWriteTargetTestInput(value: unknown): WriteTargetTestInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !["path", "content", "corrections"].includes(key)) ||
    !("path" in value) ||
    !("content" in value)
  ) {
    throw new Error("write_target_test requires path and content, with optional corrections.");
  }
  const input = value as { path: unknown; content: unknown; corrections?: unknown };
  const path = relativePath(input.path, "test path");
  if (typeof input.content !== "string") {
    throw new Error("write_target_test.content must be a string.");
  }
  if (
    input.content.includes("\0") ||
    input.content.length > MAX_TEXT_FILE_CHARS
  ) {
    throw new Error("Test content is invalid or exceeds the text-file size limit.");
  }
  let corrections: VerificationTestCorrection[] | undefined;
  if (input.corrections !== undefined) {
    if (!Array.isArray(input.corrections) || input.corrections.length > 50) throw new Error("Invalid test corrections.");
    corrections = input.corrections.map(raw => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw).some(key => !["failureId", "reason", "requirementEvidence"].includes(key)) ||
        [raw.failureId, raw.reason, raw.requirementEvidence].some(value => typeof value !== "string" || !value.trim() || value.length > 8000)) {
        throw new Error("Test corrections require failureId, reason and an exact public requirementEvidence excerpt.");
      }
      return { failureId: raw.failureId, reason: raw.reason, requirementEvidence: raw.requirementEvidence };
    });
  }
  return { path, content: input.content, ...(corrections ? { corrections } : {}) };
}

function rootsDescription(testRoots: readonly string[]): string {
  return testRoots.length > 0 ? testRoots.join(", ") : "(none)";
}

export function createWriteTargetTestTool(): HostToolFactory {
  return (context: ToolContext): HostTool<WriteTargetTestInput, WriteTargetTestOutput> => {
    const testRoots = context.runtime.testRoots.map((root) =>
      relativePath(root, "test root"),
    );
    if (testRoots.length === 0) {
      throw new Error("write_target_test requires at least one test root.");
    }

    return {
      name: "write_target_test",
      description: `Create or update a focused ${context.runtime.targetLanguage} target test under these project-relative test roots: ${rootsDescription(testRoots)}.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          corrections: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false,
            required: ["failureId", "reason", "requirementEvidence"], properties: {
              failureId: { type: "string" }, reason: { type: "string" }, requirementEvidence: { type: "string" },
            } } },
        },
      },
      parse: parseWriteTargetTestInput,
      async execute(input) {
        context.budget?.assertActive();
        const path = relativePath(input.path, "test path");
        assertTestPath(path, testRoots);
        const target = resolveSafePath(context.runtime.targetProjectPath, path);
        if (context.runtime.functionGroup) await recordTestRevision(context, path, input.content, input.corrections);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, input.content, { encoding: "utf8" });
        context.state.lastTargetTest = undefined;
        return { path, ...(context.runtime.functionGroup ? { testEvidence: structuredClone(testEvidence(context)) } : {}) };
      },
    };
  };
}
