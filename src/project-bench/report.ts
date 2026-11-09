import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  PROJECT_MODELS,
  type ProjectModel,
  type ProviderCall,
  type TokenUsage,
} from "./providers.ts";
import { projectTasks, type ProjectGrade } from "./tasks.ts";

const arms = ["recast", "sag2sql", "rawagent"] as const;
type Arm = (typeof arms)[number];
type Status = "passed" | "failed" | "credential_missing" | "unrecorded";
interface Trial {
  batch: string;
  model: ProjectModel;
  arm: Arm;
  taskId: string;
  rep: number;
  status: Status;
  inputHash?: string;
  gradingHash?: string;
  implementationHash?: string;
  commitRECAST?: string;
  concurrency?: number;
  protocol?: {
    maxTurns: number;
    maxTokens: number;
    maxOutputTokens: number;
    timeoutMs: number;
  };
  publicDelivered?: boolean;
  grade?: ProjectGrade | null;
  usage?:
    | (TokenUsage & { requests: number; turns: number; usageComplete: boolean })
    | null;
  wallMs?: number | null;
  executionMs?: number | null;
  timeToVerifiedMs?: number | null;
  toolCalls?: number;
  repairAttempts?: number | null;
  indexMs?: number | null;
  error?: string | null;
  calls?: ProviderCall[];
}

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const pct = (n: number, d: number) =>
  d ? ((100 * n) / d).toFixed(1) + "%" : "—";
const show = (n: number | null | undefined, places = 1) =>
  n == null ? "—" : n.toFixed(places);
const seconds = (n: number | null | undefined) =>
  n == null ? "—" : show(n / 1000);
const measured = (r: Trial) => r.status === "passed" || r.status === "failed";
const key = (r: Pick<Trial, "taskId" | "model" | "arm" | "rep">) =>
  [r.taskId, r.model, r.arm, r.rep].join("/");
function reason(r: Trial) {
  if (r.status === "credential_missing")
    return r.model === "deepseek-flash" ? "缺 DeepSeek 凭据" : "缺 OpenAI 凭据";
  if (r.status === "unrecorded") return "尚无结果";
  if (r.status === "passed") return "";
  const error = r.error ?? "";
  if (/filename too long|ENAMETOOLONG/i.test(error)) return "宿主路径超长";
  if (/EPERM|EACCES|access is denied|permission denied/i.test(error))
    return "宿主文件权限或占用错误";
  const http = error.match(/HTTP\s+(\d{3})\b/i);
  if (http) return "模型接口 HTTP " + http[1];
  if (/token budget/i.test(error)) return "任务 Token 预算用尽";
  if (/turn budget|max.*turns|turn limit/i.test(error))
    return "任务模型轮数预算用尽";
  if (/timeout|timed out|aborted|cancelled/i.test(error)) return "超时或取消";
  if (/fetch failed|ECONN|ENET|socket|network/i.test(error))
    return "模型连接失败";
  if (/external grader/i.test(error)) return "外部评分执行错误";
  if (r.grade?.integrityErrors.length) return "提交完整性未通过";
  if (r.grade && r.publicDelivered && !r.grade.passed)
    return "隐藏行为检查未通过";
  if (/git|commit/i.test(error)) return "Git 交付失败";
  if (/public.build|public.test|compile|compilation|verification/i.test(error))
    return "公开构建或测试未通过";
  return "执行未完成（本地原始记录含诊断）";
}

function taskRow(r: Trial) {
  return {
    model: r.model,
    arm: r.arm,
    task: r.taskId,
    rep: r.rep,
    status: r.status,
    attempted: Number(measured(r)),
    publicDelivered: measured(r) ? Number(Boolean(r.publicDelivered)) : null,
    graded: r.grade ? 1 : 0,
    hiddenPassed: r.grade?.passedChecks ?? null,
    hiddenTotal: r.grade?.totalChecks ?? null,
    hiddenFailedChecks:
      r.grade?.checks
        .filter((c) => !c.passed)
        .map((c) => c.id)
        .join(",") ?? null,
    wallMs: r.wallMs ?? null,
    timeToVerifiedMs: r.timeToVerifiedMs ?? null,
    executionMs: r.executionMs ?? null,
    gradingMs: r.grade?.elapsedMs ?? null,
    indexMs: r.indexMs ?? null,
    repairAttempts: r.repairAttempts ?? null,
    turns: r.usage?.turns ?? null,
    requests: r.usage?.requests ?? null,
    toolCalls: r.toolCalls ?? null,
    observedInputTokens: r.usage?.inputTokens ?? null,
    observedOutputTokens: r.usage?.outputTokens ?? null,
    observedCachedInputTokens: r.usage?.cachedInputTokens ?? null,
    observedReasoningTokens: r.usage?.reasoningTokens ?? null,
    observedTotalTokens: r.usage?.totalTokens ?? null,
    usageComplete: r.usage?.usageComplete ?? null,
    timeLabel:
      r.wallMs == null ? "" : r.status === "passed" ? "verified" : "attempt",
    errorCategory: reason(r),
    servedModels:
      [
        ...new Set((r.calls ?? []).map((c) => c.servedModel).filter(Boolean)),
      ].join(" / ") || null,
    inputHash: r.inputHash ?? null,
    gradingHash: r.gradingHash ?? null,
    implementationHash: r.implementationHash ?? null,
  };
}

function comparable(a: Trial, b: Trial) {
  return (
    a.status === "passed" &&
    b.status === "passed" &&
    a.inputHash === b.inputHash &&
    a.gradingHash === b.gradingHash &&
    a.implementationHash === b.implementationHash &&
    a.commitRECAST === b.commitRECAST &&
    a.concurrency === b.concurrency &&
    JSON.stringify(a.protocol) === JSON.stringify(b.protocol)
  );
}
const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
function summarize(group: Trial[], all: Map<string, Trial>) {
  const attempted = group.filter(measured),
    passed = attempted.filter((r) => r.status === "passed"),
    graded = attempted.filter((r) => r.grade),
    metered = attempted.filter((r) => r.usage),
    complete = metered.filter((r) => r.usage!.usageComplete);
  const usageMean = (field: keyof TokenUsage) =>
    mean(complete.map((r) => r.usage![field]));
  const pairs =
    group[0].arm === "rawagent"
      ? []
      : passed.flatMap((r) => {
          const raw = all.get(key({ ...r, arm: "rawagent" }));
          return raw && comparable(r, raw) ? [{ r, raw }] : [];
        });
  const timePairs = pairs.filter(
    ({ r, raw }) => r.timeToVerifiedMs! > 0 && raw.timeToVerifiedMs! > 0,
  );
  const tokenPairs = pairs.filter(
    ({ r, raw }) =>
      r.usage?.usageComplete &&
      raw.usage?.usageComplete &&
      r.usage.totalTokens > 0 &&
      raw.usage.totalTokens > 0,
  );
  return {
    model: group[0].model,
    arm: group[0].arm,
    planned: group.length,
    recorded: group.filter((r) => r.status !== "unrecorded").length,
    missingCredential: group.filter((r) => r.status === "credential_missing")
      .length,
    unrecorded: group.filter((r) => r.status === "unrecorded").length,
    attempted: attempted.length,
    passed: passed.length,
    failed: attempted.length - passed.length,
    graded: graded.length,
    hiddenPassed: total(graded.map((r) => r.grade!.passedChecks)),
    hiddenTotalGraded: total(graded.map((r) => r.grade!.totalChecks)),
    meanWallMs: mean(
      attempted.flatMap((r) => (r.wallMs == null ? [] : [r.wallMs])),
    ),
    meanVerifiedMs: mean(
      passed.flatMap((r) =>
        r.timeToVerifiedMs == null ? [] : [r.timeToVerifiedMs],
      ),
    ),
    usageComplete: complete.length,
    usageIncomplete: attempted.length - complete.length,
    meanInputTokens: usageMean("inputTokens"),
    meanOutputTokens: usageMean("outputTokens"),
    meanCachedInputTokens: usageMean("cachedInputTokens"),
    meanReasoningTokens: usageMean("reasoningTokens"),
    tokensPerTask: complete.length === attempted.length ? usageMean("totalTokens") : null,
    completeSampleTokensPerTask: usageMean("totalTokens"),
    observedTotalTokens: metered.length
      ? total(metered.map((r) => r.usage!.totalTokens))
      : null,
    meanObservedTokensPerAttempt:
      attempted.length && metered.length
        ? total(metered.map((r) => r.usage!.totalTokens)) / attempted.length
        : null,
    timePairs: timePairs.length,
    rawTimeRatio: timePairs.length
      ? total(timePairs.map((p) => p.raw.timeToVerifiedMs!)) /
        total(timePairs.map((p) => p.r.timeToVerifiedMs!))
      : null,
    tokenPairs: tokenPairs.length,
    rawTokenRatio: tokenPairs.length
      ? total(tokenPairs.map((p) => p.raw.usage!.totalTokens)) /
        total(tokenPairs.map((p) => p.r.usage!.totalTokens))
      : null,
  };
}

function csv(rows: Record<string, unknown>[]) {
  const headers = Object.keys(rows[0]),
    cell = (v: unknown) =>
      v == null ? "" : '"' + String(v).replaceAll('"', '""') + '"';
  return (
    "\uFEFF" +
    [
      headers.join(","),
      ...rows.map((r) => headers.map((k) => cell(r[k])).join(",")),
    ].join("\r\n") +
    "\r\n"
  );
}
function table(headers: string[], rows: unknown[][]) {
  const cell = (v: unknown) =>
    String(v ?? "—")
      .replaceAll("|", "\\|")
      .replace(/[\r\n]+/g, " ");
  return [
    "| " + headers.join(" | ") + " |",
    "|" + headers.map(() => "---").join("|") + "|",
    ...rows.map((r) => "| " + r.map(cell).join(" | ") + " |"),
  ].join("\n");
}

export async function writeProjectReport(
  batch: string,
  requestedReps?: number,
  root = resolve("results"),
) {
  if (!/^[\w-]+$/.test(batch)) throw new Error("Invalid batch name");
  const path = join(root, "project-bench", batch),
    records = new Map<string, Trial>();
  const names = await readdir(path);
  const taskIds = projectTasks.map((t) => t.id);
  let maxRep = 1;
  for (const name of names.filter((p) => p.endsWith(".json"))) {
    const r = JSON.parse(await readFile(join(path, name), "utf8")) as Trial;
    if (
      r.batch !== batch ||
      !taskIds.includes(r.taskId) ||
      !PROJECT_MODELS.includes(r.model) ||
      !arms.includes(r.arm) ||
      !Number.isInteger(r.rep) ||
      r.rep < 1 ||
      !["passed", "failed", "credential_missing"].includes(r.status) ||
      records.has(key(r))
    )
      throw Error("Invalid or duplicate trial record: " + name);
    records.set(key(r), r);
    maxRep = Math.max(maxRep, r.rep);
  }
  const reps = requestedReps ?? maxRep;
  if (!Number.isSafeInteger(reps) || reps < maxRep)
    throw Error("--reps must cover all recorded repetitions");
  const all: Trial[] = [];
  for (const model of PROJECT_MODELS)
    for (const arm of arms)
      for (let rep = 1; rep <= reps; rep++)
        for (const taskId of taskIds) {
          const identity = { model, arm, rep, taskId };
          all.push(
            records.get(key(identity)) ?? {
              batch,
              ...identity,
              status: "unrecorded",
            },
          );
        }
  const summaries = PROJECT_MODELS.flatMap((model) =>
    arms.map((arm) =>
      summarize(
        all.filter((r) => r.model === model && r.arm === arm),
        records,
      ),
    ),
  );
  const detail = all.map(taskRow),
    attempts = all.filter(measured),
    nPassed = attempts.filter((r) => r.status === "passed").length;
  const protocols = [
    ...new Set(
      [...records.values()]
        .map((r) => JSON.stringify(r.protocol))
        .filter(Boolean),
    ),
  ];
  const commits = [
      ...new Set(
        [...records.values()].map((r) => r.commitRECAST).filter(Boolean),
      ),
    ],
    jobs = [
      ...new Set(
        [...records.values()].map((r) => r.concurrency).filter(Boolean),
      ),
    ];
  const title = "项目端到端构建对照实验";
  const comparableInputs = new Map<string, Set<string>>();
  for (const r of records.values()) {
    const name = r.taskId + "/r" + r.rep;
    const versions = comparableInputs.get(name) ?? new Set<string>();
    versions.add(JSON.stringify([r.inputHash, r.gradingHash]));
    comparableInputs.set(name, versions);
  }
  const differing = [...comparableInputs.entries()]
    .filter(([, v]) => v.size > 1)
    .map(([id]) => id);
  const md = [
    "# " + title,
    "",
    "批次 `" +
      batch +
      "`，" +
      taskIds.length +
      " 个项目，" +
      reps +
      " 次计划重复，共 " +
      all.length +
      " 个组合。已有 " +
      attempts.length +
      " 次实际尝试，" +
      nPassed +
      " 次通过公开交付和外部隐藏验收。",
    "",
    ...arms.map(arm => {
      const selected=attempts.filter(r=>r.arm===arm);
      const delivered=selected.filter(r=>r.status==="passed").length;
      const correctWithoutDelivery=selected.filter(r=>r.status==="failed"&&r.grade?.passed).length;
      const budgetStops=selected.filter(r=>r.status==="failed"&&/budget|limit reached/i.test(r.error??"")).length;
      return "- `"+arm+"` 实际交付 "+delivered+"/"+selected.length+"；其中预算耗尽的失败 "+budgetStops+" 次。另按最终代码检查，"+correctWithoutDelivery+" 次通过全部隐藏测试但未完成交付。";
    }),
    "",
    "## 项目交付",
    "",
    "通过率的分母为实际尝试数。缺凭据与尚无记录分开列出。墙钟均时包含失败，验证交付均时仅汇总通过外部验收的项目。隐藏分数是获得评分的尝试内通过检查数 / 检查总数，评分数显示该分数的覆盖范围。",
    "",
    table(
      [
        "模型",
        "方案",
        "计划",
        "已尝试",
        "通过/尝试",
        "通过率",
        "缺凭据",
        "未记录",
        "评分数",
        "隐藏分数",
        "尝试均时 s",
        "验证交付均时 s",
      ],
      summaries.map((s) => [
        s.model,
        s.arm,
        s.planned,
        s.attempted,
        s.passed + "/" + s.attempted,
        pct(s.passed, s.attempted),
        s.missingCredential,
        s.unrecorded,
        s.graded,
        s.graded ? s.hiddenPassed + "/" + s.hiddenTotalGraded : "—",
        seconds(s.meanWallMs),
        seconds(s.meanVerifiedMs),
      ]),
    ),
    "",
    "## 每项任务的模型消耗",
    "",
    "Tokens/task 按该组全部实际尝试计算（含失败）：API 报告的输入与输出总和除以任务次数。缓存输入已计入输入，推理已计入输出。若有请求未返回用量，精确值留空，并单列所有尝试的已知 Token 总量 / 尝试数作为下界。输入、输出、缓存、推理分项均值使用有完整 usage 的任务，分母见“完整用量/尝试”。缺凭据或未记录项不作零消耗样本。",
    "",
    table(
      [
        "模型",
        "方案",
        "完整用量/尝试",
        "输入/项",
        "输出/项",
        "缓存输入/项",
        "推理/项",
        "Tokens/task",
        "观测均值",
      ],
      summaries.map((s) => [
        s.model,
        s.arm,
        s.usageComplete + "/" + s.attempted,
        show(s.meanInputTokens, 0),
        show(s.meanOutputTokens, 0),
        show(s.meanCachedInputTokens, 0),
        show(s.meanReasoningTokens, 0),
        show(s.tokensPerTask, 0),
        show(s.meanObservedTokensPerAttempt, 0),
      ]),
    ),
    "",
    "## 同模型对 rawagent 的配对比较",
    "",
    "同任务、同重复、相同输入与评分、RECAST 版本、驱动版本、协议及并发设置，且双方都通过外部验收，才进入配对。时间比为 raw 总验证交付时间 / 当前方案总验证交付时间；Token 比为 raw 总 Token / 当前方案总 Token，要求双方 usage 完整。比值大于 1 表示当前方案使用更少时间或 Token。先看上表通过率，再解释成功子集的比值。",
    "",
    table(
      ["模型", "方案", "时间配对数", "时间比", "Token 配对数", "Token 比"],
      summaries
        .filter((s) => s.arm !== "rawagent")
        .map((s) => [
          s.model,
          s.arm,
          s.timePairs,
          show(s.rawTimeRatio, 2),
          s.tokenPairs,
          show(s.rawTokenRatio, 2),
        ]),
    ),
    "",
    "## 逐任务结果",
    "",
    table(
      [
        "项目",
        "重复",
        "模型",
        "方案",
        "状态",
        "隐藏分数",
        "墙钟 s",
        "验证 s",
        "已观测 Token",
        "完整用量",
        "诊断",
      ],
      detail.map((d) => [
        d.task,
        d.rep,
        d.model,
        d.arm,
        d.status,
        d.graded ? d.hiddenPassed + "/" + d.hiddenTotal : "—",
        seconds(d.wallMs),
        seconds(d.timeToVerifiedMs),
        d.observedTotalTokens,
        d.usageComplete == null ? "—" : d.usageComplete ? "是" : "否",
        d.errorCategory || "—",
      ]),
    ),
    "",
    "## 计时与公平性",
    "",
    "三个方案获得相同需求、项目骨架、公开参考源码、可写模块清单和公开测试。rawagent 在单个项目级对话中自行读写、构建、测试和交付。recast 使用真实 RECAST 项目流水线与模块代理；sag2sql 额外在同一份公开参考上建 SQLite FTS5 索引并选择证据，其建库计入任务墙钟。各组对所有项目使用相同模型客户端和外部评分器；不同工具名称、模块编排和参考内容注入是方案本身的一部分。",
    "",
    "当前已记录的 " +
      comparableInputs.size +
      " 个任务/重复分组中，" +
      (differing.length
        ? "输入或评分哈希出现差异的分组为 " +
          differing.join("、") +
          "。配对比值只使用同哈希记录。"
        : "未发现输入或评分哈希差异。"),
    "",
    "从隔离快照开始计时，涵盖模型和工具调用、公开验收、Git 交付及独立隐藏评分。前置骨架物化在计时窗口外。通过要求公开构建与行为测试通过、提交成功且独立隐藏检查全部通过。隐藏标准在交付后运行，模型看不到评分脚本及结果。每任务的执行、评分、建库、工具和模型调用数据见逐任务 CSV。",
    "",
    "模型使用官方 Responses API，统一低推理档；DeepSeek V4.1 Flash 的 API ID 为 deepseek-flash。模型间 Token 计数来自各自的分词器；横跨模型的数值不能直接表示费用。任务数、重复次数、服务负载和本机并发限制了推广范围。未记录项表示在报告生成时缺少完成记录，可能仍在运行或未被选择。",
    ...(batch === "project-delivery" ? ["",
      "正式批次使用短工作目录及修复过 Windows 日志原子替换临时锁冲突的 RECAST 版本。前置 API 连通检查和受 Git 路径长度或 Windows 文件锁影响的预运行单列留存；本表统计正式项目尝试的时间与用量。每组每项目采样一次。"
    ] : []),
    "",
    "RECAST 提交为 " +
      (commits.join(", ") || "尚无记录") +
      "。记录的并发数为 " +
      (jobs.join(", ") || "—") +
      "。记录的预算为 " +
      (protocols.map((x) => "`" + x + "`").join("，") || "—") +
      "。",
    "",
    "[OpenAI 模型与接口](https://developers.openai.com/api/docs/models) · [DeepSeek 模型与接口](https://api-docs.deepseek.com/quick_start/pricing/)",
    "",
  ].join("\n");
  await mkdir(root, { recursive: true });
  const stem = join(root, "project-e2e-" + batch);
  await Promise.all([
    writeFile(stem + ".md", md),
    writeFile(stem + "-summary.csv", csv(summaries)),
    writeFile(stem + "-tasks.csv", csv(detail)),
  ]);
  return {
    planned: all.length,
    attempted: attempts.length,
    passed: nPassed,
    stem,
  };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { reps: { type: "string" } },
  });
  if (positionals.length !== 1)
    throw Error("Expected project benchmark batch name");
  console.log(
    await writeProjectReport(
      positionals[0],
      values.reps === undefined ? undefined : Number(values.reps),
    ),
  );
}
