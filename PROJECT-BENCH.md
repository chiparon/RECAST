# 端到端项目交付对照实验

本实验的单位是一次完整项目交付。每个项目的需求、起始文件、可读参考、模块边界和公开测试全部固定。在同一个模型内配对比较三种执行方式，观察通过外部验收所需的时间和 Token。

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
