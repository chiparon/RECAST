import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdir,
  writeFile,
  readFile,
  rename,
  open,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { getHeapStatistics } from "node:v8";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const mysql = createRequire(resolve("../weichai/package.json"))(
  "mysql2/promise",
);
const configs = [
  "sag2-memory",
  "sag2-sqlite-file",
  "seekdb-hash",
  "seekdb-model",
  "sag2-over-seekdb",
];
const { values } = parseArgs({
  options: {
    batch: { type: "string", default: "measured-build" },
    cases: { type: "string" },
    configs: { type: "string" },
    "phase-seconds": { type: "string", default: "300" },
    heap: { type: "string", default: "both" },
    agent: { type: "boolean", default: false },
    "full-only": { type: "boolean", default: false },
  },
});
const phases = values["full-only"] ? ["full"] : ["full", "one", "1pct", "10pct"];
const batch = values.batch!;
if (!/^[A-Za-z0-9_-]+$/.test(batch)) throw Error("Invalid batch name");
if (!["default", "8192", "both"].includes(values.heap!))
  throw Error("Invalid heap");
const phaseTimeoutMs = Number(values["phase-seconds"]) * 1000;
if (!Number.isFinite(phaseTimeoutMs) || phaseTimeoutMs < 1000)
  throw Error("Invalid timeout");
const manifest = JSON.parse(await readFile("corpora/manifest.json", "utf8"));
function select(ids: string[], filter?: string) {
  const picks = filter?.split(",") ?? ids;
  if (picks.some((i) => !ids.includes(i)))
    throw Error("Unknown selection " + picks.join(","));
  return ids.filter((x) => picks.includes(x));
}
const cases = select(
  manifest.cases.map((x) => x.id),
  values.cases,
);
const wanted = select(configs, values.configs);
if (values.agent && cases.some((id) => !["B02", "B03"].includes(id)))
  throw Error("Optional agent modeling only supports B02/B03");
const out = resolve("results/index-build", batch);
const work = resolve("work/index-build", batch);
await mkdir(out, { recursive: true });
await mkdir(work, { recursive: true });
const commit = execFileSync("git", ["-C", "../weichai", "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
async function json(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function admin() {
  return mysql.createConnection({
    host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST || "127.0.0.1",
    port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT || 2881),
    user: process.env.CODE_INTELLIGENCE_SEEKDB_USER || "root",
    password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD || "",
    connectTimeout: 10000,
  });
}
async function manage(db: string, operation: "create" | "drop") {
  if (!/^recast_bench_[a-f0-9]{24}$/.test(db))
    throw Error("Invalid dedicated database name");
  const con = await admin();
  try {
    await con.query({
      sql:
        operation === "create"
          ? "CREATE DATABASE " + db
          : "DROP DATABASE " + db,
      timeout: 60000,
    });
  } finally {
    con.destroy();
  }
}
async function supervise(
  root: string,
  heap: string,
  file: string,
  partial: string,
) {
  const log = await open(join(root, "worker.log"), "wx");
  const tsLoader = pathToFileURL(
    resolve("../weichai/node_modules/tsx/dist/loader.mjs"),
  ).href;
  const args = [
    ...(heap === "8192" ? ["--max-old-space-size=8192"] : []),
    "--import",
    tsLoader,
    resolve("src/index-build/worker.ts"),
    file,
  ];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", log.fd, log.fd],
    windowsHide: true,
  });
  await log.close();
  const completion = new Promise<{
    code: number | null;
    signal: string | null;
  }>((ok, bad) => {
    child.once("error", bad);
    child.once("exit", (code, signal) => ok({ code, signal }));
  });
  let group = "setup",
    stage = "setup",
    since = Date.now(),
    timedOut: string | null = null;
  // Node/OOM exits can occur while a child parser is active. End the process tree on a budget overrun.
  const timer = setInterval(async () => {
    if (timedOut) return;
    try {
      const r = await json(partial);
      stage = r?.current ?? "setup";
      const next = stage.includes("/query-probes")
        ? "queries"
        : stage.startsWith("restore/")
          ? "restore-" + r.steps.length
          : phases.includes(stage.split("/")[0])
            ? stage.split("/")[0]
            : "setup";
      if (next !== group) {
        group = next;
        since = Date.now();
      }
      if (Date.now() - since < phaseTimeoutMs) return;
      timedOut = "Timeout " + phaseTimeoutMs / 1000 + " s in " + stage;
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        const kill = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        kill.on("error", () => child.kill());
      }
    } catch (e) {
      console.error("Progress read:", e.message);
    }
  }, 1500);
  try {
    return { ...(await completion), timedOut, lastStage: stage };
  } finally {
    clearInterval(timer);
  }
}
async function trial(c, config, heap) {
  const slug = [c.id, config, heap, ...(values.agent ? ["agent"] : [])].join(
      "_",
    ),
    final = join(out, slug + ".json");
  const prior = await json(final);
  if (prior) {
    if (
      prior.corpus.sha256 !== c.sha256 ||
      prior.commit !== commit ||
      prior.phaseTimeoutMs !== phaseTimeoutMs ||
      Boolean(prior.fullOnly) !== values["full-only"]
    )
      throw Error("Batch inputs differ for " + slug + "; use a new --batch");
    console.log("RECORDED", slug, prior.status);
    return;
  }
  const lock = join(work, slug + ".lock");
  const lease = await open(lock, "wx");
  const id = randomUUID().replaceAll("-", "").slice(0, 24);
  const root = join(work, slug + "_" + id),
    partial = join(root, "progress.json"),
    file = join(root, "job.json");
  let owned = false,
    db: string | undefined,
    cleanupError = null,
    processResult = null,
    error = null;
  const start = Date.now();
  try {
    await mkdir(root, { recursive: true });
    console.log("START", slug, new Date(start).toISOString());
    try {
      if (config.startsWith("seekdb-") || config === "sag2-over-seekdb") {
        db = "recast_bench_" + id;
        await manage(db, "create");
        owned = true;
      }
      await writeFile(
        file,
        JSON.stringify({
          caseId: c.id,
          config,
          workDir: root,
          repositories: c.repositories.map(({ id, root, loc, sourceList }) => ({
            id,
            root,
            loc,
            sourceList,
          })),
          database: db,
          resultFile: partial,
          increments: phases.slice(1),
          queries: ["B03", "B06", "B08", "B09"].includes(c.id),
          agent: values.agent,
        }),
      );
      processResult = await supervise(root, heap, file, partial);
    } catch (e) {
      error = e.message;
    } finally {
      if (owned)
        try {
          await manage(db!, "drop");
        } catch (e) {
          cleanupError = e.message;
        }
    }
    const snapshot = (await json(partial)) ?? { steps: [] };
    if (processResult?.timedOut) error = processResult.timedOut;
    if (!error && snapshot.error) error = snapshot.error;
    if (!error && processResult?.code !== 0) {
      let tail = "";
      try {
        const info = await stat(join(root, "worker.log"));
        const fd = await open(join(root, "worker.log"));
        try {
          const buf = Buffer.alloc(Math.min(info.size, 12288));
          await fd.read(buf, 0, buf.length, info.size - buf.length);
          tail = buf
            .toString()
            .split(/\r?\n/)
            .filter((l) => /fatal|memory|error/i.test(l))
            .slice(-2)
            .join(" ")
            .slice(0, 500);
        } finally {
          await fd.close();
        }
      } catch {}
      error =
        "worker exit " +
        processResult?.code +
        " " +
        (processResult?.signal ?? "") +
        " " +
        tail;
    }
    for (const phase of phases) {
      let s = snapshot.steps.find((s) => s.phase === phase);
      if (!s) {
        s = {
          phase,
          status: phase === "full" ? "error" : "blocked",
          error: error ?? "Not executed",
        };
        snapshot.steps.push(s);
      } else if (s.status === "running") {
        s.status = "error";
        s.error = error ?? "Interrupted";
      }
    }
    const result = {
      ...snapshot,
      batch,
      caseId: c.id,
      config,
      heap,
      agent: values.agent,
      fullOnly: values["full-only"],
      attempt: id,
      corpus: {
        id: c.id,
        scale: c.scale,
        languageMode: c.languageMode,
        loc: c.loc,
        files: c.files,
        languages: c.languages,
        sha256: c.sha256,
      },
      commit,
      node: process.version,
      heapLimitMiB:
        heap === "8192" ? null : getHeapStatistics().heap_size_limit / 1048576,
      phaseTimeoutMs,
      elapsedMs: Date.now() - start,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date().toISOString(),
      database: db ?? null,
      cleanupError,
      processResult,
      status:
        error || cleanupError || snapshot.status !== "ok" ? "error" : "ok",
      error: error ?? snapshot.error ?? cleanupError ?? null,
      log: join(root, "worker.log"),
    };
    await writeFile(final + ".tmp", JSON.stringify(result, null, 2));
    await rename(final + ".tmp", final);
    console.log(
      "END",
      slug,
      result.status,
      Math.round(result.elapsedMs / 1000) + "s",
      result.error ?? "",
    );
    if (cleanupError)
      throw Error("Dedicated DB cleanup failed: " + db + " " + cleanupError);
  } finally {
    await lease.close();
    const { unlink } = await import("node:fs/promises");
    await unlink(lock);
  }
}
for (const id of cases) {
  const c = manifest.cases.find((x) => x.id === id);
  for (const config of wanted) {
    const heaps =
      config === "sag2-memory" && ["B08", "B09"].includes(id)
        ? ["default", "8192"]
        : ["default"];
    for (const h of heaps.filter(
      (x) => values.heap === "both" || values.heap === x,
    ))
      await trial(c, config, h);
  }
}
