import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { compileWorkspace } from "../../../weichai/services/adaptation-service/src/workspace-compiler.ts";
import { freeze, manifest, publicTask } from "./inputs.ts";
import { gradeCopy } from "./grading.ts";
import { publicCommand } from "./method-files.ts";
import type { RealFixture } from "./types.ts";

export async function calibrate(f: RealFixture, base: string) {
  const dir = await mkdtemp(join(base, "f-")),
    starter = join(dir, "s"),
    golden = join(dir, "g");
  const frozen = await freeze(f, starter, "starter"),
    oracle = await freeze(f, golden, "golden");
  const writable = f.modules.map((m) => m.path);
  assert.deepEqual(
    Object.keys(frozen.m.files),
    Object.keys(oracle.m.files),
    "Different file inventory in controls",
  );
  assert.deepEqual(
    Object.keys(oracle.m.files)
      .filter((p) => oracle.m.files[p] !== frozen.m.files[p])
      .sort(),
    [...writable].sort(),
    "Controls must differ in exactly the writable modules",
  );
  const controls = [];
  for (const [variant, root] of [
    ["golden", golden],
    ["starter", starter],
  ] as const) {
    const signal = new AbortController().signal;
    const build = await compileWorkspace(
      root,
      publicCommand(f.compile),
      signal,
    );
    const tests = await compileWorkspace(root, publicCommand(f.test), signal);
    const checks = await gradeCopy(f, root);
    if (
      variant === "golden" &&
      (!build.success || !tests.success || checks.some((c) => !c.passed))
    )
      throw Error(
        "Broken golden control: " + JSON.stringify({ build, tests, checks }),
      );
    if (
      variant === "starter" &&
      (tests.success || checks.every((c) => c.passed))
    )
      throw Error("Starter fails to distinguish missing implementation");
    controls.push({ variant, build, tests, checks });
  }
  // Ensure each language contributes to the scored task.
  for (const module of f.modules) {
    const checks = await gradeCopy(f, golden, starter, [module.path]);
    assert(
      checks.some((c) => !c.passed),
      "Grader does not exercise " + module.path,
    );
    controls.push({ variant: "missing " + module.path, checks });
  }
  assert.equal(
    (await manifest(starter, f)).hash,
    frozen.m.hash,
    "Public check modified frozen starter",
  );
  assert.equal(
    (await manifest(golden, f)).hash,
    oracle.m.hash,
    "Public check modified golden control",
  );
  const task = publicTask(f, frozen.m);
  return {
    starter,
    task,
    frozen,
    controls,
    summary: {
      taskId: f.id,
      upstream: f.upstream,
      inputHash: frozen.inputHash,
      treeHash: frozen.m.hash,
      files: Object.keys(frozen.m.files).length,
      languages: frozen.m.stats,
      readFiles: task.readFiles.length,
      referenceFiles: task.referenceFiles.length,
      writable,
      goldenHash: oracle.m.hash,
      controls,
    },
  };
}
