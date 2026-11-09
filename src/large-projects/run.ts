import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  PROJECT_MODELS,
  providerAvailable,
} from "../project-bench/providers.ts";
import { manifest } from "../real-projects/inputs.ts";
import { fixtures } from "./case.ts";
import {
  arms,
  batchName,
  existing,
  json,
  protocolFingerprint,
  resultsRoot,
  workRoot,
} from "./protocol.ts";
import { largeScope, prepareLarge } from "./scope.ts";

const { values } = parseArgs({
  options: {
    batch: { type: "string", default: batchName },
    task: { type: "string" },
    methods: { type: "string" },
    model: { type: "string" },
    controls: { type: "boolean" },
  },
});
const batch = values.batch!;
assert(/^[\w-]+$/.test(batch));
const tasks = fixtures.filter((f) => !values.task || f.id === values.task);
const models = PROJECT_MODELS.filter(
  (m) => !values.model || m === values.model,
);
const methods = values.methods ? values.methods.split(",") : [...arms];
assert(
  tasks.length &&
    models.length &&
    methods.length &&
    methods.every((a) => arms.some((x) => x === a)),
  "Invalid selector",
);
const root = resultsRoot(batch);
await Promise.all(
  [root, workRoot].map((dir) => mkdir(dir, { recursive: true })),
);
const protocol = await protocolFingerprint();
const recipes = new Map<string, { path: string; identity: any }>();
for (const f of tasks) {
  const recordPath = join(root, f.id + ".control.json");
  const prior = await existing(recordPath);
  if (prior) {
    assert.equal(
      prior.implementationHash,
      protocol.implementationHash,
      "Batch implementation changed",
    );
    assert.equal(prior.productRevision, protocol.productRevision);
    assert.equal(prior.productDiff, protocol.productDiff);
    const recipe = await existing(prior.recipe);
    if (recipe) {
      const actual = await manifest(recipe.starter, f);
      assert.equal(
        actual.hash,
        recipe.frozen.hash,
        "Frozen starter changed on disk",
      );
      assert.equal(actual.hash, prior.treeHash);
      const current = await largeScope(f, recipe.starter, actual);
      const identity = { ...protocol, inputHash: current.inputHash };
      assert.deepEqual(recipe.identity, identity);
      assert.deepEqual(recipe.task, current.task);
      assert.deepEqual(recipe.frozen, actual);
      assert.equal(prior.inputHash, current.inputHash);
      recipes.set(f.id, { path: prior.recipe, identity });
      continue;
    }
  }
  console.log("CONTROL", f.id, new Date().toISOString());
  const prepared = await prepareLarge(f, workRoot);
  const identity = { ...protocol, inputHash: prepared.summary.inputHash };
  if (prior) assert.equal(prior.inputHash, identity.inputHash);
  const recipe = join(prepared.starter, "..", "recipe.json");
  await json(recipe, {
    task: prepared.task,
    starter: prepared.starter,
    frozen: prepared.frozen,
    identity,
  });
  await json(recordPath, { ...prepared.summary, ...protocol, recipe });
  recipes.set(f.id, { path: recipe, identity });
  console.log(
    "READY",
    f.id,
    prepared.summary.physicalLines,
    prepared.summary.readableLines,
    identity.inputHash,
  );
}
if (!values.controls) {
  for (const m of models)
    assert(await providerAvailable(m), "Missing provider " + m);
  // One process per method and a serial lane per model keeps credentialed
  // transport instrumentation, per-trial Codex homes and DeepSeek balance windows isolated.
  const lanes = await Promise.allSettled(
    models.map(async (model) => {
      const modelIdx = PROJECT_MODELS.indexOf(model);
      for (const f of tasks) {
        const recipe = recipes.get(f.id)!;
        for (let k = 0; k < arms.length; k++) {
          const arm = arms[(k + modelIdx + fixtures.indexOf(f)) % arms.length];
          if (!methods.includes(arm)) continue;
          const name = [f.id, model, arm].join("_"),
            path = join(root, name + ".trial.json");
          async function recorded() {
            const old = await existing(path);
            if (!old) return false;
            for (const [key, value] of Object.entries(recipe.identity))
              assert.equal(old[key], value, "Changed " + name);
            console.log("RECORDED", name, old.passed);
            return true;
          }
          if (await recorded()) continue;
          const lease = await open(path + ".lock", "wx");
          try {
            if (await recorded()) continue;
            await lease.writeFile(
              JSON.stringify({
                pid: process.pid,
                startedAt: new Date().toISOString(),
              }),
            );
            await new Promise<void>((ok, fail) => {
              const child = spawn(
                process.execPath,
                [
                  ...process.execArgv,
                  resolve("src/large-projects/trial.ts"),
                  batch,
                  recipe.path,
                  model,
                  arm,
                ],
                { stdio: "inherit", windowsHide: true },
              );
              child.once("error", fail);
              child.once("exit", (code, signal) =>
                code === 0
                  ? ok()
                  : fail(Error(name + " worker exited " + (code ?? signal))),
              );
            });
            assert(await existing(path), "Worker returned no record: " + name);
          } finally {
            await lease.close();
            await unlink(path + ".lock");
          }
        }
      }
    }),
  );
  for (const lane of lanes) if (lane.status === "rejected") throw lane.reason;
}
