import { describe, expect, it, vi } from "vitest";
import {
  createTranslationVerifierModelClient,
  TranslationVerifierModelError,
} from "./model-client.js";
import type { AgentMessage, AgentToolDefinition } from "./model.js";

const tool: AgentToolDefinition = {
  name: "read_target_file",
  description: "Read the allowed target file.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

const messages: AgentMessage[] = [
  { role: "system", content: "System instructions." },
  { role: "user", content: "Inspect the target." },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-read",
        name: "read_target_file",
        arguments: '{"path":"src/Target.java"}',
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call-read",
    content: '{"content":"class Target {}"}',
  },
];

type FakeRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function successfulResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: "done" } }] }),
    { status: 200 },
  );
}

function clientWith(
  request: ReturnType<typeof vi.fn>,
  options: Partial<Parameters<typeof createTranslationVerifierModelClient>[0]> = {},
) {
  return createTranslationVerifierModelClient({
    apiKey: "secret-test-key",
    apiBase: "https://model.example.test/v1",
    model: "verifier-test-model",
    request: request as unknown as typeof globalThis.fetch,
    ...options,
  });
}

describe("translation verifier model client", () => {
  it('discards truncated tool calls and retries from the last valid transcript with smaller outputs', async () => {
    const observed = vi.fn();
    const original = structuredClone(messages);
    const request = vi.fn<FakeRequest>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: {
        content: 'PARTIAL_UNTRUSTED_OUTPUT', tool_calls: [{ id: 'never-execute', function: { name: 'finish', arguments: '{' } }],
      } }] })))
      .mockResolvedValueOnce(successfulResponse());
    const client = clientWith(request, { onOutputLimitRetry: observed });
    await expect(client.complete(messages, [tool])).resolves.toEqual({ content: 'done' });
    const body = JSON.parse(String(request.mock.calls[1]![1]!.body));
    expect(body.messages.slice(0, -1)).toEqual(JSON.parse(String(request.mock.calls[0]![1]!.body)).messages);
    expect(body.messages.at(-1).content).toContain('None of its tool calls were executed');
    expect(body.messages.at(-1).content).toContain('one focused tool call');
    expect(JSON.stringify(body)).not.toMatch(/PARTIAL_UNTRUSTED_OUTPUT|never-execute/);
    expect(body.max_tokens).toBe(16384);
    expect(messages).toEqual(original);
    expect(observed).toHaveBeenCalledWith(1, 3);
  });

  it('bounds repeated truncation and never interprets a null incomplete message', async () => {
    const request = vi.fn<FakeRequest>(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: null }] })));
    const client = clientWith(request, { maxOutputLimitRetries: 2 });
    await expect(client.complete(messages, [tool])).rejects.toMatchObject({ code: 'output-limit', message: expect.stringContaining('2 次') });
    expect(request).toHaveBeenCalledTimes(3);
    const body = JSON.parse(String(request.mock.calls[2]![1]!.body));
    expect(body.messages).toHaveLength(messages.length + 1);
    expect(body.messages.at(-1).content).toContain('2000 characters');
  });

  it('does not retry after the owning run is cancelled', async () => {
    const controller = new AbortController();
    const request = vi.fn<FakeRequest>(async () => {
      controller.abort(new Error('cancelled by user'));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: {} }] }));
    });
    await expect(clientWith(request).complete(messages, [tool], controller.signal)).rejects.toThrow('cancelled by user');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports an incompatible output parameter without retrying or leaking provider diagnostics', async () => {
    const request = vi.fn<FakeRequest>(async () => new Response(JSON.stringify({ error: {
      message: 'max_tokens must be less than or equal to 8192; PRIVATE_PROMPT',
    } }), { status: 400 }));
    await expect(clientWith(request).complete(messages, [tool])).rejects.toThrow('输出参数超过服务商支持范围');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("resolves the key at request time and keeps it out of the prompt body", async () => {
    const request = vi.fn<FakeRequest>(async () => successfulResponse());
    let currentKey = "secret-test-key";
    const client = clientWith(request, { apiKey: () => currentKey });

    await client.complete(messages, [tool]);

    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(url).toBe("https://model.example.test/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret-test-key",
    });
    expect(body).toEqual({
      model: "verifier-test-model",
      messages: [
        { role: "system", content: "System instructions." },
        { role: "user", content: "Inspect the target." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-read",
              type: "function",
              function: {
                name: "read_target_file",
                arguments: '{"path":"src/Target.java"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-read",
          content: '{"content":"class Target {}"}',
        },
      ],
      max_tokens: 16384,
      thinking: { type: "disabled" },
      tools: [
        {
          type: "function",
          function: {
            name: "read_target_file",
            description: "Read the allowed target file.",
            parameters: tool.inputSchema,
          },
        },
      ],
      tool_choice: "auto",
    });
    expect(JSON.stringify(body)).not.toContain(currentKey);

    currentKey = "next-secret";
    await client.complete([{ role: "user", content: "Again." }], []);
    expect((request.mock.calls[1]?.[1] as RequestInit).headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer next-secret",
    });
  });

  it("fails before fetch when the key is missing", async () => {
    const request = vi.fn<FakeRequest>(async () => successfulResponse());
    const client = clientWith(request, { apiKey: "  " });

    await expect(client.complete([], [])).rejects.toMatchObject({
      name: "TranslationVerifierModelError",
      kind: "credential",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves provider tool-call IDs and JSON argument text", async () => {
    const request = vi.fn<FakeRequest>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
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
        ),
    );
    const client = clientWith(request);

    await expect(client.complete([], [tool])).resolves.toEqual({
      toolCalls: [
        {
          id: "call-finish",
          name: "finish",
          arguments: '{"status":"success"}',
        },
      ],
    });
  });

  it("does not retry a non-retryable provider failure by default", async () => {
    const request = vi.fn<FakeRequest>(
      async () => new Response("unauthorized", { status: 401 }),
    );
    const client = clientWith(request);

    await expect(client.complete([], [])).rejects.toMatchObject({
      kind: "request",
      message: "Translation verifier model request failed with status 401.",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit request retries separate from Agent turns", async () => {
    const request = vi
      .fn<FakeRequest>()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(successfulResponse());
    const client = clientWith(request, {
      requestRetry: { maxAttempts: 2 },
    });

    await expect(client.complete([], [])).resolves.toEqual({ content: "done" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["invalid JSON", () => new Response("not json", { status: 200 }), "invalid JSON"],
    [
      "empty choices",
      () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      "invalid completion",
    ],
    [
      "empty message",
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: null, tool_calls: [] } }] }),
          { status: 200 },
        ),
      "empty completion",
    ],
    [
      "non-string tool arguments",
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call-invalid",
                      function: { name: "finish", arguments: { ok: true } },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      "invalid tool call",
    ],
  ])("fails closed for %s", async (_label, createResponse, expected) => {
    const request = vi.fn<FakeRequest>(async () => createResponse());
    const client = clientWith(request);

    await expect(client.complete([], [])).rejects.toMatchObject({
      name: "TranslationVerifierModelError",
      kind: "response",
    });
    const secondRequest = client.complete([], []);
    await expect(secondRequest).rejects.toThrow(expected);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not expose a provider response body in errors", async () => {
    const request = vi.fn<FakeRequest>(
      async () =>
        new Response("provider secret and internal prompt", { status: 502 }),
    );
    const client = clientWith(request);

    try {
      await client.complete([], []);
      throw new Error("expected completion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TranslationVerifierModelError);
      expect(String(error)).not.toContain("provider secret");
      expect(String(error)).not.toContain("internal prompt");
    }
  });
});
