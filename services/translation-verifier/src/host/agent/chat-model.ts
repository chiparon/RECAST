import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult } from "@langchain/core/outputs";

/** Credential is a caller-owned value or a late resolver; it never becomes prompt text. */
export type TranslationVerifierApiKey = string | (() => string);

/** Total transport attempts and delay for one model request. */
export type TranslationVerifierRequestRetry = {
  maxAttempts?: number;
  delayMs?: number;
};

/** Keep these aligned with the legacy adapter defaults. */
const DEFAULT_API_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_MAX_REQUEST_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 750;
const MAX_REQUEST_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Transient failures the one transport retry loop may repeat. This mirrors the
 * legacy adapter so behaviour does not change during the migration.
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type TranslationVerifierChatModelOptions = {
  apiKey: TranslationVerifierApiKey;
  apiBase?: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  request?: typeof globalThis.fetch;
  /** Total transport attempts for one model call; the transport owns the only retry loop. */
  requestRetry?: TranslationVerifierRequestRetry;
  maxOutputLimitRetries?: number;
  onOutputLimitRetry?: (attempt: number, maxRetries: number) => void;
};

/**
 * Build the framework chat model for the LangChain Host.
 *
 * The OpenAI-compatible DeepSeek endpoint is configured through the official
 * SDK client options, but every framework/SDK retry layer is disabled:
 * ChatOpenAI's outer AsyncCaller and the OpenAI client both stay at zero
 * retries. The injected fetch wrapper is the single place that performs the
 * existing "at most 3 attempts, 750ms apart" policy, so retries never stack and
 * one request stays one Agent decision round.
 */
export function createTranslationVerifierChatModel(
  options: TranslationVerifierChatModelOptions,
): ChatOpenAI {
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const retry = normalizeRequestRetry(options.requestRetry);
  const transport = options.request ?? globalThis.fetch.bind(globalThis);
  const request = createRetryingFetch(transport, retry);
  const apiKey = options.apiKey;

  const outputRetries = options.maxOutputLimitRetries ?? 3;
  if (!Number.isInteger(outputRetries) || outputRetries < 0 || outputRetries > 8) {
    throw new Error("Invalid verifier output-limit recovery budget.");
  }
  const model = new OutputRecoveringChatOpenAI({
    apiKey: typeof apiKey === "function" ? async () => apiKey() : apiKey,
    model: options.model ?? DEFAULT_MODEL,
    maxTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    // ChatOpenAI defaults its outer AsyncCaller to six retries; disable it.
    maxRetries: 0,
    disableStreaming: true,
    configuration: {
      baseURL: apiBase,
      // The official SDK defaults to two retries; disable it explicitly.
      maxRetries: 0,
      fetch: request,
    },
    modelKwargs: { thinking: { type: "disabled" } },
  });
  model.outputLimitRetries = outputRetries;
  model.onOutputLimitRetry = options.onOutputLimitRetry;
  return model;
}

/** Recover before LangChain can dispatch any tool in a truncated response. */
class OutputRecoveringChatOpenAI extends ChatOpenAI {
  outputLimitRetries = 3;
  onOutputLimitRetry?: (attempt: number, maxRetries: number) => void;

  override withConfig(config: Parameters<ChatOpenAI["withConfig"]>[0]): ReturnType<ChatOpenAI["withConfig"]> {
    // The SDK's implementation constructs ChatOpenAI directly, losing subclass
    // behavior during bindTools. Keep recovery on every configured instance.
    const model = new OutputRecoveringChatOpenAI(this.fields);
    model.defaultOptions = { ...this.defaultOptions, ...config };
    model.outputLimitRetries = this.outputLimitRetries;
    model.onOutputLimitRetry = this.onOutputLimitRetry;
    return model;
  }

  override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    for (let retry = 0; ; retry++) {
      options.signal?.throwIfAborted();
      const input = retry === 0 ? messages : [...messages, new HumanMessage(
        `The previous response reached its output token limit and was discarded. None of its tool calls executed. Continue from the last valid tool results. Recovery ${retry}/${this.outputLimitRetries}: emit one focused tool call at a time, keep arguments below ${retry > 1 ? 2000 : 4000} characters and split large tests into smaller files. Preserve requirement assertions; do not report success without running tests.`,
      )];
      const result = await super._generate(input, options, runManager);
      if (!result.generations.some(item => (item.generationInfo as Record<string, unknown> | undefined)?.finish_reason === "length" ||
          (item.message.response_metadata as Record<string, unknown> | undefined)?.finish_reason === "length")) return result;
      if (retry >= this.outputLimitRetries) {
        throw new Error(`Verifier model output limit: ${this.outputLimitRetries} small-step retries were truncated; no incomplete tool calls executed. Retry the failed module.`);
      }
      try { this.onOutputLimitRetry?.(retry + 1, this.outputLimitRetries); }
      catch { /* Logging cannot interrupt recovery. */ }
    }
  }
}

type NormalizedRetry = { maxAttempts: number; delayMs: number };

function normalizeRequestRetry(
  value: TranslationVerifierRequestRetry | undefined,
): NormalizedRetry {
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

/**
 * Wrap the transport used by the OpenAI SDK with the verifier's transient
 * retry policy. It is the only retry loop in the model path.
 */
function createRetryingFetch(
  request: typeof globalThis.fetch,
  retry: NormalizedRetry,
): typeof globalThis.fetch {
  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    for (let attempt = 1; ; attempt += 1) {
      // Cancellation can arrive between attempts or while a zero delay resolves.
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Model request was aborted.");
      }
      let response: Response;
      try {
        response = await request(input, init);
      } catch (error) {
        if (isAbort(signal, error)) throw abortReason(signal, error);
        if (attempt >= retry.maxAttempts) throw error;
        await delay(retry.delayMs, signal);
        continue;
      }
      if (
        response.ok ||
        attempt >= retry.maxAttempts ||
        !RETRYABLE_STATUS.has(response.status)
      ) {
        return response;
      }
      // Release the connection before waiting for the next attempt.
      void response.body?.cancel().catch(() => undefined);
      await delay(retry.delayMs, signal);
    }
  };
}

function isAbort(signal: AbortSignal | null | undefined, error: unknown): boolean {
  if (signal?.aborted) return true;
  return typeof error === "object" && error !== null &&
    "name" in error && (error as { name?: unknown }).name === "AbortError";
}

function abortReason(signal: AbortSignal | null | undefined, error: unknown): unknown {
  if (signal?.aborted && signal.reason !== undefined) return signal.reason;
  if (error !== undefined) return error;
  return new Error("Model request was aborted.");
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Model request was aborted.");
  if (milliseconds === 0) return;
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
