# RECAST 检索与开发速度 benchmark

[端到端项目交付实验](PROJECT-BENCH.md) 比较 RECAST、SAG2 SQLite 工作流和原生 Agent 在相同完整项目上的验收通过率、用时与 Tokens/task。

此分支包含 benchmark 源码、实测报告和汇总数据。主程序与 benchmark 使用相邻的 Windows 工作区。首次运行可在同一个父目录下检出两个分支：

```powershell
git clone --branch feat/sag2-retrieval https://github.com/chiparon/RECAST.git weichai
git clone --single-branch --branch codex/recast-bench https://github.com/chiparon/RECAST.git recast-bench
cd weichai
npm run workspace:check
npm ci
cd ../recast-bench
npm ci
```

B08 使用第三个相邻目录。在上述父目录运行 `git clone --no-checkout https://github.com/apache/camel.git recast-smoke-camel` 即可提供固定提交的 Git 对象。在线开发实验从环境变量或本机 `.env.local` 中的 `RECAST_KEY_FILE` 读取密钥文件路径。报告可直接打开 `results/report.html`；运行时的原始轨迹由各实验命令在本地生成。

## Layer 0 建库实验

从 Windows bench 根目录执行。先启动现有 SeekDB 容器与本地 E5 服务，确认 `127.0.0.1:2881` 的 `SELECT 1` 及 `http://127.0.0.1:4021/health` 成功。推理依赖使用 RECAST 独立 runtime。实测使用的是同一已加载的 E5 服务；模型的首次下载和进程启动单独于索引计时。

```powershell
python src/index-build/materialize.py
npm run bench:index -- --batch measured-build --phase-seconds 300
npm run report:index -- measured-build
```

语料脚本从固定 Git 提交导出生产源码和工程描述文件，冻结清单在 `corpora/manifest.json`，逐文件 SHA-256 在 `corpora/inventories/`。已取得上游仓库时用 `--already-materialized` 复核并重新生成清单。B08 使用相邻的 `../recast-smoke-camel` 本地仓库；需含提交 `e44ef154a5d51ca8c5a353fb838c52815d197ae1`。清单区分生产 LoC 与扫描文件数，配置文件计入后者。

五种存储配置均显式注入实际 RECAST runtime。默认对数据库使用 loopback、端口 2881 和本机配置的用户；支持 `CODE_INTELLIGENCE_SEEKDB_HOST/PORT/USER/PASSWORD`。每次 SQL 实验由父进程创建随机命名的专用库，清理只作用于该次成功创建的库。子进程内的临时修改仅发生在 `work/index-build/<batch>/` 的快照副本。

每种配置先做全量建库，再分别改动 1 个文件、向上取整的 1% 和 10% 生产文件。不同增量之间恢复原文件，重建并核对原始分析哈希；该恢复过程单独计时，不计入下一档增量。增量吞吐按涉及仓库的重建索引量计算。B08/B09 的 sag2-memory 同时保留默认堆和 8192 MiB 堆的独立尝试。

可用 `--cases B01,B03 --configs sag2-memory,seekdb-model` 缩小范围，或用 `--heap default` 只运行默认堆。基准默认使用确定性的目录/依赖模块建模；`--agent --cases B02` 或 `B03` 另起 GPT-6 Luna 付费建模实验。正式矩阵不启用该选项。

父进程按准备、全量、各档增量、回滚、查询分别执行统一时间预算。超时记录最后可见阶段和已完成步骤，后续未执行项以 blocked 进入分母。同批次保留所有已落盘结果，包括失败；复测用新批次名。建库后的固定探针使用独立仓的真值模块，额外投影不计入全量建库。查询首轮和后续五轮分别计时；数据库及 OS 页面缓存保持正常状态。

原始建库记录在 `results/index-build/<batch>/`，进度与运行日志在 `work/index-build/<batch>/`。汇总表为 `results/index-build-summary.csv`；综合报告在 `results/report.md` 和 `results/report.html`。

`results/index-query-scale.csv` 给出各规模、配置、探针与冷热状态的查询统计，含预期次数、完成次数、错误和未执行次数。如需重画报告里的曲线，在生成报告前将 `INDEX_BENCH_PLOT_PYTHON` 设为带 Matplotlib 的 Python 可执行文件路径。首轮直接比较使用本地结构 JEV；四个探针仅标注额外仓内的必需模块，反映真实历史资产增长对固定查询的干扰。

本次 B03 的 SQL 超时使用 `--batch b03-count-diagnostic --cases B03 --configs seekdb-hash,seekdb-model` 原预算复核。B08 的补测用 `--batch xl-query-diagnostic --cases B08 --configs sag2-memory --heap 8192 --full-only --phase-seconds 3600` 建立完整索引并运行查询。重新生成 `measured-build` 报告时，两批诊断在独立小节中呈现，长时限探针另存 `results/index-query-scale-xl-diagnostic.csv`。运行 `npm run verify:index -- measured-build` 检查 47 次正式尝试、188 个阶段以及目标规模的查询样本。

这个工程在 Windows 上直接加载相邻 `../weichai` 工作区的 TypeScript 源码。基准包含十个可复现的业务工程、十二个模块查询。历史 TS/Python 源码、模块边界、目标骨架和测试由 `src/scenarios/` 生成。S08 使用六个历史仓范围，S09 串行实现三个模块后运行跨模块验收，S10 使用 61 个模块。每个模式都从同一份只读骨架开始。

## 运行

在 RECAST 的 Windows 工作区运行 `npm run workspace:check`，确保该工作区的依赖已按仓库说明安装。以下命令在 `recast-bench` 根目录执行。使用具备内置 SQLite FTS5 的 Node 和可调用的 Git。本次使用 Node 26。在线评测会调用 OpenAI 的付费 API。

```powershell
npm ci
npm run bench -- --batch measured --jobs 4
npm run latency -- measured
npm run report -- measured
npm test
```

`bench` 默认串行。可用 `--scenarios s01,s08` 与 `--mode sag2-2hop` 缩小范围。场景内串行轮转四种模式，`--jobs` 控制并行场景数。每次项目运行以临时文件加重命名方式保存记录。同一批次再次启动跳过已有记录，包括已记录的失败。新的独立测量应换批次名。`RECAST_BATCH` 为回归测试指定批次。完整报告需要四十个项目结果以及同批次独立延迟样本。正式运行和预实验分目录存储。

## 数据流

1. 对生成的历史源码执行 RECAST 结构扫描，通过 ProjectAnalysisCoordinator 校验固定模块提案，将模块与源码文档装入 Sag2Bm25IndexStore。生成、扫描和建索引的时间在查询与交付计时窗口之外。
2. `no-history-direct` 无检索。传统单跳直接调用 `searchModules`。两个在线 SAG2 组调用 `searchModulesWithSag2`，分别限制一跳与两跳，共享同一查询、索引、topK=4 和裁决实现。JEV 复用生产代码的职责切分和桥接词提取，使用 OpenAI Decisions API 批量判断“候选是否实现该职责”。概率达到 0.5 即覆盖；模型收不到真值标签。该裁决适配器位于 bench，产品默认的结构裁决单独测时。
3. 宿主取前三个候选构建 historyView 与 prepareModuleTranslationScope。没有候选时调用 prepareDirectModuleTranslationScope。WorkspaceTranslationRuntime 使用 GPT-6 Luna Responses 工具调用，通过真实只读语义服务端口供 Agent 按需取证。实测 RECAST 提交在所有新任务上先运行 Analyzer，包括标记 direct-translator 的无历史任务。
4. ProjectPipelineFiles 在独立 Git 输出仓保存骨架。WorkspaceTranslationRuntime 检查文件哈希、执行 node --check 和受保护的 Node 行为测试。ProjectPipeline 再次检查所有生产文件、执行联合验收、校验输出哈希并提交。模型自主决定工具、补查和修复。每次验收都留有 Git 父提交、验收报告和工具轨迹。
5. 独立检索速度实验在开发运行结束后串行执行。各模式每个查询先预热一次；本地结构裁决与传统单跳各重复 25 次，在线 Decisions 裁决各重复 5 次，轮换顺序，重发 API 请求。在线耗时含网络。调用方没有裁决缓存，服务端提示缓存可能命中。

## 读数

- `e2eDeliveryMs` 仅用于已通过联合行为验收并有提交的运行。失败保留 `elapsedMs`、状态及诊断。计时含宿主流程和 Git 操作；模块阶段时间相加可能小于总耗时。
- 检索按十二个模块查询统计。Anchor Hit@1/4 以所需列表首项为锚点；Recall@4 为前四候选命中的必需模块数除以必需模块数；全部命中率要求没有遗漏。上下文完备度以实际交给 Agent 的候选覆盖必需模块的比例计算。JEV 职责覆盖率取模型自身的诊断，两者有独立分母。
- MRR 取锚点名次倒数；nDCG@4 对必需模块使用二元相关性。二跳发现率只计 S03/S06/S07 中诊断记录为首次发现、且进入上下文的指定协作者。诱饵剔除率按前四没有标注诱饵的查询计。单跳早停只考察 S01。
- 模型轮数、工具调用、补查字符和编译测试次数来自运行轨迹。Token 取真实 API usage；Agent 与裁决分别记账。模型循环耗时扣除循环内编译与测试子进程，compileAndVerifyMs 还包含最终项目检查。所有模块首测均通过，才记该项目首次行为验收成功。
- 配对时间与轮数比均为基线 / SAG2；报告汇总同批配对总量，值大于 1 表示 SAG2 使用更少时间或轮数。单侧精确符号检验检验改善方向，剔除平局。性能目标按实测判定。回归测试会检查 40 项历史验收与 Git 提交，并在保存的输出仓重新执行编译和行为套件。

## 产物

| 路径 | 内容 |
|---|---|
| results/report.md | 本轮中文对比报告 |
| results/report.html | 可独立浏览和打印的同版报告 |
| results/latest-report.json | 汇总、配对检验、项目记录、模型用量、候选及工具审计 |
| results/velocity-summary.csv | 每种模式、每个场景的项目交付指标 |
| results/retrieval-summary.csv | 每种模式、每个查询的质量与上下文指标 |
| results/latency-samples.csv | 串行查询的计时、名次和跳数 |
| results/runs/<batch> | 四十份逐次项目记录 |
| results/latency/<batch> | 含预热的全部查询样本与查询计划 |
| work/<batch> | 生成的历史源、骨架、独立 Git 输出仓和验收报告 |

`npm run check:speedup` 单独评估任务板中的提速假设。它要求对两个基线的时间和轮数均达到比值 > 1 且配对单侧 p < 0.05；一项未达即返回非零。这个结果与编译和行为交付验收分别记录。
