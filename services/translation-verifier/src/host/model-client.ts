import type {
  AgentCompletion,
  AgentMessage,
  AgentModelClient,
  AgentToolCall,
  AgentToolDefinition,
} from "./model.js";

export type TranslationVerifierApiKey = string | (() => string);

export type TranslationVerifierRequestRetry = {
  /** Total HTTP attempts for one AgentModelClient.complete call. Defaults to one. */
  maxAttempts?: number;
  /** Delay between retryable HTTP/network failures. Defaults to zero. */
  delayMs?: number;
};

export type TranslationVerifierModelOptions = {
  apiKey: TranslationVerifierApiKey;
  apiBase?: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  request?: typeof globalThis.fetch;
  requestRetry?: TranslationVerifierRequestRetry;
  /** Retry a truncated completion with smaller tool calls, never partial JSON. */
  maxOutputLimitRetries?: number;
  onOutputLimitRetry?: (attempt: number, maxRetries: number) => void;
};

export type TranslationVerifierModelErrorKind =
  | "credential"
  | "request"
  | "response";

export class TranslationVerifierModelError extends Error {
  readonly name = "TranslationVerifierModelError";

  constructor(
    readonly kind: TranslationVerifierModelErrorKind,
    message: string,
    readonly code?: 'output-limit',
  ) {
    super(message);
  }
}

const DEFAULT_API_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_MAX_REQUEST_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 750;
const MAX_REQUEST_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Create the smallest real model adapter used by the verifier Host.
 *
 * The adapter speaks the existing DeepSeek/OpenAI-compatible chat-completions
 * protocol. It owns the credential and HTTP request; the Host still owns the
 * Agent loop, tool execution, tool-call correlation, and turn budget.
 */
export function createTranslationVerifierModelClient(
  options: TranslationVerifierModelOptions,
): AgentModelClient {
  const apiBase = normalizeApiBase(options.apiBase ?? DEFAULT_API_BASE);
  const model = nonEmptyOption(options.model, DEFAULT_MODEL, "model");
  const maxOutputTokens = positiveIntegerOption(
    options.maxOutputTokens,
    DEFAULT_MAX_OUTPUT_TOKENS,
    "maxOutputTokens",
  );
  const temperature = numberOption(options.temperature, "temperature");
  const retry = normalizeRequestRetry(options.requestRetry);
  const request = options.request ?? globalThis.fetch.bind(globalThis);
  const maxOutputLimitRetries = options.maxOutputLimitRetries ?? 3;
  if (!Number.isInteger(maxOutputLimitRetries) || maxOutputLimitRetries < 0 || maxOutputLimitRetries > 8) {
    throw new Error('Invalid verifier output-limit recovery budget.');
  }

  return {
    async complete(messages, tools, signal) {
      for (let recovery = 0; ; recovery++) {
        signal?.throwIfAborted();
        // Discard the entire truncated response, including apparently complete
        // tool calls. Only the last valid transcript is replayed.
        const nextMessages: readonly AgentMessage[] = recovery ? [...messages, { role: 'user', content:
          `The previous response exceeded its output token limit and was discarded. None of its tool calls were executed. Continue from the last valid tool results above. Recovery ${recovery}/${maxOutputLimitRetries}: emit one focused tool call at a time, keep arguments below ${recovery > 1 ? 2000 : 4000} characters, and split large test suites into smaller test files. Do not weaken assertions, omit required behaviors or report success before running the tests. Keep prose concise.`,
        }] : messages;
        try {
          return await completeRequest({ apiBase, apiKey: options.apiKey, model, maxOutputTokens,
            temperature, retry, request, messages: nextMessages, tools, signal });
        } catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof TranslationVerifierModelError) || error.code !== 'output-limit') throw error;
          if (recovery >= maxOutputLimitRetries) throw new TranslationVerifierModelError('response',
            `Verifier model output limit: ${maxOutputLimitRetries} 次小步重试后仍被截断，未执行不完整的工具调用；请重试失败模块。`, 'output-limit');
          try { options.onOutputLimitRetry?.(recovery + 1, maxOutputLimitRetries); }
          catch { /* Observability cannot interrupt a verifier run. */ }
        }
      }
    },
  };
}

type CompleteRequestOptions = {
  apiBase: string;
  apiKey: TranslationVerifierApiKey;
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  retry: Required<TranslationVerifierRequestRetry>;
  request: typeof globalThis.fetch;
  messages: readonly AgentMessage[];
  tools: readonly AgentToolDefinition[];
  signal?: AbortSignal;
};

async function completeRequest(
  options: CompleteRequestOptions,
): Promise<AgentCompletion> {
  const apiKey = resolveApiKey(options.apiKey);
  const body = {
    model: options.model,
    messages: options.messages.map(toWireMessage),
    max_tokens: options.maxOutputTokens,
    thinking: { type: "disabled" },
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
    ...(options.tools.length === 0
      ? {}
      : {
          tools: options.tools.map(toWireTool),
          tool_choice: "auto",
        }),
  };

  let response: Response;
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await options.request(
        `${options.apiBase}/chat/completions`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: options.signal,
        },
      );
    } catch {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? requestError("Model request was aborted.");
      }
      if (attempt < options.retry.maxAttempts) {
        await delay(options.retry.delayMs, options.signal);
        continue;
      }
      throw requestError("Translation verifier model request failed.");
    }

    if (response.ok) break;
    if (
      attempt < options.retry.maxAttempts &&
      isRetryableStatus(response.status)
    ) {
      await delay(options.retry.delayMs, options.signal);
      continue;
    }
    if (response.status === 400 || response.status === 422) {
      // Inspect only to classify the failure. Never copy a provider error body,
      // which may contain prompts or secrets, into a user-facing diagnostic.
      let diagnostic = '';
      try { diagnostic = (await response.text()).slice(0, 65_536); } catch { /* Keep the status error. */ }
      if (/(?:max_tokens|max_output_tokens|max_completion_tokens)/i.test(diagnostic) &&
          /must|maximum|supported|range|too (?:large|high)|exceed/i.test(diagnostic)) {
        throw requestError('Verifier model 输出参数超过服务商支持范围；请检查模型、API 地址和允许的单次输出上限。');
      }
    }
    throw requestError(
      `Translation verifier model request failed with status ${response.status}.`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw responseError("Translation verifier model returned invalid JSON.");
  }
  return parseCompletion(value);
}

function resolveApiKey(value: TranslationVerifierApiKey): string {
  let resolved: unknown;
  try {
    resolved = typeof value === "function" ? value() : value;
  } catch {
    throw credentialError("Translation verifier model API key is unavailable.");
  }
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw credentialError("Translation verifier model API key is required.");
  }
  return resolved.trim();
}

function toWireMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "system" || message.role === "user") {
    return { role: message.role, content: message.content };
  }
  if (message.role === "tool") {
    if (!message.toolCallId.trim()) {
      throw responseError("Tool transcript entry requires a tool-call ID.");
    }
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  if (message.role !== "assistant") {
    throw responseError("Agent message role is invalid.");
  }
  return {
    role: "assistant",
    content: message.content || null,
    ...(message.toolCalls?.length
      ? { tool_calls: message.toolCalls.map(toWireToolCall) }
      : {}),
  };
}

function toWireTool(tool: AgentToolDefinition): Record<string, unknown> {
  if (!tool.name.trim()) {
    throw responseError("Tool definition requires a name.");
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toWireToolCall(call: AgentToolCall): Record<string, unknown> {
  if (!call.id.trim() || !call.name.trim() || typeof call.arguments !== "string") {
    throw responseError("Assistant tool call is invalid.");
  }
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.arguments,
    },
  };
}

function parseCompletion(value: unknown): AgentCompletion {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    throw responseError("Translation verifier model returned an invalid completion.");
  }
  const choice = value.choices[0];
  if (!isRecord(choice)) {
    throw responseError("Translation verifier model returned an invalid completion.");
  }
  if (choice.finish_reason === "length") {
    throw new TranslationVerifierModelError('response', 'Translation verifier model response reached its output token limit.', 'output-limit');
  }
  if (!isRecord(choice.message)) {
    throw responseError("Translation verifier model returned an invalid completion.");
  }

  const message = choice.message;
  if (
    message.content !== undefined &&
    message.content !== null &&
    typeof message.content !== "string"
  ) {
    throw responseError("Translation verifier model returned invalid message content.");
  }
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    throw responseError("Translation verifier model returned invalid tool calls.");
  }

  const content =
    typeof message.content === "string" && message.content.trim()
      ? message.content
      : undefined;
  const toolCalls = (message.tool_calls ?? []).map(parseToolCall);
  if (content === undefined && toolCalls.length === 0) {
    throw responseError("Translation verifier model returned an empty completion.");
  }
  return {
    ...(content === undefined ? {} : { content }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  };
}

function parseToolCall(value: unknown): AgentToolCall {
  if (!isRecord(value) || !isRecord(value.function)) {
    throw responseError("Translation verifier model returned an invalid tool call.");
  }
  const id = value.id;
  const name = value.function.name;
  const args = value.function.arguments;
  if (
    typeof id !== "string" ||
    !id.trim() ||
    typeof name !== "string" ||
    !name.trim() ||
    typeof args !== "string"
  ) {
    throw responseError("Translation verifier model returned an invalid tool call.");
  }
  return { id, name, arguments: args };
}

function normalizeApiBase(value: string): string {
  const apiBase = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    throw new Error("Translation verifier model apiBase must be an HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Translation verifier model apiBase must be an HTTP(S) URL.");
  }
  return apiBase;
}

function normalizeRequestRetry(
  value: TranslationVerifierRequestRetry | undefined,
): Required<TranslationVerifierRequestRetry> {
  const maxAttempts = value?.maxAttempts ?? DEFAULT_MAX_REQUEST_ATTEMPTS;
  const delayMs = value?.delayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_REQUEST_ATTEMPTS ||
    !Number.isInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > MAX_RETRY_DELAY_MS
  ) {
    throw new Error("Invalid translation verifier model request retry options.");
  }
  return { maxAttempts, delayMs };
}

function nonEmptyOption(
  value: string | undefined,
  fallback: string,
  label: string,
): string {
  const result = value?.trim() || fallback;
  if (!result) throw new Error(`Translation verifier model ${label} is required.`);
  return result;
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) {
    throw new Error(`Translation verifier model ${label} must be a positive integer.`);
  }
  return result;
}

function numberOption(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) {
    throw new Error(`Translation verifier model ${label} must be finite.`);
  }
  return value;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0) {
    if (signal?.aborted) throw signal.reason ?? new Error("Model request was aborted.");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Model request was aborted."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function credentialError(message: string): TranslationVerifierModelError {
  return new TranslationVerifierModelError("credential", message);
}

function requestError(message: string): TranslationVerifierModelError {
  return new TranslationVerifierModelError("request", message);
}

function responseError(message: string): TranslationVerifierModelError {
  return new TranslationVerifierModelError("response", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
