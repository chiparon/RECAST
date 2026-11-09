import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  PROJECT_MODELS,
  type ProjectModel,
  type TokenUsage,
} from "../project-bench/providers.ts";
import type { Check } from "./types.ts";

const arms = ["recast", "sag2sql", "rawagent"] as const;
type Arm = (typeof arms)[number];
type Control = {
  taskId: string;
  upstream: { url: string; commit: string };
  inputHash: string;
  files: number;
  languages: Record<
    string,
    { files: number; physical: number; nonblank: number }
  >;
  readFiles: number;
  referenceFiles: number;
  writable: string[];
  controls: { variant: string; checks: Check[] }[];
};
type Trial = {
  batch: string;
  task: string;
  model: ProjectModel;
  arm: Arm;
  inputHash: string;
  implementationHash: string;
  productRevision: string;
  productDiff: string;
  startedAt: string;
  work: string;
  outputRoot: string | null;
  passed: boolean;
  commit: string | null;
  error: string | null;
  gradingError: string | null;
  grade: { checks: Check[]; integrityErrors: string[]; passed: boolean } | null;
  wallMs: number;
  executionMs: number;
  indexMs: number | null;
  usage: TokenUsage & {
    requests: number;
    turns: number;
    usageComplete: boolean;
  };
  calls: {
    status: string;
    httpStatus?: number;
    usage: TokenUsage | null;
    servedModel?: string;
  }[];
};

const { values } = parseArgs({
  options: { batch: { type: "string", default: "real-v2" } },
});
const batch = values.batch!;
if (!/^[\w-]+$/.test(batch)) throw Error("Invalid batch");
const results = resolve("results"),
  directory = join(results, "real-project-bench", batch);
const contents = (await readdir(directory)).sort();
async function records<T>(suffix: string): Promise<T[]> {
  return Promise.all(
    contents
      .filter((name) => name.endsWith(suffix))
      .map(async (name) =>
        JSON.parse(await readFile(join(directory, name), "utf8")),
      ),
  );
}
const [calibrated, trials] = await Promise.all([
  records<Control>(".control.json"),
  records<Trial>(".trial.json"),
]);
// real-v1 was stopped after the Django matrix, before coverage.py measurements.
const pilot = batch === "real-v1";
const controls = pilot
  ? calibrated.filter((c) => c.taskId === "django-i18n")
  : calibrated;
if (!controls.length) throw Error("No calibrated fixture in " + directory);
const byTask = new Map(controls.map((c) => [c.taskId, c]));
const id = (task: string, model: string, arm: string) =>
  [task, model, arm].join("/");
const bySlot = new Map(trials.map((t) => [id(t.task, t.model, t.arm), t]));
if (bySlot.size !== trials.length || byTask.size !== controls.length)
  throw Error("Duplicate trial or control");
type Evidence = {
  task: string;
  model: ProjectModel;
  arm: Arm;
  inputHash: string;
  verdictHash: string;
  indexFiles: string[] | null;
  numstat: string | null;
};
const evidence = new Map<string, Evidence>();
try {
  const archived: Evidence[] = JSON.parse(
    gunzipSync(
      await readFile(join(results, "real-e2e-" + batch + "-evidence.json.gz")),
    ).toString("utf8"),
  );
  for (const e of archived) {
    const slot = id(e.task, e.model, e.arm);
    if (bySlot.get(slot)?.inputHash !== e.inputHash)
      throw Error("Stale archived input for " + slot);
    evidence.set(slot, e);
  }
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const indexStats = new Map<string, { files: string[]; byType: string }>();
const changes = new Map<
  string,
  { added: number; deleted: number; binary: number }
>();
for (const t of trials.filter((t) => t.commit)) {
  const key = id(t.task, t.model, t.arm);
  const stats =
    evidence.get(key)?.numstat ??
    (t.outputRoot &&
      execFileSync(
        "git",
        [
          "-C",
          t.outputRoot,
          "--literal-pathspecs",
          "diff",
          "--numstat",
          "--no-renames",
          "--no-ext-diff",
          t.commit + "^",
          t.commit!,
          "--",
          ...byTask.get(t.task)!.writable,
        ],
        { encoding: "utf8", windowsHide: true },
      ));
  if (stats == null) continue;
  const change = { added: 0, deleted: 0, binary: 0 };
  for (const line of stats.trimEnd().split(/\r?\n/).filter(Boolean)) {
    const [added, deleted] = line.split("\t");
    if (added === "-" || deleted === "-") change.binary++;
    else {
      change.added += Number(added);
      change.deleted += Number(deleted);
    }
  }
  changes.set(key, change);
}
for (const t of trials.filter((t) => t.arm === "sag2sql")) {
  const key = id(t.task, t.model, t.arm);
  let files = evidence.get(key)?.indexFiles;
  if (files === undefined) {
    try {
      files = JSON.parse(
        await readFile(join(t.work, "runtime.json"), "utf8"),
      )?.indexFiles;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (Array.isArray(files)) {
    const counts = new Map<string, number>();
    for (const path of new Set(files)) {
      const extension = extname(path).toLowerCase();
      counts.set(extension, (counts.get(extension) ?? 0) + 1);
    }
    if (
      new Set(files).size !== files.length ||
      files.length > byTask.get(t.task)!.referenceFiles
    )
      throw Error("Invalid SQLite index file inventory for " + key);
    indexStats.set(key, {
      files,
      byType: [...counts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, n]) => k + " " + n)
        .join("、"),
    });
  }
}
for (const t of trials) {
  if (
    t.batch !== batch ||
    !arms.includes(t.arm) ||
    !PROJECT_MODELS.includes(t.model) ||
    byTask.get(t.task)?.inputHash !== t.inputHash
  )
    throw Error("Input/protocol mismatch for " + id(t.task, t.model, t.arm));
  const delivered = Boolean(
    t.commit &&
      !t.error &&
      !t.gradingError &&
      t.grade?.passed &&
      !t.grade.integrityErrors.length &&
      t.grade.checks.length &&
      t.grade.checks.every((c) => c.passed),
  );
  if (delivered !== t.passed)
    throw Error(
      "Inconsistent delivery verdict for " + id(t.task, t.model, t.arm),
    );
  if (
    !Number.isFinite(t.wallMs) ||
    t.wallMs < 0 ||
    !Number.isFinite(t.usage.totalTokens) ||
    t.usage.totalTokens < 0
  )
    throw Error("Invalid measured cost for " + id(t.task, t.model, t.arm));
}
for (const c of controls) {
  const identities = new Set(
    trials
      .filter((t) => t.task === c.taskId)
      .map((t) =>
        JSON.stringify([
          t.implementationHash,
          t.productRevision,
          t.productDiff,
        ]),
      ),
  );
  if (identities.size > 1)
    throw Error("Mixed harness/product revisions for " + c.taskId);
}

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((sum, n) => sum + n, 0) / xs.length : null;
const number = (value: number | null, places = 0) =>
  value === null
    ? "—"
    : value.toLocaleString("en-US", { maximumFractionDigits: places });
const rate = (n: number, d: number) =>
  d ? ((100 * n) / d).toFixed(1) + "%" : "—";
function diagnosis(t: Trial) {
  if (t.passed) return "";
  const diagnostics = [];
  const err = t.error || "";
  if (!t.calls.length) diagnostics.push("在首次模型请求前失败");
  if (t.gradingError) diagnostics.push("外部评分执行异常");
  if (t.grade?.integrityErrors.length) diagnostics.push("交付树完整性检查失败");
  if (err) {
    const http = err.match(/HTTP\D{0,5}(\d{3})/i);
    if (http) diagnostics.push("模型接口 HTTP " + http[1]);
    else if (
      /(writeFiles|write scope|只读|read-only)/i.test(err) &&
      /(required|requires|scope|absent|authorize)/i.test(err)
    )
      diagnostics.push("模型报告所需模块超出当前步骤的写入范围");
    else if (/timeout|timed out|cancelled|aborted/i.test(err))
      diagnostics.push("执行超时或取消");
    else if (/compile|compilation|build failed/i.test(err))
      diagnostics.push("公开构建失败");
    else if (/tests? failed|verification|public.test/i.test(err))
      diagnostics.push("公开验收失败");
    else if (/ENAMETOOLONG|filename too long/i.test(err))
      diagnostics.push("宿主路径超长");
    else if (/EACCES|EPERM|permission denied/i.test(err))
      diagnostics.push("宿主文件权限错误");
    else if (/fetch failed|network|ECONN|socket/i.test(err))
      diagnostics.push("模型连接失败");
    else {
      // Use the leading message only. Raw command output can contain full paths or request bodies.
      const line = err
        .split(/\r?\n/, 1)[0]
        .replace(/(?:[A-Z]:[\\/]|(?:\/tmp\/))[^\s"']+/gi, "[路径]");
      diagnostics.push(line.slice(0, 175));
    }
  }
  const hidden =
    t.grade?.checks.filter((c) => !c.passed).map((c) => c.id) ?? [];
  if (hidden.length)
    diagnostics.push("隐藏检查失败（" + hidden.join("、") + "）");
  if (!t.commit) diagnostics.push("无交付提交");
  return diagnostics.join("。") || "交付验收未通过";
}
const csv = (rows: Record<string, unknown>[]) => {
  const keys = Object.keys(rows[0]);
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text)
      ? '"' + text.replaceAll('"', '""') + '"'
      : text;
  };
  return (
    [
      keys.join(","),
      ...rows.map((row) => keys.map((key) => cell(row[key])).join(",")),
    ].join("\r\n") + "\r\n"
  );
};
const trialsCsv = controls.flatMap((c) =>
  PROJECT_MODELS.flatMap((model) =>
    arms.map((arm) => {
      const t = bySlot.get(id(c.taskId, model, arm));
      const slot = id(c.taskId, model, arm),
        index = indexStats.get(slot),
        change = changes.get(slot);
      return {
        batch,
        task: c.taskId,
        model,
        arm,
        status: !t
          ? "unrecorded"
          : t.passed
            ? "passed"
            : t.calls.length
              ? "failed"
              : "failed_before_model_request",
        inputHash: c.inputHash,
        verdictHash: evidence.get(slot)?.verdictHash,
        implementationHash: t?.implementationHash,
        productRevision: t?.productRevision,
        productDiff: t?.productDiff,
        startedAt: t?.startedAt,
        commit: t?.commit,
        passed: t?.passed,
        addedSourceLines: change?.added,
        deletedSourceLines: change?.deleted,
        binaryModuleChanges: change?.binary,
        hiddenPassed: t?.grade?.checks.filter((c) => c.passed).length,
        hiddenTotal: t?.grade?.checks.length,
        integrityErrors: t?.grade?.integrityErrors.length,
        wallMs: t?.wallMs,
        executionMs: t?.executionMs,
        indexMs: t?.indexMs,
        eligibleReferenceFiles: c.referenceFiles,
        indexedFiles: index?.files.length,
        indexedByExtension: index?.byType,
        turns: t?.usage.turns,
        requests: t?.usage.requests,
        observedInputTokens: t?.usage.inputTokens,
        observedOutputTokens: t?.usage.outputTokens,
        cachedInputTokens: t?.usage.cachedInputTokens,
        reasoningTokens: t?.usage.reasoningTokens,
        observedTotalTokens: t?.usage.totalTokens,
        usageComplete: t?.usage.usageComplete,
        servedModels:
          t &&
          [...new Set(t.calls.map((c) => c.servedModel).filter(Boolean))].join(
            "|",
          ),
        callsMissingUsage: t?.calls.filter((c) => c.usage === null).length,
        reason: t ? diagnosis(t) : "尚无终态记录",
      };
    }),
  ),
);
function summary(selected: Trial[], model: string, arm: Arm, planned: number) {
  const passed = selected.filter((t) => t.passed).length;
  return {
    batch,
    model,
    arm,
    planned,
    attempts: selected.length,
    pending: planned - selected.length,
    passed,
    failed: selected.length - passed,
    passRate: selected.length ? passed / selected.length : null,
    preModelFailures: selected.filter((t) => !t.calls.length).length,
    meanWallSeconds: mean(selected.map((t) => t.wallMs / 1000)),
    meanObservedTokensPerTask: mean(selected.map((t) => t.usage.totalTokens)),
    incompleteUsageTasks: selected.filter((t) => !t.usage.usageComplete).length,
    requestsMissingUsage: selected
      .flatMap((t) => t.calls)
      .filter((call) => call.usage === null).length,
  };
}
const groups = PROJECT_MODELS.flatMap((model) =>
  arms.map((arm) =>
    summary(
      trials.filter((t) => t.model === model && t.arm === arm),
      model,
      arm,
      controls.length,
    ),
  ),
);
const overall = arms.map((arm) =>
  summary(
    trials.filter((t) => t.arm === arm),
    "ALL",
    arm,
    controls.length * PROJECT_MODELS.length,
  ),
);
function pairedRow(arm: "sag2sql" | "recast", baseline: "rawagent" | "recast") {
  const pairs = trials
    .filter((t) => t.arm === arm)
    .flatMap((t) => {
      const reference = bySlot.get(id(t.task, t.model, baseline));
      return reference ? [{ method: t, reference }] : [];
    });
  const both = pairs.filter(
    ({ method, reference }) => method.passed && reference.passed,
  );
  const complete = both.filter(
    ({ method, reference }) =>
      method.usage.usageComplete && reference.usage.usageComplete,
  );
  return [
    arm + " / " + baseline,
    pairs.length,
    pairs.filter((p) => p.method.passed && !p.reference.passed).length,
    pairs.filter((p) => !p.method.passed && p.reference.passed).length,
    both.length,
    number(
      mean(both.map((p) => (p.method.wallMs - p.reference.wallMs) / 1000)),
      1,
    ),
    number(
      mean(
        complete.map(
          (p) => p.method.usage.totalTokens - p.reference.usage.totalTokens,
        ),
      ),
    ),
    complete.length,
  ].join(" | ");
}
const printable = (s: (typeof groups)[number]) =>
  [
    s.model,
    s.arm,
    s.passed + "/" + s.attempts,
    rate(s.passed, s.attempts),
    number(s.meanWallSeconds, 1),
    (s.incompleteUsageTasks ? "≥ " : "") + number(s.meanObservedTokensPerTask),
    String(s.preModelFailures),
    String(s.pending),
  ].join(" | ");
const tableRow = (s: string) => "| " + s + " |";
const ratingHeader = [
  "| 模型 | 方法 | 通过/已测 | 交付通过率 | 平均用时（秒） | 平均 tokens/task | 调用前失败 | 待完成 |",
  "|---|---|---:|---:|---:|---:|---:|---:|",
];
const report = [
  "# 真实多语言项目端到端交付基准",
  "",
  "批次 " +
    batch +
    "。已校准 " +
    controls.length +
    " 个项目，已记录 " +
    trials.length +
    " 次终态尝试。每题采用三种模型、三种方法，每个组合运行一次。",
  "",
  "供应商共收到 " +
    number(trials.reduce((n, t) => n + t.calls.length, 0)) +
    " 次请求，已报告 " +
    number(trials.reduce((n, t) => n + t.usage.totalTokens, 0)) +
    " tokens。缺少用量回传的请求数为 " +
    number(
      trials.flatMap((t) => t.calls).filter((call) => !call.usage).length,
    ) +
    "。单次任务的最高已报告用量为 " +
    number(
      trials.length
        ? Math.max(...trials.map((t) => t.usage.totalTokens))
        : null,
    ) +
    " tokens。",
  ...(pilot
    ? [
        "",
        "本批为先导试验，只计 Django 的九个组合。工作流使用早期模块任务说明，coverage.py 仅用于校准。正式批次使用修订后的模块任务说明。",
      ]
    : []),
  "",
  "## 交付结果",
  "",
  ...ratingHeader,
  ...overall.map((s) => tableRow(printable(s))),
  "",
  "| 项目 | recast 通过 | sag2sql 通过 | rawagent 通过 |",
  "|---|---:|---:|---:|",
  ...controls.map((fixture) =>
    tableRow(
      [
        fixture.taskId,
        ...arms.map((arm) => {
          const measured = trials.filter(
            (trial) => trial.task === fixture.taskId && trial.arm === arm,
          );
          return (
            measured.filter((trial) => trial.passed).length +
            "/" +
            measured.length
          );
        }),
      ].join(" | "),
    ),
  ),
  "",
  ...ratingHeader,
  ...groups.map((s) => tableRow(printable(s))),
  "",
  "通过率分母为有终态记录的尝试。平均用时从方法启动计至外部评分结束，包含失败、重试和 SAG2 建库。tokens/task 为各任务所有模型请求的已报告总 token 之和再取算术平均，包括输入、输出及重试。首次模型调用前发生的错误单列计数，其实际用时及零 token 计入端到端均值。回传缺失时保留观测下界（≥），待完成的任务留空。",
  "",
  "### 同任务、同模型的配对结果",
  "",
  "| 方法 / 对照 | 配对数 | 仅方法通过 | 仅对照通过 | 两者通过 | 两者通过的平均时间差（秒） | 平均 token 差 | 用量完整配对数 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|",
  tableRow(pairedRow("recast", "rawagent")),
  tableRow(pairedRow("sag2sql", "rawagent")),
  tableRow(pairedRow("sag2sql", "recast")),
  "",
  "差值按左侧方法减右侧对照计算。负值表示左侧方法在配对中更省时或更省 token。耗时差只使用双方都交付成功的配对，token 差还要求双方用量完整。",
  "",
  "## 任务与输入",
  "",
  "| 项目 | 生产源码行（物理/非空） | 按语言的物理行 | 文件（冻结/可读） | 实现范围 |",
  "|---|---:|---|---:|---|",
  ...controls.map((c) => {
    const langs = Object.entries(c.languages).sort(
      (a, b) => b[1].physical - a[1].physical,
    );
    return tableRow(
      [
        c.taskId,
        number(langs.reduce((n, [, s]) => n + s.physical, 0)) +
          " / " +
          number(langs.reduce((n, [, s]) => n + s.nonblank, 0)),
        langs.map(([lang, s]) => lang + " " + number(s.physical)).join("、"),
        c.files + " / " + c.readFiles,
        c.writable.join("、"),
      ].join(" | "),
    );
  }),
  "",
  "每题从固定上游版本导出真实项目代码，移除指定实现。三种方法拿到相同需求、源码字节、可读文件清单、可写范围和公开测试。规模栏统计输入树中列入清单的生产源码。工作量是已有项目中的跨语言模块交付。",
  "",
  ...controls.flatMap((c) => {
    const deltas = trialsCsv.filter(
      (r) =>
        r.task === c.taskId &&
        r.passed &&
        r.addedSourceLines != null &&
        !r.binaryModuleChanges,
    );
    if (!deltas.length) return [];
    const range = (values: number[]) => {
      const low = Math.min(...values),
        high = Math.max(...values);
      return low === high ? String(low) : low + "–" + high;
    };
    return [
      "- " +
        c.taskId +
        " 的 " +
        deltas.length +
        " 次通过交付相对起始提交实际新增 " +
        range(deltas.map((r) => r.addedSourceLines!)) +
        " 行，删除 " +
        range(deltas.map((r) => r.deletedSourceLines!)) +
        " 行（Git numstat，可写模块）。",
    ];
  }),
  "",
  ...controls.flatMap((c) =>
    c.taskId === "coverage-html-contexts"
      ? [
          "- coverage.py 题要求 Python 报告写入器分配、编码执行上下文，浏览器 JavaScript 展开指定源码行的上下文名称。联合验收通过真实 HTML 报告传递数据。",
        ]
      : c.taskId === "django-i18n"
        ? [
            "- Django 题要求 Python 视图组合多级翻译目录和复数规则，浏览器 JavaScript 使用生成的目录进行带上下文的单复数翻译。联合验收覆盖本地化管理界面的日历。",
          ]
        : c.taskId === "bullmq-priority"
          ? [
              "- BullMQ 题要求 TypeScript 层生成队列键，并用 Redis Lua 脚本修改任务优先级、按优先级读取任务数。联合验收在隔离的原生 Redis 上运行。",
            ]
          : [],
  ),
  "",
  ...controls.map((c) => {
    const upstream =
      c.upstream.url.replace(/\.git$/, "") + "/tree/" + c.upstream.commit;
    const golden = c.controls.find((x) => x.variant === "golden")!,
      starter = c.controls.find((x) => x.variant === "starter")!;
    const missing = c.controls.filter((x) => x.variant.startsWith("missing "));
    const hashes = [
      ...new Set(
        [...evidence.values()]
          .filter((e) => e.task === c.taskId)
          .map((e) => e.verdictHash),
      ),
    ];
    if (hashes.length > 1)
      throw Error("Mixed verdict fingerprints for " + c.taskId);
    return (
      "- " +
      c.taskId +
      " 的输入指纹为 " +
      c.inputHash +
      "。参考实现通过 " +
      golden.checks.filter((k) => k.passed).length +
      "/" +
      golden.checks.length +
      " 项隐藏检查，起始版本通过 " +
      starter.checks.filter((k) => k.passed).length +
      "/" +
      starter.checks.length +
      " 项。逐一移除实现的 " +
      missing.length +
      " 个对照均触发验收失败。" +
      (hashes[0] ? "评分材料指纹为 " + hashes[0] + "。" : "") +
      "[上游固定版本](" +
      upstream +
      ")"
    );
  }),
  "",
  "## 方法与评分",
  "",
  "- recast 运行 RECAST 项目工作流，按模块调度实现、编译、公开验证和集成修复。",
  "- sag2sql 在相同工作流中加入 SAG2 SQLite BM25 检索，候选来自共同输入的公开源码。",
  "- rawagent 在单个会话中自主读取、编辑、构建和测试，全程由同一模型决定下一步。",
  "- 三组共享模型接入配置。运行器取消任务 token 预算并省略请求的最大输出 token 参数。模型服务自身的上下文窗口和每次调用的技术限制仍适用。",
  "- 交付成功要求生成 Git 提交、通过公开验证、提交树与实际产物一致，并在独立干净副本上通过全部外部检查。",
  "",
  "### SQLite 实际建库范围",
  "",
  "| 项目 | 模型 | 候选源码文件 | 实际入库文件 | 入库文件扩展名 | 冷建库（秒） |",
  "|---|---|---:|---:|---|---:|",
  ...trialsCsv
    .filter((r) => r.arm === "sag2sql")
    .map((r) =>
      tableRow(
        [
          r.task,
          r.model,
          r.eligibleReferenceFiles,
          r.indexedFiles ?? "—",
          r.indexedByExtension || "—",
          number(r.indexMs == null ? null : r.indexMs / 1000, 2),
        ].join(" | "),
      ),
    ),
  "",
  "候选数来自冻结输入。入库数来自扫描器实际识别并交给 SQLite 检索的文件清单。冷建库时间包含复制候选源码、扫描、建立模块投影和索引初始化，已计入端到端用时。缺少运行记录的格子用 — 表示。",
  "",
  "## 逐任务交付",
  "",
  "| 项目 | 模型 | 方法 | 结果 | 用时（秒） | 已观测 tokens | 验收与失败原因 |",
  "|---|---|---|---|---:|---:|---|",
  ...trialsCsv.map((r) =>
    tableRow(
      [
        r.task,
        r.model,
        r.arm,
        r.status === "unrecorded"
          ? "未完成"
          : r.passed
            ? "通过"
            : r.status === "failed_before_model_request"
              ? "调用前失败"
              : "失败",
        number(r.wallMs == null ? null : r.wallMs / 1000, 1),
        (r.usageComplete === false ? "≥ " : "") +
          number(r.observedTotalTokens ?? null),
        (
          r.reason || "隐藏检查 " + r.hiddenPassed + "/" + r.hiddenTotal
        ).replaceAll("|", "\\|"),
      ].join(" | "),
    ),
  ),
  "",
];
const served = PROJECT_MODELS.map((model) => {
  const labels = [
    ...new Set(
      trials
        .filter((t) => t.model === model)
        .flatMap((t) => t.calls.map((c) => c.servedModel))
        .filter(Boolean),
    ),
  ].sort();
  return "- " + model + " → " + (labels.join("、") || "尚无服务端模型回传");
});
report.push(
  "## 模型标识与数据",
  "",
  ...served,
  "",
  "本次运行使用的 `deepseek-flash` 对应 DeepSeek V4.1-Flash-1017。[DeepSeek 更新日志](https://api-docs.deepseek.com/updates/)",
  "",
  "逐次 CSV 保留冻结输入指纹、交付提交、各类 token 和缺失用量请求数。汇总 CSV 同时提供按模型及跨模型等权任务平均。每题每格只有一次采样，项目、模型和方法的交互会影响排序。",
  "",
);
const stem = join(results, "real-e2e-" + batch);
await Promise.all([
  writeFile(stem + ".md", report.join("\n"), "utf8"),
  writeFile(stem + "-trials.csv", csv(trialsCsv), "utf8"),
  writeFile(stem + "-summary.csv", csv([...groups, ...overall]), "utf8"),
]);
console.log("Report:", stem + ".md", trials.length, "terminal trials");
