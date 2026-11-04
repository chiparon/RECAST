# RECAST 项目内 Agent skills

Analyzer、Translator、Integration、Verifier 的稳定指令现在由仓库内的 Markdown 维护，现有执行阶段明确选择对应 skill。企业可以集中查看、修改和版本管理这些指令。首次迁移保持实际发送给模型的文本、段落顺序和空行一致，使用者操作方式不变。

## 文件与调用关系

| 阶段 | 入口 | 实际使用的资料 | 选择位置 |
| --- | --- | --- | --- |
| Analyzer | [SKILL.md](../skills/analyzer/SKILL.md) | `instructions.md`：模块／集成角色、只读范围、历史证据、计划输出 | `codex-workspace-translation-runtime.ts` 的 `analyzerPrompt` |
| Translator | [SKILL.md](../skills/translator/SKILL.md) | `planned.md`：按计划实现；`direct.md`：已有直接实现分支 | 同一文件的 `translatorPrompt`／`directTranslatorPrompt` |
| Integration | [SKILL.md](../skills/integration/SKILL.md) | `instructions.md`：完整项目检查、实现修复、集成报告 | 同一文件的 `integrationPrompt` |
| Verifier | [SKILL.md](../skills/verifier/SKILL.md) | `source-function.md`、`source-group.md`、`requirement-group.md`；分组报告和 Host 结束指令 | 原有策略创建任务，Host 追加测试环境及结束指令 |

这些是 **RECAST 随项目分发、显式装配的 skill 包**。无需安装到个人 `.codex/skills`，无需模型自主发现或选择。`SKILL.md` 负责说明用途与资料路由；运行时只插入被调用的具名指令段，避免额外加入说明文字改变提示词。

每份参考文件按 `## section-id` 分段，紧接一个 `text` 围栏代码块。代码块内是原始提示词，空格和换行会保留。引用形如：

```ts
skillInstruction("translator", "planned/read-plan")
```

需求、文件列表、历史路径、协议、编译错误和验证反馈仍由原有代码组装。工具实现、权限、运行时绑定、超时、重试、验收条件及 LangGraph 状态流仍由代码管理。补丁工具使用方法、证据文件说明等依赖 Host 实现的说明继续与对应工具代码放在一起。本批次不包含其他建模、检索重排、协议规划或纠错复核提示词。

## 如何修改与生效

1. 在运行平台对应的 checkout 修改 `skills/<name>/references/*.md` 中的指令；保留已有段落 ID。
2. 执行 `npm run skills:build`，更新 `skills/compiled.mjs` 与类型声明。两份生成文件应随 Markdown 一起提交，不要手工修改。
3. `npm run dev:extension` 的扩展构建会自动重新编译 skills；独立 adaptation 服务的 `dev`、`start`、`build` 也会自动编译。运行中的进程需要重新启动或重载。开发监听服务中修改 Markdown 后，应重启该服务。
4. 发布时重新构建／打包 VSIX。运行指令会内嵌到扩展和后端 bundle；Markdown 也复制到扩展 `dist/extension/skills` 供查阅。修改已安装扩展的这些 Markdown 副本不会热更新运行指令，应修改源码后重新构建发布。

```sh
npm run workspace:check
npm run skills:build
npm run test:skills
npm run build:extension
```

没有新增运行时依赖或模型请求。运行时不搜索当前工作目录、不读取个人配置，也不依赖安装机器拥有源码目录。`skillVersions` 导出每个 skill 的内容 SHA-256，便于构建对比；它不是新的执行门禁。

Windows 与 WSL 使用同一套指令源码，仍按平台维护各自依赖和构建输出。跨平台操作前使用已有 `npm run workspace:sync -- --to wsl`／`--to windows`；同步已覆盖 skills 和生成类型声明。

## 验证范围

`npm run test:skills` 检查：

- 105 份迁移前采集的完整提示词指纹，涵盖普通／集成任务、计划／直接实现、空／长上下文、编译及验证反馈、全局／模块协议，以及 Verifier 三种任务和 Host 追加指令。平台相关补丁启动命令单独归一化，其实现未改。
- Markdown 与生成指令一致。
- 真正构建 CJS 后放到独立临时目录执行，输出与源代码执行一致；运行时无需 Markdown 路径。

基线保存在 `scripts/agent-skill-prompts.baseline.json`，用于证明本次迁移没有改写提示词。日后有意修改指令时，对应指纹应当改变：评估行为变化后更新预期，不能将重新生成指纹当作效果验证。现有翻译、Verifier 和流水线测试继续覆盖工具执行和验收行为；这次文本等价迁移不宣称提升模型效果。
