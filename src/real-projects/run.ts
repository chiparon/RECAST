import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createProjectClient,
  PROJECT_MODELS,
  providerAvailable,
  type ProjectModel,
} from "../project-bench/providers.ts";
import { calibrate } from "./control.ts";
import { gradeDelivery } from "./grading.ts";
import { sha } from "./inputs.ts";
import type { RealFixture } from "./types.ts";

const cases = ["one", "two", "three"];
const { values } = parseArgs({
  options: {
    batch: { type: "string", default: "real-v2" },
    fixture: { type: "string" },
    controls: { type: "boolean" },
  },
});
if (
  !/^[\w-]+$/.test(values.batch!) ||
  (values.fixture && !cases.includes(values.fixture))
)
  throw Error("Invalid selector");
const base = resolve("work", "rb"),
  root = resolve("results", "real-project-bench", values.batch!);
for (const path of [base, root]) await mkdir(path, { recursive: true });
async function json(path: string, value: unknown) {
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}
async function existing(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function version(which: string) {
  const dir = resolve("src/real-projects"),
    files = (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) =>
        join(e.parentPath, e.name)
          .slice(dir.length + 1)
          .replaceAll("\\", "/"),
      )
      .filter(
        (p) =>
          (!p.startsWith("case-") || p.startsWith("case-" + which)) &&
          !/^(report|verify)\./.test(p),
      );
  const hashes = [];
  for (const path of files.sort())
    hashes.push([path, sha(await readFile(join(dir, path)))]);
  for (const path of ["raw.ts", "providers.ts"])
    hashes.push([
      path,
      sha(await readFile(resolve("src/project-bench", path))),
    ]);
  return sha(JSON.stringify(hashes));
}
const methods = ["recast", "sag2sql", "rawagent"] as const;
async function runFixture(which: string) {
  const f: RealFixture = (await import("./case-" + which + ".ts")).fixture;
  console.log("CONTROL", f.id, new Date().toISOString());
  const calibrated = await calibrate(f, base);
  const controlPath = join(root, f.id + ".control.json"),
    priorControl = await existing(controlPath);
  if (priorControl && priorControl.inputHash !== calibrated.summary.inputHash)
    throw Error("Frozen input changed in existing batch");
  await json(controlPath, calibrated.summary);
  console.log(
    "READY",
    f.id,
    calibrated.summary.inputHash,
    calibrated.summary.languages,
  );
  if (values.controls) return;
  const impl = await version(which),
    { runRealMethod } = await import("./methods.ts");
  const rev = execFileSync("git", ["-C", "../weichai", "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const productDiff = sha(
    execFileSync("git", [
      "-C",
      "../weichai",
      "diff",
      "HEAD",
      "--",
      "apps",
      "services",
      "packages",
    ]),
  );
  async function byModel(model: ProjectModel, j: number) {
    if (!(await providerAvailable(model)))
      throw Error("Missing provider " + model);
    for (let k = 0; k < methods.length; k++) {
      const arm = methods[(k + j + cases.indexOf(which)) % methods.length];
      const id = [f.id, model, arm].join("_"),
        path = join(root, id + ".trial.json");
      const lock = await open(path + ".lock", "wx");
      try {
        const old = await existing(path);
        const identity = {
          inputHash: calibrated.summary.inputHash,
          implementationHash: impl,
          productRevision: rev,
          productDiff,
        };
        if (old) {
          if (Object.entries(identity).some(([key, val]) => old[key] !== val))
            throw Error("Recorded protocol changed: " + id);
          console.log("RECORDED", id, old.passed);
          continue;
        }
        const work = await mkdtemp(join(base, "t-"));
        const client = createProjectClient(model, {
          uncapped: true,
          onCall: (c) =>
            appendFileSync(
              join(work, "calls.ndjson"),
              JSON.stringify(c) + "\n",
            ),
        });
        const startedAt = new Date().toISOString(),
          start = performance.now();
        console.log("START", id, startedAt, work);
        let error: string | null = null,
          commit: string | null = null,
          outputRoot: string | null = null,
          indexMs: number | null = null,
          runtime: unknown = null;
        try {
          ({ error, commit, outputRoot, indexMs, runtime } =
            await runRealMethod({
              arm,
              task: calibrated.task,
              sourceRoot: calibrated.starter,
              runRoot: work,
              client,
            }));
        } catch (e) {
          error = String(e);
        }
        const executionMs = performance.now() - start;
        let grade = null,
          gradingError: string | null = null;
        if (outputRoot)
          try {
            grade = await gradeDelivery(
              f,
              calibrated.starter,
              calibrated.frozen.m,
              outputRoot,
              commit,
            );
          } catch (e) {
            gradingError = String(e);
          }
        const wallMs = performance.now() - start;
        const passed = Boolean(
          commit && grade?.passed && !error && !gradingError,
        );
        await json(join(work, "runtime.json"), runtime);
        const row = {
          batch: values.batch,
          task: f.id,
          model,
          arm,
          ...identity,
          starter: calibrated.starter,
          work,
          outputRoot,
          startedAt,
          passed,
          commit,
          error,
          gradingError,
          grade,
          wallMs,
          executionMs,
          indexMs,
          usage: client.usage(),
          calls: client.trace,
        };
        await json(path, row);
        console.log(
          "END",
          id,
          passed,
          Math.round(wallMs / 1000) + "s",
          row.usage.totalTokens,
          error || gradingError || "",
        );
      } finally {
        await lock.close();
        await unlink(path + ".lock");
      }
    }
  }
  const results = await Promise.allSettled(PROJECT_MODELS.map(byModel));
  for (const r of results) if (r.status === "rejected") throw r.reason;
}
for (const which of values.fixture ? [values.fixture] : cases)
  await runFixture(which);
