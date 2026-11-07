# RECAST 系统与模块边界

扩展宿主是产品入口。Webview 负责展示和收集操作，宿主掌握工作区、文件选择与本地服务地址。注册命令和面板消息分别见[扩展入口](../../apps/vscode-extension/src/extension.ts)和[双向消息契约](../../apps/vscode-extension/src/protocol/messages.ts)。

## 代码归属与依赖

下表给出内部 workspace 的直接依赖（省略 npm 第三方包及开发工具）。跨模块新增能力前，先找拥有数据或副作用的一行。

| 模块 | 职责 | 直接依赖的内部包 |
| --- | --- | --- |
| [contracts](../../packages/contracts/src/index.ts) | 数据契约、常量、协议解析与验证 | 无 |
| [workflow-core](../../packages/workflow-core/src/index.ts) | 工作流状态、迁移波次及语义查询等端口 | contracts |
| [adaptation-http-adapter](../../packages/adaptation-http-adapter/src/adaptation-http-adapter.ts) | 将工作流调用转换成 HTTP，验证响应 | contracts、workflow-core |
| [code-indexer](../../services/code-indexer/src/index.ts) | 工程扫描、语言解析与结构化索引 | contracts |
| [code-intelligence-service](../../services/code-intelligence-service/src/index.ts) | 管理索引版本、模块建模与检索，提供查询服务 | code-indexer、contracts、workflow-core |
| [adaptation-service](../../services/adaptation-service/src/http-server.ts) | 接受适配、规划、翻译与验证请求，运行编译器或模型 | code-indexer、code-intelligence-service、contracts、workflow-core |
| [adaptation-mcp-server](../../services/adaptation-mcp-server/src/server.ts) | 通过 stdio 暴露适配和补丁预览工具 | adaptation-service、contracts |
| [semantic-index-mcp-server](../../services/semantic-index-mcp-server/src/server.ts) | 通过 stdio 将只读查询转发给宿主 | contracts、workflow-core |
| [translation-verifier](../../services/translation-verifier/README.md) | 在隔离的目标 Git worktree 中检查翻译行为 | contracts |
| [vscode-extension](../../apps/vscode-extension/package.json) | 注册命令，管理 Webview、索引运行时和工作区后端 | adaptation-service、adaptation-http-adapter、code-indexer、code-intelligence-service、contracts、workflow-core |

端口签名属于工作流层。文件系统、数据库、模型和 VS Code API 的实现属于相应服务或宿主。跨 workspace 的消费者从包的公开入口导入。举例来说，扩展通过 `@forexplore/code-intelligence-service/platform-path` 单独加载路径转换逻辑，避免为解析路径而加载数据库和原生解析器。[服务公开入口](../../services/code-intelligence-service/package.json)

共享协议需要同时更新生产者、消费者和解析测试。验证器还有自己的 [workflow → strategy → host 职责约束](../../services/translation-verifier/AGENTS.md)。

## 从整个项目的需求到交付

1. 工作台以“整个项目”为默认入口。宿主接收 `START_PROJECT_PIPELINE`，固定目标骨架的索引与源文件版本，在独立输出副本生成运行记录。Webview 可用运行 ID 重新读取状态。[宿主入口](../../apps/vscode-extension/src/project-pipeline-host.ts)、[消息契约](../../apps/vscode-extension/src/protocol/messages.ts)
2. LangGraph 串行驱动准备或恢复、选择模块、检索和生成，再执行项目集成、最终验收、有限修复与发布。业务状态及磁盘快照由原有运行时管理。启动顺序、取消和失败恢复有旧版快照兼容测试。[图节点](../../apps/vscode-extension/src/project-pipeline-graph.ts)、[运行时](../../apps/vscode-extension/src/project-pipeline.ts)、[兼容性测试](../../apps/vscode-extension/src/project-pipeline-compatibility.integration.test.ts)
3. 宿主按需求选取可用历史参考。模型提出 1–3 个互补候选，适配服务验证候选身份和证据。缺少历史参考时使用需求和模块协议直接实现。宿主控制目标写入范围、只读历史视图、运行预算与测试命令。[自动选择规则](../automatic-reference-selection.zh-CN.md)、[后端接线](../../apps/vscode-extension/src/project-pipeline-backend.ts)
4. Analyzer、Translator、Integration 和 Verifier 从仓库 `skills/` 装配各自指令。最终组装后，宿主重跑编译及验证，校验受保护文件与快照，在输出副本提交，并保存运行报告。验证器生成的测试按模块保留，可从交付位置重放。[角色指令](../agent-skills.zh-CN.md)、[保留测试与恢复](../retained-tests.zh-CN.md)、[项目集成测试](../../apps/vscode-extension/src/project-pipeline.integration.test.ts)

单模块调试仍可使用宿主限定的工作区翻译、查看差异与回滚。多文件目标按宿主选定的模块建立范围，服务只接受受限的写入请求。[模块翻译交接](../../apps/vscode-extension/src/module-translation-handoff.ts)、[宿主与服务接口](api.md)

宿主启动与工作区匹配的适配后端，并告诉后端本窗口的语义查询地址。测试可注入内存存储。[服务启动与所有权](../extension-backend-and-evidence.zh-CN.md)
