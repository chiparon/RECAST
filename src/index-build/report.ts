import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeReportPart } from "../report-output.ts";
import { scaleQueryCases } from "./queries.ts";

const phases = ["full", "one", "1pct", "10pct"];
const configs = [
  "seekdb-model",
  "seekdb-hash",
  "sag2-memory",
  "sag2-sqlite-file",
  "sag2-over-seekdb",
];

// Attempt files include partial checkpoints if a process exhausted its heap or time budget.
async function readAttempts(root: string, batch: string, optional = false) {
  const path = join(root, "index-build", batch);
  const rows = [];
  const names = await readdir(path).catch((e) => {
    if (optional && e.code === "ENOENT") return [];
    throw e;
  });
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const r = JSON.parse(await readFile(join(path, name), "utf8"));
    if (r.status === "error" && r.config === "sag2-sqlite-file" && /^[a-f0-9]{24}$/.test(r.attempt)) {
      const base = resolve(root, "../work/index-build", batch, basename(name,".json")+"_"+r.attempt, "fts.sqlite");
      const sizes=await Promise.all(["","-wal","-shm"].map(suffix=>stat(base+suffix).then(s=>s.size).catch(e=>{
        if(e.code==="ENOENT")return null;throw e;
      })));
      if(sizes[0]!=null)r.sqliteBytesAfterExit=sizes.reduce((sum,n)=>sum+(n??0),0);
    }
    if (r.caseId && configs.includes(r.config))
      rows.push({
        ...r,
        attemptId: r.attempt,
        attempt: basename(name, ".json"),
      });
  }
  if (!rows.length && !optional)
    throw Error("No recorded index-build attempts in " + path);
  return rows.sort(
    (a, b) =>
      a.caseId.localeCompare(b.caseId) ||
      configs.indexOf(a.config) - configs.indexOf(b.config) ||
      a.attempt.localeCompare(b.attempt),
  );
}

const ms = (v: number | null | undefined) =>
  v == null ? "—" : (v / 1000).toFixed(2);
const fmt = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));
const mib = (v: number | null | undefined) =>
  v == null ? "—" : (v / (1024 * 1024)).toFixed(1);
const pc = (v: number | null | undefined) =>
  v == null ? "—" : (100 * v).toFixed(1) + "%";
const median = (xs: number[]) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length
    ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
    : null;
};
const table = (cols: string[], rows: unknown[][]) => {
  const cell = (s: unknown) =>
    String(s ?? "—")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("|", "\\|")
      .replace(/[\r\n]+/g, " ");
  return [
    "| " + cols.map(cell).join(" | ") + " |",
    "|" + cols.map(() => "---").join("|") + "|",
    ...rows.map((r) => "| " + r.map(cell).join(" | ") + " |"),
  ].join("\n");
};
function csv(rows: Record<string, unknown>[]) {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const value = (x: unknown) =>
    x == null ? "" : '"' + String(x).replaceAll('"', '""') + '"';
  return (
    "\uFEFF" +
    [
      keys.join(","),
      ...rows.map((r) => keys.map((k) => value(r[k])).join(",")),
    ].join("\r\n") +
    "\r\n"
  );
}

function base(r) {
  return {
    caseId: r.caseId,
    config: r.config,
    heap: String(r.heap ?? "default"),
    attemptId: r.attemptId,
    attempt: r.attempt,
    modeling:
      r.modeling ??
      (r.agent ? "adaptive-module-tree/v1" : "directory-dependency/v1"),
    scale: r.corpus?.scale,
    languageMode: r.corpus?.languageMode,
    languages: Object.keys(r.corpus?.languages ?? {}).join("|"),
    files: r.corpus?.files,
    loc: r.corpus?.loc,
    corpusSha256: r.corpus?.sha256,
  };
}
function buildRows(r) {
  return phases.map((phase) => {
    const step = (r.steps ?? []).find((x) => x.phase === phase);
    const reason = step?.error ?? r.error ?? r.cleanupError;
    let status = step?.status;
    if (status === "running")
      status = r.status === "error" ? "error" : "running";
    if (!status)
      status = phase === "full" && r.status === "error" ? "error" : "blocked";
    return {
      ...base(r),
      attemptStatus: r.status,
      attemptElapsedMs: r.elapsedMs,
      setupMs: r.setupMs,
      phaseTimeoutMs: r.phaseTimeoutMs,
      phase,
      phaseStatus: status,
      measurementComplete: status === "ok",
      lastCheckpoint: status === "error" ? r.current : null,
      error: status === "ok" ? null : (reason ?? "phase did not start"),
      cleanupError: r.cleanupError ?? null,
      changedFiles: step?.changedFiles,
      indexedFiles: step?.files,
      rebuiltRepositories: step?.repos?.length,
      projectedDocuments: step?.documents,
      rebuiltLoc: step?.loc,
      elapsedMs: step?.elapsedMs,
      filesPerSecond: step?.throughput?.filesPerSecond,
      locPerSecond: step?.throughput?.locPerSecond,
      documentsPerSecond: step?.throughput?.documentsPerSecond,
      scanMs: step?.stages?.scan,
      structuralWriteMs: step?.stages?.["structural-write"],
      searchProjectionMs: step?.stages?.["search-projection"],
      summaryProjectionMs: step?.stages?.["summary-projection"],
      modelingMs: step?.stages?.["module-modeling"],
      activationMs: step?.stages?.activation,
      rssPeakBytes: step?.rssPeakBytes,
      processLifetimeRssPeakBytes: step?.processLifetimeRssPeakBytes,
      parserPeakWorkerRssBytes: step?.parserPeakWorkerRssBytes,
      parserPeakCombinedRssBytes: step?.parserPeakCombinedRssBytes,
      parserWorkers: step?.parserWorkers,
      embeddingCalls: step?.embeddingCalls,
      embeddingVectors: step?.embeddingVectors,
      embeddingHttpCalls: step?.embeddingHttpCalls,
      embeddingHttpInputs: step?.embeddingHttpInputs,
      sqliteBytes: step?.storage?.sqliteBytes,
      sqliteDiskBytes: step?.storage?.sqliteDiskBytes,
      partialSqliteDiskBytesAfterExit: status === "error" ? r.sqliteBytesAfterExit : null,
      seekdbBytes: step?.storage?.seekdbBytes,
      seekdbMemtableBytes: step?.storage?.seekdbMemtableBytes,
      seekdbMeasurement: step?.storage?.seekdbMeasurement,
      seekdbMeasurementError: step?.storage?.seekdbMeasurementError,
      agentCalls: r.agentCalls?.length,
    };
  });
}
function queryRows(r) {
  if (!scaleQueryCases.includes(r.caseId)) return [];
  const summary = r.queries?.summary ?? [];
  return ["standard-1hop", "sag2-2hop"].flatMap((mode) =>
    ["cold", "warm"].flatMap((phase) =>
      ["all", "s01", "s03", "s06", "s07"].map((query) => {
        const observed = summary.find(
          (x) => x.mode === mode && x.phase === phase && x.query === query,
        );
        const expected = (phase === "cold" ? 1 : 5) * (query === "all" ? 4 : 1);
        const attempted = observed?.planned ?? 0,
          successful = observed?.succeeded ?? 0;
        const status =
          successful === expected
            ? "ok"
            : attempted === 0
              ? "unavailable"
              : successful === 0
                ? "error"
                : "partial";
        return {
          ...base(r),
          attemptStatus: r.status,
          mode,
          phase,
          query,
          status,
          expected,
          attempted,
          succeeded: successful,
          failed: observed?.failed ?? 0,
          notRun: expected - attempted,
          p50Ms: observed?.p50Ms,
          p95Ms: observed?.p95Ms,
          recallAt4: observed?.recallAt4,
          recallAt4IncludingErrors: observed?.recallAt4IncludingErrors,
          error:
            status === "ok"
              ? null
              : [
                  ...(r.queries?.errors ?? []),
                  r.queries?.error,
                  (r.queries?.samples ?? []).find(
                    (s) =>
                      s.status === "error" &&
                      s.mode === mode &&
                      s.phase === phase &&
                      (query === "all" || s.query === query),
                  )?.error,
                  r.error,
                ]
                  .filter(Boolean)
                  .join(" / ") || "full index or query run unavailable",
        };
      }),
    ),
  );
}

function section(
  batch,
  rows,
  queries,
  attempts,
  chartAvailable,
  pilot,
  diagnostic,
  xlDiagnostic,
  xlQueryRows,
) {
  const normal = rows.filter(
    (r) => r.heap === "default" && r.modeling === "directory-dependency/v1",
  );
  const full = normal.filter((r) => r.phase === "full");
  const cases = [...new Set(full.map((r) => r.caseId))];
  const successful = rows.filter((r) => r.phaseStatus === "ok");
  const count = (xs, field, value) =>
    xs.filter((r) => r[field] === value).length;
  const lines = [
    "## Layer 0 · 建库速度、资源与规模上限",
    "",
    "批次 `" +
      batch +
      "` 收录 " +
      attempts.length +
      " 次建库尝试。默认堆、零模型模块建模覆盖 " +
      new Set(full.map((r) => r.caseId + "|" + r.config)).size +
      "/45 个配置组合。包括扩堆或诊断尝试在内，" +
      successful.length +
      "/" +
      rows.length +
      " 个阶段成功，" +
      count(rows, "phaseStatus", "error") +
      " 个阶段出错，" +
      count(rows, "phaseStatus", "blocked") +
      " 个后续阶段受阻。所有尝试和已记录的部分计数都保存在 index-build-summary.csv 中。",
    "",
    "### 按规模与语言划分的全量建库",
    "",
    "表中按语言组成分组，每格显示默认堆全量建库秒数；ERR 表示该阶段失败。每个主矩阵组合各运行一次，时间比是本机单次配对观测。规模档沿用任务板分组，横向比较使用冻结快照的实际物理 LoC 和生产文件数。全量时间含扫描、结构化写入、检索投影、模块建模与摘要投影。初始化开销单列在 CSV 的 setupMs。",
  ];
  const deadlines = [
    ...new Set(attempts.map((a) => a.phaseTimeoutMs / 1000)),
  ].join(" / ");
  lines.push(
    "",
    "每个全量、增量、恢复和查询阶段的宿主预算为 " +
      deadlines +
      " 秒。SeekDB 本身可提前返回 SQL 超时。E5 服务在测量前已加载，各配置共享该本地推理服务。结构化模块提案使用 directory-dependency/v1；变更比例基于生产文件数。增量间恢复源码和原分析哈希的时间不计入下一档。",
  );
  if (batch === "measured-build")
    lines.push(
      "",
      "B03 的 seekdb-hash 和 seekdb-model 首次运行收到 10 秒 SQL 超时。旧轨迹最后记录到模块投影，无法从日志确定报错的具体 SQL。随后驱动将观测性文档计数的失败单列为缺失指标，并保留原始失败行。",
    );
  for (const language of ["single", "multi"]) {
    const group = cases
      .map((id) => full.find((x) => x.caseId === id))
      .filter((r) => r.languageMode === language);
    lines.push(
      "",
      "#### " + (language === "single" ? "单语言" : "多语言"),
      "",
      table(
        ["语料", "规模", "语言", "文件", "LoC", ...configs],
        group.map((r) => [
          r.caseId,
          r.scale,
          r.languages,
          r.files,
          r.loc,
          ...configs.map((c) => {
            const attempts = full.filter(
              (x) => x.caseId === r.caseId && x.config === c,
            );
            return (
              attempts
                .map((x) => (x.phaseStatus === "ok" ? ms(x.elapsedMs) : "ERR"))
                .join(" / ") || "—"
            );
          }),
        ]),
      ),
    );
  }
  const ratios = configs
    .filter((x) => x !== "seekdb-model")
    .map((config) => {
      const pairs = full
        .filter(
          (r) =>
            r.config === config && r.phaseStatus === "ok" && r.elapsedMs > 0,
        )
        .flatMap((r) => {
          const baseline = full.find(
            (x) =>
              x.config === "seekdb-model" &&
              x.caseId === r.caseId &&
              x.phaseStatus === "ok" &&
              x.elapsedMs > 0,
          );
          return baseline ? [baseline.elapsedMs / r.elapsedMs] : [];
        });
      return [
        config,
        pairs.length,
        fmt(median(pairs)),
        pairs.filter((x) => x > 1).length,
      ];
    });
  lines.push(
    "",
    "同一语料与 seekdb-model 均完成全量建库时，计算基线耗时 / 当前耗时；超过 1 表示当前配置更快。表内取各语料比值的中位数，样本数显示该比较覆盖了多少个完整语料。",
    "",
    table(["配置", "成功配对", "中位时间比", "更快的语料数"], ratios),
  );
  const giant = rows.filter(
    (r) =>
      r.phase === "full" &&
      r.config === "sag2-memory" &&
      ["B08", "B09"].includes(r.caseId),
  );
  if (giant.length)
    lines.push(
      "",
      "#### 巨仓堆上限",
      "",
      "每个进程的采样 RSS 峰值以 MiB 计。失败阶段的耗时和内存只反映最后一次落盘采样，是下界；文件和文档累计量仅覆盖已完成的仓库。attemptElapsedMs 另含初始化、复制、恢复、查询和清理耗时。",
      "",
      table(
        ["语料", "堆 MiB", "状态", "已计时 s", "RSS MiB", "失败原因"],
        giant.map((r) => [
          r.caseId,
          r.heap,
          r.phaseStatus,
          ms(r.elapsedMs),
          mib(r.rssPeakBytes),
          r.error,
        ]),
      ),
    );
  lines.push(
    "",
    "### Embedding、存储与增量开销",
    "",
    "Embedding 调用和向量计数取自实际 provider.embed，HTTP 输入单独记录。下表汇总默认堆、全量成功的运行。峰值 RSS 为对应成功进程中的最大采样值。SQLite 的逻辑页和磁盘文件分开记录。各档恢复和增量生成的历史版本继续占用空间，因此阶段末文件大小包含保留的旧版本。SeekDB 将表统计或 SSTable 磁盘统计的来源保存在 seekdbMeasurement，memtable 内存单列。缺测保留为空。",
    "",
    table(
      [
        "配置",
        "成功/全量尝试",
        "Embedding 调用",
        "生成向量",
        "HTTP 输入",
        "最大 RSS MiB",
        "可测 SeekDB 容量次数",
      ],
      configs.map((c) => {
        const all = full.filter((r) => r.config === c),
          s = all.filter((r) => r.phaseStatus === "ok");
        const total = (k) =>
          s.length ? s.reduce((n, r) => n + (r[k] ?? 0), 0) : "—";
        return [
          c,
          s.length + "/" + all.length,
          total("embeddingCalls"),
          total("embeddingVectors"),
          total("embeddingHttpInputs"),
          s.length ? mib(Math.max(...s.map((r) => r.rssPeakBytes ?? 0))) : "—",
          s.filter((r) => r.seekdbBytes != null).length + "/" + s.length,
        ];
      }),
    ),
    "",
    "每个增量阶段从相同原始源码状态出发。修改在可写副本进行，目标文件数为 1 或按比例向上取整。下表是同一尝试内增量/全量耗时比的中位数，括号中给出成功配对数；只重建有文件变动的仓。每个阶段的原始耗时、吞吐、解析 worker 峰值和存储占用可从 CSV 复算。",
    "",
    table(
      ["配置", "1 文件", "1% 文件", "10% 文件"],
      configs.map((c) => [
        c,
        ...phases.slice(1).map((p) => {
          const ratios = normal
            .filter(
              (r) => r.phase === p && r.config === c && r.phaseStatus === "ok",
            )
            .flatMap((r) => {
              const base = full.find(
                (x) => x.attempt === r.attempt && x.phaseStatus === "ok",
              );
              return base?.elapsedMs > 0 && r.elapsedMs != null
                ? [r.elapsedMs / base.elapsedMs]
                : [];
            });
          return ratios.length
            ? fmt(median(ratios)) + "× (" + ratios.length + ")"
            : "—";
        }),
      ]),
    ),
  );
  const agent = rows.filter(
    (r) => r.phase === "full" && r.modeling !== "directory-dependency/v1",
  );
  lines.push(
    "",
    "本批固定结构建模路径为 directory-dependency/v1。" +
      (agent.length
        ? "下表列出独立 Agent 路径。"
        : "本批没有单列 Agent 建模尝试。"),
  );
  if (agent.length)
    lines.push(
      "",
      table(
        ["语料", "配置", "算法", "状态", "建模 s", "模型调用（尝试合计）"],
        agent.map((r) => [
          r.caseId,
          r.config,
          r.modeling,
          r.phaseStatus,
          ms(r.modelingMs),
          r.agentCalls,
        ]),
      ),
    );
  const curve = queries.filter(
    (r) =>
      r.heap === "default" &&
      r.modeling === "directory-dependency/v1" &&
      r.mode === "sag2-2hop" &&
      r.query === "all",
  );
  lines.push(
    "",
    "### 建库后的规模–延迟–召回",
    "",
    "每个可查询的完整索引另外加入同一个 23 模块探针仓。查询包含全部原生仓与探针仓，真值是 S01、S03、S06、S07 的标注模块。在这些曲线上，Recall@4 回答目标模块在不同背景资产池中的可找回程度。首次调用标记 cold；页缓存、模型与数据库保持运行。warm 是每模式每问题随后 5 次新查询，禁用宿主结果缓存。查询耗时和探针投影均不计入全量建库。",
    "",
    "下表给出默认堆两跳结果。延迟单位为 ms。索引构建失败、超时或查询未运行时不赋予召回值。两种检索方式的逐题、首次及热查询样本数与百分位见 index-query-scale.csv。",
    "",
    table(
      [
        "语料",
        "LoC",
        "配置",
        "首次 P50 / P95",
        "热 P50 / P95",
        "热 Recall@4",
        "热成功/应测",
      ],
      curve
        .filter((x) => x.phase === "warm")
        .map((r) => {
          const cold = curve.find(
            (x) => x.attempt === r.attempt && x.phase === "cold",
          );
          return [
            r.caseId,
            r.loc,
            r.config,
            fmt(cold?.p50Ms) + " / " + fmt(cold?.p95Ms),
            fmt(r.p50Ms) + " / " + fmt(r.p95Ms),
            pc(r.recallAt4),
            r.succeeded + "/" + r.expected,
          ];
        }),
    ),
  );
  const progression = curve
    .filter(
      (r) =>
        r.config === "sag2-memory" && r.phase === "warm" && r.status === "ok",
    )
    .sort((a, b) => a.loc - b.loc);
  if (progression.length >= 2) {
    const a = progression[0],
      b = progression.at(-1);
    lines.push(
      "",
      "在 sag2-memory 成功完成查询的最小和最大实测语料间，LoC 从 " +
        a.loc +
        "（" +
        a.caseId +
        "）增至 " +
        b.loc +
        "（" +
        b.caseId +
        "）；两跳热 P95 从 " +
        fmt(a.p95Ms) +
        " 变为 " +
        fmt(b.p95Ms) +
        " ms，探针 Recall@4 从 " +
        pc(a.recallAt4) +
        " 变为 " +
        pc(b.recallAt4) +
        "。仓库数与语言构成也随语料变化。",
    );
  }
  if (chartAvailable)
    lines.push(
      "",
      "![默认堆下各规模的热 P95 延迟、Recall@4 与有效样本数](index-query-scale.png)",
    );
  const issues = rows.filter(
    (r) => r.phaseStatus === "error" || r.cleanupError,
  );
  const failedAttempts = attempts.filter(
    (r) => r.status === "error" || r.cleanupError,
  );
  if (failedAttempts.length) {
    lines.push(
      "",
      "### 未完成的尝试",
      "",
      "同一尝试的失败只列一次；受阻的增量阶段仍在阶段分母和 CSV 中。查询错误在曲线 CSV 中单列。",
      "",
      table(
        ["语料", "配置", "堆", "阶段", "原因"],
        failedAttempts.map((r) => {
          const first = issues.find((x) => x.attempt === r.attempt);
          return [
            r.caseId,
            r.config,
            r.heap,
            first?.phase ?? r.current,
            r.error ?? r.cleanupError ?? first?.error ?? "未报告",
          ];
        }),
      ),
    );
  }
  if (pilot.length) {
    const failed = pilot.filter((r) => r.status === "error");
    lines.push(
      "",
      "### 驱动预实验",
      "",
      "独立预实验批次 layer0 共 " +
        pilot.length +
        " 次尝试，" +
        failed.length +
        " 次失败。其中 " +
        failed.filter((r) => String(r.error).includes("CodeIntelligenceHost"))
          .length +
        " 次在工作进程加载 CodeIntelligenceHost 时退出。逐次原始记录保存在 index-build/layer0/。本节上方的阶段统计与曲线使用批次 " +
        batch +
        "。",
    );
  }
  if (diagnostic.length) {
    lines.push(
      "",
      "### B03 SQL 超时复核",
      "",
      "单独批次 b03-count-diagnostic 使用相同语料和 300 秒预算，驱动将观测性计数失败单列。下表只用于排查首次运行的 SQL 超时，原始矩阵与曲线仍取首次尝试。文档数缺失表示观测查询未返回。",
      "",
      table(
        [
          "配置",
          "全量结果",
          "全量秒数",
          "索引文档",
          "已完成阶段",
          "探针结果",
          "错误",
        ],
        diagnostic.map((a) => {
          const f = a.steps.find((s) => s.phase === "full");
          return [
            a.config,
            f?.status,
            ms(f?.elapsedMs),
            f?.documents,
            a.steps.filter((s) => s.status === "ok").length + "/4",
            a.queries?.status,
            a.error ??
              f?.repos?.find((r) => r.documentCountError)?.documentCountError,
          ];
        }),
      ),
    );
  }
  if (xlDiagnostic.length) {
    lines.push(
      "",
      "### 巨仓长时限查询诊断",
      "",
      "主矩阵在阶段预算内未取得完整查询数据的巨仓另行执行批次 `xl-query-diagnostic`。该批次仅执行全量建库与探针查询。下表给出每次独立尝试的堆配置、阶段预算、全量结果和错误。其耗时与查询结果单独列示，主矩阵分母和曲线沿用原始尝试。",
      "",
      table(
        [
          "语料",
          "配置",
          "堆 MiB",
          "阶段预算 s",
          "全量状态",
          "全量 s",
          "建模工程数",
          "索引文档",
          "查询状态",
          "错误",
        ],
        xlDiagnostic.map((r) => {
          const full = r.steps?.find((s) => s.phase === "full");
          const errors = [
            r.error,
            r.cleanupError,
            r.queries?.error,
            ...(r.queries?.errors ?? []),
          ].filter(Boolean);
          return [
            r.caseId,
            r.config,
            r.heap,
            ms(r.phaseTimeoutMs),
            full?.status,
            ms(full?.elapsedMs),
            full?.status === "ok" ? full.repos.reduce((sum,repo)=>sum+repo.projects,0) : null,
            full?.status === "ok" ? full.documents : null,
            r.queries?.status ?? "未执行",
            [...new Set(errors)].join(" / ") || full?.error,
          ];
        }),
      ),
      "",
      "cold 和 warm 采用主矩阵的四个探针及同一召回真值，每种检索方式分别应测 4 次和 20 次。P50、P95 和 Recall@4 仅汇总成功的查询。超时或建库失败会减少有效样本，失败及未运行数列在各自分母中。逐题明细见 index-query-scale-xl-diagnostic.csv。",
      "",
      table(
        [
          "语料",
          "检索方式",
          "阶段",
          "成功/应测",
          "查询失败",
          "未运行",
          "P50 ms",
          "P95 ms",
          "Recall@4",
        ],
        xlQueryRows
          .filter((r) => r.query === "all")
          .map((r) => [
            r.caseId,
            r.mode,
            r.phase,
            r.succeeded + "/" + r.expected,
            r.failed,
            r.notRun,
            fmt(r.p50Ms),
            fmt(r.p95Ms),
            pc(r.recallAt4),
          ]),
      ),
    );
  }
  return lines.join("\n");
}

export async function writeIndexReport(batch: string, root = "results") {
  if (!batch || !/^[a-zA-Z0-9_-]+$/.test(batch))
    throw Error("Pass a valid index-build batch name");
  const attempts = await readAttempts(root, batch);
  const pilot =
    batch === "measured-build" ? await readAttempts(root, "layer0", true) : [];
  const rows = attempts.flatMap(buildRows);
  const diagnostic =
    batch === "measured-build"
      ? await readAttempts(root, "b03-count-diagnostic", true)
      : [];
  const xlBatch = "xl-query-diagnostic";
  const xlDiagnostic =
    batch === "measured-build" ? await readAttempts(root, xlBatch, true) : [];
  const xlQueryRows = xlDiagnostic.flatMap((r) =>
    queryRows(r).map((row) => ({
      batch: xlBatch,
      phaseTimeoutMs: r.phaseTimeoutMs,
      fullOnly: r.fullOnly,
      buildError: r.error,
      queryRunStatus: r.queries?.status ?? "unavailable",
      ...row,
    })),
  );
  const queries = attempts.flatMap(queryRows);
  await writeFile(join(root, "index-build-summary.csv"), csv(rows));
  await writeFile(join(root, "index-query-scale.csv"), csv(queries));
  if (xlDiagnostic.length)
    await writeFile(
      join(root, "index-query-scale-xl-diagnostic.csv"),
      csv(xlQueryRows),
    );
  const plotPython = process.env.INDEX_BENCH_PLOT_PYTHON;
  const chartAvailable = !!(queries.length && plotPython);
  if (chartAvailable)
    execFileSync(
      plotPython!,
      [
        fileURLToPath(new URL("./plot-scale.py", import.meta.url)),
        resolve(root),
      ],
      { stdio: "inherit" },
    );
  await writeReportPart(
    "index",
    section(
      batch,
      rows,
      queries,
      attempts,
      chartAvailable,
      pilot,
      diagnostic,
      xlDiagnostic,
      xlQueryRows,
    ),
    root,
  );
  return {
    attempts: attempts.length,
    phases: rows.length,
    queryRows: queries.length,
    xlDiagnosticAttempts: xlDiagnostic.length,
    xlDiagnosticQueryRows: xlQueryRows.length,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(await writeIndexReport(process.argv[2]));
}
