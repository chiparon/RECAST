import { execFile } from "node:child_process";
import { cp, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ProjectPipelineFiles } from "../../../weichai/apps/vscode-extension/src/project-pipeline-files.ts";
import type { WorkspaceCompileCommand } from "../../../weichai/packages/contracts/src/workspace-translation.ts";

const exec = promisify(execFile);
export async function git(root: string, args: string[]) {
  return (
    await exec("git", ["-C", root, ...args], {
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
  ).stdout.trim();
}
export const commitOptions = [
  "-c",
  "user.name=RECAST",
  "-c",
  "user.email=recast@localhost",
  "-c",
  "core.hooksPath=",
  "commit",
  "--no-gpg-sign",
  "--allow-empty",
];

// The product's generic skeleton copier excludes all directories named coverage,
// bin, build, etc. In an upstream source distribution those names can own actual
// production packages. Copy this fixture's pre-materialized public tree verbatim.
export class RealProjectFiles extends ProjectPipelineFiles {
  override async snapshot(source: string, id: string, signal: AbortSignal) {
    const root = await realpath(source);
    const outputRoot = join(this.directory(id), "project");
    const rel = relative(root, outputRoot);
    if (!rel || !(isAbsolute(rel) || rel.startsWith(".." + sep)))
      throw Error("Trial directory must be outside the starter tree.");
    await mkdir(dirname(outputRoot), { recursive: true });
    await cp(root, outputRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: async (from) => {
        signal.throwIfAborted();
        if (basename(from) === ".git") return false;
        const stat = await lstat(from);
        if (!stat.isDirectory() && !stat.isFile())
          throw Error("Unsupported upstream entry: " + relative(root, from));
        return true;
      },
    });
    await git(outputRoot, ["init", "-b", "codex/project-pipeline/" + id]);
    await git(outputRoot, ["config", "core.autocrlf", "false"]);
    await writeFile(
      join(outputRoot, ".git", "info", "exclude"),
      "\n/.forexplore/\n/.forexpore/\n/.agent-tmp/\n/.translation-verifier-tests/\n/.translation-verifier-coverage/\n/.recast-build/\n__pycache__/\n.pytest_cache/\n",
    );
    await git(outputRoot, ["add", "--force", "--all"]);
    await git(outputRoot, [
      ...commitOptions,
      "-m",
      "Freeze public upstream starter",
    ]);
    return {
      outputRoot,
      baselineCommit: await git(outputRoot, ["rev-parse", "HEAD"]),
    };
  }
}

export function publicCommand(
  command: WorkspaceCompileCommand,
): WorkspaceCompileCommand {
  return {
    ...command,
    executable: process.execPath,
    args: [
      fileURLToPath(new URL("./public-command.mjs", import.meta.url)),
      command.executable,
      ...command.args,
    ],
  };
}
