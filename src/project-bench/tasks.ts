import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import orders from "./fixtures/orders.ts";
import claims from "./fixtures/claims.ts";
import jobs from "./fixtures/jobs.ts";
import type { ProjectTask } from "./fixture-format.ts";

export type { ProjectTask, ProjectModule } from "./fixture-format.ts";
export const projectTasks: ProjectTask[] = [orders, claims, jobs];

export async function materializeTask(task: ProjectTask, root: string) {
  await mkdir(root, { recursive: true });
  for (const [path, source] of Object.entries(task.files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source, { encoding: "utf8", flag: "wx" });
  }
}
export interface GradedCheck {
  id: string;
  passed: boolean;
  elapsedMs: number;
  error?: string;
}
export interface ProjectGrade {
  passed: boolean;
  passedChecks: number;
  totalChecks: number;
  elapsedMs: number;
  integrityErrors: string[];
  checks: GradedCheck[];
}
const hostDirectories = new Set([".git", ".forexplore", ".forexpore"]);
async function inspectSubmission(task: ProjectTask, root: string) {
  const allowed = new Set(task.modules.map((m) => m.path));
  const expected = new Set(Object.keys(task.files));
  const sources: Record<string, string> = {};
  const integrityErrors: string[] = [];
  async function inspect(directory: string, parent: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = parent ? parent + "/" + entry.name : entry.name;
      if (!parent && entry.isDirectory() && hostDirectories.has(entry.name))
        continue;
      if (entry.isSymbolicLink()) {
        integrityErrors.push("Symbolic link: " + path);
        continue;
      }
      if (entry.isDirectory()) {
        await inspect(join(directory, entry.name), path);
        continue;
      }
      if (!entry.isFile() || !expected.delete(path)) {
        integrityErrors.push("Unexpected entry: " + path);
        continue;
      }
      const source = await readFile(join(directory, entry.name), "utf8");
      if (allowed.has(path)) sources[path] = source;
      else if (source !== task.files[path])
        integrityErrors.push("Protected file changed: " + path);
    }
  }
  try {
    if (!(await lstat(root)).isDirectory())
      throw Error("Delivery root is not a directory");
    await inspect(root, "");
  } catch (e) {
    integrityErrors.push(
      "Cannot inspect delivery: " +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  for (const missing of expected)
    integrityErrors.push("Missing file: " + missing);
  return { sources, integrityErrors };
}

// Tests are fed through stdin and never written to the project or to the graded snapshot.
// Only submitted module bytes and trusted reference modules enter this read-only child.
function externalCheck(
  dir: string,
  script: string,
  signal?: AbortSignal,
): Promise<void> {
  const marker = "checks-passed-" + randomUUID();
  const env: Record<string, string> = {};
  if (process.platform === "win32" && process.env.SystemRoot)
    env.SystemRoot = process.env.SystemRoot;
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["--permission", "--allow-fs-read=" + dir, "--input-type=module", "-"],
      {
        cwd: dir,
        env,
        timeout: 8000,
        signal,
        encoding: "utf8",
        maxBuffer: 65536,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(Error((stderr.trim() || err.message).slice(0, 1800)));
          return;
        }
        if (!stdout.split(/\r?\n/).includes(marker)) {
          reject(Error("Check exited before completion"));
          return;
        }
        resolve();
      },
    );
    child.stdin?.on("error", () => {}); // Process aborts and early exit report through the callback.
    child.stdin?.end(
      "import assert from 'node:assert/strict';\n" +
        script +
        "\nconsole.log(" +
        JSON.stringify(marker) +
        ");\n",
    );
  });
}
export async function gradeTask(
  task: ProjectTask,
  root: string,
  signal?: AbortSignal,
): Promise<ProjectGrade> {
  const start = performance.now();
  const { sources, integrityErrors } = await inspectSubmission(task, root);
  const checks: GradedCheck[] = [];
  if (integrityErrors.length) {
    checks.push(
      ...task.acceptance.map((t) => ({
        id: t.id,
        passed: false,
        elapsedMs: 0,
        error: "Submission integrity check failed",
      })),
    );
  } else {
    const snapshot = await mkdtemp(join(tmpdir(), "recast-project-grade-"));
    try {
      const refs = Object.fromEntries(
        Object.entries(task.files).filter(([path]) => path.startsWith("refs/")),
      );
      for (const [path, source] of Object.entries({ ...sources, ...refs })) {
        const dest = join(snapshot, path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, source);
      }
      for (const test of task.acceptance) {
        const t = performance.now();
        try {
          await externalCheck(snapshot, test.body, signal);
          checks.push({
            id: test.id,
            passed: true,
            elapsedMs: performance.now() - t,
          });
        } catch (e) {
          checks.push({
            id: test.id,
            passed: false,
            elapsedMs: performance.now() - t,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
  }
  const passedChecks = checks.filter((c) => c.passed).length;
  return {
    passed: !integrityErrors.length && passedChecks === task.acceptance.length,
    passedChecks,
    totalChecks: task.acceptance.length,
    elapsedMs: performance.now() - start,
    integrityErrors,
    checks,
  };
}
