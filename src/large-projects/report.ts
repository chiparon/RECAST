import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  PROJECT_MODELS,
  type ProjectModel,
} from "../project-bench/providers.ts";
import { RATE_CARD, priceRequests } from "./billing.ts";
import {
  costTotal,
  loadPilot,
  loadSetup,
  type CostRun,
} from "./report-costs.ts";
import { arms, batchName, type Arm } from "./protocol.ts";
import type { MeterCall } from "./meter.ts";

type Verdict = { id: string; passed: boolean };
interface Control {
  taskId: string;
  title: string;
  upstream: { url: string; commit: string };
  inputHash: string;
  files: number;
  physicalLines: number;
  readableLines: number;
  readFiles: number;
  referenceFiles: number;
  languages: Record<string, { physical: number }>;
  writable: string[];
  controls: { variant: string; checks: Verdict[] }[];
}
interface Row {
  id: string;
  task: string;
  arm: Arm;
  model: ProjectModel;
  inputHash: string;
  passed: boolean;
  commit: string | null;
  error: string | null;
  gradingError: string | null;
  wallMs: number;
  indexMs: number | null;
  readiness?: { attempts: number; waitMs: number; status: number };
  calls: MeterCall[];
  grade: { checks: Verdict[]; integrityErrors: string[] } | null;
  usage: { totalTokens: number; requests: number; usageComplete: boolean };
  price: ReturnType<typeof priceRequests>;
  balanceChange: {
    from: string;
    to: string;
    totalRmb: number | null;
    toppedUpRmb: number | null;
    grantedRmb: number | null;
    error: string | null;
  } | null;
  harness: {
    version?: string;
    status?: string;
    providerTools?: string[];
    suppressedNativeTools?: string[];
  } | null;
  indexFiles: string[] | null;
}
interface Bundle {
  batch: string;
  protocol: { implementationHash: string; productRevision: string };
  controls: Control[];
  rows: Row[];
  wallets?: {
    cells: string[];
    closing: NonNullable<Row["balanceChange"]>;
    after30s: NonNullable<Row["balanceChange"]>;
  }[];
}
type Table = { headers: string[]; rows: string[][] };
interface Section {
  id: string;
  title: string;
  paragraphs?: string[];
  tables?: Table[];
}
const labels: Record<Arm, string> = {
  rawagent: "rawagent",
  recast: "RECAST",
  sag2sql: "SAG2-SQLite",
  codex: "Codex CLI",
};
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const num = (n: number, d = 0) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fmtMoney = (n: number) =>
  Math.abs(n) > 0 && Math.abs(n) < 0.00005 ? n.toPrecision(2) : num(n, 4);
const money = (lo: number, hi: number | null) =>
  hi === null
    ? "≥" + fmtMoney(lo)
    : lo === hi
      ? fmtMoney(lo)
      : fmtMoney(lo) + "–" + fmtMoney(hi);

function summarize(rows: Row[]) {
  const attempts = rows.length,
    successes = rows.filter((r) => r.passed).length;
  const millis = sum(rows.map((r) => r.wallMs)),
    tokens = sum(rows.map((r) => r.usage.totalTokens));
  const lower = sum(rows.map((r) => r.price.knownRmb));
  const upper = rows.every((r) => r.price.upperRmb !== null)
    ? sum(rows.map((r) => r.price.upperRmb!))
    : null;
  const balance = rows.flatMap((r) =>
    r.balanceChange?.totalRmb == null ? [] : [r.balanceChange.totalRmb],
  );
  return {
    attempts,
    successes,
    failures: attempts - successes,
    passRate: successes / attempts,
    meanSeconds: millis / attempts / 1000,
    deliveredPerHour: (successes * 3600000) / millis,
    tokens,
    meanTokens: tokens / attempts,
    missingUsageCalls: rows.flatMap((r) => r.calls).filter((c) => !c.usage)
      .length,
    lowerRmb: lower,
    upperRmb: upper,
    meanLowerRmb: lower / attempts,
    meanUpperRmb: upper === null ? null : upper / attempts,
    rangedPriceCalls: sum(rows.map((r) => r.price.estimatedCalls)),
    unpricedCalls: sum(rows.map((r) => r.price.unpricedCalls)),
    balanceWindows: balance.length,
    accountNetDebitRmb: balance.length ? sum(balance) : null,
  };
}

function metricTable(groups: { name: string; rows: Row[] }[]): Table {
  return {
    headers: [
      "方法 / 模型",
      "交付通过",
      "平均秒/任务",
      "tokens/task",
      "公开价 ¥/任务",
      "串行交付/小时",
    ],
    rows: groups.map((g) => {
      const s = summarize(g.rows);
      return [
        g.name,
        s.successes + "/" + s.attempts + " · " + num(s.passRate * 100, 1) + "%",
        num(s.meanSeconds, 1),
        (s.missingUsageCalls ? "≥" : "") + num(s.meanTokens),
        money(s.meanLowerRmb, s.meanUpperRmb),
        num(s.deliveredPerHour, 1),
      ];
    }),
  };
}
function diagnosis(r: Row) {
  if (r.passed) return "通过";
  const reasons: string[] = [];
  if (!r.calls.length) reasons.push("首次模型请求前终止");
  const serviceError = r.calls.filter((c) => c.status === "error").at(-1);
  if (serviceError?.httpStatus && r.error)
    reasons.push("模型服务 HTTP " + serviceError.httpStatus);
  const failures = r.grade?.checks.filter((c) => !c.passed).map((c) => c.id);
  if (failures?.length) reasons.push("未通过 " + failures.join("、"));
  if (r.grade?.integrityErrors.length) reasons.push("交付完整性检查失败");
  if (!r.commit) reasons.push("缺少交付提交");
  if (r.error || r.gradingError) {
    const first = String(r.gradingError ?? r.error)
      .split(/\r?\n/)[0]
      .replace(/sk-[^\s"']+/g, "[redacted]");
    reasons.push(first.slice(0, 180));
  }
  return reasons.join("。") || "外部验收失败";
}
function paired(rows: Row[], a: Arm, b: Arm) {
  const items = rows
    .filter((r) => r.arm === a)
    .map((x) => [
      x,
      rows.find(
        (y) => y.task === x.task && y.model === x.model && y.arm === b,
      )!,
    ]);
  const both = items.filter(([x, y]) => x.passed && y.passed),
    n = both.length;
  const lower = both.every(([, y]) => y.price.upperRmb !== null)
    ? sum(both.map(([x, y]) => x.price.knownRmb - y.price.upperRmb!)) / n
    : null;
  const upper = both.every(([x]) => x.price.upperRmb !== null)
    ? sum(both.map(([x, y]) => x.price.upperRmb! - y.price.knownRmb)) / n
    : null;
  const complete = both.filter(
    ([x, y]) => x.usage.usageComplete && y.usage.usageComplete,
  );
  return [
    labels[a] + " / " + labels[b],
    String(items.length),
    String(items.filter(([x, y]) => x.passed && !y.passed).length),
    String(items.filter(([x, y]) => !x.passed && y.passed).length),
    String(n),
    n
      ? num(sum(both.map(([x, y]) => (x.wallMs - y.wallMs) / 1000)) / n, 1)
      : "—",
    complete.length
      ? num(
          sum(
            complete.map(([x, y]) => x.usage.totalTokens - y.usage.totalTokens),
          ) / complete.length,
        ) +
        " (" +
        complete.length +
        ")"
      : "—",
    n && lower !== null && upper !== null ? money(lower, upper) : "—",
  ];
}
function csv<T extends object>(rows: T[]) {
  const keys = Object.keys(rows[0]) as (keyof T)[];
  const quote = (v: unknown) =>
    '"' + String(v ?? "").replaceAll('"', '""') + '"';
  return (
    [
      keys.join(","),
      ...rows.map((row) => keys.map((key) => quote(row[key])).join(",")),
    ].join("\r\n") + "\r\n"
  );
}
const { values } = parseArgs({
  options: { batch: { type: "string", default: batchName } },
});
const batch = values.batch!;
assert(/^[\w-]+$/.test(batch));
const prefix = resolve("results", batch),
  evidence = prefix + "-evidence.json.gz";
const {
  rows,
  controls,
  protocol,
  wallets = [],
  ...meta
}: Bundle = JSON.parse(gunzipSync(await readFile(evidence)).toString("utf8"));
assert.equal(meta.batch, batch);
const keys = controls.flatMap((c) =>
  PROJECT_MODELS.flatMap((m) => arms.map((a) => [c.taskId, m, a].join("_"))),
);
assert.deepEqual(
  rows.map((r) => r.id).sort(),
  keys.sort(),
  "Incomplete or duplicate evidence",
);
for (const r of rows) {
  assert.equal(
    r.inputHash,
    controls.find((c) => c.taskId === r.task)!.inputHash,
  );
  assert.deepEqual(priceRequests(r.calls), r.price);
}
const overall = summarize(rows),
  byArm = arms.map((arm) => ({
    name: labels[arm],
    rows: rows.filter((r) => r.arm === arm),
  }));
const byModel = PROJECT_MODELS.flatMap((model) =>
  arms.map((arm) => ({
    name: model + " / " + labels[arm],
    rows: rows.filter((r) => r.model === model && r.arm === arm),
  })),
);
const title = "十万行级多语言项目交付基准";
const currencyMethod =
  "本批固定 " +
  RATE_CARD.asOf +
  " 的公开价，按每次请求回传的输入、缓存、输出和服务层级计价。美元按当日国家外汇管理局中间价 1 USD = " +
  RATE_CARD.usdToRmb +
  " CNY 折算，DeepSeek 使用人民币钱包价格。";
const allDeep = rows.filter((r) => r.model === "deepseek-flash");
const deepRequests = allDeep.flatMap((r) => r.price.requests);
const openaiLong = rows
  .filter((r) => r.model !== "deepseek-flash")
  .flatMap((r) => r.calls)
  .filter(
    (c) => c.usage && c.usage.inputTokens > RATE_CARD.openaiLongThreshold,
  ).length;
const realWindows = allDeep.filter((r) => r.balanceChange?.totalRmb != null);
const deepSum = summarize(allDeep);
if (batch === "large-v3")
  assert.deepEqual(
    wallets.flatMap((w) => w.cells).sort(),
    allDeep.map((r) => r.id).sort(),
    "DeepSeek batch wallet coverage mismatch",
  );
const intervals = realWindows
  .map((r) => r.balanceChange!)
  .sort((a, b) => a.from.localeCompare(b.from));
const overlap = intervals.some((w, i) => i > 0 && intervals[i - 1].to > w.from);
const windowsTotal = realWindows.length
  ? fmtMoney(sum(realWindows.map((r) => r.balanceChange!.totalRmb!)))
  : "—";
const versions = [
  ...new Set(
    rows.flatMap((r) => (r.harness?.version ? [r.harness.version] : [])),
  ),
];
const codexRows = rows.filter((r) => r.arm === "codex");
const codexStats = summarize(codexRows),
  rawStats = summarize(rows.filter((r) => r.arm === "rawagent"));
const onlyDelivered = (a: Arm, b: Arm) =>
  rows
    .filter(
      (r) =>
        r.arm === a &&
        r.passed &&
        !rows.some(
          (other) =>
            other.arm === b &&
            other.task === r.task &&
            other.model === r.model &&
            other.passed,
        ),
    )
    .map((r) => r.task + " / " + r.model)
    .join("、") || "无";
const upstream = controls[0].upstream;
const sections: Section[] = [
  {
    id: "delivery",
    title: "交付表现",
    paragraphs: [
      "冻结仓库 " +
        upstream.url.replace(/\.git$/, "") +
        "，版本 " +
        upstream.commit +
        "。正式批次覆盖 " +
        controls.length +
        " 项需求、" +
        PROJECT_MODELS.length +
        " 个模型和 " +
        arms.length +
        " 种方法，每格一次。",
      "交付成功要求得到 Git 提交并通过公开构建、项目测试、外部行为验收及完整性检查。用时为方法启动至外部验收完成的墙钟秒数，包含索引、重试和试验内的网络恢复等待。环境准备、试验前连续两次模型目录连通性检查和余额查询都在计时区间之外。平均指标以全部尝试为分母。串行交付/小时以通过次数除以该组全部尝试的累计用时。",
    ],
    tables: [
      metricTable(byArm),
      {
        headers: ["任务", ...arms.map((a) => labels[a] + " 通过")],
        rows: controls.map((c) => [
          c.title,
          ...arms.map((arm) => {
            const trials = rows.filter(
              (r) => r.task === c.taskId && r.arm === arm,
            );
            return trials.filter((r) => r.passed).length + "/" + trials.length;
          }),
        ]),
      },
    ],
  },
  {
    id: "models",
    title: "同模型比较",
    paragraphs: [
      "三组模型请求 ID 为 gpt-6-luna、gpt-6.1-sol 和 deepseek-flash。DeepSeek 在本批运行时将 deepseek-flash 映射至 V4.1-Flash-1017。",
    ],
    tables: [metricTable(byModel)],
  },
  {
    id: "codex",
    title: "Codex harness 与配对结果",
    paragraphs: [
      "Codex CLI 版本 " +
        (versions.join("、") || "未记录") +
        "，按供应商 API key 使用与其他方法相同的三个模型。Codex CLI 自主完成一次项目任务，使用基准配置的读写与公开检查工具。该配置限制原生 shell、联网及工作区外读写。",
      "Codex CLI 完成交付 " +
        codexStats.successes +
        "/" +
        codexStats.attempts +
        " 次，rawagent 完成 " +
        rawStats.successes +
        "/" +
        rawStats.attempts +
        " 次。rawagent 在单个模型会话中自主使用项目工具。RECAST 按模块调度分析、实现和验证。SAG2-SQLite 在同一流水线中加入冷建 SQLite 检索。",
      "在 Codex CLI 与 rawagent 的配对中，仅 Codex CLI 通过的组合为「" +
        onlyDelivered("codex", "rawagent") +
        "」，仅 rawagent 通过的组合为「" +
        onlyDelivered("rawagent", "codex") +
        "」。",
      "配对的差值均按左侧减右侧。同一模型同一需求的两种方法都通过时才计算用时与费用差。Token 差还要求双方用量完整，括号内为计入配对数。",
    ],
    tables: [
      {
        headers: [
          "方法 / 对照",
          "配对",
          "仅左侧通过",
          "仅右侧通过",
          "均通过",
          "平均秒差",
          "平均 Token 差",
          "平均公开价 ¥ 差",
        ],
        rows: [
          paired(rows, "codex", "rawagent"),
          paired(rows, "recast", "rawagent"),
          paired(rows, "sag2sql", "recast"),
        ],
      },
    ],
  },
  {
    id: "charges",
    title: "人民币费用核对",
    paragraphs: [
      currencyMethod,
      "正式批次已观测到 " +
        num(openaiLong) +
        " 次 OpenAI 请求达到长上下文费率。可归类的 DeepSeek 请求有 " +
        num(deepRequests.filter((r) => r.tariff === "off-peak").length) +
        " 次空闲、" +
        num(deepRequests.filter((r) => r.tariff === "peak").length) +
        " 次高峰。",
      "下表以百万 Token 为单位。OpenAI 单次输入超过 272,000 Token 时，整次请求的输入及缓存单价乘 2、输出乘 1.5。推理 Token 已包含在输出中。DeepSeek 按请求开始时的北京时间选择费率，周一至周五 09:00–12:00、14:00–18:00 为高峰，周末及中国法定节假日全天为空闲时段。",
      "正式批次共有 " +
        num(rows.flatMap((r) => r.calls).length) +
        " 次 HTTP 尝试，报告 " +
        num(overall.tokens) +
        " tokens。公开价合计 ¥" +
        money(overall.lowerRmb, overall.upperRmb) +
        "。缺少用量的尝试 " +
        overall.missingUsageCalls +
        " 次，价目分项有界估算 " +
        overall.rangedPriceCalls +
        " 次，无法上界定价 " +
        overall.unpricedCalls +
        " 次。",
      "DeepSeek 的 " +
        realWindows.length +
        "/" +
        allDeep.length +
        " 个任务有实际账户窗口余额差，合计 ¥" +
        windowsTotal +
        "，对应 DeepSeek 全部任务的公开价为 ¥" +
        money(deepSum.lowerRmb, deepSum.upperRmb) +
        "。金额使用开始余额减去结束余额，仅导出差值。" +
        (overlap
          ? "存在时间重叠的窗口，合计可能重复观察相同扣款。"
          : "有记录的窗口互不重叠。") +
        " 同账户其他流量、充值或延迟入账都可能影响差额。",
      "OpenAI 组织 Costs API 对现有项目密钥返回 HTTP 403。OpenAI 的逐任务费用来自公开价重算。缓存分项缺失时按可行单价给出上下界，若某次请求缺少总用量则只给出下界。表格显示到 4 位小数。",
      "DeepSeek 的整段账户窗口从同一份期初余额分别计算运行结束时和约 30 秒后的累计净扣减。任务即时窗口与这两个累计读数覆盖相同活动，各自单列比较。延后读数也可能包含共享账户的其他交易。",
    ],
    tables: [
      {
        headers: [
          "每百万 Token 单价",
          "币种",
          "未缓存输入",
          "缓存读取",
          "写入 30 分钟",
          "写入 12 小时",
          "输出",
        ],
        rows: [
          ...Object.entries(RATE_CARD.openaiStandardUsdPerMillion).map(
            ([name, r]) => [
              name + " · 标准短上下文",
              "USD",
              String(r.input),
              String(r.read),
              String(r.input * RATE_CARD.openaiWrite30mMultiplier),
              String(r.input * RATE_CARD.openaiWrite12hMultiplier),
              String(r.output),
            ],
          ),
          ...[1, RATE_CARD.deepSeekPeakMultiplier].map((k) => {
            const r = RATE_CARD.deepSeekOffPeakRmbPerMillion;
            return [
              "deepseek-flash · " + (k === 1 ? "空闲" : "高峰"),
              "CNY",
              String(r.input * k),
              String(r.read * k),
              "—",
              "—",
              String(r.output * k),
            ];
          }),
        ],
      },
      {
        headers: [
          "方法",
          "公开价合计 ¥",
          "公开价 ¥/任务",
          "DeepSeek 已观测窗口",
          "DeepSeek 窗口净扣减合计 ¥",
          "充值余额扣减 ¥",
          "赠送余额扣减 ¥",
        ],
        rows: byArm.map((group) => {
          const s = summarize(group.rows),
            deep = group.rows.filter((r) => r.model === "deepseek-flash");
          const observations = deep.filter(
            (r) => r.balanceChange?.totalRmb != null,
          );
          return [
            group.name,
            money(s.lowerRmb, s.upperRmb),
            money(s.meanLowerRmb, s.meanUpperRmb),
            observations.length + "/" + deep.length,
            s.accountNetDebitRmb === null
              ? "—"
              : fmtMoney(s.accountNetDebitRmb),
            ...(["toppedUpRmb", "grantedRmb"] as const).map((k) =>
              observations.length
                ? fmtMoney(sum(observations.map((r) => r.balanceChange![k]!)))
                : "—",
            ),
          ];
        }),
      },
      ...(wallets.length
        ? [
            {
              headers: [
                "整段窗口（UTC）",
                "所含任务",
                "这些任务的公开价 ¥",
                "任务即时窗口净扣减合计 ¥",
                "截至结束净扣减 ¥",
                "延后 30 秒净扣减 ¥",
                "延后充值/赠送扣减 ¥",
                "余额查询",
              ],
              rows: wallets.map((w) => {
                const selected = allDeep.filter((r) => w.cells.includes(r.id)),
                  stats = summarize(selected);
                const display = (v: number | null) =>
                  v === null ? "—" : fmtMoney(v);
                return [
                  w.closing.from + " ～ " + w.closing.to,
                  String(selected.length),
                  money(stats.lowerRmb, stats.upperRmb),
                  display(stats.accountNetDebitRmb) +
                    " (" +
                    stats.balanceWindows +
                    "/" +
                    selected.length +
                    ")",
                  display(w.closing.totalRmb),
                  display(w.after30s.totalRmb),
                  display(w.after30s.toppedUpRmb) +
                    " / " +
                    display(w.after30s.grantedRmb),
                  [w.closing.error, w.after30s.error]
                    .filter(Boolean)
                    .join("。") || "两次均返回",
                ];
              }),
            },
          ]
        : []),
    ],
  },
  {
    id: "inputs",
    title: "任务规模与冻结输入",
    paragraphs: [
      "每种方法使用相同的起始源码、项目需求、模块清单、受控可读文件、可写范围及验收。规模分别统计每个骨架的生产源码物理行和实际工具可读源码行。重复使用同一仓库的各题分别计数。模型请求没有任务累计 Token 或费用上限。",
      "各题在固定的 Django 工程内恢复一种后台功能，每题开放两个或三个 Python、JavaScript 生产文件。每种模型和方法每题只运行一次。通过率和均值描述本批需求与工具配置。",
    ],
    tables: [
      {
        headers: [
          "任务",
          "生产源码行",
          "工具可读源码行",
          "冻结/可读文件",
          "可写模块",
          "生产语言（行）",
          "骨架/参考验收",
        ],
        rows: controls.map((c) => {
          const grade = (name: string) => {
            const b = c.controls.find((v) => v.variant === name);
            return b
              ? b.checks.filter((v) => v.passed).length + "/" + b.checks.length
              : "—";
          };
          return [
            c.title,
            num(c.physicalLines),
            num(c.readableLines),
            c.files + " / " + c.readFiles,
            c.writable.join("、"),
            Object.entries(c.languages)
              .map(([lang, stat]) => lang + " " + num(stat.physical))
              .join("、"),
            grade("starter") + " / " + grade("golden"),
          ];
        }),
      },
    ],
  },
  {
    id: "trials",
    title: "逐任务记录",
    tables: controls.map((c) => ({
      headers: [
        c.taskId,
        "模型",
        "交付",
        "秒",
        "tokens/task",
        "公开价 ¥",
        "DeepSeek 窗口 ¥",
        "验收结果",
      ],
      rows: PROJECT_MODELS.flatMap((model) =>
        arms.map((arm) => {
          const r = rows.find(
            (t) => t.task === c.taskId && t.model === model && t.arm === arm,
          )!;
          return [
            labels[arm],
            model,
            r.passed ? "通过" : "失败",
            num(r.wallMs / 1000, 1),
            (r.usage.usageComplete ? "" : "≥") + num(r.usage.totalTokens),
            money(r.price.knownRmb, r.price.upperRmb),
            r.balanceChange?.totalRmb != null
              ? fmtMoney(r.balanceChange.totalRmb)
              : "—",
            diagnosis(r),
          ];
        }),
      ),
    })),
  },
];
if (batch === "large-v3") {
  const [pilot, network, setup] = await Promise.all([
    loadPilot(),
    loadPilot("large-v2"),
    loadSetup(),
  ]);
  const phases: { name: string; runs: CostRun[] }[] = [
    { name: "正式评测 " + batch, runs: rows },
  ];
  if (pilot) phases.push({ name: "宿主故障先导 large-v1", runs: pilot.runs });
  if (network)
    phases.push({ name: "网络异常批次 large-v2", runs: network.runs });
  if (setup) phases.push({ name: "接入与工具预检", runs: setup.runs });
  const all = costTotal(phases.flatMap((phase) => phase.runs));
  sections.splice(
    sections.findIndex((s) => s.id === "inputs"),
    0,
    {
      id: "extra-costs",
      title: "本次搭建与测量支出",
      paragraphs: [
        "正式结果的通过率、用时和 ¥/任务仅采用 " +
          batch +
          "。large-v1 在 Windows 文件替换报错后停止派发。large-v2 在两家模型接口出现连接故障后停止派发。两个批次均保留当时已启动任务的最终记录。预检包括接入连通性和 Codex 工具调用。" +
          (!pilot ? " 先导账本未提供。" : "") +
          (!network ? " 网络批次账本未提供。" : "") +
          (!setup ? " 接入账本未提供。" : ""),
        ...(network
          ? [
              "网络异常批次共 " +
                network.runs.length +
                " 次终态尝试，其中 " +
                network.runs.filter((r) => r.passed === true).length +
                " 次通过，" +
                network.runs.filter(
                  (r) => r.failureReason === "provider transport",
                ).length +
                " 次记录了传输终止原因。" +
                network.runs.filter(
                  (r) => !r.calls.some((c) => Boolean(c.usage)),
                ).length +
                " 次尝试没有任何用量回传，" +
                network.runs.filter(
                  (r) =>
                    r.calls.some((c) => c.usage) &&
                    r.calls.some((c) => !c.usage),
                ).length +
                " 次尝试只收到了部分请求的用量。",
            ]
          : []),
        ...(network?.wallets?.map(
          (w) =>
            "large-v2 的整段 DeepSeek 账户观察覆盖 " +
            w.cells.length +
            " 个任务。运行结束时净扣减 " +
            (w.closing.totalRmb == null
              ? "缺测"
              : "¥" + fmtMoney(w.closing.totalRmb)) +
            "，延后 30 秒为 " +
            (w.after30s.totalRmb == null
              ? "缺测"
              : "¥" + fmtMoney(w.after30s.totalRmb)) +
            "。",
        ) ?? []),
        "上述各阶段已记录费用对应 " +
          num(all.requests) +
          " 次请求和 " +
          num(all.tokens) +
          " 个已报告 Token，公开价总计" +
          (all.upperRmb === null
            ? "至少 ¥" + fmtMoney(all.lowerRmb)
            : " ¥" + money(all.lowerRmb, all.upperRmb)) +
          "。账户栏仅汇总有开始和结束快照的 DeepSeek 窗口。",
      ],
      tables: [
        {
          headers: [
            "阶段",
            "已记录运行",
            "HTTP 尝试",
            "无用量回传",
            "已报告 tokens",
            "公开价合计 ¥",
            "余额窗口数",
            "窗口净扣减合计 ¥",
          ],
          rows: phases.map((phase) => {
            const s = costTotal(phase.runs);
            return [
              phase.name,
              num(s.runs),
              num(s.requests),
              num(s.missingUsage),
              (s.missingUsage ? "≥" : "") + num(s.tokens),
              money(s.lowerRmb, s.upperRmb),
              num(s.balanceWindows),
              s.walletRmb == null ? "—" : fmtMoney(s.walletRmb),
            ];
          }),
        },
      ],
    },
  );
}
const links = [
  [
    "固定上游版本",
    upstream.url.replace(/\.git$/, "") + "/tree/" + upstream.commit,
  ],
  ["OpenAI 全球价目表", RATE_CARD.openaiPrices],
  ["OpenAI 缓存计费规则", RATE_CARD.openaiCache],
  ["OpenAI Costs API", RATE_CARD.openaiCosts],
  ["DeepSeek 人民币价目表", RATE_CARD.deepSeekPrices],
  ["DeepSeek 余额接口", RATE_CARD.deepSeekBalance],
  ["国家外汇管理局当日人民币中间价", RATE_CARD.fxSource],
];
function mdTable(t: Table) {
  const line = (cells: string[]) =>
    "| " +
    cells
      .map((s) => s.replaceAll("|", "\\|").replace(/[\r\n]+/g, " "))
      .join(" | ") +
    " |";
  return [
    line(t.headers),
    line(t.headers.map(() => "---")),
    ...t.rows.map(line),
  ].join("\n");
}
function htmlTable(t: Table) {
  return (
    '<div class="scroll" role="region" aria-label="' +
    esc(t.headers.join("、")) +
    '" tabindex="0"><table><thead><tr>' +
    t.headers.map((h) => '<th scope="col">' + esc(h) + "</th>").join("") +
    "</tr></thead><tbody>" +
    t.rows
      .map(
        (c) =>
          '<tr><th scope="row">' +
          esc(c[0]) +
          "</th>" +
          c
            .slice(1)
            .map((s) => "<td>" + esc(s) + "</td>")
            .join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
const lead =
  overall.successes +
  "/" +
  overall.attempts +
  " 次通过独立交付验收，共回传 " +
  num(overall.tokens) +
  " tokens，公开价人民币合计 ¥" +
  money(overall.lowerRmb, overall.upperRmb) +
  "。";
const markdown =
  [
    "# " + title,
    lead,
    ...sections.flatMap((s) => [
      "## " + s.title,
      ...(s.paragraphs ?? []),
      ...(s.tables ?? []).map(mdTable),
    ]),
    "## 证据与价格来源",
    "批次 " +
      batch +
      "，RECAST 版本 " +
      protocol.productRevision +
      "，实现指纹 " +
      protocol.implementationHash +
      "。",
    links.map(([s, u]) => "[" + s + "](" + u + ")").join(" · "),
  ].join("\n\n") + "\n";
const css = `:root{color-scheme:light;--ink:#152e2c;--muted:#52645e;--line:#c8d6cf;--paper:#fffefa;--accent:#176453}*{box-sizing:border-box}html{scroll-padding-top:1rem}body{margin:0;background:#edf2ef;font:16px/1.65 "Segoe UI","Microsoft YaHei",sans-serif;color:var(--ink)}main{max-width:1240px;margin:24px auto;background:var(--paper)}header{background:#173f39;color:white;padding:38px 5%}header p{max-width:80ch;margin:.5em 0}h1{font-size:clamp(1.8rem,4vw,3.3rem);line-height:1.15;margin:.4em 0}h2{font-size:1.55rem;margin:.15em 0 .65em}section,footer,nav{padding:22px 5%;border-bottom:1px solid var(--line)}nav{display:flex;gap:.5rem 1.25rem;flex-wrap:wrap}a{color:var(--accent)}p{overflow-wrap:anywhere;margin:.65em 0}.scroll{overflow-x:auto;margin:14px 0;max-width:100%}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:.87rem}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:.52rem .62rem;overflow-wrap:anywhere}thead{background:#e2ece6}tbody th{font-weight:600}tbody tr:nth-child(even){background:#f6f8f5}footer{color:var(--muted);font-size:.86rem}@media(max-width:600px){main{margin:0}header,section,footer,nav{padding:20px 16px}table{min-width:600px}}@media print{body,main,header{background:white;color:#14221f;margin:0}nav{display:none}header,section,footer{padding:10px 0}.scroll{overflow:visible}table{font-size:8pt;min-width:0}h2,thead{break-after:avoid}tr{break-inside:avoid}thead{display:table-header-group}@page{size:A4 landscape;margin:12mm}}`;
const html =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
  title +
  "</title><style>" +
  css +
  "</style></head><body><main><header><p>RECAST Benchmark · " +
  esc(batch) +
  "</p><h1>" +
  title +
  "</h1><p>" +
  esc(lead) +
  "</p></header><nav>" +
  sections
    .map((s) => '<a href="#' + s.id + '">' + esc(s.title) + "</a>")
    .join("") +
  "</nav>" +
  sections
    .map(
      (s) =>
        '<section id="' +
        s.id +
        '"><h2>' +
        esc(s.title) +
        "</h2>" +
        (s.paragraphs ?? []).map((p) => "<p>" + esc(p) + "</p>").join("") +
        (s.tables ?? []).map(htmlTable).join("") +
        "</section>",
    )
    .join("") +
  "<footer><strong>核查来源</strong><p>" +
  links
    .map(([s, u]) => '<a href="' + esc(u) + '">' + esc(s) + "</a>")
    .join(" · ") +
  "</p><p>RECAST " +
  esc(protocol.productRevision) +
  " · " +
  esc(protocol.implementationHash) +
  "</p></footer></main></body></html>\n";
const summaries = [
  ...byArm.map((g, i) => ({
    model: "ALL",
    arm: arms[i],
    ...summarize(g.rows),
  })),
  ...PROJECT_MODELS.flatMap((model) =>
    arms.map((arm) => ({
      model,
      arm,
      ...summarize(rows.filter((r) => r.model === model && r.arm === arm)),
    })),
  ),
];
const trials = rows.map((r) => ({
  task: r.task,
  model: r.model,
  method: r.arm,
  inputHash: r.inputHash,
  passed: r.passed,
  wallSeconds: r.wallMs / 1000,
  routeReadinessSeconds: r.readiness ? r.readiness.waitMs / 1000 : null,
  routeReadinessProbes: r.readiness?.attempts,
  tokens: r.usage.totalTokens,
  usageComplete: r.usage.usageComplete,
  requests: r.calls.length,
  priceLowerRmb: r.price.knownRmb,
  priceUpperRmb: r.price.upperRmb,
  priceComplete: r.price.complete,
  rangedPriceCalls: r.price.estimatedCalls,
  unpricedCalls: r.price.unpricedCalls,
  accountWindowTotalRmb: r.balanceChange?.totalRmb,
  accountWindowToppedUpRmb: r.balanceChange?.toppedUpRmb,
  accountWindowGrantedRmb: r.balanceChange?.grantedRmb,
  accountWindowStart: r.balanceChange?.from,
  accountWindowEnd: r.balanceChange?.to,
  accountWindowError: r.balanceChange?.error,
  indexSeconds: r.indexMs == null ? null : r.indexMs / 1000,
  indexedReferences: r.indexFiles?.length,
  codexVersion: r.harness?.version,
  deliveredCommit: r.commit,
  diagnosis: diagnosis(r),
}));
await Promise.all([
  writeFile(prefix + ".md", markdown),
  writeFile(prefix + ".html", html),
  writeFile(prefix + "-summary.csv", csv(summaries)),
  writeFile(prefix + "-trials.csv", csv(trials)),
]);
console.log("Report:", prefix + ".html", rows.length, "verified trials");
