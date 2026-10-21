import { stat } from "node:fs/promises";
import { recordTestRun, snapshotTest } from "../test-evidence.js";
import {
  assertTestPath,
  relativePath,
  resolveSafePath,
  type FunctionGroupTestRun,
  type HostTool,
  type HostToolFactory,
  type ToolContext,
} from "./common.js";

export type RunFunctionGroupTestsInput = {
  paths: string[];
};

function parseRunFunctionGroupTestsInput(value: unknown): RunFunctionGroupTestsInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("paths" in value)
  ) {
    throw new Error("run_function_group_tests requires only paths.");
  }
  const paths = (value as { paths: unknown }).paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("run_function_group_tests requires at least one path.");
  }
  return {
    paths: paths.map((path) => relativePath(path, "test path")),
  };
}

export function createRunFunctionGroupTestsTool(): HostToolFactory {
  return (context: ToolContext): HostTool<RunFunctionGroupTestsInput, FunctionGroupTestRun> => {
    const testRoots = context.runtime.testRoots.map((root) => relativePath(root, "test root"));
    if (testRoots.length === 0) {
      throw new Error("run_function_group_tests requires at least one test root.");
    }
    if (!context.functionGroupRunner) {
      throw new Error("run_function_group_tests requires a function-group test runner.");
    }

    return {
      name: "run_function_group_tests",
      description: `Run one or more authorized ${context.runtime.targetLanguage} target test files for the bound function group. The Host selects the test command and coverage targets.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["paths"],
        properties: { paths: { type: "array", items: { type: "string" }, minItems: 1 } },
      },
      parse: parseRunFunctionGroupTestsInput,
      async execute(input) {
        context.budget?.assertActive();
        for (const path of input.paths) {
          assertTestPath(path, testRoots);
          const absoluteTestPath = resolveSafePath(context.runtime.targetProjectPath, path);
          let testStat: Awaited<ReturnType<typeof stat>>;
          try {
            testStat = await stat(absoluteTestPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              throw new Error(`Test file does not exist: ${path}`);
            }
            throw error;
          }
          if (!testStat.isFile()) throw new Error(`Test path is not a file: ${path}`);
        }
        const versions = await Promise.all(input.paths.map(path => snapshotTest(context, path)));
        const result = await context.functionGroupRunner!.run(input.paths);
        await recordTestRun(context, result, versions);
        context.budget?.assertActive();
        context.state.lastFunctionGroupTest = result;
        context.state.functionGroupTests ??= [];
        context.state.functionGroupTests.push(result);
        return result;
      },
    };
  };
}
