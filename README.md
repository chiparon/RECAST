# RECAST

## 从零配置：先选运行平台

支持 Windows 原生和 WSL2。**两种方式的源码目录、`node_modules`、扩展 `dist` 和推理运行时分别维护**。Windows 使用 Windows Node，WSL 使用 Linux Node；不要在 `/mnt/c`、`/mnt/e` 等 Windows checkout 中执行 Linux 的 `npm ci`。

建议配置：Node.js **24 LTS**（含 npm）、Git、VS Code、Docker Desktop（Linux containers），以及至少 8 GB 可用内存。首次启动需要联网安装推理依赖、下载 SeekDB 镜像和 embedding/rerank 模型。GPU 可选，默认 CPU 路径也能运行。

项目生成还需在**运行扩展的同一平台**安装 Codex CLI 和所选目标语言工具链：

| 目标工程 | 需要的工具 |
| --- | --- |
| Java | JDK（示例工程使用 21）、Maven；按工程设置 `JAVA_HOME` |
| C# | .NET SDK（示例工程使用 8） |
| C / C++ | CMake 3.21+、本平台编译器；自动行为验证使用 GCC/G++ 和同版本 gcov（Windows 可用 MinGW-w64） |
| TypeScript / JavaScript | Node.js/npm、工程自身依赖 |
| Python | Python 3；Windows 确认 `python --version` 可用 |
| Go / Rust | Go / Rust 工具链，按目标工程版本安装 |

只需安装实际使用的语言工具链。验证器可能需要对应测试依赖，目标工程应能先在本平台独立构建和测试。

C／C++ 已接入目标工程识别、模块生成、CMake 构建及 CTest＋gcov 行为验证。默认支持提供可链接库目标的 CMake 工程；多个库可显式指定测试目标。Makefile、仅有可执行程序的工程，以及 MSVC／Clang 的覆盖率验收需要单独适配，详见 [C／C++ 配置与支持边界](docs/c-cpp-support.zh-CN.md)。

### Windows 原生

1. 安装软件，可在 PowerShell 中使用 winget：

   ```powershell
   winget install --id Git.Git -e
   winget install --id OpenJS.NodeJS.LTS -e
   winget install --id Microsoft.VisualStudioCode -e
   winget install --id Docker.DockerDesktop -e
   ```

   按安装器要求重启系统，首次打开 Docker Desktop 完成初始化，选择 WSL2/Linux 容器后端。重新打开 PowerShell，确认命令可用：

   ```powershell
   git --version
   node --version
   npm --version
   code --version
   docker compose version
   docker info
   ```

2. 克隆到 Windows 本地目录，安装本平台依赖和 Codex CLI：

   ```powershell
   git clone https://github.com/chiparon/weichai.git E:\work\recast
   Set-Location E:\work\recast
   npm run workspace:check
   npm ci
   npm run workspace:check
   npm install --global @openai/codex
   codex --version
   ```

   全新 checkout 的第一次 `workspace:check` 会提示缺少平台依赖，执行 `npm ci` 后应通过。若提示目录属于另一平台，先修正工作目录。npm 全局命令未找到时重新打开终端。

3. 指定自己的索引数据库并启动：

   ```powershell
   $env:CODE_INTELLIGENCE_SEEKDB_DATABASE = 'recast'
   npm run dev:extension
   ```

   数据库名可选，建议首次部署显式设置并保持不变。当前未设置时，普通入口默认名称为 `forexplore_javafileupload_flow_20260913`。

### WSL2 / Ubuntu

1. 在 Windows 管理员 PowerShell 中安装 WSL2（已安装可跳过），按提示重启并完成 Linux 用户初始化：

   ```powershell
   wsl --install -d Ubuntu-24.04
   wsl --set-default-version 2
   ```

   Windows 安装 VS Code、Docker Desktop。在 Docker Desktop 的 **Settings → Resources → WSL integration** 启用该 Ubuntu 发行版；VS Code 安装 **WSL** 扩展。无需在 WSL 再安装另一套 Docker Desktop 或完整 VS Code。

2. 以下命令全部在 **Ubuntu 终端**执行，安装 Linux Node.js 24 和基础工具：

   ```bash
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl git build-essential python3 python3-venv
   curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/recast-node-setup.sh
   sudo -E bash /tmp/recast-node-setup.sh
   sudo apt-get install -y nodejs
   node --version
   npm --version
   command -v node
   code --version
   docker compose version
   docker info
   ```

   `command -v node` 应指向 Linux 路径（如 `/usr/bin/node`），不能指向 `/mnt/c/.../node.exe`。`code` 来自 Windows VS Code 的 WSL 集成；不存在时先从 Windows 通过 **WSL: Connect to WSL** 打开一次该发行版。`docker info` 失败时检查 WSL integration。

3. 克隆到 Linux 文件系统，安装 Linux 依赖和 CLI：

   ```bash
   mkdir -p ~/src
   git clone https://github.com/chiparon/weichai.git ~/src/recast
   cd ~/src/recast
   npm run workspace:check
   npm ci
   npm run workspace:check
   mkdir -p ~/.local
   npm install --global --prefix ~/.local @openai/codex
   export PATH="$HOME/.local/bin:$PATH"
   codex --version
   ```

   第一次检查缺依赖的含义同 Windows。把上面的 PATH 设置加入 `~/.profile` 以便以后使用。Java 示例可用 `sudo apt-get install -y openjdk-21-jdk maven`；其他语言按所选工程安装 Linux SDK。

4. 在 WSL 工作目录启动：

   ```bash
   export CODE_INTELLIGENCE_SEEKDB_DATABASE=recast
   npm run dev:extension
   ```

   开发窗口应显示 **WSL: Ubuntu-24.04**，扩展与编译器在 Linux 中执行。不要从 Windows PowerShell 对 Linux checkout 安装或构建。

## 首次启动与模型配置

日常在对应平台的仓库根目录执行：

```sh
npm run dev:extension
```

启动器会准备或复用 Docker/SeekDB、安装独立推理运行时、启动 embedding 和 rerank、构建扩展并打开开发窗口；扩展负责启动适配后端。它会检查 SQL、模型身份及宿主状态。终端出现 **`RECAST services ready`** 才表示服务启动完成。npm 项目依赖和目标语言 SDK 需按上文预先安装。

首次下载可能超过默认等待时间，可在启动前延长准备预算（毫秒）：Windows `$env:RECAST_SERVICES_WAIT_MS = '900000'`；WSL `export RECAST_SERVICES_WAIT_MS=900000`。失败后重新执行入口，已有缓存会复用。

在新打开的 RECAST 工作台中：

1. 打开 **设置 → AI 服务**，填写提供方、API Base、模型名和 API Key，保存。默认 DeepSeek 配置可按账号实际支持的模型调整。
2. 导入目标骨架，添加历史参考仓库；多个历史仓串行导入，工作台显示进度，使用建模完成的结果进入后续流程。
3. 输入需求，点击 **开始执行**。没有历史参考时可按需求直接实现；跨模块集成和行为验证属于后续验收链路。

Key 保存在 VS Code SecretStorage，由宿主交给后端，不写入 Git 或 Webview 配置。Windows 与 WSL 首次分别配置。**服务绿色只表示依赖就绪，不等于模型授权成功或业务验收通过。** 普通扩展入口无需复制 `.env`，只在 shell 设置 `DEEPSEEK_API_KEY` 也不能代替工作台保存凭据。

流水线通过 Codex CLI 调用支持 **Responses API** 的模型端点，部署前需确认协议兼容；仅兼容 Chat Completions 的代理不能直接代用。企业可用 `ADAPTATION_CODEX_COMMAND` 指定 CLI、`ADAPTATION_CODEX_HOME` 指定配置目录。自动隔离配置保存在平台缓存中，任务结束后删除，不覆盖个人配置。

### 缓存、模型源与端口

| 配置 / 服务 | 默认值或用途 |
| --- | --- |
| `FOREXPLORE_MODEL_CACHE` | 当前用户 `~/.cache/forexplore-model-cache`，可改到自选持久目录 |
| `FOREXPLORE_MODEL_HOST` | 冷缓存默认 `https://hf-mirror.com`；可设 `https://huggingface.co` 或兼容企业源 |
| `FOREXPLORE_EMBEDDING_TOOLS` | Windows `%LOCALAPPDATA%/recast/embed-tools`；WSL `~/.cache/recast/embed-tools` |
| `FOREXPLORE_SOURCE_SNAPSHOT_DIR` | `~/.cache/recast/source-snapshots` |
| SeekDB SQL | `127.0.0.1:2881`，Compose 使用持久数据卷 |
| embedding / rerank | `127.0.0.1:4021` / `127.0.0.1:4022` |
| 扩展适配后端、语义查询 | 每个窗口分配空闲端口，地址见 **输出 → RECAST** |

可在启动前设置，例如：

```powershell
# Windows PowerShell，可选
$env:FOREXPLORE_MODEL_CACHE = 'D:\recast-cache\models'
$env:FOREXPLORE_MODEL_HOST = 'https://huggingface.co'
```

```bash
# WSL，可选
export FOREXPLORE_MODEL_CACHE="$HOME/.cache/recast-models"
export FOREXPLORE_MODEL_HOST=https://huggingface.co
```

推理工具独立于仓库依赖，不要将 ONNX/Transformers 安装进项目 `node_modules`。默认 CPU 路径无需 CUDA；后续更换 embedding 模型或变体时保持索引维度和模型身份一致。

外部 SeekDB 设置 `CODE_INTELLIGENCE_SEEKDB_HOST`、`CODE_INTELLIGENCE_SEEKDB_PORT`、`CODE_INTELLIGENCE_SEEKDB_USER`、`CODE_INTELLIGENCE_SEEKDB_PASSWORD` 和 `CODE_INTELLIGENCE_SEEKDB_DATABASE`，再用 `npm run dev:extension -- --skip-seek-db`。自行管理模型服务时再加 `--skip-services`，提供匹配端点。不要为了重试初始化而删除 `seekdb-data` 数据卷。

## 同时维护 Windows 与 WSL checkout

仅使用一个平台时无需此配置。两边协作时，在两个 checkout 中各放一份相同的 `.recast-platforms.json`，路径按实际用户、盘符、发行版修改：

```json
{
  "windowsRoot": "E:\\work\\recast",
  "windowsMountRoot": "/mnt/e/work/recast",
  "wslRoot": "/home/your-linux-user/src/recast",
  "wslDistribution": "Ubuntu-24.04"
}
```

此文件与 `.recast-platform-sync.json` 均已忽略，不提交 Git。两边 Git HEAD 必须相同；已提交变更先通过 Git 更新，再同步未提交源码：

```sh
# Windows -> WSL，在 Windows checkout 执行
npm run workspace:sync -- --to wsl

# WSL -> Windows，在 WSL checkout 执行
npm run workspace:sync -- --to windows
```

同步不复制 `node_modules`、`dist`、本地凭据、缓存或实验运行结果。目标平台运行 `workspace:check`；依赖清单变化时在目标目录执行 `npm ci`，再分别构建。冲突时先合并源码，不强制覆盖或删除同步基线。

两平台可共享 Docker Desktop 的 SeekDB 实例；需要独立数据时设置不同数据库名。模型运行缓存分别归各平台所有。

## 常用开发命令

在当前平台仓库根目录执行：

```sh
npm run workspace:check
npm run dev:extension                       # 构建并启动完整开发工作台
npm run dev:extension -- --folder <path>     # 指定初始工程
npm run services:up                         # 仅启动和检查依赖服务
npm run build:extension                     # 构建 webview 和扩展后端
npm run typecheck --workspace forexplore-vscode
npm run check:hygiene
npm test
```

`npm run dev` 是开发入口的别名。已有开发窗口再次启动时会重载，也可执行 **Developer: Reload Window**。当前前端项目翻译预算为每次运行 2 小时，失败以阶段记录为准。

模型单次输出超限时，流水线会在原时限内自动小步续接，默认最多额外重试 3 次；恢复后继续正常编译与验收。参数不兼容会单独提示，详见[输出超限与自动恢复](docs/output-limit-recovery.zh-CN.md)。

独立 HTTP / MCP 集成才使用 `npm run dev:adaptation` 或 `npm run dev:mcp`，参考各服务 `.env.example`；独立 HTTP 默认端口 `8788`。**普通扩展入口之外不要再预启动同一个适配后端。** MCP 和 Claude Code 工作流见 [MCP 服务说明](services/adaptation-mcp-server/README.md)。

## 启动与导入问题

| 现象 | 处理方式 |
| --- | --- |
| `workspace:check` 缺平台依赖 | 确认平台与目录，在该 checkout 执行 `npm ci` |
| Docker / SQL 未就绪 | 完成 Docker Desktop 初始化，WSL 启用集成；检查外部数据库配置 |
| 模型下载 `fetch failed`、缓存为空 | 检查模型源、网络和持久缓存，必要时延长首次准备预算后重试 |
| 模型健康检查身份不匹配 | 查看端口上实际服务的模型，与配置保持一致 |
| 初始化等待或 `Operation not allowed now` | 查看 **输出 → RECAST** 迁移阶段；同版本宿主会协调等待和有限重试，保留数据重试 |
| 配置 Key 后仍为文件视图 | 检查 AI 设置和建模进度；结构索引成功不代表建模成功 |
| WSL 窗口未加载扩展 | 确认 WSL 模式，Node 和依赖均来自 Linux checkout |

更多诊断见 [启动指南](docs/startup-guide.md)、[索引初始化恢复](docs/index-initialization-recovery.zh-CN.md)及 [后端与验收说明](docs/extension-backend-and-evidence.zh-CN.md)。

## 仓库结构

- `apps/vscode-extension`：VS Code 扩展、项目流水线、工作台前端。
- `packages/contracts`、`packages/workflow-core`：共享契约和工作流。
- `services/code-intelligence-service`、`services/code-indexer`：索引、建模、检索。
- `services/adaptation-service`：分析、实现、编译、受控写回。
- `services/translation-verifier`：行为验证和失败证据复核。
- `services/adaptation-mcp-server`：可选 MCP 集成。
- `fixtures`：回归测试使用的参考工程和骨架源码。
- `tests`、`scripts`、`docs`：回归测试、运行维护工具、企业使用与接口文档。

## 发布分支与完整归档

`main` 保留产品运行、构建、企业使用说明和必要回归测试。实验数据、第三方源码快照、研究报告、答辩材料及历史日志已完整保存在 [`codex/archive-full-20261025`](https://github.com/chiparon/weichai/tree/codex/archive-full-20261025)。归档对应分离前的版本，后续产品修复以 main 为准。访问与复现实验的方法见[归档说明](docs/archive.md)。
