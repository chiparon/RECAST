# 贡献指南

`main` 维护产品、必要测试夹具和企业使用说明。历史实验、研究材料与第三方快照在独立归档分支，需要复现实验时另建 checkout。[归档说明](docs/archive.md)

1. 新 checkout 先用 `npm run workspace:check -- --before-install` 核对平台与目录，再依次运行 `npm ci` 和 `npm run workspace:check`。依赖已就绪的工作区直接运行后者。[工作区约束](AGENTS.md)
2. 按模块归属修改代码和测试。工作台与项目流水线归扩展宿主，数据形状归 contracts，工作流端口归 workflow-core，索引、适配和验证由相应服务拥有。应用和服务依赖共享契约与核心，workflow-core 只依赖 contracts。验证器按 workflow → strategy → host 分层。[职责与依赖表](docs/architecture/system-overview.md)
3. 产品回归输入放在 `fixtures/` 或相应服务的夹具目录，运行工具在 `scripts/`。提交源码与可复现的测试输入。面向企业的使用变更同步更新用户指南；改动角色指令时同时更新源 Markdown 与编译结果。[用户指南](docs/user-guide/README.zh-CN.md)、[Agent 指令维护](docs/agent-skills.zh-CN.md)
4. 缺陷修复补回归用例，核心业务变更附测试，跨包协议至少覆盖一个真实调用方。单独定位开发脚本和验证器问题可运行 `npm run test:scripts`、`npm run test:verifier`。编译器、SeekDB 或在线模型验收在具备前置条件的环境中运行并记录结果。[需求与验收](docs/requirements/README.md)、[测试分层和命令](docs/testing/testing-strategy.md)
5. PR 前运行 `npm run quality`，在模板中写明执行结果、外部环境验证和变更文档。关键模块至少一次非作者评审，重大架构变更附 ADR。[研发与发布手册](docs/engineering/handbook.md)
