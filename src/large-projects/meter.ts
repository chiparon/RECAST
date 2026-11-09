import { AsyncLocalStorage } from "node:async_hooks";
import { waitForProvider } from "./transport.ts";
import {
  createProjectClient,
  type ProjectModel,
  type ProviderCall,
  type TokenUsage,
} from "../project-bench/providers.ts";

export interface MeterUsage extends TokenUsage {
  cacheReadReported?: boolean;
  cacheWriteTokens?: number;
  cacheWrite30mTokens?: number;
  cacheWrite12hTokens?: number;
}
export interface MeterCall extends Omit<ProviderCall, "usage"> {
  startedAt: string;
  serviceTier?: string;
  requestedCacheTtl?: "30m" | "12h" | "mixed";
  requestKind?: "responses" | "compact";
  usage: MeterUsage | null;
}
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export function decodeUsage(u: any): MeterUsage | null {
  if (!u || !integer(u.input_tokens) || !integer(u.output_tokens)) return null;
  const details = u.input_tokens_details ?? {},
    writes = details.cache_write_tokens_details ?? {};
  const cached = details.cached_tokens ?? u.prompt_cache_hit_tokens;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    totalTokens: u.total_tokens ?? u.input_tokens + u.output_tokens,
    cachedInputTokens: cached ?? 0,
    cacheReadReported: integer(cached),
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    ...(integer(details.cache_write_tokens) && {
      cacheWriteTokens: details.cache_write_tokens,
    }),
    ...(integer(writes.ttl_30m_tokens) && {
      cacheWrite30mTokens: writes.ttl_30m_tokens,
    }),
    ...(integer(writes.ttl_12h_tokens) && {
      cacheWrite12hTokens: writes.ttl_12h_tokens,
    }),
  };
}
export function replyDetails(data: any, startedAt: string) {
  return {
    startedAt,
    servedModel: data?.model,
    responseId: data?.id,
    serviceTier: data?.service_tier,
    usage: decodeUsage(data?.usage),
  };
}
export const sumUsage = (calls: readonly MeterCall[]) => ({
  inputTokens: calls.reduce((n, c) => n + (c.usage?.inputTokens ?? 0), 0),
  cachedInputTokens: calls.reduce(
    (n, c) => n + (c.usage?.cachedInputTokens ?? 0),
    0,
  ),
  outputTokens: calls.reduce((n, c) => n + (c.usage?.outputTokens ?? 0), 0),
  reasoningTokens: calls.reduce(
    (n, c) => n + (c.usage?.reasoningTokens ?? 0),
    0,
  ),
  totalTokens: calls.reduce((n, c) => n + (c.usage?.totalTokens ?? 0), 0),
  requests: calls.length,
  usageComplete: calls.every((c) => c.usage !== null),
});

// The historical Responses client emits only the basic token counters. Observe the
// provider response inside this trial's child process without changing v2 replay code.
export function meterExisting(
  model: ProjectModel,
  onCall: (call: MeterCall) => void,
) {
  const nativeFetch = globalThis.fetch;
  type Observed = {
    reply?: ReturnType<typeof replyDetails>;
    signal?: AbortSignal;
  };
  const context = new AsyncLocalStorage<Observed>();
  const endpoints = new Set([
    "https://api.openai.com/v1/responses",
    "https://api.deepseek.com/responses",
  ]);
  globalThis.fetch = async (input, init) => {
    const observed = context.getStore(),
      url = input instanceof Request ? input.url : String(input);
    if (!observed || !endpoints.has(url)) return nativeFetch(input, init);
    const startedAt = new Date().toISOString();
    observed.reply = replyDetails(null, startedAt);
    const response = await nativeFetch(input, init);
    try {
      observed.reply = replyDetails(await response.clone().json(), startedAt);
    } catch {
      /* The original SDK handles invalid or interrupted responses. */
    }
    return response;
  };
  const client = createProjectClient(model, {
    uncapped: true,
    onCall: async (row) => {
      const observed = context.getStore()?.reply;
      if (!observed) throw Error("Provider attempt was not observed");
      onCall({ ...row, ...observed, usage: observed.usage ?? row.usage });
      if (
        row.status === "error" &&
        row.httpStatus === undefined &&
        row.attempt < 3
      ) {
        const signal = context.getStore()?.signal;
        if (!signal?.aborted) await waitForProvider(model, signal);
      }
      if (row.status === "ok" && observed.servedModel !== model)
        throw Error("Provider did not attest requested model: " + model);
    },
  });
  return {
    client: {
      complete: (...args: Parameters<typeof client.complete>) =>
        context.run({ signal: args[2] }, () => client.complete(...args)),
    },
    close() {
      globalThis.fetch = nativeFetch;
    },
  };
}
