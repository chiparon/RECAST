# RECAST 代码使用情况与 Windows / WSL 同步审计

检查日期：2026-10-13。检查的是当前工作树，包含未提交修改。

## 结论

存在仓库内现有运行入口未使用的旧实现；但截图以外的代码不全是冗余，迁移波次、MCP、符号级适配和可选服务仍有入口。

Windows 与 WSL 的已提交版本相同，未提交源码尚未统一。排除实验工程、结果、依赖、构建输出、凭证和平台本地配置后，比较 1,344 个文件（文本忽略 CRLF / LF 差异），发现 22 个文件不同：7 个仅 WSL 存在，15 个内容不同。22 个差异对照当前同步基线均属于 WSL 后续改动，Windows 仍保留基线内容。

## 已确认没有仓库内实际运行调用的实现

| 文件 / 符号 | 调用证据 | 判断及清理边界 |
|---|---|---|
| apps/vscode-extension/src/module-generation-client.ts:17 — createModuleGenerationModelClient | 全仓源码检索只有定义，没有 import 或调用 | 整个旧 HTTP 模型客户端没有接线 |
| apps/vscode-extension/src/module-generation-gate.ts:46 — parseModuleGenerationGate | 只有定义和单元测试；扩展没有调用，package.json 没有注册该配置项 | 配置解析器没有接线。宿主还保留 moduleGeneration 回调和相关错误提示，属于未完成接线的功能，不能只因有提示就认为可用 |
| services/code-intelligence-service/src/module-modeling.ts:26 — buildProjectModuleProposal | 只有公共导出、定义和单元测试；没有运行入口调用 | 旧 directory-dependency/v1 确定性建模器；当前 Agent 层级建模流程不调用它 |
| packages/workflow-core/src/module-migration-workflow.ts:235 — ModuleMigrationWorkflow | 只有定义、公共导出和单元测试 | 旧封装类无实际调用；同文件 buildModuleMigrationPlan、recordModulePlanDecision 仍被扩展使用，不能删除整个文件 |
| packages/adaptation-http-adapter/src/adaptation-http-adapter.ts:79、111 — BackfillHttpAdapter、withAdaptationService | 只有定义、导出、测试，以及封装内部实例化 | 当前扩展回填使用 WorkspaceBackfill；同文件 AdaptationHttpAdapter 仍被 ServiceManager 使用，不能删除整个文件 |
| packages/workflow-core/src/module-target.ts:3 — toModuleTarget | 只有定义和 index.ts 通配导出，无调用 | 旧节点转目标辅助函数，无仓库内运行用途 |
| apps/vscode-extension/src/module-explorer.ts:57 — buildModuleExplorer | 只有定义和单元测试调用 | 旧的本地扫描总入口未使用；当前扩展使用 buildProjectExplorer。文件中的 workspacePresentationFromStructuralIndex、folderTree 仍被新入口复用，不能整文件删除 |

另有 workflowSteps 常量没有外部运行引用，属于小型清理候选。以上判断是“当前仓库内现有运行流程不调用”，公开导出是否被仓库外部消费者使用不在此次检查范围。

其中 module-generation-client.ts、module-generation-gate.ts、module-modeling.ts、module-target.ts 四份生产源码共 317 行；其余主要是活文件中的旧类、旧函数。这是已核实的清理候选范围，不是全仓死代码行数。

## 图外仍然有用途，不能直接删除的代码

- 模块迁移波次流程：extension.ts:352–370 注册了建模、计划审核、波次审核、准备、审批和恢复命令；ModuleMigrationHost、GitWaveTransaction、ModuleWaveExecutionCoordinator 仍有实际接线。不过自动模块生成所需的 moduleGeneration 回调未在当前宿主配置中注入。
- 符号级适配：extension.ts:1115 的 startAdaptation 将模块目标送入多文件翻译，将其他目标送入旧适配端口；HTTP /v1/adapt 与 MCP 仍有入口。
- MCP：package.json 注册 dev:mcp、dev:semantic-index-mcp。
- 可选 BGE 重排：code-intelligence-service/src/index.ts:138 在配置 moduleReranker 时实例化 LocalModuleReranker。
- Java/C# 编译器增强与 LSP：runtime 工厂会实例化并注册这些 provider；扩展还会绑定 Java/C# 编译器事实。不能把“通过 index.ts 接线”误判成“仅导出”。
- 单函数 Verifier：createVerifier 当前由 e2e / live e2e 测试及 README 示例使用；正式模块实验使用 createFunctionGroupVerifier。它不是产品主链路，但存在测试流程，不能宣称完全无用途。
- 两个本地重排服务脚本：serve-local-rerank.mjs 由 start-recast-services.mjs 启动；serve-local-reranker.mjs 有文档手工启动入口。协议、分数语义不同，是维护重叠候选，不等于无入口死代码。

静态筛查覆盖 apps、packages、services、scripts 中 400 个 TS/JS 文件，并逐项查询实验驱动等仓库代码的符号引用，核对扩展命令、HTTP/MCP 接线、公共导出及可选配置。未把只有文件级入边不足的结果直接认定为死代码，也未把源码快照、历史仓和实验结果算成产品代码。

## 截图流程与当前入口的差别

WSL 的 run-target-module-pipeline.mts 已调用 Integration Plan Agent、保存全局协议、投影模块协议、执行模块 Function Group Verifier 并回写协议检查；run-project-integration-pass.mts 是独立的整项目集成入口。

当前 extension.ts 的模块翻译入口则是 prepareModuleTranslationScope → WorkspaceTranslationHost → 后端 Analyzer / Translator 和编译、配置的验证机制。扩展没有自动接入上述集成规划 Agent、协议生命周期和模块 Agent Verifier 的整套编排。因此，“完整实验脚本支持”与“前端工作台完整接入”不能等同。

## Windows 与 WSL 具体差异

- Windows 分支：test/enterprise-asset-upgrade-dataset。
- WSL 分支：integrate/pr43-function-verification。
- 两边 HEAD：ef9a363e02d687285fca94236fa7bb3a984ac996。
- 分支名字不同不代表提交落后；此次差距来自未提交改动。
- 两边同步基线内容相同，22 个差异文件均是 WSL 后续修改；在这些源码差异中没有发现双边修改冲突。完整同步还应检查实验目录等其他同步范围。
- package.json / package-lock.json 在此次平台比较中没有差异。

对运行最关键的差异：

1. WSL 新增 GlobalProtocol、ModuleProtocol、Integration Plan Agent 和 protocol sidecar，Windows 尚未具备这些新增源码。
2. WSL 翻译请求及 Analyzer 解析支持协议上下文，Verifier 输出 protocolChecks；Windows 后端还是之前的行为。
3. 重排接口允许的候选数量上限：Windows 40，WSL 48。相同的大候选请求可能在 Windows 被拒绝。
4. WSL 检索额外支持召回数量、仓库候选配额、重排文档长度配置，以及 channelRanks / channelScores 诊断。
5. WSL 的 Maven 验证环境显式设置 compiler release；实验 baseline 驱动脚本也有改动。

| 文件 | 差异 |
|---|---|
| packages/contracts/src/global-protocol.ts | 仅 WSL 存在 |
| packages/contracts/src/index.ts | WSL 后续修改，Windows 未同步 |
| packages/contracts/src/workspace-translation.ts | WSL 后续修改，Windows 未同步 |
| scripts/run-enterprise-asset-upgrade-baseline.sh | WSL 后续修改，Windows 未同步 |
| scripts/run-enterprise-asset-upgrade-codex-deepseek-baseline.sh | 仅 WSL 存在 |
| scripts/run-enterprise-asset-upgrade-java-baseline.sh | WSL 后续修改，Windows 未同步 |
| scripts/run-enterprise-asset-upgrade-java-codex-deepseek-baseline.sh | 仅 WSL 存在 |
| scripts/run-project-integration-pass.mts | WSL 后续修改，Windows 未同步 |
| scripts/run-target-module-pipeline.mts | WSL 后续修改，Windows 未同步 |
| services/adaptation-service/src/codex-workspace-translation-runtime.ts | WSL 后续修改，Windows 未同步 |
| services/adaptation-service/src/index.ts | WSL 后续修改，Windows 未同步 |
| services/adaptation-service/src/integration-plan-agent.test.ts | 仅 WSL 存在 |
| services/adaptation-service/src/integration-plan-agent.ts | 仅 WSL 存在 |
| services/adaptation-service/src/protocol-sidecar.test.ts | 仅 WSL 存在 |
| services/adaptation-service/src/protocol-sidecar.ts | 仅 WSL 存在 |
| services/adaptation-service/src/retrieval-rerank.ts | WSL 后续修改，Windows 未同步 |
| services/adaptation-service/src/workspace-translation-agent.ts | WSL 后续修改，Windows 未同步 |
| services/code-intelligence-service/src/module-matching.ts | WSL 后续修改，Windows 未同步 |
| services/translation-verifier/src/host/test-environment.ts | WSL 后续修改，Windows 未同步 |
| services/translation-verifier/src/host/tools/finish-function-group.ts | WSL 后续修改，Windows 未同步 |
| services/translation-verifier/src/strategies/single-agent-function-group/strategy.ts | WSL 后续修改，Windows 未同步 |
| services/translation-verifier/src/types.ts | WSL 后续修改，Windows 未同步 |

此次没有删除产品代码、同步工作树、安装依赖或修改运行环境。完整 workspace:sync --dry-run 因扫描范围包含较大的实验目录长时间未完成，已停止；平台结论来自独立的源码清单与归一化内容比较，冲突判断来自对 22 个差异文件的同步基线核对。没有以未完成的 dry run 宣称全范围同步可安全执行。

本报告不核验两边已有 dist 的新旧或正在运行的进程是否加载最新源码；即使后续源码同步完成，仍需分别在所属平台构建并重启服务。
