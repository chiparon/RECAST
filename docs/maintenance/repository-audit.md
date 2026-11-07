# RECAST 仓库工程审计

## 当前产品主线

治理改动移植到 `main` 的 `a772db67`。该提交以 LangGraph 编排默认的整个项目工作流，保留企业使用文档、回归输入和项目内角色指令。历史实验、研究材料与供应商快照在独立归档分支。[归档说明](../archive.md)、[项目架构与数据流](../architecture/system-overview.md)

| 移植前盘点 | 主线证据与本轮处理 |
| --- | --- |
| 仓库范围 | `git ls-tree -r --name-only a772db67` 得到 1,386 个已跟踪文件，其中 37 个位于 docs。npm 管理 1 个扩展、3 个共享包和 6 个服务。历史参考源和企业数据实验单独复现。 |
| 测试 | apps、packages、services、scripts 共有 200 个 JS/TS 的 `*.test.*` 文件。根测试曾列举 8 个工作区，已有独立脚本和验证器入口，以及项目流水线、快照兼容、保留测试与语言工具链验收。新门禁把包内回归、开发脚本及仓库级三层套件串入 PR。[测试策略](../testing/testing-strategy.md) |
| 关键业务 | 宿主保护原骨架，在独立副本完成模块生成、集成、验收、交付和恢复。针对只读版本证据和单模块启动/回滚，补充跨服务 HTTP 和可重复的无界面 E2E。[需求矩阵](../requirements/README.md)、[项目运行测试](../../apps/vscode-extension/src/project-pipeline.integration.test.ts) |
| 架构与静态分析 | contracts 和 workflow-core 设置依赖方向检查。扩展通过服务的公开入口使用路径转换与重排类型；工作区构建和类型检查有统一入口。[静态分析](static-analysis.md) |
| 文档与协作 | 保留主线操作手册、LangGraph 迁移与验证器说明，新增需求到测试的链接、接口、ADR 与评审发布规则；PR 和标签构建报告稳定状态 `Repository quality`。[工程手册](../engineering/handbook.md)、[CI](../../.github/workflows/quality.yml) |

## 在本提交复测

| 检查 | 命令与范围 |
| --- | --- |
| 环境与安装 | 在当前平台的 checkout 运行 `npm run workspace:check -- --before-install`、`npm ci`、`npm run workspace:check`。CI 使用 Node 26.0.0。 |
| 产品门禁 | `npm run quality` 检查仓库卫生、静态规则、类型、文档、角色指令，运行默认测试并构建各 workspace。 |
| 核心覆盖率 | `npm run coverage:core` 单独测量 workflow-core 的行和分支，作为趋势记录。 |
| 发布 | `npm run release:check` 执行质量门禁，检查扩展版本并从新目录生成 VSIX。原生能力按平台验证。 |
| 外部环境 | 模型、SeekDB、目标语言 runner 及真实 VS Code 宿主分别记录环境、结果和跳过项。[测试策略](../testing/testing-strategy.md) |

## 本轮实测

下表记录移植到 `a772db67` 后的 Windows 工作区实测。

| 验证 | 结果 |
| --- | --- |
| 产品测试 | `npm test` 通过 1,538 项 Vitest 和 7 项 Node 内置测试，共 **1,545 项通过，5 项跳过**。 |
| 静态分析、类型与构建 | 共享包 lint 警告为 0，全范围 59 条警告。`typecheck` 和 `build:all` 通过。运行时依赖审计 `npm audit --omit=dev` 报告 0 个公告。 |
| 核心覆盖率 | workflow-core 行覆盖 **85.81%（726/846）**、分支覆盖 **71.54%（523/731）**。 |
| 真实宿主 | 在 Windows 上用 VS Code 1.136.1 启动 Electron 扩展宿主，激活、命令、打开及复用工作台测试通过。 |
| 发布包 | `skills:check` 校验 4 个角色包。`release:package` 通过；生成的 VSIX 含 531 个文件，归档 CRC、4 个角色指令和包内 README 链接检查通过。 |

Windows 本地结果与托管 CI、分支保护是不同的验收项。目标分支要求的检查名和评审规则见[合并与发布手册](../engineering/handbook.md)。

## 历史分支对照

首轮审计在 `feat/ui-improvements@4f90be01` 进行，工程建设提交为 `99d9028d`。该分支含 22,771 个跟踪文件，其中 21,078 个位于企业实验冻结源码目录，产品和 scripts 有 139 个测试文件。初始诊断包括 Webview 类型错误、Windows 启动 JS 工具失败和测试发现缺口。该分支的 Webview 及实验脚本随后在产品主线上演进或归档。

历史 Windows 验证得到 938 项 Vitest、6 项 Node 与 23 项 Python 实验测试全过，workflow-core 行覆盖 85.76%、分支覆盖 71.28%。这些数字仅用于比较首轮工程建设。企业实验不参与当前产品 CI。主线迁移至 LangGraph 时的 Windows/WSL 运行记录另见[迁移验证](../langgraph-transparent-migration-validation.zh-CN.md)。
