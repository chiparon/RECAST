import { mkdir } from "node:fs/promises";
import { retainedTestDirectory } from "../test-artifacts.js";
import type { TestRetention } from "../../types.js";
import { resolveSafePath } from "../tools/common.js";
import { dirname } from "node:path";
import { resolveTestEnvironment } from "./test-environment.js";
import type {
  AgentTaskContext,
  ToolRuntimeContext,
} from "../tools/common.js";

/** Resolves the Host-owned test environment for one Agent task. */
export type ToolContextResolver = (
  taskContext: AgentTaskContext,
) => Promise<ToolRuntimeContext>;

/**
 * Default resolver shared by the LangChain Hosts and every production caller:
 * it discovers the dedicated test roots, the fixed runner command and any
 * ephemeral harness cleanup for the task's target project.
 */
export async function defaultToolContextResolver(
  taskContext: AgentTaskContext,
  retention?: TestRetention,
): Promise<ToolRuntimeContext> {
  const directory = retention ? retainedTestDirectory(retention.id) : undefined;
  const testEnvironment = await resolveTestEnvironment(taskContext, directory);
  if (retention) {
    const key = directory!.split('/')[1];
    testEnvironment.testRoots = await Promise.all(testEnvironment.testRoots.map(async root => {
      const owned = root.startsWith(directory! + '/') ? root : root + '/recast/' + key;
      await mkdir(resolveSafePath(taskContext.targetProjectPath, owned), { recursive: true });
      return owned;
    }));
    testEnvironment.cleanup = undefined;
  }
  return {
    ...taskContext,
    sourceDirectory: directoryForFile(taskContext.sourcePath),
    targetDirectory: directoryForFile(taskContext.targetPath),
    testRoots: testEnvironment.testRoots,
    testRunner: testEnvironment.framework,
    targetTest: testEnvironment.targetTest,
    cleanup: testEnvironment.cleanup,
  };
}

function directoryForFile(path: string): string {
  const directory = dirname(path.replaceAll("\\", "/"));
  return directory === "" ? "." : directory;
}
