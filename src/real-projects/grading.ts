import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifest, type Manifest } from "./inputs.ts";
import type { Check, RealFixture } from "./types.ts";

export async function gradeCopy(
  f: RealFixture,
  starter: string,
  patches?: string,
  paths = f.modules.map((m) => m.path),
) {
  const isolated = await mkdtemp(join(tmpdir(), "rb-"));
  try {
    await cp(starter, isolated, { recursive: true });
    if (patches)
      for (const path of paths)
        await copyFile(join(patches, path), join(isolated, path));
    const checks = await f.grade(isolated);
    assert(
      checks.length && new Set(checks.map((c) => c.id)).size === checks.length,
      "Missing or duplicate acceptance checks",
    );
    for (const c of checks)
      assert(typeof c.id === "string" && typeof c.passed === "boolean");
    return checks;
  } finally {
    await rm(isolated, { recursive: true, force: true, maxRetries: 3 });
  }
}
function tree(root: string, revision: string) {
  const ls = execFileSync("git", ["-C", root, "ls-tree", "-rz", revision], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }).toString();
  return Object.fromEntries(
    ls
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode, kind, hash] = line.slice(0, tab).split(" ");
        assert(
          kind === "blob" && ["100644", "100755"].includes(mode),
          "Non-regular Git entry",
        );
        return [line.slice(tab + 1), hash];
      }),
  );
}
export async function gradeDelivery(
  f: RealFixture,
  starter: string,
  frozen: Manifest,
  output: string,
  commit: string | null,
) {
  const checked = await manifest(output, f, true),
    allowed = new Set(f.modules.map((m) => m.path));
  const integrityErrors: string[] = [];
  for (const path of new Set([
    ...Object.keys(frozen.files),
    ...Object.keys(checked.files),
  ])) {
    if (
      !(path in frozen.files) ||
      !(path in checked.files) ||
      (!allowed.has(path) && frozen.files[path] !== checked.files[path])
    )
      integrityErrors.push(path);
  }
  if (commit) {
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.equal(
      execFileSync("git", ["-C", output, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      commit,
    );
    assert.deepEqual(
      tree(output, commit + "^"),
      frozen.blobs,
      "Published parent differs from frozen starter",
    );
    assert.deepEqual(
      tree(output, commit),
      checked.blobs,
      "Published Git tree differs from submitted bytes",
    );
  }
  const checks: Check[] = integrityErrors.length
    ? []
    : await gradeCopy(f, starter, output);
  return {
    checks,
    integrityErrors,
    passed:
      !integrityErrors.length &&
      checks.length > 0 &&
      checks.every((c) => c.passed),
  };
}
