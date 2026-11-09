import { createHash } from "node:crypto";
import { compileWorkspace } from "../../../weichai/services/adaptation-service/src/workspace-compiler.ts";
import { TranslationWorkspaceFiles } from "../../../weichai/services/adaptation-service/src/workspace-translation-files.ts";
import {
  applyWorkspaceEdits,
  parseWorkspaceEdits,
} from "../../../weichai/services/adaptation-service/src/workspace-translation-edits.ts";
import { workspaceTranslatorTools } from "../../../weichai/services/adaptation-service/src/workspace-translation-agent.ts";
import {
  commitOptions,
  git,
  publicCommand,
} from "../real-projects/method-files.ts";
import type { MethodTask } from "../real-projects/method-types.ts";

const objectTool = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
) => ({
  type: "function",
  name,
  description,
  deferLoading: false,
  inputSchema: {
    type: "object",
    properties,
    additionalProperties: false,
    required: [],
  },
});
export const projectTools = [
  objectTool(
    "list_files",
    "List the supplied workspace inventory, writable files and module tests.",
  ),
  ...workspaceTranslatorTools
    .filter((t) => ["read_file", "write_file", "edit_file"].includes(t.name))
    .map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      deferLoading: false,
    })),
  objectTool("compile", "Run the public project build."),
  objectTool(
    "run_tests",
    "Run the public project tests, optionally selecting a named module.",
    { module: { type: "string" } },
  ),
];
export const allowedTools = new Set(projectTools.map((t) => t.name));
const hash = (content: string | null) =>
  content === null ? null : createHash("sha256").update(content).digest("hex");

export function projectBridge(
  task: MethodTask,
  root: string,
  signal: AbortSignal,
) {
  const inventory = {
    readFiles: task.readFiles,
    writeFiles: task.modules.map((m) => m.path),
    moduleTests: Object.keys(task.moduleTestCommands ?? {}),
  };
  const fs = new TranslationWorkspaceFiles(root),
    readHashes = new Map<string, string | null>();
  const build = () =>
    compileWorkspace(root, publicCommand(task.compileCommand), signal);
  const test = (module?: string) => {
    if (module && !inventory.moduleTests.includes(module))
      throw Error("Unknown public test selection");
    return compileWorkspace(
      root,
      publicCommand(
        module ? task.moduleTestCommands![module] : task.testCommand,
      ),
      signal,
    );
  };
  async function execute(name: string, args: Record<string, any>) {
    if (!allowedTools.has(name)) throw Error("Tool outside project scope");
    if (name === "list_files") return inventory;
    if (name === "compile") return build();
    if (name === "run_tests") return test(args.module);
    if (!inventory.readFiles.includes(args.path))
      throw Error("File outside readable inventory");
    const path = args.path,
      old = fs.read(path),
      digest = hash(old);
    if (name === "read_file") {
      readHashes.set(path, digest);
      return { path, content: old, hash: digest };
    }
    if (!inventory.writeFiles.includes(path))
      throw Error("File outside write scope");
    if (args.expectedHash !== digest || readHashes.get(path) !== digest)
      throw Error("Read the latest file and supply its hash");
    const next =
      name === "edit_file"
        ? applyWorkspaceEdits(old ?? "", parseWorkspaceEdits(args.edits))
        : args.content;
    if (typeof next !== "string") throw Error("write_file requires content");
    fs.write(path, old, next);
    const updated = hash(next);
    readHashes.set(path, updated);
    return { path, hash: updated };
  }
  async function publish() {
    const compiled = await build();
    if (!compiled.success)
      throw Error("Public compilation failed: " + compiled.output.slice(-2000));
    const tested = await test();
    if (!tested.success)
      throw Error("Public tests failed: " + tested.output.slice(-2000));
    const tracked = await git(root, ["diff", "--name-only", "-z", "HEAD"]);
    const added = await git(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    for (const path of [...tracked.split("\0"), ...added.split("\0")].filter(
      Boolean,
    ))
      if (!inventory.writeFiles.includes(path))
        throw Error("Output outside write scope: " + path);
    await git(root, [
      "--literal-pathspecs",
      "add",
      "--force",
      "--",
      ...inventory.writeFiles,
    ]);
    await git(root, [...commitOptions, "-m", "Codex project delivery"]);
    return git(root, ["rev-parse", "HEAD"]);
  }
  const prompt =
    task.requirement +
    "\n\nPublic module manifest:\n" +
    JSON.stringify(task.modules) +
    "\n\nWorkspace inventory:\n" +
    JSON.stringify(inventory);
  return { execute, publish, prompt };
}
