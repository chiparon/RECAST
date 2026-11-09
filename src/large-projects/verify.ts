import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PROJECT_MODELS } from "../project-bench/providers.ts";
import { gradeCopy, gradeDelivery } from "../real-projects/grading.ts";
import { freeze, sha } from "../real-projects/inputs.ts";
import { fixtures } from "./case.ts";
import { sumUsage, type MeterCall } from "./meter.ts";
import { priceRequests, RATE_CARD } from "./billing.ts";
import {
  arms,
  batchName,
  existing,
  protocolFingerprint,
  resultsRoot,
  workRoot,
} from "./protocol.ts";
import { largeScope } from "./scope.ts";

const { values } = parseArgs({
  options: {
    batch: { type: "string", default: batchName },
    replay: { type: "boolean" },
  },
});
const batch = values.batch!;
assert(/^[\w-]+$/.test(batch));
const data = resultsRoot(batch),
  bundle = resolve("results", batch + "-evidence.json.gz");
const protocol = await protocolFingerprint();
const portable = values.replay
  ? JSON.parse(gunzipSync(await readFile(bundle)).toString("utf8"))
  : null;
const billingProtocol = {
  rateCard: RATE_CARD,
  implementationHash: sha(
    await readFile(resolve("src/large-projects/billing.ts")),
  ),
};
if (portable) {
  assert.deepEqual(portable.protocol, protocol);
  assert.deepEqual(portable.billingProtocol, billingProtocol);
}
const cells = fixtures.flatMap((f) =>
  PROJECT_MODELS.flatMap((model) =>
    arms.map((arm) => ({ f, model, arm, id: [f.id, model, arm].join("_") })),
  ),
);
const expected = cells.map((c) => c.id).sort();
const ids = portable
  ? portable.rows.map((row) => row.id)
  : (await readdir(data))
      .filter((p) => p.endsWith(".trial.json"))
      .map((p) => p.slice(0, -".trial.json".length));
assert.deepEqual(ids.sort(), expected);
const wallets = portable
  ? portable.wallets
  : await Promise.all(
      (await readdir(data))
        .filter((p) => p.endsWith(".wallet.json"))
        .sort()
        .map((p) => existing(join(data, p))),
    );
const debitedCells = wallets.flatMap((w) => w.cells);
assert.deepEqual(
  [...debitedCells].sort(),
  cells
    .filter((c) => c.model === "deepseek-flash")
    .map((c) => c.id)
    .sort(),
  "Account windows must cover each DeepSeek attempt once",
);
const rows = [],
  controls = [];
let passed = 0,
  requests = 0,
  tokens = 0;
const verdict = (checks: any[]) =>
  checks.map((c) => ({ id: c.id, passed: c.passed }));
await mkdir(workRoot, { recursive: true });
for (const f of fixtures) {
  const fresh = await mkdtemp(join(workRoot, "verify-"));
  try {
    const { m } = await freeze(f, fresh, "starter"),
      scope = await largeScope(f, fresh, m);
    const control = portable
      ? portable.controls.find((c) => c.taskId === f.id)
      : await existing(join(data, f.id + ".control.json"));
    assert.equal(control.treeHash, m.hash);
    assert.equal(control.inputHash, scope.inputHash);
    assert.equal(control.readableLines, scope.readableLines);
    assert.equal(control.physicalLines, scope.physicalLines);
    controls.push({
      taskId: f.id,
      title: f.title,
      upstream: f.upstream,
      inputHash: control.inputHash,
      treeHash: m.hash,
      files: control.files,
      languages: m.stats,
      physicalLines: scope.physicalLines,
      readableLines: scope.readableLines,
      readFiles: scope.task.readFiles.length,
      referenceFiles: scope.task.referenceFiles.length,
      writable: f.modules.map((m) => m.path),
      controls: control.controls.map((c) => ({
        variant: c.variant,
        checks: verdict(c.checks),
      })),
    });
    for (const { id, model, arm } of cells.filter((c) => c.f === f)) {
      const row = portable
        ? portable.rows.find((r) => r.id === id)
        : await existing(join(data, id + ".trial.json"));
      assert.equal(row.inputHash, scope.inputHash);
      assert.equal(row.implementationHash, protocol.implementationHash);
      assert.equal(row.productRevision, protocol.productRevision);
      assert.equal(row.productDiff, protocol.productDiff);
      assert.equal(row.model, model);
      assert.equal(row.arm, arm);
      assert.equal(row.task, f.id);
      assert.equal(row.gradingError, null, "External grader failed in " + id);
      let submitted = null,
        indexFiles = null,
        harness = null;
      if (!portable) {
        let recorded = [];
        try {
          recorded = (await readFile(join(row.work, "calls.ndjson"), "utf8"))
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((x) => JSON.parse(x));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        assert.deepEqual(recorded, row.calls);
        const runtime = await existing(join(row.work, "runtime.json"));
        indexFiles = runtime?.indexFiles ?? null;
        if (arm === "codex" && runtime)
          harness = {
            version: runtime.agent?.version,
            status: runtime.agent?.status,
            threadId: runtime.agent?.threadId,
            providerTools: runtime.providerTools,
            suppressedNativeTools: runtime.suppressedNativeTools,
          };
        if (row.outputRoot) {
          const grade = await gradeDelivery(
            f,
            fresh,
            m,
            row.outputRoot,
            row.commit,
          );
          assert.equal(grade.passed, row.grade.passed);
          assert.deepEqual(grade.integrityErrors, row.grade.integrityErrors);
          assert.deepEqual(verdict(grade.checks), verdict(row.grade.checks));
          submitted = Object.fromEntries(
            await Promise.all(
              f.modules.map(async (unit) => [
                unit.path,
                (await readFile(join(row.outputRoot, unit.path))).toString(
                  "base64",
                ),
              ]),
            ),
          );
        }
      } else if (row.submitted) {
        assert.deepEqual(
          Object.keys(row.submitted).sort(),
          f.modules.map((m) => m.path).sort(),
        );
        if (!row.grade.integrityErrors.length) {
          const patch = await mkdtemp(join(workRoot, "patch-"));
          try {
            for (const [path, encoded] of Object.entries(row.submitted)) {
              const file = join(patch, path);
              await mkdir(dirname(file), { recursive: true });
              await writeFile(file, Buffer.from(encoded as string, "base64"));
            }
            assert.deepEqual(
              verdict(await gradeCopy(f, fresh, patch)),
              verdict(row.grade.checks),
            );
          } finally {
            await rm(patch, { recursive: true, force: true });
          }
        }
      }
      assert(row.wallMs >= row.executionMs && row.executionMs > 0);
      assert.equal(
        row.passed,
        Boolean(
          row.commit && row.grade?.passed && !row.error && !row.gradingError,
        ),
      );
      const calls: MeterCall[] = row.calls;
      for (const call of calls) {
        assert.equal(call.model, model);
        assert(Number.isFinite(Date.parse(call.startedAt)));
        if (call.status === "ok") {
          assert(call.httpStatus >= 200 && call.httpStatus < 300);
          if (call.requestKind !== "compact" || call.servedModel !== undefined)
            assert.equal(
              call.servedModel,
              model,
              "Unexpected or unreported served model",
            );
        }
        if (call.usage)
          assert.equal(
            call.usage.totalTokens,
            call.usage.inputTokens + call.usage.outputTokens,
          );
      }
      assert.deepEqual(sumUsage(calls), row.usage);
      if (row.passed) {
        assert(calls.some((c) => c.status === "ok"));
        passed++;
      }
      requests += calls.length;
      tokens += row.usage.totalTokens;
      const price = priceRequests(calls);
      if (portable) assert.deepEqual(row.price, price);
      else {
        const { outputRoot, work, ...publicRow } = row;
        rows.push({ id, ...publicRow, submitted, indexFiles, harness, price });
      }
      console.log(values.replay ? "REPLAY" : "VERIFY", id, row.passed);
    }
  } finally {
    await rm(fresh, { recursive: true, force: true, maxRetries: 3 });
  }
}
if (!portable)
  await writeFile(
    bundle,
    gzipSync(
      JSON.stringify({
        batch,
        protocol,
        billingProtocol,
        controls,
        rows,
        wallets,
      }),
      { level: 9 },
    ),
  );
console.log(
  JSON.stringify({
    batch,
    cells: cells.length,
    passed,
    requests,
    tokens,
    sha256: sha(await readFile(bundle)),
  }),
);
