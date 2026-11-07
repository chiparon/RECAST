# Windows 与 WSL 分开开发

两个平台使用相同版本的源码和 package-lock.json，各自安装原生依赖。
目录映射保存在本机 `.recast-platforms.json`，不进入 Git。

使用双工作区时，从含有本机映射的 checkout 读取 `windowsRoot` 和 `wslRoot`。
两处的 Git HEAD 必须一致。目录和分支名称因机器而异。

```powershell
$mapping = Get-Content -Raw .recast-platforms.json | ConvertFrom-Json
Set-Location -LiteralPath $mapping.windowsRoot
npm run workspace:check
npm run dev:extension
```

准备改用 WSL 时，在 PowerShell 中同步源码：

```powershell
npm run workspace:sync -- --to wsl
```

该命令通过 WSL 执行文件同步，可以同时访问 Windows 源码和 Linux worktree。
然后在 WSL 终端进入映射中的 `wslRoot`，在该目录执行：

```bash
npm run workspace:check
npm run build:extension
# 如需打开 Linux 扩展宿主，使用 VS Code Remote WSL：
code .
```

结束 WSL 开发并返回 Windows 前，在 WSL 目录执行：

```bash
npm run workspace:sync -- --to windows
```

`--dry-run` 可以查看同步数量而不写入文件。同步命令检查源文件与上次同步
基线：目标目录独有的修改会保留，同一文件两边都改过会中止整个同步并列出
冲突，不会选择某一边覆盖。只完成到本地源码的同步，不自动提交 Git。

同步包括工程源码、开发脚本、需求、测试和文档。`node_modules`、`dist`、
`bin/obj`、Java `target`、模型缓存、日志、结果目录、原始历史仓库和本地
凭据不参与同步。历史实验和冻结参考源码保存在[独立归档](archive.md)，产品 worktree 仅维护运行和回归所需的源码与夹具。各平台已有的本地服务配置独立保留。

依赖清单发生变化时，同步命令会提示在目标平台目录运行 `npm ci`。
没有依赖变化时，切换平台无需重新安装。

同步命令要求两个 worktree 的 Git HEAD 一致。若在某个平台创建了新提交，
先通过 Git 合并或 cherry-pick 把提交同步到另一分支；有未提交改动时按正常
Git 流程保存和合并，不要使用 hard reset 强行对齐。

`npm run build:extension`、`npm test` 和扩展开发启动器在开始工作前会检查
目录与平台。首次安装时先运行 `npm run workspace:check -- --before-install`，
再执行 `npm ci` 和 `npm run workspace:check`。运行其他脚本或实验时也使用
当前平台的工作区。两个目录各自保留构建产物，可以共用 SeekDB 容器和数据卷。
