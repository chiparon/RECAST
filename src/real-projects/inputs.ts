import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { RealFixture } from "./types.ts";

export const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function publicTask(f: RealFixture, m: Manifest) {
  const paths = Object.keys(m.files),
    targets = f.modules.map((unit) => unit.path);
  const fixed = [
    ...new Set([
      ...targets,
      ...f.references,
      ...paths.filter(
        (p) =>
          /^(?:bench-public|public-checks|bench_checks)\//.test(p) ||
          p === "SPEC.md",
      ),
    ]),
  ];
  // Module translation accepts at most 256 workspaceFiles. Give every arm
  // the same inventory, prioritizing source near the requested modules.
  if (fixed.some((p) => !m.files[p]) || fixed.length > 256)
    throw Error("Invalid public scope for " + f.id);
  const proximity = (path: string) =>
    Math.max(
      ...targets.map((t) => {
        const parts = t.split("/"),
          other = path.split("/");
        let n = 0;
        while (n < parts.length && parts[n] === other[n]) n++;
        return n;
      }),
    );
  if (fixed.some((p) => m.oversize.includes(p)))
    throw Error("A required file exceeds the translation read limit");
  const sources = paths
    .filter(
      (path) =>
        f.productionFiles(path) &&
        !fixed.includes(path) &&
        !m.oversize.includes(path),
    )
    .sort((a, b) => proximity(b) - proximity(a) || (a < b ? -1 : 1));
  const readFiles = [...fixed, ...sources].slice(0, 256);
  const referenceFiles = readFiles.filter(
    (p) =>
      !targets.includes(p) &&
      /\.(py|c|h|cpp|hpp|go|rs|lua|java|cs|[cm]?js|tsx?)$/.test(p) &&
      f.productionFiles(p),
  );
  return {
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
}
const languages: Record<string, string> = {
  ".py": "Python",
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".c": "C",
  ".h": "C",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML",
  ".go": "Go",
  ".lua": "Lua",
  ".rs": "Rust",
  ".cpp": "C++",
  ".hpp": "C++",
  ".java": "Java",
  ".cs": "C#",
};
export async function manifest(root: string, f: RealFixture, delivery = false) {
  const files: Record<string, string> = {},
    blobs: Record<string, string> = {};
  const oversize: string[] = [];
  const stats: Record<
    string,
    { files: number; physical: number; nonblank: number }
  > = {};
  async function walk(parent: string) {
    for (const entry of (
      await readdir(join(root, parent), { withFileTypes: true })
    ).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (
        !parent &&
        delivery &&
        [".git", ".forexplore", ".forexpore"].includes(entry.name)
      )
        continue;
      if (entry.name.toLowerCase() === ".git")
        throw Error("Git metadata in input tree");
      const path = parent ? parent + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) throw Error("Non-regular source entry: " + path);
      const bytes = await readFile(join(root, path));
      if (bytes.length > 256000 && bytes.toString("utf8").length > 256000)
        oversize.push(path);
      files[path] = sha(bytes);
      blobs[path] = createHash("sha1")
        .update("blob " + bytes.length + "\0")
        .update(bytes)
        .digest("hex");
      const language = languages[extname(path).toLowerCase()];
      if (language && f.productionFiles(path)) {
        const lines = bytes.toString("utf8").split(/\r?\n/);
        if (lines.at(-1) === "") lines.pop();
        const s = (stats[language] ??= { files: 0, physical: 0, nonblank: 0 });
        s.files++;
        s.physical += lines.length;
        s.nonblank += lines.filter((l) => l.trim()).length;
      }
    }
  }
  await walk("");
  return { files, blobs, stats, oversize, hash: sha(JSON.stringify(files)) };
}
export type Manifest = Awaited<ReturnType<typeof manifest>>;
export async function freeze(
  f: RealFixture,
  root: string,
  variant: "starter" | "golden",
) {
  await mkdir(root, { recursive: true });
  await f.prepare(root, variant);
  const m = await manifest(root, f);
  const t = publicTask(f, m);
  if (
    t.readFiles.some((path) => !m.files[path]) ||
    f.modules.some((u) => f.references.includes(u.path))
  )
    throw Error("Unusable task scope: " + f.id);
  if (
    Object.keys(m.stats).length < 2 ||
    Object.values(m.stats).reduce((n, s) => n + s.physical, 0) < 10000
  )
    throw Error("Insufficient source scale: " + JSON.stringify(m.stats));
  return {
    m,
    inputHash: sha(
      JSON.stringify({ public: t, tree: m.hash, upstream: f.upstream }),
    ),
  };
}
