import type {
  DeepSeekToolDefinition,
  DeepSeekToolMessage,
  DeepSeekToolCompletion,
} from "../../../weichai/services/adaptation-service/src/deepseek-client.ts";

interface RawOptions {
  client: {
    complete(
      messages: readonly DeepSeekToolMessage[],
      tools: readonly DeepSeekToolDefinition[],
      signal?: AbortSignal,
    ): Promise<DeepSeekToolCompletion>;
  };
  requirement: string;
  files: string[];
  writeFiles: string[];
  testFiles: string[];
  read(path: string): string | Promise<string>;
  write(path: string, content: string): void | Promise<void>;
  compile(path?: string): unknown | Promise<unknown>;
  test(path?: string): unknown | Promise<unknown>;
  signal?: AbortSignal;
  maxTurns?: number;
}
interface RawEvent {
  turn: number;
  tool: string;
  path?: string;
  elapsedMs: number;
  error?: string;
}
type RawResult =
  | { status: "completed"; events: RawEvent[]; message: string }
  | { status: "failed"; events: RawEvent[]; error: string };

const string = { type: "string" };
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
): DeepSeekToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
  };
}
const rawTools = [
  tool("list_files", "List all readable files and the writable subset.", {}),
  tool(
    "read_file",
    "Read a project input or the latest version of a writable file.",
    { path: string },
  ),
  tool(
    "write_file",
    "Replace the whole content of one writable project file.",
    { path: string, content: string },
  ),
  tool(
    "compile",
    "Run the whole shared build check, or pass one writable file path for a syntax check.",
    { path: string },
    [],
  ),
  tool(
    "test",
    "Run the public project tests. Optionally pass one of the listed testFiles to run a focused public test.",
    { path: string },
    [],
  ),
  tool("finish", "Return the current project as your final delivery.", {}),
];

/** Single conversation, one project-level request; planning and tool use are decided by the agent. */
export async function runRawAgent(options: RawOptions): Promise<RawResult> {
  const events: RawEvent[] = [];
  const inventory = {
    files: options.files,
    writeFiles: options.writeFiles,
    testFiles: options.testFiles,
  };
  const messages: DeepSeekToolMessage[] = [
    {
      role: "system",
      content:
        "You are a software development agent. Implement the user's entire project in the supplied workspace. Use the available tools as you see fit. Only the listed writable files may be changed. Return the finished project with finish or a final text response.",
    },
    {
      role: "user",
      content:
        options.requirement +
        "\n\nWorkspace inventory:\n" +
        JSON.stringify(inventory),
    },
  ];
  try {
    for (let turn = 1; turn <= (options.maxTurns ?? 64); turn++) {
      options.signal?.throwIfAborted();
      const reply = await options.client.complete(
        messages,
        rawTools,
        options.signal,
      );
      const calls = reply.toolCalls ?? [];
      if (!calls.length)
        return { status: "completed", events, message: reply.content ?? "" };
      messages.push({
        role: "assistant",
        content: reply.content ?? "",
        toolCalls: calls,
      });
      for (const call of calls) {
        options.signal?.throwIfAborted();
        const start = performance.now();
        const event: RawEvent = { turn, tool: call.name, elapsedMs: 0 };
        let output: unknown;
        try {
          const args = JSON.parse(call.arguments);
          switch (call.name) {
            case "list_files":
              output = inventory;
              break;
            case "read_file":
              if (
                typeof args.path !== "string" ||
                !options.files.includes(args.path)
              )
                throw new Error(
                  "Path is outside the readable project inventory",
                );
              event.path = args.path;
              output = {
                path: args.path,
                content: await options.read(args.path),
              };
              break;
            case "write_file":
              if (
                typeof args.path !== "string" ||
                !options.writeFiles.includes(args.path)
              )
                throw new Error(
                  "Path is outside the writable project inventory",
                );
              if (typeof args.content !== "string")
                throw new Error("write_file requires full string content");
              event.path = args.path;
              await options.write(args.path, args.content);
              output = { written: args.path };
              break;
            case "compile":
              if (
                args.path !== undefined &&
                !options.writeFiles.includes(args.path)
              )
                throw new Error(
                  "The build path must be one of the writable project files",
                );
              event.path = args.path;
              output = await options.compile(args.path);
              break;
            case "test":
              if (
                args.path !== undefined &&
                !options.testFiles.includes(args.path)
              )
                throw new Error(
                  "The test path must be one of the public testFiles",
                );
              event.path = args.path;
              output = await options.test(args.path);
              break;
            case "finish":
              return {
                status: "completed",
                events,
                message: reply.content ?? "",
              };
            default:
              throw new Error("Unknown tool: " + call.name);
          }
        } catch (e) {
          event.error = e instanceof Error ? e.message : String(e);
          output = { error: event.error };
        } finally {
          event.elapsedMs = performance.now() - start;
          events.push(event);
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(output),
        });
      }
    }
    throw new Error("Raw agent turn budget exhausted");
  } catch (e) {
    return {
      status: "failed",
      events,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
