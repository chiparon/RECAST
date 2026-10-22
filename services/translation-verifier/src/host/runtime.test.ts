import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHost } from "./runtime.js";
import { createTranslationVerifierModelClient } from "./model-client.js";
import type { AgentCompletion, AgentMessage, AgentModelClient } from "./model.js";
import type { AgentWorkLogEvent } from "./work-log.js";
import type { AgentTraceEvent } from "./trace-log.js";
import type { AgentTask, AgentToolFactory } from "./agent.js";
import type { HostTool, TargetTestResult, ToolRuntimeContext } from "./tools/common.js";
import { createFinishTool } from "./tools/finish.js";
import { createWriteTargetTestTool } from "./tools/write-target-test.js";

const subject = {
  sourceFunction: { path: "src/source.py", name: "source_fn" },
  targetFunction: { path: "src/target.py", name: "target_fn" },
  requirement: "Preserve the method behavior.",
};

const taskContext = {
  sourceLanguage: "Python",
  targetLanguage: "Python",
  sourceProjectPath: "/tmp/source",
  targetProjectPath: "/tmp/target",
  sourcePath: "src/source.py",
  targetPath: "src/target.py",
  targetFunction: subject.targetFunction,
};

const resolveToolContext = async (): Promise<ToolRuntimeContext> => ({
  ...taskContext,
  sourceDirectory: "src",
  targetDirectory: "src",
  testRoots: ["tests/agent"],
  testRunner: "pytest",
  targetTest: { executable: "pytest", args: [] },
});

function task(
  tools: readonly AgentToolFactory[],
  terminalTools: readonly string[] = ["finish"],
): AgentTask {
  return {
    subject,
    taskContext,
    systemPrompt: "system",
    userPrompt: "user",
    tools,
    terminalTools,
  };
}

function tool(
  name: string,
  execute: (input: unknown) => Promise<unknown>,
): AgentToolFactory {
  return () => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    parse: (input: unknown) => input,
    execute,
  } as HostTool<unknown, unknown>);
}

function clientFor(
  completions: readonly AgentCompletion[],
  observed: AgentMessage[][] = [],
) {
  let index = 0;
  return {
    observed,
    complete: async (messages: readonly AgentMessage[]) => {
      observed.push([...messages]);
      const completion = completions[index++];
      if (completion === undefined) throw new Error("No scripted completion.");
      return completion;
    },
  };
}

describe("AgentHost runtime", () => {
  it("returns full-suite feedback to the Agent, lets it repair a test, then finishes on a fresh passing suite", async () => {
    const root = await mkdtemp(join(tmpdir(), "verifier-host-feedback-"));
    try {
      const path = "tests/agent/test_existing.py";
      await mkdir(join(root, "tests/agent"), { recursive: true });
      await writeFile(join(root, path), "stale fixture");
      const runtime = { ...await resolveToolContext(), sourceProjectPath: root, targetProjectPath: root };
      const calls: string[][] = [], observed: AgentMessage[][] = [], events: AgentTraceEvent[] = [];
      const observe = async (paths: readonly string[]): Promise<TargetTestResult> => {
        calls.push([...paths]);
        const passed = await readFile(join(root, path), "utf8") === "repaired fixture";
        return {
          status: passed ? "success" : "failure", timedOut: false, exitCode: passed ? 0 : 1,
          stdout: passed ? "" : `BEGIN ${"x".repeat(200_000)} END`, stderr: passed ? "" : "Expected current API fixture", durationMs: 1,
          tests: { executed: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0 },
          coverage: { status: "available", targetFunction: { name: "target_fn", executed: true, lineCoverage: 100, branchCoverage: null } },
          reportPaths: ["tests.xml"],
        };
      };
      const host = createAgentHost({ resolveToolContext: async () => runtime, traceLogger: event => events.push(event),
        limits: { maxContextCharacters: 40_000 },
        modelClient: clientFor([
          { toolCalls: [{ id: "first-finish", name: "finish", arguments: '{"testExecutionStatus":"success","translationStatus":"success"}' }] },
          { toolCalls: [{ id: "repair", name: "write_target_test", arguments: JSON.stringify({ path, content: "repaired fixture" }) }] },
          { toolCalls: [{ id: "retry-finish", name: "finish", arguments: '{"testExecutionStatus":"success","translationStatus":"success"}' }] },
        ], observed),
      });
      const result = await host.run(task([
        context => createFinishTool()({ ...context, runner: { run: path => observe([path]), runSuite: observe } }),
        createWriteTargetTestTool(),
      ]));
      expect(result).toMatchObject({ testExecutionStatus: "success", translationStatus: "success", targetTest: { tests: { passed: 1 } } });
      const feedback = JSON.parse(observed[1]!.find(message => message.role === "tool" && message.toolCallId === "first-finish")!.content);
      expect(feedback).toMatchObject({ outcome: "continue", targetTest: { status: "failure", tests: { failed: 1 },
        coverage: { status: "available", targetFunction: { executed: true } }, reportPaths: ["tests.xml"] } });
      expect(feedback.feedback).toContainEqual(expect.stringContaining("does not match the Host result"));
      expect(feedback).not.toHaveProperty("error");
      expect(feedback.targetTest.stdout).toContain("BEGIN");
      expect(feedback.targetTest.stdout).toContain("END");
      expect(JSON.stringify(feedback).length).toBeLessThan(20_000);
      expect(calls).toEqual([[path], [path]]);
      expect(events.filter(event => event.event === "tool.completed" && event.toolName === "finish").map(event => event.terminal)).toEqual([false, true]);
      expect(events.some(event => event.event === "tool.failed")).toBe(false);
      expect(await readdir(root)).toEqual(["tests"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("ignores legacy failure metadata supplied by a caller", async () => {
    const legacy = { runs: [], revisions: [], failures: [{ id: "old-failure", runId: "old-run", testId: "old-test",
      message: "stale expected value", versions: [], status: "unresolved" as const }] };
    const input = { ...task([context => {
      expect(context.state).toEqual({});
      return tool("finish", async () => ({ status: "success" }))(context);
    }]), functionGroup: { schemaVersion: "3.1" as const, mode: "requirement" as const, sourceLanguage: "Python", targetLanguage: "Python",
      targetProjectPath: "/tmp/target", requirement: "Preserve behavior", functions: [{ target: subject.targetFunction }], testEvidence: legacy } };
    const host = createAgentHost({ resolveToolContext, modelClient: clientFor([
      { toolCalls: [{ id: "finish", name: "finish", arguments: "{}" }] },
    ]) });
    expect(await host.run(input)).toEqual({ status: "success" });
    expect(legacy.failures[0]!.status).toBe("unresolved");
  });
  it("bounds model diagnostics while preserving the complete Host trace and test facts", async () => {
    const output = { status: "success", tests: { executed: 23, passed: 23, failed: 0, skipped: 0 },
      stdout: `BEGIN ${"x".repeat(200_000)} END`, stderr: "y".repeat(100_000),
      failures: [{ message: "z".repeat(200_000) }] };
    const events: AgentTraceEvent[] = [], observed: AgentMessage[][] = [];
    const host = createAgentHost({ resolveToolContext, traceLogger: event => events.push(event),
      limits: { maxContextCharacters: 40_000 },
      modelClient: clientFor([
        { toolCalls: [{ id: "run", name: "run_function_group_tests", arguments: "{}" }] },
        { toolCalls: [{ id: "finish", name: "finish", arguments: "{}" }] },
      ], observed) });
    await host.run(task([tool("run_function_group_tests", async () => output), tool("finish", async () => ({ status: "success" }))]));
    const response = observed[1]!.find(message => message.role === "tool")!;
    const visible = JSON.parse(response.content);
    expect(visible.tests).toEqual(output.tests);
    expect(visible.stdout).toContain("BEGIN");
    expect(visible.stdout).toContain("END");
    expect(response.content.length).toBeLessThan(20_000);
    expect(events.find(event => event.event === "tool.completed" && event.toolName === "run_function_group_tests")?.output).toEqual(output);
  });
  it.each([false, true])("retains a Host-created C# harness after a run (failure=%s)", async (fail) => {
    const root = await mkdtemp(join(tmpdir(), "verifier-host-cleanup-"));
    try {
      await writeFile(join(root, "Product.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
      const host = createAgentHost({
        modelClient: { complete: async () => {
          expect((await readdir(join(root, ".translation-verifier-tests"))).length).toBe(1);
          if (fail) throw new Error("model unavailable");
          return { toolCalls: [{ id: "finish", name: "finish", arguments: "{}" }] };
        } },
      });
      const input = { ...task([tool("finish", async () => ({ status: "success" }))]),
        taskContext: { ...taskContext, targetLanguage: "C#", targetProjectPath: root } };
      if (fail) await expect(host.run(input)).rejects.toThrow("model unavailable");
      else await expect(host.run(input)).resolves.toEqual({ status: "success" });
      expect(await readdir(root)).toEqual(expect.arrayContaining(["Product.csproj", ".translation-verifier-tests"]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("executes tool calls and returns a terminal tool result", async () => {
    const observed: AgentMessage[][] = [];
    const client = clientFor(
      [
        {
          content: "Inspecting the target.",
          toolCalls: [
            { id: "call-1", name: "inspect", arguments: '{"path":"src/target.py"}' },
          ],
        },
        {
          toolCalls: [
            { id: "call-2", name: "finish", arguments: '{"status":"success"}' },
          ],
        },
      ],
      observed,
    );
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    const result = await host.run(
      task([
        tool("inspect", async (input) => ({ inspected: input })),
        tool("finish", async (input) => ({ ...(input as object), terminal: true })),
      ]),
    );

    expect(result).toEqual({ status: "success", terminal: true });
    expect(observed).toHaveLength(2);
    expect(observed[1]).toContainEqual({
      role: "tool",
      toolCallId: "call-1",
      content: '{"inspected":{"path":"src/target.py"}}',
    });
  });

  it("emits bounded work events without recording tool payloads", async () => {
    const events: AgentWorkLogEvent[] = [];
    const client = clientFor([
      {
        content: "private model response",
        toolCalls: [
          { id: "call-inspect", name: "inspect", arguments: '{"path":"src/target.py"}' },
        ],
      },
      {
        toolCalls: [
          { id: "call-finish", name: "finish", arguments: '{"status":"success"}' },
        ],
      },
    ]);
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
      workLogger: (event) => events.push(event),
    });

    await expect(
      host.run(
        task([
          tool("inspect", async () => ({ secret: "private tool output" })),
          tool("finish", async () => ({ secret: "private terminal output" })),
        ]),
      ),
    ).resolves.toEqual({ secret: "private terminal output" });

    expect(events.map((event) => event.event)).toEqual([
      "run.started",
      "turn.started",
      "model.completed",
      "tool.started",
      "tool.completed",
      "turn.started",
      "model.completed",
      "tool.started",
      "tool.completed",
      "run.completed",
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(events.find((event) => event.event === "tool.started")).toMatchObject({
      toolCallId: "call-inspect",
      toolName: "inspect",
      argumentCharacters: expect.any(Number),
    });
  });

  it("emits detailed trace payloads separately from bounded work events", async () => {
    const events: AgentTraceEvent[] = [];
    const client = clientFor([
      {
        content: "visible model note",
        toolCalls: [
          { id: "call-inspect", name: "inspect", arguments: '{"path":"src/target.py"}' },
        ],
      },
      {
        toolCalls: [
          { id: "call-finish", name: "finish", arguments: '{"status":"success"}' },
        ],
      },
    ]);
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
      traceLogger: (event) => events.push(event),
    });

    await expect(
      host.run(
        task([
          tool("inspect", async () => ({ content: "private tool output" })),
          tool("finish", async () => ({ status: "success" })),
        ]),
      ),
    ).resolves.toEqual({ status: "success" });

    expect(events.map((event) => event.event)).toEqual([
      "run.started",
      "model.request",
      "model.response",
      "tool.started",
      "tool.completed",
      "model.request",
      "model.response",
      "tool.started",
      "tool.completed",
      "run.completed",
    ]);
    expect(JSON.stringify(events)).toContain("visible model note");
    expect(events.find((event) => event.event === "tool.started")).toMatchObject({
      arguments: '{"path":"src/target.py"}',
    });
    expect(events.find((event) => event.event === "tool.completed")).toMatchObject({
      output: { content: "private tool output" },
    });
  });  it("returns tool errors to the Agent and allows it to continue", async () => {
    const observed: AgentMessage[][] = [];
    const client = clientFor(
      [
        {
          toolCalls: [{ id: "call-1", name: "broken", arguments: "{}" }],
        },
        {
          toolCalls: [
            { id: "call-2", name: "finish", arguments: '{"status":"uncertain"}' },
          ],
        },
      ],
      observed,
    );
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    const result = await host.run(
      task([
        tool("broken", async () => {
          throw new Error("fixture is unavailable");
        }),
        tool("finish", async (input) => input),
      ]),
    );

    expect(result).toEqual({ status: "uncertain" });
    expect(observed[1]).toContainEqual({
      role: "tool",
      toolCallId: "call-1",
      content: '{"error":"fixture is unavailable"}',
    });
  });

  it("returns malformed tool arguments with the same call ID", async () => {
    const observed: AgentMessage[][] = [];
    const client = clientFor(
      [
        {
          toolCalls: [
            { id: "call-invalid", name: "inspect", arguments: "{invalid" },
          ],
        },
        {
          toolCalls: [
            { id: "call-finish", name: "finish", arguments: '{"status":"uncertain"}' },
          ],
        },
      ],
      observed,
    );
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    const result = await host.run(
      task([
        tool("inspect", async (input) => input),
        tool("finish", async (input) => input),
      ]),
    );

    expect(result).toEqual({ status: "uncertain" });
    expect(observed[1]).toContainEqual({
      role: "tool",
      toolCallId: "call-invalid",
      content: expect.stringContaining("Expected property name"),
    });
  });

  it("returns unknown tools with the same call ID", async () => {
    const observed: AgentMessage[][] = [];
    const client = clientFor(
      [
        {
          toolCalls: [
            { id: "call-unknown", name: "not_available", arguments: "{}" },
          ],
        },
        {
          toolCalls: [
            { id: "call-finish", name: "finish", arguments: '{"status":"uncertain"}' },
          ],
        },
      ],
      observed,
    );
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    const result = await host.run(
      task([tool("finish", async (input) => input)]),
    );

    expect(result).toEqual({ status: "uncertain" });
    expect(observed[1]).toContainEqual({
      role: "tool",
      toolCallId: "call-unknown",
      content: '{"error":"Tool is unavailable: not_available"}',
    });
  });

  it("continues after a prose-only completion", async () => {
    const client = clientFor([
      { content: "I need more evidence." },
      {
        toolCalls: [
          { id: "call-1", name: "finish", arguments: '{"status":"success"}' },
        ],
      },
    ]);
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    await expect(
      host.run(task([tool("finish", async (input) => input)])),
    ).resolves.toEqual({ status: "success" });
  });

  it("does not count provider retries as additional Agent turns", async () => {
    let requestCalls = 0;
    let completionCalls = 0;
    const adapter = createTranslationVerifierModelClient({
      apiKey: "test-key",
      apiBase: "https://model.example.test/v1",
      request: async () => {
        requestCalls += 1;
        if (requestCalls === 1) {
          return new Response("temporary", { status: 503 });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call-finish",
                      type: "function",
                      function: {
                        name: "finish",
                        arguments: '{"status":"success"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
      requestRetry: { maxAttempts: 2 },
    });
    const modelClient: AgentModelClient = {
      complete(messages, tools, signal) {
        completionCalls += 1;
        return adapter.complete(messages, tools, signal);
      },
    };
    const host = createAgentHost({
      modelClient,
      resolveToolContext,
      limits: { maxTurns: 1 },
    });

    await expect(
      host.run(task([tool("finish", async (input) => input)])),
    ).resolves.toEqual({ status: "success" });
    expect(completionCalls).toBe(1);
    expect(requestCalls).toBe(2);
  });

  it("enforces the turn budget before another model request", async () => {
    let modelCalls = 0;
    const host = createAgentHost({
      modelClient: {
        complete: async () => {
          modelCalls += 1;
          return { content: "still investigating" };
        },
      },
      resolveToolContext,
      limits: { maxTurns: 1 },
    });

    await expect(host.run(task([], []))).rejects.toThrow("1-turn budget");
    expect(modelCalls).toBe(1);
  });

  it("recovers when a terminal tool is combined with another call", async () => {
    const client = clientFor([
      {
        toolCalls: [
          { id: "call-1", name: "inspect", arguments: "{}" },
          { id: "call-2", name: "finish", arguments: "{}" },
        ],
      },
      { toolCalls: [{ id: "call-3", name: "finish", arguments: "{}" }] },
    ]);
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    await expect(host.run(task([
      tool("inspect", async () => { throw new Error("must not execute"); }),
      tool("finish", async () => ({ status: "success" })),
    ]))).resolves.toEqual({ status: "success" });
  });
});
