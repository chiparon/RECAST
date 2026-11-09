import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { sha } from "../real-projects/inputs.ts";

export const arms = ["recast", "sag2sql", "rawagent", "codex"] as const;
export type Arm = (typeof arms)[number];
export const batchName = "large-v1";
export const resultsRoot = (batch: string) =>
  resolve("results/large-project-bench", batch);
export const workRoot = resolve("work/lb");
export async function json(path: string, value: unknown) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, path);
}
export async function existing(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function protocolFingerprint() {
  const files: string[] = [];
  for (const dir of ["src/large-projects", "src/real-projects"]) {
    for (const item of await readdir(dir, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (
        !item.isFile() ||
        item.parentPath.split(/[\\/]/).includes("__pycache__")
      )
        continue;
      const path = relative(
        process.cwd(),
        join(item.parentPath, item.name),
      ).replaceAll("\\", "/");
      if (
        dir === "src/large-projects" &&
        /\/(report|verify|billing)([-.]|\/)/i.test(path)
      )
        continue;
      if (
        dir === "src/real-projects" &&
        /\/(run|report|verify)\.ts$/.test(path)
      )
        continue;
      files.push(path);
    }
  }
  files.push("src/project-bench/providers.ts");
  const hashes = [];
  for (const path of files.sort())
    hashes.push([path, sha(await readFile(path))]);
  return {
    implementationHash: sha(JSON.stringify(hashes)),
    productRevision: execFileSync(
      "git",
      ["-C", "../weichai", "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim(),
    productDiff: sha(
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
    ),
  };
}
