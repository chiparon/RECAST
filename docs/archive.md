# 完整资料归档

`main` 是企业使用和发布维护的入口，保留运行源码、部署/构建工具、使用说明、接口文档、回归测试及必要测试夹具。

清理前的完整仓库保存在远端分支 [`codex/archive-full-20261025`](https://github.com/chiparon/weichai/tree/codex/archive-full-20261025)，对应提交 `5ff260547903a81ce77de22d72853031566b8a19`。该分支包含第三方参考仓库源码、实验数据、评测脚本、研究资料、答辩文件和历史运行报告。

需要复现实验时，在独立目录克隆归档，避免与日常产品目录混用：

```sh
git clone --single-branch --branch codex/archive-full-20261025 https://github.com/chiparon/weichai.git recast-archive
```

随后按归档中的实验 README 配置工具链和数据。归档是历史快照；当前产品修复以 main 为准，不要用归档覆盖正在使用的源码、依赖或数据缓存。

正常企业使用无需下载这些材料，按[安装配置](../README.md)和[图文使用说明书](user-guide/README.zh-CN.md)导入自己的目标工程与参考仓库。

发布树检查使用 `npm run check:hygiene`，禁止跟踪实验目录、日志、依赖和编译缓存，并检查单文件与整个发布树的大小。回归测试的冻结源码夹具属于测试输入，保留在 main；测试运行产生的二进制、报告和缓存不提交。

本次通过普通提交精简 main 当前目录，没有改写 Git 历史。完整历史及归档分支仍包含旧文件；只需当前产品时可用 `git clone --depth 1 --single-branch --branch main <仓库地址>`。
