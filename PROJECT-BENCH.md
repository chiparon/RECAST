# 端到端项目交付对照实验

本实验的单位是一次完整项目交付。每个项目的需求、起始文件、可读参考、模块边界和公开测试全部固定。在同一个模型内配对比较三种执行方式，观察通过外部验收所需的时间和 Token。

## 十万行 Django 四种 harness 对照

[HTML 报告](results/large-v3.html) · [逐次数据](results/large-v3-trials.csv) · [分组汇总](results/large-v3-summary.csv) · [独立回放归档](results/large-v3-evidence.json.gz) · [人民币计费依据](src/large-projects/BILLING.md)

`large-v3` 在同一固定版本的 Django 生产源码上设置三个独立任务：管理后台关联字段自动补全、预填 slug、设置或禁用密码。每个任务跨 Python 与 JavaScript，在原生 Django、SQLite 和浏览器 DOM 环境中验收。仓库源码和 agent 可读取的源码分别统计。RECAST 的单模块清单最多容纳 256 个文件，四组共享这份清单。它首先包含必需的目标、参考和公开检查，再按路径邻近程度选取 20 个文件，并按生产源码行数填满余下位置。每题冻结树与实际可读生产源码均须超过十万行。

四组使用同一模型来源、`low` 推理设置、公开模块接口和编辑权限。RECAST 与 SAG2-SQLite 运行产品的项目流水线，后者为每次交付重新建索引。rawagent 使用单会话工具循环。Codex 组使用真正的 Codex CLI app-server、独立工作目录和六种项目工具。Codex 原生模型循环可以决定何时检查、修改或结束，代理层只将获准的读、改、编译和测试接口提供给模型。各组的模型请求不设任务 Token 预算。每一任务、模型、方法组合采样一次，共 36 次；失败也计入交付率、平均耗时、tokens/task 和人民币费用。

运行前沿用 Windows bench 空间的 `.env.local` 密钥设置，并准备 Docker 和支持 app-server 动态工具的 `codex.exe`；可用 `RECAST_CODEX_BIN` 指定可执行文件。首次需下载固定的 Django、浏览器运行依赖与容器镜像。

十万行先导批次 `large-v1` 在运行记录的原子替换中遇到 Windows 文件共享冲突，留下五个终态尝试。修订后的产品提交 `5ba062a4` 在这种冲突下重试原子写入。第二批 `large-v2` 遇到两家供应商同时连接超时，在停止派发前留下 16 个终态。正式批次 `large-v3` 使用已验证的进程级 HTTPS 代理，并在连接可用后从头运行全部 36 个组合。两个先导批次与接入预检均保留用量，单独计费。[先导用量](results/large-v1-pilot.json) · [连接异常批次用量](results/large-v2-network.json) · [接入预检用量](results/large-setup.json)

```powershell
npm run bench:large -- --controls
npm run bench:large
npm run verify:large
npm run verify:large -- --replay
npm run report:large
```

`--task`、`--model`、`--methods` 可选择子集，`--batch` 可另开批次。正式任务按模型串行运行，同一模型的一次 DeepSeek 账户余额观测窗口覆盖一次任务。账单字段保留请求时间、实际返回的模型、服务档位、缓存读写和输出用量。人民币定价逐请求应用再求和；DeepSeek 同时记录账户余额差，导出的证据仅含差额。

## 真实多语言项目批次

[真实项目结果](results/real-e2e-real-v2.md) · [分组指标](results/real-e2e-real-v2-summary.csv) · [逐次数据](results/real-e2e-real-v2-trials.csv) · [请求用量和交付代码归档](results/real-e2e-real-v2-evidence.json.gz)

Django 任务恢复德语国际化目录从 Python 视图到 JavaScript 客户端的行为，包含真实的翻译、模板和 admin 调用链。coverage.py 任务让 Python HTML 报告生成器与浏览器的执行上下文展开逻辑协同工作。前者冻结该功能的上游源码和运行依赖闭包，后者冻结上游 coverage 生产包并将两处待交付逻辑提取为模块。两题各有两个可写生产文件。Django 的 JS 使用 QuickJS，coverage.py 使用 Node VM 和覆盖相关行为的 DOM 测试替身。

BullMQ 冻结上游 TypeScript 和 Lua 源码。任务要求完整交付三个协作模块，分别生成队列键、原子修改作业优先级、按优先级读回计数。验收沿用上游客户端方法，在一次性的 Redis 7.2.5 实例上验证队列隔离、任务状态、计分桶与顺序。三道题均按完整冻结项目运行对应功能。

每个模型在每个任务各运行三个方法一次。同一任务共享需求、依赖清单、字节级起始树、可读文件、允许编辑的文件、公开命令和私有判分。rawagent 接收整项需求，自主选用读、写、局部编辑和测试等工具。recast 使用 ProjectPipeline 和 WorkspaceTranslationRuntime。sag2sql 在相同工作流上从本次输入的只读源码冷建 SQLite FTS5，再把检索到的模块交给生成环节。原始上游 Git 历史、参考实现和私有测例都在 agent 工具范围以外。样本的原始树与骨架只在可写模块上不同。控制实验还会逐一撤掉正确实现，验证每个模块都影响外部验收。

Django 的预跑 `real-v1` 完成了九次付费尝试。最初的工作流适配器把整项需求作为单个模块的交付指令，同时只开放这一个模块的写权限。模型因此在 Python 阶段报告缺少 JavaScript 写权限。正式批次 `real-v2` 将整项需求作为共享背景，按流水线实际授权的模块分配当前工作。预跑结果单列，正式统计从新工作区重新执行所有方法。[预跑的九次记录](results/real-e2e-real-v1-trials.csv)

同一任务最多三个模型并行，每个模型按轮换顺序串行运行三种方法。墙钟从执行方法开始，到外部验收结束，包含冷索引、原生构建和提交，排除一次性的下载和实验前控制验证。tokens/task 使用供应商返回的输入、输出 Token 总和，缓存输入包含在总数内。分母包括失败交付。真实项目运行不设累计 Token、模型轮数、任务总时长或费用上限；请求不发送 `max_output_tokens`。模型自身上下文窗口、原生构建命令的单次超时、HTTP 重试和工作流的正常终止条件仍生效。

本次宿主为 Windows x64、Ryzen 9 7940HX（16 核）、Node 26.0.0、Python 3.12.7、Git 2.49.0 和 Docker Engine 29.4.0。RECAST 版本为 `a66af7bf3933b016e1ac2508655a009dcf923e32`。三个模型均采用 Responses API 和 `reasoning.effort=low`。SAG2 使用产品默认的结构化 JEV 判定及最多两跳扩展。BullMQ 的 Lua 命令通过 Redis 原生验收，三种方法均可直接读取 Lua 源码。产品的结构索引识别 TypeScript，Lua 不在其解析器语言表中。工作流显示的宿主类型回退为 TypeScript，任务和实际翻译请求均明确指定 Redis Lua。

在 Windows 的 bench 工作区运行。首次准备需要 Git、Python、可运行 Linux 容器的 Docker，以及网络下载固定的上游版本和 Django 镜像依赖。供应商密钥沿用本地 `.env.local` 中配置的 `RECAST_KEY_FILE` 和 `DEEPSEEK_KEY_FILE`。

```powershell
npm run bench:real -- --controls
npm run bench:real
npm run verify:real
npm run verify:real -- --replay
npm run report:real
```

`--batch 新名称` 创建独立实验批次。`--fixture one` 选择 Django，`--fixture two` 选择 coverage.py，`--fixture three` 选择 BullMQ。同一批次可从完整记录继续。验证程序重新从固定上游准备骨架，对照 Git 父提交与最终提交，重新跑私有验收并核对每次请求的 Token。它还生成压缩 JSON，含生成文件、各次验收和逐请求供应商用量。`--replay` 可仅凭此归档和固定上游重放私有验收。

## 小项目对照批次

[正式批次报告](results/project-e2e-project-delivery.md) · [九组汇总](results/project-e2e-project-delivery-summary.csv) · [逐项目数据](results/project-e2e-project-delivery-tasks.csv)

## 三组执行方式

| 执行组 | Agent 的工作方式 | 参考材料 |
|---|---|---|
| recast | 真实 ProjectPipeline 按公开的依赖顺序调度 WorkspaceTranslationRuntime，运行 Analyzer、Translator、编译、验证及按需集成修复，最终 Git 提交 | 工作区中的全部公开文件可读 |
| sag2sql | 同一个 RECAST 流水线，每个试验从零建立文件型 SQLite FTS5 索引，按模块需求把选中的参考内容放进翻译上下文 | 只索引同一份公开 refs/，不引入外部历史仓；索引时间计入墙钟 |
| rawagent | 把整份任务交给一个原生工具调用 Agent，它自行安排读文件、编辑、编译和测试，并决定何时交付 | 与前两组完全相同的工作区、写入清单和公开测试，支持整项目和按模块检查 |

rawagent 可以多轮调用工具；没有 RECAST 的强制规划、逐模块代理或修复流程。三组都使用隔离 Git 骨架和独立验收，rawagent 的 Git 提交由宿主在 Agent 交卷、公开检查通过后完成。三组使用同一套 provider 和预算，工具名称和每次写入的模块范围服从各自的执行方式。

## 固定项目与评分

- P01 实现订单规范化、账务分录与审计出箱，处理重复订单与金额溢出。
- P02 实现按租户隔离的索赔扣款、幂等重放和原子出箱。
- P03 实现作业租约、到期选择、退避重试和终止状态。

每个项目包含三个相关生产模块和两个公开参考模块。三组看到同一份 SPEC.md；每行试验保留公开输入和隐藏检查的 SHA-256。每个项目有六组宿主保管的独立行为检查。评分器把候选生产模块与规范参考复制进新的只读目录，在干净环境里通过 stdin 传入隐藏测试；禁止提交方改动受保护文件。隐藏检查及其反馈不会回流给被测 Agent。

## 运行与复现

在 Windows 的 recast-bench 根目录运行，使用相邻 weichai 工作区及本机 Node 26 / Git。模型 ID 分别为 OpenAI 的 gpt-6-luna、gpt-6.1-sol 和 DeepSeek 的 deepseek-flash（V4.1 Flash）。各自的 API key 可通过 RECAST_KEY_FILE 和 DEEPSEEK_KEY_FILE 指定本机密钥文件；启动器也会读取不进 Git 的 .env.local。密钥文件仅含 key 本身，密钥无需放进源码或命令行。

```powershell
npm run bench:project -- --batch project-delivery --jobs 1
npm run report:project -- project-delivery
npm run verify:project -- project-delivery
```

正式矩阵是三个项目 × 三种模型 × 三种执行方式，共 27 次，各单元一次。串行运行，按模型和项目轮转执行顺序。正式批次使用 RECAST 提交 `a66af7bf`，它修复 Windows 翻译日志原子替换遇到短暂文件锁的问题。可用 --models、--tasks、--arms 缩小范围；--reps N 用于增加独立重复，扩大重复数时一并传给报告与验证命令。相同批次复用已完成记录，包括行为失败。缺凭据单列，填好密钥后同批次可补齐；更改协议、输入或运行代码后请使用新批次。运行会产生付费 API 调用。

单项目统一预算为 64 次逻辑模型调用、累计 160,000 个 API 报告 Token 的请求边界预算、单次最多 8,192 输出 Token 和 600 秒执行时间。Token 跨所有模块和修复累计。输入用量在响应后返回，因此最后一次请求可越过累计额度。独立评分在交卷后统一执行并另行计时。模型实际请求、重试、返回型号和用量记录到隔离运行目录，汇总表不含密钥或模型提示内容。

## 如何读结果

1. **交付成功率。** 成功要求生产文件通过公开检查、提交 Git、通过全部隐藏行为检查且受保护文件完整；另报通过的检查数以区分部分正确与完全交付。
2. **时间。** wallMs 从启动执行（含快照、SAG2 建库、Agent 调用、检查、提交）计到独立评分结束。原始指标另存生成阶段耗时；timeToVerifiedMs 只对通过项目有效。与 rawagent 的配对时间比只取双方都成功的同一任务。
3. **Tokens/task。** 一次项目的输入 + 输出 Token 累计全部模型请求，含失败尝试与修复，缓存输入、推理输出是子项。遇到未返回 usage 的 API 尝试，已知用量标为下界。不同供应商的 Token 不等同于相同费用。
4. **适用范围。** 三个可执行 JS 工程构成小规模基线；每格三个项目、每项目一次，适合发现差异与定位失败。生产级项目和模型调用波动需要更大样本验证。

结果明细保存在 results/project-bench/<batch>/，模型工作目录在 work/pb/。生成的可分享报告为 results/project-e2e-<batch>.md，另有 summary 与 tasks 两张 CSV。Layer 0 的建库速度和以前的 no-history-direct 检索对照保留在原报告中。
