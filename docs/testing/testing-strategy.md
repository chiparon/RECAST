# 分层测试与复现

从仓库根目录运行。新 checkout 按 [AGENTS.md](../../AGENTS.md) 选定对应平台的工作区，依次运行 `npm run workspace:check -- --before-install`、`npm ci` 和 `npm run workspace:check`。已有依赖的工作区直接从最后一步开始。PR 的 Windows 和 Linux 任务使用 Git、Node 26、Python 3.12、.NET 8 SDK 和 JDK 21，启用 `RUN_DOTNET_INTEGRATION=1` 以验证实际 C# 工程编译。[CI 工作流](../../.github/workflows/quality.yml)

| 要回答的问题 | 入口 | 行为与环境边界 |
| --- | --- | --- |
| 单个改动破坏了哪些已有行为？ | `npm run test:unit` | 运行工作区、开发脚本和共享契约测试。已有测试按模块归档，也包含 HTTP、UI 和实际编译检查。需要快速反馈时先限定一个包，如 `npm test --workspace @forexplore/workflow-core`。[旧版模块计划与所有权契约](../../tests/contract/module-hierarchy.test.ts) |
| 接口两端能否互通？ | `npm run test:integration` | 索引器、内存存储、真实回环 HTTP 与适配服务消费端一起验证版本隔离和鉴权，另有模块规划经 HTTP 发布的链路。[历史证据集成测试](../../tests/integration/revision-evidence.test.ts)、[规划集成测试](../../tests/integration/project-http-pipeline.test.ts) |
| 用户启动翻译后，工作区实际发生了什么？ | `npm run test:e2e` | 从生产宿主的作用域准备和翻译操作进入，经过鉴权 HTTP，检查隔离目标工程的真实文件、验证结果与回滚。用可控的模型响应消除网络和凭据依赖。[业务流程用例](../../tests/e2e/module-translation.test.ts) |

`npm test` 汇总默认测试，`npm run quality` 再执行静态检查、文档链接、`skills:check` 与 workspace 构建。测试沿用主线的双 worker 限制。项目宿主已有 LangGraph 等价、旧版磁盘快照兼容、真实编译与 Git 输出的用例；仓库级单模块 E2E 补测 HTTP 交接。企业历史实验按[归档说明](../archive.md)单独复现。[项目级集成测试](../../apps/vscode-extension/src/project-pipeline.integration.test.ts)、[快照兼容测试](../../apps/vscode-extension/src/project-pipeline-compatibility.integration.test.ts)记录失败的命令、平台、工作区和测试名。CI 中环境缺失应补充依赖或明确隔离适用的用例，保持核心断言生效。

## 如何补测试

- **单元测试**放在实现旁边。以[波次调度测试](../../packages/workflow-core/src/module-migration.test.ts)为例，断言依赖先后、环、未知依赖、其他模块的文件归属等可观察结果。修缺陷时先用最小输入复现，再验证修复；覆盖正常值、边界和错误输出。
- **集成测试**跨越改变的真实边界，例如从适配客户端向真实 HTTP 处理器发起请求。模型调用可以替换成固定响应，存储可以使用 `InMemoryIndexStore`。用临时目录和回环随机端口，结束时关闭监听、释放文件。SQL、迁移及持久化改动另外用隔离的 SeekDB 测试库验证。
- **E2E**从使用者可触发的操作进入，断言最终文件、界面或运行结果。写入功能同时覆盖恢复路径。界面点击与宿主消息顺序另有 [Webview 交互测试](../../apps/vscode-extension/webview/src/App.pipeline.test.tsx)。

## 带外部环境的验收

| 改动 | 补充验证 |
| --- | --- |
| 扩展激活、命令注册或面板生命周期 | `npm run test:integration --workspace forexplore-vscode` 在真实桌面宿主打开并复用面板。设置 `FOREXPLORE_TEST_VSCODE_PATH` 可指定可执行文件，缺省会下载 VS Code。[测试入口](../../apps/vscode-extension/src/test/integration/run-tests.ts) |
| 模型、检索投影或 SeekDB 持久化 | 依照 [SeekDB 部署](../seekdb-docker-setup.md)准备独立测试库，用同一工程导入两个 revision，重启宿主后查询指定版本并检查激活状态。记录模型、数据库名、revision、命令与报告路径；保留开发数据卷。 |
| 翻译验证器的目标语言 runner 或真实模型 | 依照[验证器说明](../../services/translation-verifier/README.md)准备对应 runner。实模型测试额外需要凭据与 `TRANSLATION_VERIFIER_LIVE_E2E=1`。 |

用 `npm run coverage:core` 复测 workflow-core 的覆盖率。Linux CI 运行相同命令。观察分支未覆盖的位置，再决定下一批边界测试；这份报告只覆盖该包。全仓已执行的套件、跳过项和初始覆盖率见[仓库审计](../maintenance/repository-audit.md)。
