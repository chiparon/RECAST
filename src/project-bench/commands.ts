import type { WorkspaceCompileCommand } from "../../../weichai/packages/contracts/src/workspace-translation.ts";

export function publicTestCommand(
  root: string,
  testFile = "tests/all.mjs",
): WorkspaceCompileCommand {
  // Remove inherited credentials before loading candidate code. Node restricts filesystem
  // reads to this trial and denies writes, child processes, workers and native addons.
  const launch = [
    'import { pathToFileURL } from "node:url";',
    'import { resolve } from "node:path";',
    "for (const key of Object.keys(process.env)) delete process.env[key];",
    "await import(pathToFileURL(resolve(process.argv[1])).href);",
  ].join("\n");
  return {
    executable: process.execPath,
    args: [
      "--permission",
      "--allow-fs-read=" + root,
      "--input-type=module",
      "--eval",
      launch,
      testFile,
    ],
    timeoutMs: 20000,
  };
}

export function publicCompileCommand(): WorkspaceCompileCommand {
  // The immutable host script runs node --check separately on each module.
  return {
    executable: process.execPath,
    args: ["tests/check.mjs"],
    timeoutMs: 20000,
  };
}
