# LangGraph 无感替换实施验证记录

日期：2026-11-03。行为对照基线：`d6b17b319b49d3b27fcf10f8c1ebee69763d3a75`。

## 实现范围

项目级主流程现由 `project-pipeline-graph.ts` 的 LangGraph 状态图编排：准备或恢复、选择模块、检索、生成、项目集成、最终验收、有限集成修复、提交。生产入口已切换到该图，没有新增用户选项，也没有任务失败后自动切换另一执行器的路径。

图维护模块游标、集成游标、验收尝试和路由状态；原 `ProjectPipelineRun`、消息快照和 `run.json` 继续使用同一个业务状态更新来源。原入口、恢复预检、保存队列、取消、清理和报告机制保留。旧编排仅作为测试目录中的固定行为基线，不进入产品 bundle。

本次未增加 worker、并行执行、模型角色、模型调用、自动重试、检查点数据库或验收条件。保留串行处理、原提示词与工具、2 小时 Codex 配置、原修复预算、保护规则，以及 `compilation-only` / `behavior-verified` 的原判定。

Verifier 和 Translator 产品代码没有修改；Webview 交互和消息结构没有修改。退出扩展宿主后的恢复仍按原中断记录及用户继续操作处理。

## 迁移中处理的框架差异

1. **Verifier 会话隔离**：LangGraph 节点的隐式上下文会让内部 Agent 的同一反馈会话落入不同检查点空间。现有宿主能力在清空外层图配置的上下文中执行，保留 Verifier 原 Agent、MemorySaver 和会话历史。实际 Agent 与内部图的回归用例在修复前均复现历史丢失，修复后通过。
2. **启动时序**：保持 `start/resume` 立即进入原准备操作，再由图的首节点接收该操作，避免把原初始保存失败行为改变。
3. **取消顺序**：图不抢先中断正在运行的宿主操作；继续沿用原操作级 AbortSignal，等待子操作结束后进入原清理和最终快照流程。
4. **错误文本**：框架会给异常附加属性，因此将字符串或被冻结的异常归一化为可写 Error，保留原错误信息。
5. **执行步数**：显式使用足够大的图步数配置，不把框架默认步数限制引入为项目规模限制。业务预算仍由原实现控制；没有节点级框架重试。

## 验证结果

| 验证项 | Windows | WSL / Linux |
| --- | --- | --- |
| 平台工作区检查、扩展类型检查 | 通过 | 通过 |
| 扩展构建 | 通过 | 通过 |
| `npm test` 全仓回归 | 通过；其中扩展当次 435 项通过，随后新增磁盘兼容 8 项单独通过 | 通过；扩展 442 项通过、1 项平台用例跳过，包含磁盘兼容测试 |
| `npm run test:verifier` | 217 通过、1 跳过 | 213 通过、5 跳过 |
| `npm run test:scripts` | 70 项及同步脚本 7 项通过 | 70 项及同步脚本 7 项通过 |
| VSIX 打包 | 通过，20.37 MB | 通过，20.06 MB |
| 真实 VS Code 宿主 | 构建扩展激活、打开工作台及面板复用通过 | 未运行图形宿主 |
| Windows 安装包内容加载 | 从 VSIX 解包后使用独立配置与扩展目录加载，激活和面板用例通过 | 不适用 |

专项测试包括：

- `project-pipeline-equivalence.test.ts`：25 项，受控响应下对照新旧业务调用、进度快照、保存记录及最终状态；覆盖修复上限、验收等级、硬性阻断、取消、恢复、发布失败、保存失败、异常原文、旁路字段和 80 个串行模块。
- `project-pipeline-graph.test.ts`：2 项，使用实际 LangChain Agent 和实际内存检查点图，验证独立会话及累计状态不受外层图影响。
- `project-pipeline-compatibility.integration.test.ts`：8 项，旧到新、新到旧两个方向，分别覆盖失败、取消、中断和 Integration 失败。实际执行磁盘快照、原恢复预检、部分生产写入和交付测试恢复、Node 编译、固定测试、交付测试重放、Git 提交及测试文件跟踪。
- 原有项目集成测试继续实际运行生成工具链、Codex staging、编译器、最终验收及隔离 Git 交付；模型输出由确定性测试替身提供。

中断兼容测试使用执行器真实产生的写前运行记录和磁盘上实际写后文件模拟崩溃窗口，不声称执行了真实进程强杀实验。

## 环境与复现说明

WSL 与 Windows HEAD 核对一致后，通过仓库同步命令同步未提交源码，在 WSL 自己的目录执行 `npm ci --offline`。两端依赖和构建目录独立，WSL 原有三处 XML fixture 修改保留。

Windows 的受限测试临时目录路径过长会触发 Git 路径问题，已在测试命令中将 TEMP/TMP 指向工作区内短路径；本机服务和文件链接相关集成用例在正常本机权限下重验通过。没有为绕开这些测试环境问题修改产品逻辑。

原打包脚本不能自动解析 README 的远端相对链接，打包时显式提供内容和图片基址。打包扫描另把 LangSmith 源码映射中的 TypeScript 类型名称 `Auth.SandboxesSandboxAwsMountRoleAuthConfig` 误识别为 AWS 密钥；确认其来源是第三方类型声明后，仅在本次打包命令中允许该类别。没有更改产品扫描规则或加入任何密钥。

```text
npm run package --workspace forexplore-vscode -- \
  --baseContentUrl https://github.com/chiparon/RECAST/blob/main/apps/vscode-extension/ \
  --baseImagesUrl https://raw.githubusercontent.com/chiparon/RECAST/main/apps/vscode-extension/ \
  --allow-package-secrets aws
```

该命令以通用多行形式展示；PowerShell 可合并为一行执行。

## 真实模型补测

使用用户已授权的 DeepSeek 密钥进行 Windows 补测，密钥仅通过测试进程环境传入，没有写入源码、测试配置或报告。模型为 `deepseek-flash`，接口为 `https://api.deepseek.com`。

| 测试 | 实际结果 |
| --- | --- |
| 鉴权与直接请求 | `/models`、`/responses` 均返回 HTTP 200；最小 Responses 请求返回 `OK`，约 11 秒 |
| 原生 Codex 最小请求 | 最终返回 `OK`，退出码 0，耗时 320,322 ms；期间有多次 HTTP 503 和 SSE 空闲超时重连 |
| 原生 Codex 直连对照 | 仅调整该测试子进程的代理环境，最终返回 `OK`，退出码 0，耗时 258,217 ms；同样出现 HTTP 503 和响应流提前关闭，因此不能仅归因于本机代理 |
| 新项目图与生产后端 | 已实际执行项目快照、Integration Plan 和第一个模块的原生 Codex 生成；约 20 分 47 秒后失败，未进入编译、Verifier、最终验收或发布 |

完整任务运行编号：`b41eca98-4120-45d0-9584-f2a524bb71e4`。运行时间为 2026-11-03 10:12:38—10:33:24 UTC，进程清理及摘要写入在其后完成。最终状态为 `failed / unverified`，首模块 `subtotal` 失败，依赖它的 `checkout` 保持待执行。原始骨架内容一致性断言通过，没有产出可交付项目或最终交付 Git 提交。

原生 Translator 退出码为 1，错误证据包括：

```text
unexpected status 503 Service Unavailable: Service is too busy.
stream disconnected before completion: idle timeout waiting for SSE
```

这是本次失败的直接外部请求证据，并非触发 2 小时翻译时间上限；不能据此认定 LangGraph 引入了故障，也不能宣称真实模型项目验收通过。最小请求独立于项目状态图，同样复现上游繁忙与响应流中断。另有原生 Codex 插件同步的路径过长和 GitHub 限流告警，但最小请求仍能完成，不能将这些告警直接认定为此次流水线退出原因。

补测使用两个有依赖关系的 JavaScript 模块及固定验收脚本，调用生产 `ProjectPipelineBackend`、Codex Translator 和模块验证入口。模块目录为固定测试输入，没有配置历史参考仓库，走产品支持的直接生成路径；未覆盖真实仓库导入、索引、历史检索和前端交互。编译与验证入口虽已接好，但本次未运行到这些阶段。未增加门禁、业务重试、产品超时或模型角色。

本地证据保存在被 Git 忽略的 `tmp/lg-live-real/summary.json`、对应 `storage/project-pipelines/<运行编号>/run.json`、`tmp/langgraph-live-real.log` 以及两个 `tmp/langgraph-codex-*-probe.log`。这些运行数据没有作为产品源码提交。

## 2026-11-03 重试与运行器诊断

在同样的模型、需求、模块依赖及原有预算下重新执行，上一轮服务繁忙导致的阻断没有持续阻止本轮项目生成。

第一轮重试编号为 `e4638127-9ee7-487a-96a5-d8a1a92b02bb`，耗时 395,370 ms，实际完成两个模块生成、项目集成、最终编译、固定需求验收和独立输出项目 Git 提交。固定验收输出为 `fixed acceptance passed`，保护文件一致性通过，交付提交为 `579d7a62d2ed9f244d80069c7417d1bf2bf517de`。最终状态是 `completed / compilation-only`，不是 `behavior-verified`：测试夹具声明了 `tests/` 却遗漏该目录，Verifier 在环境预检阶段退出，没有交付生成测试。

补齐目录后的中间尝试还发现，夹具原先借用的仓库 Vitest 安装没有 `@vitest/coverage-v8`。实际测试启动错误为 `ERR_MODULE_NOT_FOUND`，故该尝试被主动结束并保留 `test-interruption.json`，不计为自然完成或通过。随后仅在 Git 忽略的 Windows `tmp/` 测试目录安装官方 `vitest@4.1.10` 与 `@vitest/coverage-v8@4.1.10`，改用同一完整安装中的 CLI；独立真实测试及 V8 覆盖率预检通过，未更改仓库产品依赖。

完整工具链补测编号为 `140144af-f54b-4c3d-bb05-f10e6e563852`，证据目录为 `tmp/lg-live-retry-ready-20261103/`，日志为 `tmp/langgraph-live-retry-ready-20261103.log`。该补测于 10:52:32 UTC 启动、11:06:17 UTC 主动结束：两个模块均已生成并编译，首模块验证完成后保留 `agent-uncertain`；第二模块验证中再次遇到下述覆盖率参数问题及原有 48 次调用预算。为避免对已复现问题继续重复模型请求，结束测试进程，保留 `test-interruption.json`、`test-summary.json` 和 `verification-snapshots/`。这属于测试主动中断，不是自然完成、自然失败或已发布项目；中断时的业务 `run.json` 原样保留，不能将其 `running` 字段理解为测试仍在执行。

结束后在该补测已生成的输出副本实际执行 `node build.mjs` 和 `node acceptance.mjs`，分别输出 `build passed` 与 `fixed acceptance passed`。没有运行到该次补测的项目集成、最终 Verifier、交付测试重放或发布，也没有把手工固定验收表述为完整行为验收。此前第一轮 `compilation-only` 交付结果与本次中断结果分别保留。

### 已复现的既有覆盖率参数问题

生产 Verifier 的 `services/translation-verifier/src/host/testing/test-runner.ts` 将所有目标函数的路径用逗号拼成一个 `--coverage.include` 参数。同一个模块文件包含多个函数时会产生如下参数；多个不同文件也存在相同拼接风险：

```text
--coverage.include=src/subtotal.js,src/subtotal.js
```

用实际生成的同一份测试，在独立副本中分别执行两个参数对照，两次测试运行退出码均为 0：

| 参数 | 真实覆盖率结果 |
| --- | --- |
| `--coverage.include=src/subtotal.js,src/subtotal.js` | `coverage-final.json` 为空对象，没有覆盖到源文件 |
| `--coverage.include=src/subtotal.js` | 覆盖 1 个真实源文件；两个函数调用计数分别为 32、18 |

这能解释本轮部分测试全绿、Host 仍不能接受行为结论的现象。首模块原有 Verifier 重试期间实际最多记录了 43 个通过测试，但遇到了模型调用/反馈预算耗尽，保留 `agent-uncertain`。已通过 `git show` 确认，迁移前基线 `d6b17b319b49d3b27fcf10f8c1ebee69763d3a75` 已包含同一拼接代码；它不是项目级 LangGraph 替换引入的新代码。本次重试记录问题，不修改产品覆盖率参数、预算、门禁或验收规则。

独立对照证据位于 `tmp/lg-coverage-diagnose-20261103/` 下的 `probe-comma-coverage/coverage-final.json`、`probe-single-coverage/coverage-final.json` 及对应测试报告。该副本独立于活动 Verifier，没有向正在验收的项目注入报告。

## Vitest 覆盖率参数修复

后续按用户要求修复上述问题：仅在 Host 的 Vitest 运行器中，将目标函数的文件路径去重，再逐个传入独立的 `--coverage.include=<path>` 参数。原有模型预算、反馈轮数、覆盖率证据要求及最终验收规则保持不变，未修改 Verifier 提示词或结论策略。

新增同文件多函数、跨文件函数两项回归用例，修复前均实际失败，修复后通过。Windows Verifier 全量回归为 219 通过、1 跳过；WSL 为 215 通过、5 跳过。两端扩展类型检查和构建均通过。

另通过生产 `bindFunctionGroupTestRunner` 实际运行官方 Vitest/V8：同文件两个函数的报告包含 1 个源文件，跨文件场景包含 2 个源文件，所有被调用函数均判为已执行；特意未调用的函数仍为 `unverified / executed=false`。跨文件场景包含带空格和逗号的真实路径。Windows、Linux 两端均通过，确认修复没有把未执行函数误报为通过。证据分别位于两端工作区的 `tmp/verifier-coverage-fix-check.json`，测试依赖各自安装于本平台的忽略目录。

修复后使用相同真实模型及夹具重跑，运行编号为 `a7b2a151-2bba-4e57-aeb9-c6be73cbb2c1`，证据目录为 `tmp/lg-live-coverage-fixed-20261103/`，日志为 `tmp/langgraph-live-coverage-fixed-20261103.log`。生成阶段两个模块的 Verifier 均已取得 `verified`：`subtotal` 实际执行 13 个测试，`checkout` 实际执行 11 个测试。此前空覆盖率阻碍已消除，未再触及此前 48 次模型调用预算。

该轮真实模型端到端任务最终自然完成，耗时 365,949 ms（约 6 分 6 秒），状态为 **`completed / behavior-verified`**，不是 `compilation-only`。实际完成：

- 两模块生成、编译与模块 Verifier 验证。
- 主动项目集成及完整输出项目编译、固定需求验收。
- 最终源码上的模块重新验证：`subtotal` 13 个测试通过、`checkout` 20 个测试通过，两者均为 `verified`。
- 两个模块交付测试在最终输出目录重放，退出码 0，失败模块清单为空。
- 最终测试重放前后源码哈希一致，保护文件一致性通过，原始骨架内容一致性断言通过。
- 独立输出项目原子提交成功，交付提交为 `167b96190d0a003ee1c1ddd4e207194b9340b641`。

最终输出位于 `tmp/lg-live-coverage-fixed-20261103/storage/project-pipelines/a7b2a151-2bba-4e57-aeb9-c6be73cbb2c1/project/`。上述提交属于生成项目的独立 Git 仓库，本次没有提交或推送 RECAST 仓库。测试报告、交付测试及完整运行记录保留在忽略目录内。成功结果的范围仍是 Windows 真实模型双模块夹具与生产后端，未扩大为真实仓库导入、历史检索或所有语言验证。

## 验证边界

严格等价结论仍来自确定性新旧对照；真实文件、编译、测试、框架 Agent、宿主加载、Git 提交和恢复已在前述专项测试中实际执行。真实模型补测先记录了上游请求失败与 `compilation-only` 交付，修复既有覆盖率参数问题后，已取得上述双模块夹具 `behavior-verified` 的完整交付证据。

产品代码替换、双平台回归和前述安装包加载已经完成；本次覆盖率修复后，两端扩展已重新构建，未重新打包 VSIX。本次未提交或推送 RECAST 仓库 Git。
