# 静态分析与依赖审计

## 当前主线的检查范围

`npm run lint` 检查 apps、packages、services、scripts 和 tests 的 JS/TS 文件。共享包的警告必须清零，全范围警告的预算在根清单中声明。新增工作区只有公开的包入口供外部引用，contracts 保持独立，workflow-core 仅依赖 contracts。校验器覆盖静态导入，动态装配、原生解析器与按平台加载的代码在评审和构建中检查。[Oxlint 配置](../../.oxlintrc.json)、[根命令](../../package.json)

在 `a772db67` 主线上应用治理改动后，Oxlint 1.92.0 实测共享包 **0** 个警告，全范围 **59** 个警告，错误数为 **0**。共享包出现警告、全范围警告数超过 59、解析错误或命中 error 级规则都会使 CI 失败。下表统计的是当前产品、脚本和测试。全范围按总数设限，修改模块时还需核对本次产生的具体警告，并随清理下调门限。

| 规则 | 数量 | 评审重点 |
| --- | ---: | --- |
| `no-unused-vars` | 14 | 清理前检查默认参数是否触发恢复操作 |
| `no-useless-spread` | 12 | 确认遍历中是否会修改集合 |
| `no-new-array` | 9 | 核对按长度分配的排序和索引数组 |
| `no-useless-escape` | 8 | 用解析器样例验证正则与文字中的转义 |
| `no-unsafe-optional-chaining` | 6 | 在测试中先确认请求或消息存在再读取 |
| `no-control-regex` | 5 | 保留 Webview、MCP 等输入拒绝控制字符的用例 |
| `no-unsafe-finally` | 2 | 检查流水线实验驱动回滚时如何报告原始失败 |
| `prefer-string-starts-ends-with` | 2 | 随字符串匹配逻辑变更简化 |
| `no-useless-fallback-in-spread` | 1 | 检查翻译运行时的可选配置合并 |

依赖审计分别运行 `npm audit --omit=dev` 和 `npm audit`。前者是运行时面，后者也覆盖 VSIX 打包链等开发工具。Linux CI 检查运行时的 high / critical 公告；审计结果与执行时注册表公告相关。[CI 检查](../../.github/workflows/quality.yml)

此次移植保留 LangChain 使用的传递依赖 `js-tiktoken`，并刷新验证器的 `zod` 依赖。更新后的主线锁文件通过 `npm audit --omit=dev`，运行时公告为 0。

## 已处理的边界

扩展需要路径转换时，通过服务导出的 `@forexplore/code-intelligence-service/platform-path` 加载轻量入口。重排消费者通过包入口引用服务类型，依赖方向由 lint 检查和 workspace 构建共同验证。审查重排变更还需覆盖候选原始下标、顺序、参考选择和后端凭据刷新。[公开入口](../../services/code-intelligence-service/package.json)、[扩展重排测试](../../apps/vscode-extension/src/model-reranker.test.ts)、[参考选择测试](../../services/adaptation-service/src/retrieval-reference-selection.test.ts)

项目流水线通过 adaptation-service 的公开入口读取集成上下文、协议与参考选择类型，按需加载 Codex 运行时及规划器。扩展显式声明 translation-verifier-service 依赖，通过轻量入口访问保留测试产物，在验证阶段才加载 LangChain Host。打包集成测试通过同一组公开入口装配运行时。[适配层导出](../../services/adaptation-service/package.json)、[验证器导出](../../services/translation-verifier/package.json)、[打包集成测试](../../apps/vscode-extension/src/project-pipeline-backend.integration.test.ts)

## 复杂度与维护重点

| 文件 | 在 `a772db67` 的行数 | 修改时优先验证 |
| --- | ---: | --- |
| [repository-analysis.ts](../../services/code-indexer/src/repository-analysis.ts) | 2,142 | 静态分析快照、编译器探针及回退 |
| [seekdb-index-store.ts](../../services/code-intelligence-service/src/seekdb-index-store.ts) | 2,024 | 活动版本切换、回滚与持久化 |
| [code-intelligence-host.ts](../../apps/vscode-extension/src/code-intelligence-host.ts) | 1,878 | 注册与扫描时序、查询生命周期、历史视图边界 |

行数用于定位评审成本。优先围绕具体行为增加测试，再拆分职责。重复逻辑的输入和错误行为一致时才共用实现。

## 历史数据的口径

首轮分支 `4f90be01` 在治理后报告共享包 0 个警告、全范围 37 个警告，运行时依赖 0 个告警，完整审计还有 5 个打包链条目。该分支包含已归档的实验脚本，依赖树也早于主线的 LangGraph 与角色指令装配。当前门禁以本次产品清单和实测为准。[仓库审计](repository-audit.md)
