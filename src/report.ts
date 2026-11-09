import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cpus } from "node:os";
import { writeReportPart } from "./report-output.ts";
import { modes } from "./harness.ts";
import { scenarios } from "./scenarios/index.ts";
import {
  mean,
  percentile,
  sum,
  retrievalMetrics,
  velocityMetrics,
  pair,
} from "./metrics.ts";
const batch = process.argv[2] ?? "measured";
if (!/^[a-zA-Z0-9_-]+$/.test(batch)) throw Error("Invalid batch name");
const dir = join("results", "runs", batch);
async function readRows(dir) {
  return Promise.all(
    (await readdir(dir))
      .filter((n) => n.endsWith(".json"))
      .sort()
      .map(async (n) => JSON.parse(await readFile(join(dir, n), "utf8"))),
  );
}
const data = await readRows(dir),
  velocity = pair(data.map(velocityMetrics)),
  retrieval = data.flatMap(retrievalMetrics);
const latency = (await readRows(join("results", "latency", batch)))
  .flatMap((x) => x.rows)
  .filter((x) => !x.warmup);
if (data.length !== 40 || latency.length !== 12 * (3 * 25 + 2 * 5))
  throw Error("Both complete measured matrices are required");
const localModes = [
  "standard-1hop",
  "local-sag2-1hop",
  "local-sag2-2hop",
  "sag2-1hop",
  "sag2-2hop",
];
const fmt = (x, d = 1) => (x == null ? "—" : Number(x).toFixed(d));
const pct = (x) => (x == null ? "—" : fmt(100 * x, 1) + "%");
function csv(rows) {
  const keys = Object.keys(rows[0]);
  const cell = (x) =>
    x == null ? "" : '"' + String(x).replaceAll('"', '""') + '"';
  return (
    "\uFEFF" +
    [
      keys.join(","),
      ...rows.map((r) => keys.map((k) => cell(r[k])).join(",")),
    ].join("\r\n") +
    "\r\n"
  );
}
function table(headers, rows) {
  return [
    "| " + headers.join(" | ") + " |",
    "|" + headers.map(() => "---").join("|") + "|",
    ...rows.map((r) => "| " + r.join(" | ") + " |"),
  ].join("\n");
}
const summaries = modes.map((mode) => {
  const v = velocity.filter((r) => r.mode === mode),
    a = retrieval.filter((r) => r.mode === mode);
  const avg = (k) => mean(v.map((r) => r[k])),
    quality = (k) => mean(a.map((r) => r[k]));
  return {
    mode,
    success: sum(v.map((r) => r.delivered)),
    seconds: mean(
      v.map((r) => (r.e2eDeliveryMs == null ? null : r.e2eDeliveryMs / 1000)),
    ),
    turns: avg("modelTurns"),
    tools: avg("toolCallCount"),
    input: avg("agentInputTokens"),
    judgeInput: avg("judgeInputTokens"),
    evidence: sum(v.map((r) => r.evidenceQueryCount)),
    repairs: sum(v.map((r) => r.integrationRepairCount)),
    firstCompile: avg("firstPassCompileSuccess"),
    firstTest: avg("firstPassVerifySuccess"),
    hit1: quality("anchorHit1"),
    hit4: quality("anchorHit4"),
    recall: quality("recall4"),
    all: quality("allRequiredHit4"),
    ctx: quality("contextCompleteness"),
    noise: quality("distractorRejection"),
  };
});
const speed = localModes.map((mode) => {
  const group = latency.filter((x) => x.mode === mode);
  const g = group.map((x) => x.ms);
  return {
    mode,
    n: g.length,
    p50: percentile(g, 0.5),
    p95: percentile(g, 0.95),
    judgeMean: mean(group.map((x) => x.judgeMs)),
  };
});
const comparison = ["no-history-direct", "standard-1hop"].map((mode) => {
  const pairs = velocity
    .filter((x) => x.mode === "sag2-2hop" && x.delivered)
    .map((x) => [
      x,
      velocity.find((y) => y.scenario === x.scenario && y.mode === mode),
    ])
    .filter(([x, y]) => y?.delivered);
  function paired(k) {
    const wins = pairs.filter(([x, y]) => x[k] < y[k]).length,
      n = pairs.filter(([x, y]) => x[k] !== y[k]).length;
    let coeff = 1,
      total = 0;
    for (let i = 0; i <= n; i++) {
      if (i >= wins) total += coeff;
      coeff = (coeff * (n - i)) / (i + 1);
    }
    return {
      ratio: sum(pairs.map((p) => p[1][k])) / sum(pairs.map((p) => p[0][k])),
      wins,
      n,
      p: total / 2 ** n,
    };
  }
  return {
    mode,
    pairs: pairs.length,
    time: paired("e2eDeliveryMs"),
    turns: paired("modelTurns"),
  };
});
const traces = [];
for (const id of ["s03", "s06", "s07", "s08", "s09", "s10"]) {
  const group = data.filter((r) => r.scenario.startsWith(id));
  for (const r of group.filter((r) =>
    ["standard-1hop", "sag2-2hop"].includes(r.mode),
  )) {
    const v = velocity.find(
      (x) => x.scenario === r.scenario && x.mode === r.mode,
    );
    const path = r.retrieval
      .map((x) => x.ranked.map((k) => k.id).join(" → ") || "空")
      .join("<br>");
    traces.push([
      id.toUpperCase(),
      r.mode,
      path,
      r.retrieval.map((x) => x.diagnostics?.hopsExecuted ?? 1).join("/"),
      v.modelTurns,
      v.compileAttempts + "/" + v.testAttempts,
      fmt(v.e2eDeliveryMs / 1000),
    ]);
  }
}
const scale = data.find((r) => r.scenario.startsWith("s10")),
  stress = speed.map((y) => {
    const g = latency
      .filter((x) => x.scenario.startsWith("s10") && x.mode === y.mode)
      .map((x) => x.ms);
    return [
      y.mode,
      g.length,
      fmt(percentile(g, 0.5), 2),
      fmt(percentile(g, 0.95), 2),
    ];
  });
const observedBridge = retrieval.filter((x) => x.hop2Discovery != null);
const row = (id, mode) =>
  velocity.find((r) => r.scenario.startsWith(id + "-") && r.mode === mode);
const s03base = row("s03", "standard-1hop"),
  s03feat = row("s03", "sag2-2hop");
const falseAnchors = data
  .filter(
    (r) =>
      r.mode === "sag2-2hop" &&
      r.retrieval.some((t) => t.ranked[0]?.id.startsWith("display-")),
  )
  .map((r) => r.scenario.slice(0, 3).toUpperCase());
const groups = summaries.map((r) => [
  r.mode,
  r.success + "/10",
  fmt(r.seconds),
  fmt(r.turns),
  fmt(r.tools),
  pct(r.firstCompile),
  pct(r.firstTest),
  r.evidence,
  r.repairs,
]);
const intro =
  "本轮覆盖 10 套场景、12 个模块查询、40 次独立项目交付。共 " +
  sum(summaries.map((x) => x.success)) +
  " 次通过固定行为验收并提交 Git。";
const full = summaries.at(-1),
  std = summaries[1];
const original = await readRows("results/runs/s06-original").catch(() => []);
const setupNotes = original.length
  ? "S06 预实验中，中英词面差异使三个检索模式都返回空候选，无法观测结构边。随后给历史锚点的业务说明补上查询中已有的中文职责，保持协作者和调用边原样，四组全部重跑。原始四条轨迹单独保存在 results/runs/s06-original，不计入汇总。"
  : "";
const report = [
  "# RECAST 检索与开发速度实测",
  "",
  intro,
  "",
  "在线 SAG2 两跳的检索 P50 为 " +
    fmt(speed.at(-1).p50, 0) +
    " ms，传统单跳为 " +
    fmt(speed[0].p50, 2) +
    " ms。必需模块 Recall@4 从 " +
    pct(std.recall) +
    " 变为 " +
    pct(full.recall) +
    "。相对于传统单跳，配对总交付时间比为 " +
    fmt(comparison[1].time.ratio, 2) +
    "×（基线 / 两跳，超过 1 表示两跳更快）。",
  "",
  "## 检索耗时",
  "",
  "同一预建索引上串行轮换模式。每个查询各模式预热 1 次并剔除；生产单跳与本地结构裁决各测 25 次，在线裁决各测 5 次。单位为毫秒。百分位采用最近秩，汇总 12 个模块查询。local 使用 RECAST 自带 StructuralSag2JevJudge；在线 SAG2 包含到 OpenAI Decisions API 的网络往返。",
  "",
  table(
    ["模式", "样本", "P50 ms", "P95 ms", "平均裁决往返 ms"],
    speed.map((x) => [
      x.mode,
      x.n,
      fmt(x.p50, 2),
      fmt(x.p95, 2),
      x.mode.startsWith("sag2") ? fmt(x.judgeMean, 2) : "—",
    ]),
  ),
  "",
  "## 检索质量",
  "",
  "目标锚点由场景标注，Recall@4 为每个查询所需模块的命中比例，全部命中率要求所有必需模块同时进入前四；上下文实际装入前三份候选。诱饵剔除率表示 Top-4 无已标注诱饵的查询占比。",
  "",
  table(
    [
      "模式",
      "锚点 Hit@1",
      "锚点 Hit@4",
      "Recall@4",
      "全部命中率",
      "初始上下文覆盖",
      "诱饵剔除率",
    ],
    summaries.map((x) => [
      x.mode,
      pct(x.hit1),
      pct(x.hit4),
      pct(x.recall),
      pct(x.all),
      pct(x.ctx),
      pct(x.noise),
    ]),
  ),
  "",
  "三个指定桥接场景中，" +
    observedBridge.filter((x) => x.hop2Discovery === 1).length +
    "/" +
    observedBridge.length +
    " 个协作者同时满足二跳首次发现和进入初始上下文。S01 的早停实测为 " +
    (retrieval.find((x) => x.earlyExit != null)?.earlyExit ? "1/1" : "0/1") +
    "。",
  "",
  "## 开发速度",
  "",
  "每个场景、每种模式各运行一次 GPT-6 Luna 工作 Agent，场景间最多四路并发。墙钟从流水线启动计至验收及独立 Git 提交，含快照、检索和上下文准备。均值按项目计算，补查与集成修复列为合计。一次通过要求该项目所有模块的第一次对应检查通过。",
  "",
  table(
    [
      "模式",
      "交付",
      "均时 s",
      "平均轮数",
      "平均工具调用",
      "首次编译",
      "首次行为测试",
      "补查",
      "集成修复",
    ],
    groups,
  ),
  "",
  "同场景配对比率用基线总量除以两跳总量。胜场只计两跳数值严格更低的场景，平局从单侧精确符号检验剔除。时间检验与轮数检验分别列出。",
  "",
  table(
    [
      "对照",
      "配对数",
      "时间比",
      "时间胜/非平",
      "时间 p",
      "轮数比",
      "轮数胜/非平",
      "轮数 p",
    ],
    comparison.map((c) => [
      c.mode,
      c.pairs,
      fmt(c.time.ratio, 2),
      c.time.wins + "/" + c.time.n,
      fmt(c.time.p, 3),
      fmt(c.turns.ratio, 2),
      c.turns.wins + "/" + c.turns.n,
      fmt(c.turns.p, 3),
    ]),
  ),
  "",
  "任务板提出的开发提速假设" +
    (comparison.every((c) => c.time.p < 0.05 && c.turns.p < 0.05)
      ? "在两项配对检验中均达到 p<0.05。"
      : "未达到对两条基线均有显著改善的门槛。") +
    " 两跳每项目平均 " +
    fmt(full.turns) +
    " 轮、" +
    fmt(full.seconds) +
    " 秒；传统单跳为 " +
    fmt(std.turns) +
    " 轮、" +
    fmt(std.seconds) +
    " 秒。固定行为契约足以独立实现这些小任务。",
  "",
  "## 逐场景交付时间",
  "",
  "单位为秒。各场景的工具次数、Token、编译次数、阶段耗时和配对压缩比见 velocity-summary.csv。",
  "",
  table(
    ["场景", ...modes],
    scenarios.map((s) => [
      s.id,
      ...modes.map((m) => {
        const ms = velocity.find(
          (x) => x.scenario === s.id && x.mode === m,
        )?.e2eDeliveryMs;
        return ms == null ? "未交付" : fmt(ms / 1000);
      }),
    ]),
  ),
  "",
  "## 检索轨迹与下游返工",
  "",
  "候选按优先级排列。前三份进入翻译上下文。S09 按三个模块分别列出候选和跳数。",
  "",
  table(
    ["场景", "模式", "前四候选", "跳数", "模型轮数", "编译/测试", "交付 s"],
    traces,
  ),
  "",
  "S03 标准单跳补查 " +
    s03base.evidenceQueryCount +
    " 次，使用 " +
    s03base.modelTurns +
    " 轮；两跳补查 " +
    s03feat.evidenceQueryCount +
    " 次，使用 " +
    s03feat.modelTurns +
    " 轮。两跳减单跳的交付时间差为 " +
    fmt((s03feat.e2eDeliveryMs - s03base.e2eDeliveryMs) / 1000) +
    " 秒。两跳将展示类诱饵排至首位的场景为 " +
    (falseAnchors.join("、") || "无") +
    "。S09 四组共触发 " +
    sum(modes.map((m) => row("s09", m).integrationRepairCount)) +
    " 次项目集成修复。S10 四组按表中模式顺序分别执行 " +
    modes.map((m) => row("s10", m).testAttempts).join(" / ") +
    " 次模块行为测试。",
  "",
  "## S10 规模与延迟",
  "",
  "该资产库有 " +
    scale.catalog[0].modules +
    " 个模块、" +
    scale.catalog[0].documents +
    " 条索引文档。",
  "",
  "" + table(["模式", "样本", "P50 ms", "P95 ms"], stress),
  "",
  "S10 在线两跳 P95 " +
    (Number(stress.at(-1)[3]) < 50 ? "达到" : "超过") +
    "任务板的 50 ms 门槛。S01 在线两跳的 " +
    latency.filter(
      (r) => r.scenario.startsWith("s01") && r.mode === "sag2-2hop" && r.ms < 5,
    ).length +
    "/5 次计时低于 5 ms。",
  "",
  "## 复现条件与适用范围",
  "",
  "RECAST 提交 `" +
    data[0].commit +
    "`，Windows " +
    process.arch +
    "，" +
    cpus()[0].model +
    "，Node " +
    data[0].node +
    "。场景使用随 benchmark 生成的 TS/Python 历史源码、固定模块提案、JS 目标骨架和独立验收脚本。项目分析、FTS5、检索、翻译工具、编译、验收与 Git 均通过 RECAST 运行。四组共享同一 feat 提交与相同源数据；standard 调用产品的 searchModules。历史索引构建在计时窗口外。",
  "",
  "在线两跳的费用与延迟包含 JEV 裁决。no-history-direct 跳过历史检索，提交 direct-translator 标记。该版本 WorkspaceTranslationRuntime 对所有新任务均先调用 Analyzer，实测轮数含该阶段。每个项目平均工作 Agent 输入 Token 依模式顺序为 " +
    summaries.map((x) => fmt(x.input, 0)).join(" / ") +
    "；裁决输入 Token 为 " +
    summaries.map((x) => fmt(x.judgeInput, 0)).join(" / ") +
    "。Token 来自 API usage，包含缓存输入。固定行为协议对四组可见。一次开发运行无法估计同场景模型波动或覆盖生产需求分布，耗时代表本机和本次服务负载。",
  "",
  setupNotes,
  "",
  "[OpenAI Decisions API 接口说明](https://developers.openai.com/api/reference/resources/decisions/methods/create)",
  "",
].join("\n");
await mkdir("results", { recursive: true });
await writeFile("results/velocity-summary.csv", csv(velocity));
await writeFile("results/retrieval-summary.csv", csv(retrieval));
await writeFile(
  "results/latency-samples.csv",
  csv(latency.map(({ ranked, ...r }) => ({ ...r, ranked: ranked.join("|") }))),
);
await writeFile(
  "results/latest-report.json",
  JSON.stringify(
    { batch, summaries, speed, comparison, velocity, retrieval, runs: data },
    null,
    2,
  ),
);
await writeReportPart("development", report);
console.log(intro, comparison);
