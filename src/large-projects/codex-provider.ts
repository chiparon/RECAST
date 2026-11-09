import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  modelKeyEnvironment,
  type ProjectModel,
} from "../project-bench/providers.ts";
import { replyDetails, type MeterCall } from "./meter.ts";
import { allowedTools, projectTools } from "./codex-tools.ts";

async function secret(model: ProjectModel) {
  const path = process.env[modelKeyEnvironment(model)];
  const envKey =
    process.env[
      model === "deepseek-flash" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY"
    ];
  const key = path ? (await readFile(path, "utf8")).trim() : envKey?.trim();
  if (!key) throw Error("Missing provider credential for " + model);
  return key;
}
function sseEvents(body: string) {
  return body
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .flatMap((block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
    });
}
function requestedRetention(input: any): MeterCall["requestedCacheTtl"] {
  const global =
    input.prompt_cache_options?.ttl ?? input.prompt_cache_retention;
  const ttls = new Set<string>();
  if (global === "30m" || global === "12h") ttls.add(global);
  for (const item of input.input ?? []) {
    for (const part of [
      item,
      ...(Array.isArray(item.content) ? item.content : []),
    ]) {
      const ttl =
        part.type === "prompt_cache_breakpoint"
          ? part.ttl
          : part.prompt_cache_breakpoint?.ttl;
      if (ttl === "30m" || ttl === "12h") ttls.add(ttl);
    }
  }
  if (ttls.size > 1) return "mixed";
  return ttls.has("12h") ? "12h" : ttls.has("30m") ? "30m" : undefined;
}

/** The CLI receives a single-use local bearer, never the upstream provider key.
 * Only project tools can reach the model or be dispatched by the CLI. Keep the
 * provider's original SSE events and inspect returned items before releasing them. */
export async function openCodexProvider(
  model: ProjectModel,
  onCall: (row: MeterCall) => unknown,
  signal: AbortSignal,
) {
  const key = await secret(model),
    token = randomBytes(32).toString("hex");
  const endpoint =
    model === "deepseek-flash"
      ? "https://api.deepseek.com"
      : "https://api.openai.com/v1";
  const offered = new Set<string>(),
    suppressed = new Set<string>();
  let turn = 0,
    attempt = 0,
    previous = "";
  const server = createServer(async (req, res) => {
    let charged: MeterCall | undefined,
      started = performance.now();
    let code = 400,
      contentType = "application/json",
      output = "";
    try {
      if (req.headers.authorization !== "Bearer " + token) {
        res.writeHead(401).end();
        return;
      }
      const compact = req.url === "/responses/compact";
      if (req.method !== "POST" || (!compact && req.url !== "/responses")) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (input.model !== model)
        throw Error("Unexpected model requested by Codex: " + input.model);
      if (!compact) {
        const requested = [
          ...(input.tools ?? []),
          ...input.input
            .filter((i: any) => i.type === "additional_tools")
            .flatMap((i: any) => i.tools ?? []),
        ];
        input.input = input.input.filter(
          (i: any) => i.type !== "additional_tools",
        );
        const flat = requested.flatMap((t: any) =>
          t.type === "namespace"
            ? (t.tools ?? []).map((child: any) => ({ ...child, group: t.name }))
            : [t],
        );
        for (const tool of flat) {
          if (tool.type !== "function" || !allowedTools.has(tool.name))
            suppressed.add(tool.name ?? tool.type);
        }
        // New Codex clients wrap dynamic tools behind a code-execution namespace.
        // Expose the exact same registered RPC tools as Responses functions.
        input.tools = projectTools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
          strict: false,
        }));
        for (const t of input.tools) offered.add(t.name);
        input.store = false;
      }
      const serialized = JSON.stringify(input),
        fingerprint = createHash("sha256").update(serialized).digest("hex");
      if (previous !== fingerprint) {
        turn++;
        attempt = 0;
        previous = fingerprint;
      }
      charged = {
        turn,
        attempt: ++attempt,
        requestKind: compact ? "compact" : "responses",
        model,
        status: "error",
        tools: [],
        elapsedMs: 0,
        usage: null,
        startedAt: new Date().toISOString(),
      };
      const ttl = requestedRetention(input);
      if (ttl) charged.requestedCacheTtl = ttl;
      const response = await fetch(
        endpoint + (compact ? "/responses/compact" : "/responses"),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
          },
          body: serialized,
          signal,
          redirect: "error",
        },
      );
      charged.httpStatus = response.status;
      const body = await response.text(),
        type = response.headers.get("content-type") ?? "application/json";
      if (!response.ok) {
        let diagnostic;
        try {
          const e = JSON.parse(body).error;
          diagnostic = [e?.code, e?.param, e?.message]
            .filter(Boolean)
            .join(" ");
        } catch {}
        charged.error = ("HTTP " + response.status + " " + (diagnostic ?? ""))
          .split(key)
          .join("[redacted]")
          .slice(0, 450);
        try {
          Object.assign(
            charged,
            replyDetails(JSON.parse(body), charged.startedAt),
          );
        } catch {}
        code = response.status;
        contentType = type;
        output = body;
        return;
      }
      const events = type.includes("event-stream") ? sseEvents(body) : [];
      const terminal =
        events.findLast((e) =>
          [
            "response.completed",
            "response.incomplete",
            "response.failed",
          ].includes(e.type),
        )?.response ?? (!events.length ? JSON.parse(body) : undefined);
      Object.assign(charged, replyDetails(terminal, charged.startedAt));
      if (!terminal || (!compact && terminal.status !== "completed"))
        throw Error("Incomplete upstream response");
      if (
        (!compact || terminal.model !== undefined) &&
        terminal.model !== model
      )
        throw Error("Provider served a different model: " + terminal.model);
      // A malformed model-generated tool name must never become a built-in CLI operation.
      const items = [
        ...(terminal.output ?? []),
        ...events.flatMap((e) => (e.item ? [e.item] : [])),
      ];
      for (const item of items) {
        if (item.type === "function_call" && !allowedTools.has(item.name))
          throw Error("Provider returned an unapproved tool: " + item.name);
        if (
          !compact &&
          !["message", "reasoning", "function_call", "compaction"].includes(
            item.type,
          )
        )
          throw Error(
            "Provider returned an unapproved output type: " + item.type,
          );
      }
      charged.tools = [
        ...new Set(
          items
            .filter((i) => i.type === "function_call")
            .map((i) => i.name as string),
        ),
      ];
      charged.status = "ok";
      code = 200;
      contentType = type;
      output = body;
    } catch (e) {
      const message = String(e).split(key).join("[redacted]").slice(0, 2000);
      if (charged) charged.error = message;
      output = JSON.stringify({ error: { message } });
    } finally {
      if (charged) {
        charged.elapsedMs = performance.now() - started;
        try {
          await onCall(charged);
        } catch {
          code = 500;
          contentType = "application/json";
          output = '{"error":{"message":"Provider usage ledger write failed"}}';
        }
      }
      if (!res.writableEnded)
        res.writeHead(code, { "Content-Type": contentType }).end(output);
    }
  });
  await new Promise<void>((ok, fail) =>
    server.once("error", fail).listen(0, "127.0.0.1", ok),
  );
  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    token,
    offered,
    suppressed,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
