# RECAST 开发文档

如果要第一次运行扩展，从[仓库启动说明](../README.md)开始。在 Windows 和 WSL 之间切换前，先核对[本机工作区映射和同步步骤](windows-wsl-workspaces.zh-CN.md)及[仓库规则](../AGENTS.md)。

| 开发问题 | 阅读入口 |
| --- | --- |
| 产品必须满足什么行为？可以看哪个测试？ | [需求与验收矩阵](requirements/README.md) |
| 整个项目如何从需求生成可验收的输出？ | [系统、模块职责与数据流](architecture/system-overview.md) |
| 宿主、HTTP 和 MCP 怎样通信？ | [接口与错误处理](architecture/api.md) |
| 谁可以决定工作区的可写文件？ | [ADR-001 模块翻译范围](decisions/ADR-001-host-owned-translation-scope.md) |
| 如何复现失败或增加回归测试？ | [分层测试策略](testing/testing-strategy.md) |
| 什么条件下可以合并或发布？ | [研发与发布手册](engineering/handbook.md) |
| 当前基线、风险和下一步是什么？ | [仓库审计](maintenance/repository-audit.md)、[静态分析](maintenance/static-analysis.md)、[技术债](maintenance/technical-debt.md)、[变更记录](maintenance/changelog.md) |

产品操作以[企业用户指南](user-guide/README.zh-CN.md)为入口。整个项目的执行和恢复见[LangGraph 验证记录](langgraph-transparent-migration-validation.zh-CN.md)，生成的测试如何随输出项目交付见[保留测试](retained-tests.zh-CN.md)。部署与维护索引见[SeekDB 配置](seekdb-docker-setup.md)。实验数据、历史脚本和材料在[归档分支](archive.md)独立复现。
