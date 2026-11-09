import { createHash, randomUUID } from "node:crypto";
import type {
  DeepSeekToolDefinition,
  DeepSeekToolMessage,
} from "../../../weichai/services/adaptation-service/src/deepseek-client.ts";
import { compileWorkspace } from "../../../weichai/services/adaptation-service/src/workspace-compiler.ts";
import { workspaceTranslatorTools } from "../../../weichai/services/adaptation-service/src/workspace-translation-agent.ts";
import { TranslationWorkspaceFiles } from "../../../weichai/services/adaptation-service/src/workspace-translation-files.ts";
import {
  applyWorkspaceEdits,
  parseWorkspaceEdits,
} from "../../../weichai/services/adaptation-service/src/workspace-translation-edits.ts";
import {
  RealProjectFiles,
  git,
  commitOptions,
  publicCommand,
} from "./method-files.ts";
import type { MethodOptions } from "./method-types.ts";

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
): DeepSeekToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required: [],
    },
  };
}
const tools = [
  tool(
    "list_files",
    "List the readable and writable project files and public test selections.",
  ),
  ...workspaceTranslatorTools.filter((tool) =>
    ["read_file", "write_file", "edit_file"].includes(tool.name),
  ),
  tool("compile", "Run the public project build."),
  tool(
    "run_tests",
    "Run the public project tests, optionally selecting a named module.",
    { module: { type: "string" } },
  ),
  tool("finish", "Submit the current project."),
];
const hash = (content: string | null) =>
  content === null ? null : createHash("sha256").update(content).digest("hex");

export async function runRealRaw(input: MethodOptions, signal: AbortSignal) {
  const { task, client } = input;
  const snapshot = await new RealProjectFiles(input.runRoot).snapshot(
    input.sourceRoot,
    randomUUID(),
    signal,
  );
  const { outputRoot, baselineCommit } = snapshot;
  const fs = new TranslationWorkspaceFiles(outputRoot);
  const inventory = {
    readFiles: task.readFiles,
    writeFiles: task.modules.map((m) => m.path),
    moduleTests: Object.keys(task.moduleTestCommands ?? {}),
  };
  const messages: DeepSeekToolMessage[] = [
    {
      role: "system",
      content:
        "You are a software development agent. Implement the entire user request using the tools as you see fit. Only the listed writable files may be changed. Return the finished project with finish or a final text response.",
    },
    {
      role: "user",
      content:
        task.requirement +
        "\n\nWorkspace inventory:\n" +
        JSON.stringify(inventory),
    },
  ];
  const events: {
    turn: number;
    tool: string;
    path?: string;
    error?: string;
  }[] = [];
  const readHashes = new Map<string, string | null>();
  const build = () =>
    compileWorkspace(outputRoot, publicCommand(task.compileCommand), signal);
  const test = (module?: string) => {
    if (module && !inventory.moduleTests.includes(module))
      throw Error("Unknown public test selection");
    return compileWorkspace(
      outputRoot,
      publicCommand(
        module ? task.moduleTestCommands![module] : task.testCommand,
      ),
      signal,
    );
  };
  let commit: string | null = null,
    error: string | null = null;
  let turns = 0,
    message = "";
  try {
    outer: while (true) {
      signal.throwIfAborted();
      turns++;
      const reply = await client.complete(messages, tools, signal);
      const calls = reply.toolCalls ?? [];
      message = reply.content ?? "";
      if (!calls.length) break;
      messages.push({ role: "assistant", content: message, toolCalls: calls });
      for (const call of calls) {
        const event = {
          turn: turns,
          tool: call.name,
        } as (typeof events)[number];
        events.push(event);
        let output: unknown;
        try {
          const args = JSON.parse(call.arguments);
          if (call.name === "finish") break outer;
          if (call.name === "list_files") output = inventory;
          else if (call.name === "compile") output = await build();
          else if (call.name === "run_tests") output = await test(args.module);
          else {
            if (!inventory.readFiles.includes(args.path))
              throw Error("File is outside the readable inventory");
            const path: string = args.path;
            event.path = path;
            const old = fs.read(path),
              digest = hash(old);
            if (call.name === "read_file") {
              readHashes.set(path, digest);
              output = { path, content: old, hash: digest };
            } else {
              if (!inventory.writeFiles.includes(path))
                throw Error("File is outside the write scope");
              if (
                args.expectedHash !== digest ||
                readHashes.get(path) !== digest
              )
                throw Error("Read the latest file and supply its hash.");
              if (call.name !== "write_file" && call.name !== "edit_file")
                throw Error("Unknown tool " + call.name);
              const next =
                call.name === "write_file"
                  ? args.content
                  : applyWorkspaceEdits(
                      old ?? "",
                      parseWorkspaceEdits(args.edits),
                    );
              if (typeof next !== "string")
                throw Error("write_file requires text");
              fs.write(path, old, next);
              const updated = hash(next);
              readHashes.set(path, updated);
              output = { path, hash: updated };
            }
          }
        } catch (e) {
          event.error = e instanceof Error ? e.message : String(e);
          output = { error: event.error };
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(output),
        });
      }
    }
    const compilation = await build();
    if (!compilation.success)
      throw Error(
        "Public compilation failed: " + compilation.output.slice(-2000),
      );
    const verification = await test();
    if (!verification.success)
      throw Error("Public tests failed: " + verification.output.slice(-2000));
    const changed = (
      await git(outputRoot, ["diff", "--name-only", "-z", "HEAD"])
    )
      .split("\0")
      .filter(Boolean);
    const added = (
      await git(outputRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    for (const path of [...changed, ...added])
      if (!inventory.writeFiles.includes(path))
        throw Error("Output outside write scope: " + path);
    await git(outputRoot, [
      "--literal-pathspecs",
      "add",
      "--force",
      "--",
      ...inventory.writeFiles,
    ]);
    await git(outputRoot, [
      ...commitOptions,
      "-m",
      "Raw agent project delivery",
    ]);
    commit = await git(outputRoot, ["rev-parse", "HEAD"]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    outputRoot,
    commit,
    error,
    indexMs: null,
    runtime: { ...snapshot, agent: { turns, events, message, error } },
  };
}
