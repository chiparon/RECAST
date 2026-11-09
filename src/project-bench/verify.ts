import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  gradeTask,
  projectTasks,
  type ProjectGrade,
  type ProjectTask,
} from "./tasks.ts";
import { PROJECT_MODELS, type ProviderCall } from "./providers.ts";
import { arms, hash, protocol, publicProject } from "./trial.ts";

// Match the measured version in run.ts. Acceptance contents and project inputs
// are frozen separately because those definitions are imported by tasks.ts.
async function implementationHash(historical = false) {
  const h = createHash("sha256");
  for (const name of [
    "trial.ts",
    "commands.ts",
    "run.ts",
    "providers.ts",
    "workflow.ts",
    "raw.ts",
    "tasks.ts",
    "fixture-format.ts",
  ]) {
    const bytes = historical
      ? execFileSync("git", ["show", "66006d025bbed54d413b5dc1cd346d1623a7700f:src/project-bench/" + name])
      : await readFile(new URL(name, import.meta.url));
    h.update(name).update(bytes);
  }
  return h.digest("hex");
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  });
}
async function inRoot(parent: string, path: string) {
  const actual = await realpath(path),
    base = await realpath(parent),
    rel = relative(base, actual);
  assert(
    rel && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel),
    "Artifact outside its expected root",
  );
  return actual;
}
function duration(n: number) {
  assert(Number.isFinite(n) && n >= 0, "Invalid duration: " + n);
}
const tokenKeys = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "reasoningTokens",
] as const;
function verifyCalls(row, trace: ProviderCall[]) {
  assert.deepEqual(
    row.calls,
    trace,
    "Result calls differ from the append-only request trace",
  );
  const sums = Object.fromEntries(tokenKeys.map((k) => [k, 0]));
  let turn = 0,
    attempt = 0,
    requestMs = 0,
    toolCalls = 0;
  for (const c of trace) {
    assert.equal(c.model, row.model);
    if (c.turn === turn + 1) {
      turn++;
      attempt = 0;
    }
    assert.equal(c.turn, turn);
    assert.equal(c.attempt, ++attempt);
    assert(attempt <= 3);
    assert(c.status === "ok" || c.status === "error");
    if (c.status === "ok")
      assert(c.httpStatus != null && c.httpStatus >= 200 && c.httpStatus < 300);
    else assert(c.error);
    assert(Array.isArray(c.tools));
    toolCalls += c.tools.length;
    duration(c.elapsedMs);
    requestMs += c.elapsedMs;
    if (c.usage) {
      for (const k of tokenKeys) {
        assert(
          Number.isSafeInteger(c.usage[k]) && c.usage[k] >= 0,
          "Invalid reported " + k,
        );
        sums[k] += c.usage[k];
      }
      assert.equal(
        c.usage.totalTokens,
        c.usage.inputTokens + c.usage.outputTokens,
      );
      assert(
        c.usage.cachedInputTokens <= c.usage.inputTokens &&
          c.usage.reasoningTokens <= c.usage.outputTokens,
      );
    }
  }
  for (const k of tokenKeys)
    assert.equal(row.usage[k], sums[k], "Incorrect aggregate " + k);
  assert.equal(row.usage.requests, trace.length);
  assert.equal(row.toolCalls, toolCalls);
  assert.equal(
    row.usage.usageComplete,
    trace.every((c) => c.usage !== null),
  );
  // A cancellation or request-construction failure can occur before the turn's first HTTP attempt.
  assert(
    row.usage.turns === turn ||
      (row.status === "failed" && row.usage.turns === turn + 1),
  );
  assert(
    row.usage.turns <= row.protocol.maxTurns &&
      requestMs <= row.executionMs + 5,
  );
}
async function verifyStarter(task: ProjectTask, run: string) {
  const starter = await inRoot(run, join(run, "starter")),
    expected = new Set(Object.keys(task.files));
  async function walk(path: string, prefix: string) {
    for (const ent of await readdir(path, { withFileTypes: true })) {
      const name = prefix + ent.name;
      if (ent.isDirectory()) await walk(join(path, ent.name), name + "/");
      else {
        assert(
          ent.isFile() && expected.delete(name),
          "Unexpected starter file " + name,
        );
        assert.equal(
          await readFile(join(path, ent.name), "utf8"),
          task.files[name],
          "Changed starter " + name,
        );
      }
    }
  }
  await walk(starter, "");
  assert.equal(expected.size, 0, "Incomplete starter input");
}
function comparableGrade(g: ProjectGrade) {
  return {
    passed: g.passed,
    passedChecks: g.passedChecks,
    totalChecks: g.totalChecks,
    integrityErrors: [...g.integrityErrors].sort(),
    checks: g.checks.map((c) => ({ id: c.id, passed: c.passed })),
  };
}
async function verifyPublication(
  task: ProjectTask,
  row,
  runtime,
  output: string,
) {
  const committed = row.commit;
  assert.match(committed, /^[a-f0-9]{40}$/);
  assert.equal(git(output, "rev-parse", "HEAD").trim(), committed);
  const baseline = runtime.baselineCommit ?? runtime.projectRun?.baselineCommit;
  assert.match(baseline, /^[a-f0-9]{40}$/);
  assert.equal(git(output, "rev-parse", "HEAD^").trim(), baseline);
  const paths = Object.keys(task.files).sort();
  assert.deepEqual(
    git(output, "ls-tree", "-r", "--name-only", "-z", baseline)
      .split("\0")
      .filter(Boolean)
      .sort(),
    paths,
  );
  assert.deepEqual(
    git(output, "ls-tree", "-r", "--name-only", "-z", committed)
      .split("\0")
      .filter(Boolean)
      .sort(),
    paths,
  );
  const digest = createHash("sha256");
  for (const path of paths) {
    const working = await readFile(join(output, path), "utf8");
    assert.equal(
      git(output, "show", baseline + ":" + path),
      task.files[path],
      "Baseline commit differs from frozen " + path,
    );
    assert.equal(
      git(output, "show", committed + ":" + path),
      working,
      "Working file differs from publication " + path,
    );
    digest.update(
      JSON.stringify([
        path,
        createHash("sha256").update(working).digest("hex"),
      ]),
    );
  }
  if (row.arm !== "rawagent") {
    assert.equal(runtime.projectRun.commit, committed);
    assert.equal(
      runtime.projectRun.validation.sourceHash,
      digest.digest("hex"),
    );
    assert.equal(runtime.projectRun.acceptance, "behavior-verified");
    assert.equal(runtime.projectRun.validation.protectedFilesUnchanged, true);
  } else assert.equal(runtime.agent.status, "completed");
}
async function traceFile(run: string): Promise<ProviderCall[]> {
  try {
    const body = await readFile(join(run, "calls.ndjson"), "utf8");
    return body.trim()
      ? body
          .trim()
          .split(/\r?\n/)
          .map((s) => JSON.parse(s))
      : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { reps: { type: "string", default: "1" } },
});
const batch = positionals[0] ?? "e2e-v1",
  reps = Number(values.reps);
assert(
  positionals.length <= 1 &&
    /^[\w-]+$/.test(batch) &&
    Number.isSafeInteger(reps) &&
    reps >= 1,
);
const folder = resolve("results", "project-bench", batch);
const files = (await readdir(folder)).filter((f) => f.endsWith(".json")).sort();
const impl = await implementationHash(),
  archivedImpl = batch === "project-delivery" ? await implementationHash(true) : undefined,
  commit = git("../weichai", "rev-parse", "HEAD").trim();
const expected = [],
  seenRuns = new Set<string>(),
  seenOutputs = new Set<string>();
for (const t of projectTasks)
  for (const model of PROJECT_MODELS)
    for (const arm of arms)
      for (let rep = 1; rep <= reps; rep++)
        expected.push({
          t,
          model,
          arm,
          rep,
          name: [t.id, model, arm, "r" + rep].join("_") + ".json",
        });
assert.deepEqual(
  files,
  expected.map((e) => e.name).sort(),
  "Matrix missing cells or has unexpected results",
);
let concurrency: number | undefined;
const counts = {
  passed: 0,
  failed: 0,
  credential_missing: 0,
  regraded: 0,
  requests: 0,
  knownTokens: 0,
  unknownUsageRequests: 0,
};
const missing = new Set<string>();
for (const { t, model, arm, rep, name } of expected) {
  try {
    const r = JSON.parse(await readFile(join(folder, name), "utf8"));
    for (const [k, v] of Object.entries({
      batch,
      arm,
      model,
      rep,
      taskId: t.id,
      commitRECAST: commit,
      protocol,
      implementationHash: r.implementationHash === archivedImpl && archivedImpl ? archivedImpl : impl,
      inputHash: hash(publicProject(t)),
      gradingHash: hash(t.acceptance),
    }))
      assert.deepEqual(r[k], v, "Mismatch in " + k);
    if (concurrency === undefined) concurrency = r.concurrency;
    assert(
      Number.isSafeInteger(concurrency) &&
        concurrency! >= 1 &&
        concurrency! <= 3,
    );
    assert.equal(r.concurrency, concurrency);
    if (r.status === "credential_missing") {
      assert.equal(r.wallMs, null);
      assert.equal(r.usage, null);
      assert.equal(r.grade, null);
      assert(
        r.passed !== true &&
          r.commit == null &&
          r.runRoot == null &&
          r.attempt == null &&
          r.calls == null,
      );
      counts.credential_missing++;
      missing.add(model);
      continue;
    }
    assert(r.status === "passed" || r.status === "failed");
    assert.match(r.attempt, /^[a-f\d-]{36}$/);
    assert(Number.isFinite(Date.parse(r.startedAt)));
    duration(r.wallMs);
    duration(r.executionMs);
    assert(r.executionMs <= r.wallMs + 1);
    assert.equal(r.status === "passed", r.passed);
    const run = await inRoot(resolve("work"), r.runRoot);
    assert(!seenRuns.has(run), "Trial roots reused");
    seenRuns.add(run);
    await verifyStarter(t, run);
    const trace = await traceFile(run);
    verifyCalls(r, trace);
    counts.requests += trace.length;
    counts.knownTokens += r.usage.totalTokens;
    counts.unknownUsageRequests += trace.filter((c) => !c.usage).length;
    const runtime = JSON.parse(
      await readFile(join(run, "runtime.json"), "utf8"),
    );
    assert.equal(r.publicDelivered, Boolean(r.commit));
    assert.equal(r.timeToVerifiedMs, r.passed ? r.wallMs : null);
    if (r.passed) {
      assert(
        r.commit &&
          r.grade?.passed &&
          !r.error &&
          trace.some((c) => c.status === "ok"),
      );
      counts.passed++;
    } else {
      assert(r.error, "Unexplained failed trial");
      counts.failed++;
    }
    if (r.outputRoot) {
      const output = await inRoot(run, r.outputRoot);
      assert(!seenOutputs.has(output), "Trial submissions reused");
      seenOutputs.add(output);
      assert.equal(await realpath(runtime.outputRoot), output);
      if (r.commit) await verifyPublication(t, r, runtime, output);
      assert(r.grade, "Recorded output has no grading evidence");
      duration(r.grade.elapsedMs);
      assert(
        Math.abs(r.wallMs - r.executionMs - r.grade.elapsedMs) < 1000,
        "Execution and grade time do not reconstruct wall time",
      );
      for (const c of r.grade.checks) duration(c.elapsedMs);
      const independent = await gradeTask(
        t,
        output,
        AbortSignal.timeout(120000),
      );
      assert.deepEqual(
        comparableGrade(r.grade),
        comparableGrade(independent),
        "Stored grade differs from fresh external grading",
      );
      counts.regraded++;
    } else {
      assert(
        !r.grade && !r.commit && r.status === "failed",
        "No submitted sources to grade",
      );
    }
  } catch (e) {
    throw Error(name + ": " + (e instanceof Error ? e.message : String(e)), {
      cause: e,
    });
  }
}
console.log(
  JSON.stringify(
    {
      batch,
      cells: expected.length,
      ...counts,
      missingCredentialModels: [...missing],
    },
    null,
    2,
  ),
);
