import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { RealProjectFiles } from "../real-projects/method-files.ts";
import type { MethodTask } from "../real-projects/method-types.ts";
import type { ProjectModel } from "../project-bench/providers.ts";
import type { MeterCall } from "./meter.ts";
import { projectTools, projectBridge } from "./codex-tools.ts";
import { openCodexProvider } from "./codex-provider.ts";

export interface CodexOptions {
  model: ProjectModel;
  sourceRoot: string;
  runRoot: string;
  task: MethodTask;
  onCall: (record: MeterCall) => unknown;
  signal?: AbortSignal;
}

function isolatedEnv(home: string, token: string) {
  const keep = new Set([
    "path",
    "pathext",
    "systemroot",
    "windir",
    "comspec",
    "temp",
    "tmp",
    "lang",
    "localappdata",
    "appdata",
    "systemdrive",
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => keep.has(k.toLowerCase())),
    ),
    USERPROFILE: home,
    HOME: home,
    CODEX_HOME: home,
    RECAST_LOCAL_PROXY_TOKEN: token,
  };
}

async function nativeTurn(
  model: ProjectModel,
  home: string,
  cwd: string,
  proxy: Awaited<ReturnType<typeof openCodexProvider>>,
  bridge: ReturnType<typeof projectBridge>,
  signal: AbortSignal,
) {
  const binary =
    process.env.RECAST_CODEX_BIN ||
    (process.platform === "win32" ? "codex.exe" : "codex");
  const version = execFileSync(binary, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  await writeFile(
    join(home, "config.toml"),
    [
      "model = " + JSON.stringify(model),
      'model_provider = "benchmark"',
      'model_reasoning_effort = "low"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'web_search = "disabled"',
      "project_doc_max_bytes = 0",
      "[features]",
      "shell_tool = false",
      "unified_exec = false",
      "multi_agent = false",
      "apps = false",
      "view_image = false",
      "code_mode = false",
      "code_mode_only = false",
      "code_mode_host = false",
      "skip_host_skill_discovery = true",
      "[model_providers.benchmark]",
      'name = "Metered benchmark API"',
      "base_url = " + JSON.stringify(proxy.url),
      'wire_api = "responses"',
      'env_key = "RECAST_LOCAL_PROXY_TOKEN"',
      "supports_websockets = false",
      "request_max_retries = 2",
      "stream_max_retries = 2",
    ].join("\n"),
  );
  const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
    cwd,
    env: isolatedEnv(home, proxy.token),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diag = "",
    seq = 0;
  const events: { tool: string; path?: string; success: boolean }[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    diag = (diag + text).slice(-3000);
  });
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (error: Error) => void }
  >();
  const completed = Promise.withResolvers<any>();
  completed.promise.catch(() => {}); // Startup can fail before the completion promise is consumed.
  const send = (v: object) => child.stdin.write(JSON.stringify(v) + "\n");
  function request(method: string, params: unknown): Promise<any> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  }
  function failAll(e: Error) {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    completed.reject(e);
  }
  const exited = new Promise<void>((resolve) =>
    child.once("close", (code) => {
      failAll(Error("Codex CLI exited " + code + ": " + diag));
      resolve();
    }),
  );
  child.once("error", failAll);
  child.stdin.on("error", failAll);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && !msg.method) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    } else if (msg.id != null && msg.method === "item/tool/call") {
      const { tool, arguments: args } = msg.params;
      void (async () => {
        let success = true,
          out;
        try {
          out = await bridge.execute(tool, args ?? {});
        } catch (e) {
          success = false;
          out = { error: String(e) };
        }
        events.push({
          tool,
          ...(args?.path ? { path: args.path } : {}),
          success,
        });
        send({
          id: msg.id,
          result: {
            success,
            contentItems: [{ type: "inputText", text: JSON.stringify(out) }],
          },
        });
      })().catch(failAll);
    } else if (msg.id != null) {
      send({
        id: msg.id,
        error: {
          code: -32601,
          message: "Outside the benchmark project interface",
        },
      });
    } else if (msg.method === "turn/completed") {
      completed.resolve(msg.params.turn);
    }
  });
  const abort = () => {
    failAll(Error("Codex trial cancelled"));
    child.kill();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await request("initialize", {
      clientInfo: { name: "recast_benchmark", version: "1.0" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized" });
    const start = await request("thread/start", {
      model,
      modelProvider: "benchmark",
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      dynamicTools: projectTools,
      developerInstructions:
        "Use the supplied project tools for all reads, edits and public checks. Only listed writable files may be changed. Finish by returning your final response.",
    });
    await request("turn/start", {
      threadId: start.thread.id,
      effort: "low",
      input: [{ type: "text", text: bridge.prompt }],
    });
    const turn = await completed.promise;
    const error =
      turn.status === "completed"
        ? null
        : (turn.error?.message ?? "Codex turn " + turn.status);
    return {
      version,
      threadId: start.thread.id,
      turnId: turn.id,
      status: turn.status,
      events,
      error,
    };
  } finally {
    signal.removeEventListener("abort", abort);
    lines.close();
    child.stdin.end();
    child.kill();
    await exited;
  }
}

export async function runCodex(options: CodexOptions) {
  const { model, runRoot, onCall } = options,
    signal = options.signal ?? new AbortController().signal;
  const snapshot = await new RealProjectFiles(runRoot).snapshot(
    options.sourceRoot,
    randomUUID(),
    signal,
  );
  const bridge = projectBridge(options.task, snapshot.outputRoot, signal);
  const isolated = await mkdtemp(join(tmpdir(), "recast-codex-")),
    home = join(isolated, "home"),
    cwd = join(isolated, "cwd");
  let commit: string | null = null,
    error: string | null = null,
    runtime: unknown = null;
  try {
    await mkdir(home);
    await mkdir(cwd);
    const proxy = await openCodexProvider(model, onCall, signal);
    try {
      const agent = await nativeTurn(model, home, cwd, proxy, bridge, signal);
      runtime = {
        ...snapshot,
        agent,
        providerTools: [...proxy.offered],
        suppressedNativeTools: [...proxy.suppressed],
      };
      if (agent.error) throw Error(agent.error);
      commit = await bridge.publish();
    } finally {
      await proxy.close();
    }
  } catch (e) {
    error = String(e);
  } finally {
    await rm(isolated, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    });
  }
  return {
    outputRoot: snapshot.outputRoot,
    commit,
    error,
    indexMs: null,
    runtime,
  };
}
