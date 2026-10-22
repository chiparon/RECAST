# 启动指南

## VS Code 工作流

首次安装按[根目录 README 的 Windows / WSL 从零配置](../README.md)准备本平台的 Node、Git、Docker、Codex CLI 和目标语言工具链。新 checkout 先运行 `npm run workspace:check`，缺依赖时执行 `npm ci` 并重新检查。日常从当前平台的仓库根目录运行：

```sh
npm run workspace:check
npm run dev:extension
```

启动器自动拉起已安装的 Docker Desktop、SeekDB、embedding 和 rerank，验证 SQL 和模型健康状态，再打开 RECAST 工作台。没有目标工程也会先启动模型后端，导入目标后再启用工作区翻译。不要手动启动另一个 adaptation 进程。

已运行的 SeekDB 会先通过 SQL 查询确认可用并直接复用，避免 Docker 管理命令暂时超时阻断启动。需要启动 Docker Desktop 时，同时支持系统目录和当前用户目录的安装。

命令会等待扩展内的数据库初始化、语义查询和模型后端完成检查；看到 `RECAST services ready` 才表示启动成功。已有开发窗口会重新加载本次运行配置，避免保留上次的端口和启动模式。后端意外退出后，工作台每 15 秒检查并尝试重新启动。

启动时只加载已有索引，不会自动重扫全部历史仓。首次解析通过“导入历史仓”触发，已有仓库通过刷新索引触发。单个仓库不存在或解析失败，会单独显示待检查／待重试，不代表数据库和模型服务断开。

状态读取短暂超时时，会保留上次加载的仓库列表并明确显示提示，正在运行的导入仍显示当前进度。刷新成功后恢复最新状态；状态读取失败时，验收报告不会判定通过。

首次启动会自动补齐按仓库和版本统计语言信息的索引，避免刷新状态时反复扫描大型符号表。升级可恢复，已有向量和模块结果继续复用。

同一目录的不同构建类型会在项目名称中区分，例如 Maven 和 Node。没有独立文件的构建边界保留在列表中并显示“无需建模”，不会反复调用模型，也不计入已建模数量。

- 已有 SeekDB：`npm run dev:extension -- --skip-seek-db`。外部数据库通过 `CODE_INTELLIGENCE_SEEKDB_HOST` 和 `CODE_INTELLIGENCE_SEEKDB_PORT` 指定；健康检查使用该地址。
- 自行管理依赖：`npm run dev:extension -- --skip-services --skip-seek-db`，并确认实际配置的数据库、embedding/rerank 已就绪。
- 指定工程：`npm run dev:extension -- --folder <path>`。
- 修改源码并重新构建后，在开发窗口执行 **Developer: Reload Window**。

长时间索引使用持久源码快照目录（默认 `~/.cache/recast/source-snapshots`，可用 `FOREXPLORE_SOURCE_SNAPSHOT_DIR` 覆盖），任务结束后清理。源码写入数据库并校验后，向量生成读取对应版本的数据库快照，避免系统清理临时目录导致 `forexplore-source-* ENOENT`。模型 API Key 仍需首次配置，服务健康检查不会调用付费模型。

默认 E5 模型使用可选的原生分词器加速长源码处理。它与推理工具一起安装在独立运行目录，不进入项目依赖；启动时会校验 token、掩码及截断行为，缺失或不兼容时自动回退 JavaScript 分词器，仍可正常启动。模型、源码和向量窗口不变。

## 端口与诊断

外部翻译后端配置地址默认 `http://127.0.0.1:8788`，显式 `forexplore.adaptationApiUrl` 优先，否则使用 `ADAPTATION_PORT`。扩展自动启动的翻译子进程与每个窗口的语义查询服务均由系统分配端口，实际地址见 **输出 → RECAST**；API Key 仍按配置地址保存。只有外部 MCP / 手动后端需要固定地址时，才在启动扩展前设置 `FOREXPLORE_SEMANTIC_QUERY_PORT`；外部客户端必须使用同一地址与令牌。

```sh
npm run services:up
```

该命令检查真实依赖健康状态，不会把“端口能连接”当作服务就绪。失败时检查输出列出的日志：`not serving the configured … model` 表示该端口上的服务模型与配置不匹配；模型下载的 `fetch failed` / `UND_ERR_CONNECT_TIMEOUT` 需要检查模型源网络或模型缓存，不能靠更换索引端口解决。索引异常的详细原因记录在 RECAST 输出中。

模型 Key 在 RECAST **设置 → AI 服务**配置。后端已连接不等于模型请求已授权；没有 Key 时不能声称完成真实翻译。SeekDB、模型配置及独立 HTTP 服务运行方法见[根目录 README](../README.md)和[后端说明](extension-backend-and-evidence.zh-CN.md)。

## 原生 Codex 执行检查

自动创建的隔离 Codex 配置位于平台运行缓存：Windows 为 `%LOCALAPPDATA%/recast/codex-runs`，Linux 为 `${XDG_CACHE_HOME:-~/.cache}/recast/codex-runs`。任务结束后删除本次配置，Key 仅通过环境传递。不要把 `CODEX_HOME` 放进系统临时目录：Codex 会拒绝在那里安装命令和补丁辅助工具。

Windows 自动配置使用无需管理员初始化的 `windows.sandbox = "unelevated"`，仍受机器管理策略约束。企业已经部署 elevated 沙盒时，通过 `ADAPTATION_CODEX_HOME` 提供预配置目录及允许的沙盒实现；系统保留显式目录中的配置，不会自动降低企业权限要求。模型返回执行受阻时，流水线会立即停止并报告原因，不会把进程正常退出当作生成成功。

安装 Codex 后，可运行不调用远端付费模型的真实工具回归检查。它使用本地响应服务驱动已安装 Codex，实际完成沙盒内历史参考读取、目标副本修改和宿主编译：

```powershell
$env:RECAST_CODEX_NATIVE_TEST = '1'
npm exec --workspace @forexplore/adaptation-service -- vitest run src/codex-native-runtime.integration.test.ts
```

Linux 使用 `RECAST_CODEX_NATIVE_TEST=1 npm exec --workspace @forexplore/adaptation-service -- vitest run src/codex-native-runtime.integration.test.ts`。该检查验证执行能力，不代表业务需求已经通过验收。
