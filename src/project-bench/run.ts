import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { projectTasks } from "./tasks.ts";
import { PROJECT_MODELS, providerAvailable } from "./providers.ts";
import { arms, hash, protocol, publicProject, runTrial } from "./trial.ts";
const { values } = parseArgs({
  options: {
    batch: { type: "string", default: "project-delivery" },
    models: { type: "string" },
    tasks: { type: "string" },
    arms: { type: "string" },
    reps: { type: "string", default: "1" },
    jobs: { type: "string", default: "1" },
  },
});
const batch = values.batch!,
  reps = Number(values.reps),
  jobs = Number(values.jobs);
if (
  !/^[\w-]+$/.test(batch) ||
  !Number.isInteger(reps) ||
  reps < 1 ||
  !Number.isInteger(jobs) ||
  jobs < 1 ||
  jobs > 3
)
  throw Error("Invalid batch, reps or jobs (1..3)");
function choose<T extends string>(all: readonly T[], filter?: string) {
  const list = (filter ? filter.split(",") : all) as T[];
  if (!list.length || list.some((x) => !all.includes(x)))
    throw Error("Unknown selector: " + filter);
  return [...new Set(list)];
}
const chosenModels = choose(PROJECT_MODELS, values.models),
  chosenArms = choose(arms, values.arms);
const chosenTasks = choose(
  projectTasks.map((t) => t.id),
  values.tasks,
);
const root = resolve("results", "project-bench", batch),
  work = resolve("work", "pb");
await mkdir(root, { recursive: true });
await mkdir(work, { recursive: true });
const commit = execFileSync("git", ["-C", "../weichai", "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
async function readJson(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function atomic(path: string, r: unknown) {
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(r, null, 2));
  await rename(tmp, path);
}
const scripts = [
  "trial.ts",
  "commands.ts",
  "run.ts",
  "providers.ts",
  "workflow.ts",
  "raw.ts",
  "tasks.ts",
  "fixture-format.ts",
];
const h = createHash("sha256");
for (const name of scripts) {
  h.update(name).update(await readFile(new URL(name, import.meta.url)));
}
const version = h.digest("hex");
const queue = [];
for (let rep = 1; rep <= reps; rep++) {
  for (const [i, t] of projectTasks.entries()) {
    if (!chosenTasks.includes(t.id)) continue;
    for (let j = 0; j < PROJECT_MODELS.length; j++) {
      const model = PROJECT_MODELS[(j + i + rep - 1) % PROJECT_MODELS.length];
      if (!chosenModels.includes(model)) continue;
      for (let k = 0; k < arms.length; k++) {
        // Rotate within each model as well as across models, tasks and repetitions.
        const arm = arms[(k + 2 * i + j + 2 * (rep - 1)) % arms.length];
        if (chosenArms.includes(arm)) queue.push({ rep, t, model, arm });
      }
    }
  }
}
async function runOne({ rep, t, model, arm }: (typeof queue)[number]) {
  const name = [t.id, model, arm, "r" + rep].join("_");
  const path = join(root, name + ".json"),
    lock = join(root, name + ".lock");
  const lease = await open(lock, "wx");
  try {
    const expected = {
      batch,
      rep,
      arm,
      model,
      taskId: t.id,
      inputHash: hash(publicProject(t)),
      gradingHash: hash(t.acceptance),
      commitRECAST: commit,
      protocol,
      implementationHash: version,
      concurrency: jobs,
    };
    const prior = await readJson(path);
    if (prior) {
      for (const [k, v] of Object.entries(expected))
        if (JSON.stringify(prior[k]) !== JSON.stringify(v))
          throw Error(
            "Changed batch inputs (" + k + "): " + name + "; use a fresh batch",
          );
      if (prior.status !== "credential_missing") {
        console.log("RECORDED", name, prior.status);
        return;
      }
    }
    if (!(await providerAvailable(model))) {
      await atomic(path, {
        ...expected,
        status: "credential_missing",
        usage: null,
        wallMs: null,
        grade: null,
      });
      console.log("MISSING", name);
      return;
    }
    // RECAST also nests a UUID in the output path and its Git branch ref.
    // Keep the outer run directory short for Windows Git's lock-file limit.
    const attempt = randomUUID(),
      runRoot = await mkdtemp(join(work, "p-"));
    console.log("START", name, new Date().toISOString());
    const row = await runTrial(t, arm, model, runRoot);
    await atomic(path, { ...expected, ...row, attempt, runRoot });
    console.log(
      "END",
      name,
      row.status,
      Math.round(row.wallMs / 1000) + "s",
      row.usage.totalTokens + " tokens",
      row.error ?? "",
    );
  } finally {
    await lease.close();
    await unlink(lock);
  }
}
async function worker() {
  for (let job; (job = queue.shift()); ) await runOne(job);
}
const outcomes = await Promise.allSettled(Array.from({ length: jobs }, worker));
for (const o of outcomes)
  if (o.status === "rejected") {
    console.error(o.reason);
    process.exitCode = 1;
  }
