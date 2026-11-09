import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { calibrate } from "../real-projects/control.ts";
import { sha, type Manifest } from "../real-projects/inputs.ts";
import type { RealFixture } from "../real-projects/types.ts";

export async function largeScope(f: RealFixture, starter: string, m: Manifest) {
  const targets = f.modules.map((unit) => unit.path),
    files = Object.keys(m.files);
  const mandatory = [
    ...new Set([
      ...targets,
      ...f.references,
      ...files.filter(
        (p) =>
          /^(bench-public|public-checks|bench_checks)\//.test(p) ||
          p === "SPEC.md",
      ),
    ]),
  ];
  assert(
    mandatory.length <= 256 &&
      mandatory.every((p) => m.files[p] && !m.oversize.includes(p)),
    "Invalid mandatory scope",
  );
  const sizes = new Map<string, number>();
  for (const p of files.filter(
    (p) => f.productionFiles(p) && !m.oversize.includes(p),
  )) {
    const content = await readFile(join(starter, p), "utf8");
    const lines = content.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    sizes.set(p, lines.length);
  }
  const proximity = (p: string) =>
    Math.max(
      ...targets.map((t) => {
        const a = p.split("/"),
          b = t.split("/");
        let n = 0;
        while (n < a.length && n < b.length && a[n] === b[n]) n++;
        return n;
      }),
    );
  const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const candidates = [...sizes.keys()].filter((p) => !mandatory.includes(p));
  const neighbors = [...candidates]
    .sort((a, b) => proximity(b) - proximity(a) || lexical(a, b))
    .slice(0, 20);
  const remaining = candidates
    .filter((p) => !neighbors.includes(p))
    .sort((a, b) => sizes.get(b)! - sizes.get(a)! || lexical(a, b));
  const readFiles = [...mandatory, ...neighbors, ...remaining].slice(0, 256);
  const readableLines = readFiles.reduce((n, p) => n + (sizes.get(p) ?? 0), 0);
  const physicalLines = Object.values(m.stats).reduce(
    (n, s) => n + s.physical,
    0,
  );
  assert(
    physicalLines >= 100000 && readableLines >= 100000,
    `Scale below 100K: repo=${physicalLines}, tools=${readableLines}`,
  );
  const referenceFiles = readFiles.filter(
    (p) =>
      !targets.includes(p) &&
      sizes.has(p) &&
      /\.(py|c|h|cpp|hpp|go|rs|lua|java|cs|[cm]?js|tsx?)$/.test(p),
  );
  const task = {
    id: f.id,
    title: f.title,
    requirement: f.requirement,
    modules: f.modules,
    readFiles,
    referenceFiles,
    compileCommand: f.compile,
    testCommand: f.test,
    moduleTestCommands: f.moduleTests,
  };
  // Absolute tool installations and checkout locations do not alter public inputs.
  const publicSpec = JSON.stringify(task, (_key, v) =>
    typeof v === "string" && isAbsolute(v)
      ? v === process.execPath
        ? "@node"
        : relative(resolve("."), v).replaceAll("\\", "/")
      : v,
  );
  const inputHash = sha(
    JSON.stringify({
      schema: 1,
      upstream: f.upstream,
      tree: m.hash,
      publicSpec: JSON.parse(publicSpec),
    }),
  );
  return { task, inputHash, physicalLines, readableLines };
}
export async function prepareLarge(f: RealFixture, base: string) {
  const checked = await calibrate(f, base);
  const { task, inputHash, physicalLines, readableLines } = await largeScope(
    f,
    checked.starter,
    checked.frozen.m,
  );
  return {
    task,
    starter: checked.starter,
    frozen: checked.frozen.m,
    summary: {
      ...checked.summary,
      inputHash,
      physicalLines,
      readableLines,
      readFiles: task.readFiles.length,
      referenceFiles: task.referenceFiles.length,
    },
  };
}
