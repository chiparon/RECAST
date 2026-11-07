# 日常开发、评审与发布

## 工作区与代码归属

1. 在当前平台的 worktree 检查分支、HEAD 和本地改动。新 checkout 或依赖清单有变化时，按 [AGENTS.md](../../AGENTS.md) 依次运行 `npm run workspace:check -- --before-install`、`npm ci` 和 `npm run workspace:check`。已有依赖的工作区执行最后一步。Windows 与 WSL 在相同 HEAD 上通过 `workspace:sync` 同步源码，分别保留原生依赖与构建产物。
2. 在与需求相关的分支修改[拥有该职责的模块](../architecture/system-overview.md)。用已有的契约和端口表达跨模块调用。将测试替身放在测试侧，生产模块通过包公开的入口引用其他 workspace。
3. 在接收 JSON 或 Webview 消息的位置验证外部输入。明确区分校验失败、取消、部分完成和可重试的失败；已产生文件写入但响应丢失时尤其要检查状态。[相关回归用例](../../apps/vscode-extension/src/module-translation-handoff.test.ts)
4. 记录诊断时保留操作类型、运行 ID 和失败原因。模型密钥、Bearer 令牌和本机历史源码路径只在拥有权限的宿主或进程中使用。MCP 的启动日志写 stderr，stdout 留给协议。[语义 MCP 启动入口](../../services/semantic-index-mcp-server/src/server.ts)

## 提交和 PR

提交主题说明改变的行为，可采用仓库已有的 `fix(scope): ...`、`feat(scope): ...` 或 `docs: ...`。提交前检查暂存差异，去掉开发者配置、运行缓存和实验结果。角色指令同时更新源 Markdown 与约定提交的编译文件；用 `npm run skills:check` 校验一致性。相关变更需附现有提示词测试或行为用例。[角色指令规范](../agent-skills.zh-CN.md)安装依赖的变更需一起审查清单和锁文件。

在 PR 模板中填入复现或验收方法。核心逻辑变更附相应测试，跨模块协议至少有一个调用方测试。缺陷修复补回归用例，确实无法自动化时记录原因及可复现的替代检查。对外行为变更同步[需求](../requirements/README.md)和[接口说明](../architecture/api.md)。改变模块责任、依赖方向、写入权限或持久化格式时，提交包含迁移路径及验证方法的 ADR。用 `npm run check:docs` 核对治理文档到实现和测试的本地链接，再由评审者核对内容。[既有决策示例](../decisions/ADR-001-host-owned-translation-scope.md)

## 合并条件

- 作者在本地运行 `npm run quality`，处理失败。需要外部环境时列出已执行与待执行的具体用例。评审者复核用户行为和证据，确认新测试能在实现出错时失败。
- 更改 contracts、workflow-core、索引版本/存储、宿主写入或凭据逻辑，至少由一位熟悉相应模块的其他开发者批准。涉及多个模块时同时核对调用方、旧数据兼容、取消与重试。
- PR 的 `Repository quality` 成功且评审意见已解决才能合并。仓库管理员应在目标分支 ruleset 中要求 PR、一次非作者批准和该状态检查；工作流首次运行后选择实际出现的检查名。工作流文件能报告状态，强制阻止合并依赖托管平台上的规则。

## 发布扩展

1. 选择已通过评审的提交，确定扩展版本。在[扩展 manifest](../../apps/vscode-extension/package.json)与锁文件中核对版本；若同批发布内部包，同步其声明及直接消费者的版本引用。记录面向用户的行为变化、兼容性和回退办法。[变更记录](../maintenance/changelog.md)
2. 在干净 checkout 按上面的三步完成平台检查与安装，再运行 `npm run release:check`。发布检查执行质量门禁、核对扩展版本，并在新建的临时目录准备发布文件和打包 VSIX。任一环节失败均需修复并从该候选提交重新验证。[打包入口](../../apps/vscode-extension/package-release.mjs)
3. 在目标 VS Code 版本中安装 `apps/vscode-extension/dist/recast.vsix`，打开测试工程，验证命令和工作台。涉及写入、存储或翻译的变化，额外跑相应的[外部环境验收](../testing/testing-strategy.md)。保留提交 SHA、版本、VSIX 与验证结果。
4. 由发布负责人以该提交建立 `v<扩展版本>` 标签。CI 会核对标签与 manifest，并将各平台打包的 VSIX 上传为工作流产物。按团队渠道分发对应平台的包。回退时重新安装上一个已验证版本。涉及数据库格式的发布，应在发布说明中给出可用的备份、恢复步骤和兼容范围。
