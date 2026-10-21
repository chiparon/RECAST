# 项目级 Integration Agent 实验记录（2026-10-10）

## 运行方式

原有模块翻译链路保持不变，在全部模块完成后增加一次通用项目级 Integration Agent。Integration Agent 使用与 RECAST 相同的 Codex/DeepSeek 配置，观察完整生产源代码、公开 requirements、模块计划和 Host 事实；hidden tests、hidden evaluator、baseline 源码和历史仓原目录没有进入 Agent workspace。

C# 使用上一版完整 RECAST 结果作为 base：

- base：`results/csharp-rerun-20261009-completed-project`
- Integration 快照：`results/csharp-integration-facade-defaults-completed-20261010`
- 编译：`dotnet build`，0 warning / 0 error
- model：`deepseek-v4-flash`
- Integration 运行约 455.8 秒，输入约 8,680,184 tokens，输出约 72,142 tokens
- 生产文件改动：7 个

Java 使用干净骨架作为 base：

- 骨架：`java-target-project`
- 原始骨架快照：`results/java-integration-original-skeleton-20261010`
- Integration 完成快照：`results/java-integration-completed-20261010`
- model：`deepseek-v4-flash`
- Integration 运行 706,833 ms（约 11.8 分钟）
- Integration 改动：71 个生产文件，约 5,155 行增量
- Integration 输入 16,695,752 tokens，输出 131,737 tokens
- `mvn -q -DskipTests package` 通过

## C# 外部验收

| 结果 | 总用例 | 需求 | 质量防线 |
|---|---:|---:|---:|
| 上一版 RECAST base | 14/24 | — | — |
| Agent baseline | 16/24 | 15/20 | 1/4 |
| 加 Integration Agent | 15/24 | 12/20 | 3/4 |

Integration Agent 将质量防线从 1/4 提高到 3/4，但需求用例从 15/20 降到 12/20，最终比 baseline 少 1 个用例。因此当前 Integration 增量已经能改善跨模块质量，但还不能声称稳定超过 baseline。

验收文件：`csharp-integration-facade-defaults-hidden-20261010.json`。

## Java 外部验收

第一次从干净骨架执行的完整 pipeline 报告为 `java-integration-full-20261010.json`：

- 13 个模块中 10 个完成；3 个模块（workflow、order、reconciliation）在宿主启动阶段被拒绝。
- 原因是前面模块翻译后，依赖写范围动态扩大到 139–157 个文件，超过既有 128 文件模块上限，宿主返回 `Invalid workspace translation request`。
- Integration Agent 仍然在 assembled project 上完成并通过 Maven 编译。

外部 hidden evaluator 首次发现 `TransactionPort.isActive()` 被生成代码改成抽象方法，破坏了已有事务替身的源兼容性。将该方法改为默认返回 `false` 后，hidden evaluator 正常执行：

- 25 个用例执行，21 个通过，4 个失败；
- 订单、工作流、对账用例全部通过；
- 4 个失败集中在附件流程（扫描后状态、释放授权、跨租户持久化前拒绝、重复命令幂等）。

对应文件：

- 首次编译失败：`java-hidden-20261010.log`
- 修复后验收：`java-hidden-20261010-after-compat.log`

为修复模块写范围问题，我在 `scripts/run-target-module-pipeline.mts` 中加入了既有 128 文件上限内的确定性截断。随后重跑时，DeepSeek 在最初 3 个模块的编译修复又发生了本轮生成失败；该次重跑已停止，日志为 `java-integration-full-20261010-rerun.log`，没有将它当作正式验收结果。

## 清理与验证

C# 与 Java target 最终都已恢复到原始干净骨架，并逐文件 SHA-256 核对一致。恢复后：

- Java 原始骨架 Maven 编译通过；
- C# 原始骨架 `dotnet build` 通过（0 warning / 0 error）；
- 构建生成的 `target/`、`bin/`、`obj/`、`.forexplore/` 运行时文件已清理。

代码侧验证：`npm run workspace:check` 和 `npm run build:adaptation` 通过。
