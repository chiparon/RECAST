# 核心需求与验收

RECAST 的默认入口是 VS Code 工作台中的“整个项目”。用户导入目标工程和可选历史仓、填写需求，宿主在独立输出副本完成生成、验证和交付。单模块调试保留翻译作用域和回滚能力。下表列出影响用户代码或索引可信度的行为。修改其中一项时，在同一个 PR 更新预期、实现和测试。

| 需求 | 可观察的验收条件 | 实现入口 | 自动化证据 |
| --- | --- | --- | --- |
| F1 查询指定版本的工程 | 同一仓库重新索引后，指定旧 revision 的查询仍读取旧版。新版本完成投影后才可成为活动版本。 | [语义查询](../../services/code-intelligence-service/src/semantic-query-service.ts)、[索引协调器](../../services/code-intelligence-service/src/analysis-coordinator.ts) | [版本隔离、投影失败与活动版本测试](../../services/code-intelligence-service/src/semantic-query-service.test.ts) |
| F2 单模块调试的历史证据 | 宿主选定的候选决定历史证据。宿主根据目标模块和明确的关联依赖确定可写文件。选择变化或文件变化后，旧作用域不得启动写入。 | [建立翻译范围](../../apps/vscode-extension/src/module-translation-handoff.ts) | [范围和异步选择测试](../../apps/vscode-extension/src/module-translation-handoff.test.ts)、[界面操作测试](../../apps/vscode-extension/webview/src/App.pipeline.test.tsx) |
| F3 复验并回滚翻译 | 区分编译通过与行为验证通过。后端按运行 ID 记录修改，重启后可回滚。 | [运行契约](../../packages/contracts/src/workspace-translation.ts)、[工作区翻译运行时](../../services/adaptation-service/src/workspace-translation-runtime.ts) | [编译、行为修复与重启回滚测试](../../services/adaptation-service/src/workspace-translation-runtime.test.ts) |
| F4 按已审阅计划执行迁移波次 | 前置依赖先执行。提交的补丁必须对应已审批的准备结果，恢复时需再次核对该结果。 | [调度器](../../packages/workflow-core/src/module-scheduler.ts)、[波次宿主](../../apps/vscode-extension/src/module-wave-execution-host.ts) | [计划与调度测试](../../packages/workflow-core/src/module-migration.test.ts)、[审批和恢复测试](../../apps/vscode-extension/src/module-wave-execution-host.test.ts) |
| F5 整个项目生成与交付 | 源目标骨架保持原始内容。宿主在独立副本依次执行模块、项目集成和最终验收，完成时提交产物与报告。 | [项目运行时](../../apps/vscode-extension/src/project-pipeline.ts)、[LangGraph](../../apps/vscode-extension/src/project-pipeline-graph.ts) | [真实编译、测试与 Git 提交](../../apps/vscode-extension/src/project-pipeline.integration.test.ts) |
| F6 中断恢复和生成测试交付 | 根据磁盘上的运行快照恢复。交付位置保留生成测试与运行入口，重放失败影响最终验收。 | [项目文件与快照](../../apps/vscode-extension/src/project-pipeline-files.ts)、[交付测试说明](../retained-tests.zh-CN.md) | [快照双向兼容](../../apps/vscode-extension/src/project-pipeline-compatibility.integration.test.ts)、[交付测试集成](../../apps/vscode-extension/src/project-pipeline-tests.integration.test.ts) |

## 非功能要求

| 属性 | 判定方法 |
| --- | --- |
| 写入隔离 | 候选源码和只读依赖只能提供上下文。验证越界输入被拒绝，并检查磁盘上作用域外的文件。[范围测试](../../apps/vscode-extension/src/module-translation-scope.test.ts) |
| 凭据隔离 | 模型密钥只随发往获准本地端点的宿主请求传递，收到重定向时终止。并发请求各用自己的凭据。[宿主凭据测试](../../apps/vscode-extension/src/model-credential.test.ts)、[服务端 HTTP 测试](../../services/adaptation-service/src/http-server.test.ts) |
| 可重复验证 | 默认测试使用仓库夹具、临时目录和可控的模型响应。真实 SeekDB、目标语言工具链及模型验收分别记录环境与跳过项。[测试策略](../testing/testing-strategy.md) |

新需求应给出输入、用户观察到的结果和至少一个拒绝或失败场景。吞吐、延迟和召回率等指标随语料及模型变化；引用实验时注明语料、revision、模型和测量命令。[历史实验的归档和复现方法](../archive.md)
