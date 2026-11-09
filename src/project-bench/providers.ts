import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import type {
  DeepSeekToolCall,
  DeepSeekToolCompletion,
  DeepSeekToolDefinition,
  DeepSeekToolMessage,
} from "../../../weichai/services/adaptation-service/src/deepseek-client.ts";

export const PROJECT_MODELS = [
  "gpt-6-luna",
  "gpt-6.1-sol",
  "deepseek-flash",
] as const;
export type ProjectModel = (typeof PROJECT_MODELS)[number];
export type ProjectClient = ReturnType<typeof createProjectClient>;
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}
export interface ProviderCall {
  turn: number;
  attempt: number;
  model: ProjectModel;
  servedModel?: string;
  responseId?: string;
  httpStatus?: number;
  status: "ok" | "error";
  error?: string;
  elapsedMs: number;
  usage: TokenUsage | null;
  tools: string[];
}
interface ClientOptions {
  /** Omit bench-imposed task, turn and response caps for the real-project suite. */
  uncapped?: boolean;
  maxTurns?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onCall?: (record: ProviderCall) => unknown;
}
interface OutputItem {
  type: string;
  role?: string;
  content?: { type: string; text?: string }[];
  name?: string;
  arguments?: string;
  call_id?: string;
  created_by?: unknown;
  [key: string]: unknown;
}
interface ProviderResponse {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  error?: { code?: string; message?: string };
  output?: OutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

export function modelKeyEnvironment(model: ProjectModel) {
  return model === "deepseek-flash" ? "DEEPSEEK_KEY_FILE" : "RECAST_KEY_FILE";
}

async function getKey(model: ProjectModel): Promise<string | undefined> {
  const envName =
    model === "deepseek-flash" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
  const envKey = process.env[envName]?.trim();
  const file = process.env[modelKeyEnvironment(model)];
  if (!file) return envKey || undefined;
  try {
    return (await readFile(file, "utf8")).trim() || envKey || undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return envKey || undefined;
    throw new Error(
      "Cannot read the file configured by " + modelKeyEnvironment(model),
    );
  }
}

export async function providerAvailable(model: ProjectModel) {
  return Boolean(await getKey(model));
}

function reportedUsage(response: ProviderResponse): TokenUsage | null {
  const u = response.usage;
  if (
    !u ||
    !Number.isSafeInteger(u.input_tokens) ||
    !Number.isSafeInteger(u.output_tokens)
  )
    return null;
  return {
    inputTokens: u.input_tokens!,
    outputTokens: u.output_tokens!,
    totalTokens: u.total_tokens ?? u.input_tokens! + u.output_tokens!,
    cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

function retryDelay(header: string | null, attempt: number) {
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(header) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 60_000);
  }
  return 1_000 * 2 ** (attempt - 1);
}

/** One metered client per project trial; the budget spans every module and repair. */
export function createProjectClient(
  model: ProjectModel,
  options: ClientOptions = {},
) {
  if (!PROJECT_MODELS.includes(model))
    throw new Error("Unknown project model: " + model);
  const trace: ProviderCall[] = [];
  let turns = 0;
  const replay = new Map<string, OutputItem[]>();
  const endpoint =
    model === "deepseek-flash"
      ? "https://api.deepseek.com/responses"
      : "https://api.openai.com/v1/responses";

  function usage() {
    const sum: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    };
    for (const call of trace) {
      if (!call.usage) continue;
      for (const key of Object.keys(sum) as (keyof TokenUsage)[])
        sum[key] += call.usage[key];
    }
    return {
      ...sum,
      requests: trace.length,
      turns,
      usageComplete: trace.every((x) => x.usage !== null),
    };
  }
  const inputItems = (messages: readonly DeepSeekToolMessage[]): object[] => {
    const input: object[] = [];
    for (const m of messages) {
      if (m.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: m.toolCallId,
          output: m.content,
        });
        continue;
      }
      const saved =
        m.role === "assistant" && m.toolCalls?.length
          ? replay.get(m.toolCalls[0].id)
          : undefined;
      if (saved) {
        // Preserve provider-issued reasoning items and assistant phases within the active transcript.
        input.push(...saved);
        continue;
      }
      if (m.content) input.push({ role: m.role, content: m.content });
      for (const call of m.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    }
    return input;
  };
  async function complete(
    messages: readonly DeepSeekToolMessage[],
    tools: readonly DeepSeekToolDefinition[],
    callerSignal?: AbortSignal,
  ): Promise<DeepSeekToolCompletion> {
    const signals = [options.signal, callerSignal].filter(
      (s): s is AbortSignal => Boolean(s),
    );
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    if (!options.uncapped && turns >= (options.maxTurns ?? 64))
      throw new Error("Project model turn budget exhausted");
    const remaining = options.uncapped ? Infinity : (options.maxTokens ?? 160_000) - usage().totalTokens;
    if (remaining < 16) throw new Error("Project model token budget exhausted");
    const key = await getKey(model);
    if (!key)
      throw new Error(
        "Missing credentials for " +
          model +
          ": set " +
          modelKeyEnvironment(model),
      );
    const turn = ++turns;
    const body = JSON.stringify({
      model,
      input: inputItems(messages),
      store: false,
      reasoning: { effort: "low" },
      ...(options.uncapped ? {} : { max_output_tokens: Math.min(remaining, options.maxOutputTokens ?? 8192) }),
      tools: tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      })),
    });
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      const started = performance.now();
      const row: ProviderCall = {
        turn,
        attempt,
        model,
        status: "error",
        elapsedMs: 0,
        usage: null,
        tools: [],
      };
      let response: Response | undefined;
      let decoded: ProviderResponse | undefined;
      let retry = false;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
          },
          body,
        });
        row.httpStatus = response.status;
        retry = [408, 429, 500, 502, 503, 504].includes(response.status);
        decoded = (await response.json()) as ProviderResponse;
        row.usage = reportedUsage(decoded);
        row.servedModel = decoded.model;
        row.responseId = decoded.id;
        if (!response.ok) {
          if (decoded.error?.code === "insufficient_quota") retry = false;
          throw new Error(
            "HTTP " +
              response.status +
              (decoded.error?.code ? " " + decoded.error.code : ""),
          );
        }
        if (decoded.status !== "completed" || !Array.isArray(decoded.output))
          throw new Error(
            "Response " +
              String(decoded.status) +
              (decoded.incomplete_details?.reason
                ? ": " + decoded.incomplete_details.reason
                : ""),
          );
        const toolCalls: DeepSeekToolCall[] = [];
        const text: string[] = [];
        for (const item of decoded.output) {
          if (item.type === "function_call") {
            if (
              !item.call_id ||
              !item.name ||
              typeof item.arguments !== "string"
            )
              throw new Error("Malformed provider function call");
            toolCalls.push({
              id: item.call_id,
              name: item.name,
              arguments: item.arguments,
            });
          }
          if (item.type === "message") {
            for (const part of item.content ?? [])
              if (part.type === "output_text" && part.text)
                text.push(part.text);
          }
        }
        if (!toolCalls.length && !text.length)
          throw new Error(
            "Provider returned no assistant text or function calls",
          );
        if (toolCalls.length) {
          // The Responses SDK strips created_by when replaying function/message/reasoning output.
          replay.set(
            toolCalls[0].id,
            decoded.output.map(({ created_by, ...item }) => item),
          );
        }
        row.tools = toolCalls.map((c) => c.name);
        row.status = "ok";
        return { content: text.join("\n"), toolCalls };
      } catch (e) {
        row.error = (e instanceof Error ? e.message : String(e))
          .split(key)
          .join("[redacted]")
          .replace(/sk-[^\s"']+/g, "[redacted]")
          .slice(0, 500);
        if (attempt >= 3 || signal.aborted || (response && !retry))
          throw new Error(model + ": " + row.error);
      } finally {
        row.elapsedMs = performance.now() - started;
        trace.push(row);
        await options.onCall?.(row);
      }
      await wait(
        retryDelay(response?.headers.get("retry-after") ?? null, attempt),
        undefined,
        { signal },
      );
    }
  }
  return { model, trace, usage, complete };
}
