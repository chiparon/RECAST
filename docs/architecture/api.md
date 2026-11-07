# 宿主与本地服务接口

## 整个项目工作台

Webview 发出 `START_PROJECT_PIPELINE`，宿主以 `PROJECT_PIPELINE_STATE` 回传 `ProjectPipelineRun`。后续的 `PROJECT_PIPELINE_ACTION` 使用运行 ID 指定读取、取消、继续或打开结果等操作；重试单个模块还需模块 ID。宿主按磁盘运行快照恢复，并在恢复前核对项目范围。模型调用、工具与运行状态的所有权都在宿主侧。[双向消息及载荷验证](../../apps/vscode-extension/src/protocol/messages.ts)、[项目宿主](../../apps/vscode-extension/src/project-pipeline-host.ts)、[工作台交互测试](../../apps/vscode-extension/webview/src/App.project-pipeline.test.tsx)

## 扩展与适配服务

Webview 通过消息请求宿主操作。扩展宿主先用能力接口确认工作区及语义查询端点，再向相应后端发起翻译。常用交互列在下表。请求及响应的字段以[工作区翻译契约](../../packages/contracts/src/workspace-translation.ts)和[实际路由](../../services/adaptation-service/src/http-server.ts)为准。

| 请求 | 输入与返回 | 调用方应处理的结果 |
| --- | --- | --- |
| `GET /health`、`GET /v1/capabilities` | 前者检查进程，后者报告能力及配置了的工作区和查询端点 | 宿主复用后端前核对能力与归属。[后端管理](../../apps/vscode-extension/src/backend-process.ts) |
| `POST /v1/adapt` | JSON `AdaptationRequest` → `AdaptationResult`，包含验证与补丁信息 | 载荷不合法返回 400，媒体类型不符返回 415。[适配契约](../../packages/contracts/src/adaptation.ts) |
| `POST /v1/backfill` | 普通 HTTP 写回入口已关闭 | 返回 410。用户在扩展中审阅后，通过获准的宿主流程写入。 |
| `GET /v1/workspace-translations/configuration` | 返回绑定的工作区和运行时配置 | 工作区翻译未配置返回 404，令牌无效返回 401。 |
| `POST /v1/workspace-translations` | JSON `WorkspaceTranslationRequest` 含需求、上下文、可读和可写文件 → 202 + `WorkspaceTranslationRun` | 保存运行 ID。遇到不确定的提交结果时，禁止自动重发写入。 |
| `GET /v1/workspace-translations/{id}` | 返回该运行的状态、变更和验证结果 | 根据返回的 `status` 和 `acceptance` 分别展示执行结果与验收级别。 |
| `POST /v1/workspace-translations/{id}/{action}` | `cancel`、`rollback` 成功返回 200；`resume` 成功返回 202 | 修复动作 `verification-repair` 接收验证反馈；运行时不支持该动作时返回 409。 |

工作区翻译系列路由需要宿主配置的 Bearer 令牌。携带 Origin 的请求必须匹配服务配置。工作区路径、命令、令牌和历史源码路径的授权由宿主管理。[HTTP 错误与鉴权测试](../../services/adaptation-service/src/http-server.test.ts)、[运行时测试](../../services/adaptation-service/src/workspace-translation-runtime.test.ts)

## 只读语义查询与 MCP

语义客户端向宿主提供的地址发送 `POST /v1/semantic-query/{operation}`。例如，`listRepositories` 接受空对象，`getFileStructure` 读取指定版本的文件结构。客户端按端口方法的类型组装 JSON。请求超过 256 KiB 返回 413，非法操作返回 404，已配置令牌时鉴权失败返回 401。错误体为 `{ "error": { "message": "..." } }`。[端口签名](../../packages/workflow-core/src/semantic-query-port.ts)、[HTTP 实现及操作白名单](../../services/code-intelligence-service/src/semantic-query-http-server.ts)

独立语义 MCP 通过 `SEMANTIC_QUERY_PORT_URL` 转发这些查询。适配 MCP 则暴露上下文收集、分析、生成、修复、验证与补丁预览工具。[语义 MCP 启动入口](../../services/semantic-index-mcp-server/src/server.ts)、[适配工具清单](../../services/adaptation-mcp-server/README.md)
