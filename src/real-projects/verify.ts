import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { PROJECT_MODELS } from "../project-bench/providers.ts";
import { gradeCopy, gradeDelivery } from "./grading.ts";
import { freeze, manifest, publicTask, sha } from "./inputs.ts";

const { values } = parseArgs({
  options: {
    batch: { type: "string", default: "real-v2" },
    replay: { type: "boolean" },
  },
});
assert(/^[\w-]+$/.test(values.batch!));
const archive = resolve(
  "results",
  "real-e2e-" + values.batch + "-evidence.json.gz",
);
const dir = resolve("results", "real-project-bench", values.batch!);
const caseKeys = ["one", "two", "three"];
const units = await Promise.all(
    caseKeys.map(
      async (key) => (await import("./case-" + key + ".ts")).fixture,
    ),
  ),
  methods = ["recast", "sag2sql", "rawagent"];
const cells = units.flatMap((f) =>
  PROJECT_MODELS.flatMap((model) =>
    methods.map((arm) => ({ f, model, arm, id: [f.id, model, arm].join("_") })),
  ),
);
const normalize = (checks) => checks.map(({ id, passed }) => ({ id, passed }));
const portable = [];
const payload = values.replay
  ? JSON.parse(gunzipSync(await readFile(archive)).toString("utf8"))
  : null;
if (payload)
  assert.deepEqual(
    payload.map((r) => r.id).sort(),
    cells.map((c) => c.id).sort(),
  );
else
  assert.deepEqual(
    (await readdir(dir)).filter((p) => p.endsWith(".trial.json")).sort(),
    cells.map((c) => c.id + ".trial.json").sort(),
  );
const base = resolve("work", "rb");
await mkdir(base, { recursive: true });
// Match run.ts's measured implementation digest on export. Retain a narrower
// portable manifest covering the case, grader, native entry points and pinned
// dependency/build definitions so replay can validate the scoring materials.
async function protocolHashes(which: string) {
  const source = resolve("src", "real-projects");
  const paths = (
    await readdir(source, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(source.length + 1)
        .replaceAll("\\", "/"),
    )
    .filter(
      (path) =>
        (!path.startsWith("case-") || path.startsWith("case-" + which)) &&
        !/^(report|verify)\./.test(path),
    )
    .sort();
  const hashes: [string, string][] = [];
  const verdictMaterials: Record<string, string> = {};
  for (const path of paths) {
    const digest = sha(await readFile(join(source, path)));
    hashes.push([path, digest]);
    if (
      path.startsWith("case-") ||
      [
        "grading.ts",
        "control.ts",
        "inputs.ts",
        "types.ts",
        "public-command.mjs",
        "method-files.ts",
      ].includes(path)
    )
      verdictMaterials[path] = digest;
  }
  for (const path of ["raw.ts", "providers.ts"])
    hashes.push([
      path,
      sha(await readFile(resolve("src/project-bench", path))),
    ]);
  return {
    implementationHash: sha(JSON.stringify(hashes)),
    verdictMaterials,
    verdictHash: sha(JSON.stringify(verdictMaterials)),
  };
}
let allCalls = 0,
  knownTokens = 0,
  unknownCalls = 0,
  preModelFailures = 0,
  passed = 0;
for (const [i, f] of units.entries()) {
  const protocol = await protocolHashes(caseKeys[i]);
  const fresh = await mkdtemp(join(base, "v-"));
  try {
    const frozen = await freeze(f, fresh, "starter");
    const task = publicTask(f, frozen.m);
    if (!payload) {
      const control = JSON.parse(
        await readFile(join(dir, f.id + ".control.json"), "utf8"),
      );
      assert.equal(control.inputHash, frozen.inputHash);
      assert.equal(control.treeHash, frozen.m.hash);
      assert.equal(control.referenceFiles, task.referenceFiles.length);
    }
    const canonicalCommand = (c) => ({
      ...c,
      executable: c.executable === process.execPath ? "node" : c.executable,
      args: c.args.map((a) =>
        isAbsolute(a) && a.replaceAll("\\", "/").includes("/src/real-projects/")
          ? a.replaceAll("\\", "/").split("/src/real-projects/").at(-1)
          : a,
      ),
    });
    const portableInputHash = sha(
      JSON.stringify({
        tree: frozen.m.hash,
        upstream: f.upstream,
        verdictHash: protocol.verdictHash,
        task: {
          ...task,
          compileCommand: canonicalCommand(task.compileCommand),
          testCommand: canonicalCommand(task.testCommand),
          moduleTestCommands: Object.fromEntries(
            Object.entries(task.moduleTestCommands ?? {}).map(([k, v]) => [
              k,
              canonicalCommand(v),
            ]),
          ),
        },
      }),
    );
    for (const cell of cells.filter((c) => c.f === f)) {
      const { id, model, arm } = cell;
      const row = payload
        ? payload.find((r) => r.id === id)
        : JSON.parse(await readFile(join(dir, id + ".trial.json"), "utf8"));
      if (payload) {
        assert.equal(
          row.treeHash,
          frozen.m.hash,
          "Different starter tree for " + id,
        );
        assert.equal(row.readFiles, task.readFiles.length);
        assert.deepEqual(
          row.verdictMaterials,
          protocol.verdictMaterials,
          "Different scoring files for " + id,
        );
        assert.equal(
          row.verdictHash,
          protocol.verdictHash,
          "Different verdict fingerprint for " + id,
        );
        assert.equal(row.portableInputHash, portableInputHash);
        assert.equal(
          Boolean(row.submitted),
          Boolean(row.grade),
          "Missing payload or grade for " + id,
        );
      } else {
        assert.equal(row.inputHash, frozen.inputHash);
        assert.equal(
          row.implementationHash,
          protocol.implementationHash,
          "Measured harness differs from export materials for " + id,
        );
      }
      assert.equal(row.batch, values.batch);
      assert.equal(row.model, model);
      assert.equal(row.arm, arm);
      assert.equal(row.task, f.id);
      let submitted: Record<string, string> | null = null;
      let numstat: string | null = null;
      const indexFiles = payload
        ? row.indexFiles
        : arm === "sag2sql"
          ? (JSON.parse(await readFile(join(row.work, "runtime.json"), "utf8"))
              ?.indexFiles ?? null)
          : null;
      if (indexFiles !== null) {
        assert.equal(arm, "sag2sql");
        assert(
          Array.isArray(indexFiles) &&
            indexFiles.every((path) => task.referenceFiles.includes(path)),
        );
        assert.equal(new Set(indexFiles).size, indexFiles.length);
      }
      if (row.indexMs !== null) assert(Array.isArray(indexFiles));
      if (!payload) {
        assert.equal((await manifest(row.starter, f)).hash, frozen.m.hash);
        let ledger = [];
        try {
          ledger = (await readFile(join(row.work, "calls.ndjson"), "utf8"))
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((s) => JSON.parse(s));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        assert.deepEqual(row.calls, ledger);
        assert(
          !row.gradingError,
          "Grader malfunction in " + id + ": " + row.gradingError,
        );
        if (row.outputRoot) {
          const grade = await gradeDelivery(
            f,
            fresh,
            frozen.m,
            row.outputRoot,
            row.commit,
          );
          assert.deepEqual(grade.integrityErrors, row.grade.integrityErrors);
          assert.equal(grade.passed, row.grade.passed);
          assert.deepEqual(
            normalize(grade.checks),
            normalize(row.grade.checks),
          );
          submitted = Object.fromEntries(
            await Promise.all(
              f.modules.map(async (m) => [
                m.path,
                (await readFile(join(row.outputRoot, m.path))).toString(
                  "base64",
                ),
              ]),
            ),
          );
          if (row.commit)
            numstat = execFileSync(
              "git",
              [
                "-C",
                row.outputRoot,
                "--literal-pathspecs",
                "diff",
                "--numstat",
                "--no-renames",
                "--no-ext-diff",
                row.commit + "^",
                row.commit,
                "--",
                ...f.modules.map((m) => m.path),
              ],
              { encoding: "utf8", windowsHide: true },
            );
        }
      } else if (row.submitted) {
        assert.deepEqual(
          Object.keys(row.submitted).sort(),
          f.modules.map((m) => m.path).sort(),
        );
        if (!row.grade.integrityErrors.length) {
          const scratch = await mkdtemp(join(base, "vpatch-"));
          try {
            for (const [path, content] of Object.entries(row.submitted)) {
              const file = join(scratch, path);
              await mkdir(join(file, ".."), { recursive: true });
              await writeFile(file, Buffer.from(content as string, "base64"));
            }
            assert.deepEqual(
              normalize(await gradeCopy(f, fresh, scratch)),
              normalize(row.grade.checks),
            );
          } finally {
            await rm(scratch, { recursive: true, force: true });
          }
        }
      }
      assert(row.wallMs >= row.executionMs && row.executionMs > 0);
      if (row.grade) {
        assert.equal(
          row.grade.passed,
          Boolean(
            !row.grade.integrityErrors.length &&
              row.grade.checks.length &&
              row.grade.checks.every((c) => c.passed),
          ),
        );
      }
      assert.equal(
        row.passed,
        Boolean(
          row.commit && row.grade?.passed && !row.error && !row.gradingError,
        ),
      );
      if (!row.calls.length) {
        assert(!row.passed);
        preModelFailures++;
      }
      if (row.passed) {
        assert(row.calls.some((c) => c.status === "ok"));
        passed++;
      }
      assert.equal(row.usage.requests, row.calls.length);
      assert.equal(
        row.usage.usageComplete,
        row.calls.every((c) => c.usage),
      );
      for (const key of [
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "cachedInputTokens",
        "reasoningTokens",
      ]) {
        assert.equal(
          row.usage[key],
          row.calls.reduce((sum, c) => sum + (c.usage?.[key] ?? 0), 0),
        );
      }
      assert.equal(
        row.usage.inputTokens + row.usage.outputTokens,
        row.usage.totalTokens,
      );
      allCalls += row.calls.length;
      unknownCalls += row.calls.filter((c) => !c.usage).length;
      knownTokens += row.usage.totalTokens;
      if (!payload) {
        const { work, outputRoot, starter, ...portableRow } = row;
        portable.push({
          id,
          ...portableRow,
          submitted,
          indexFiles,
          numstat,
          treeHash: frozen.m.hash,
          portableInputHash,
          verdictMaterials: protocol.verdictMaterials,
          verdictHash: protocol.verdictHash,
          readFiles: publicTask(f, frozen.m).readFiles.length,
        });
      }
    }
  } finally {
    await rm(fresh, { recursive: true, force: true, maxRetries: 3 });
  }
}
if (!payload)
  await writeFile(archive, gzipSync(JSON.stringify(portable), { level: 9 }));
console.log(
  JSON.stringify(
    {
      cells: cells.length,
      passed,
      preModelFailures,
      allCalls,
      knownTokens,
      unknownCalls,
      evidence: archive,
      sha256: sha(await readFile(archive)),
    },
    null,
    2,
  ),
);
