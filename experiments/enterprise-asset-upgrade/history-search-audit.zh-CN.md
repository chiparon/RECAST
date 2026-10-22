# Agent 搜索历史仓审计报告

## 统计口径

本报告只统计带有历史仓可读权限的四组实验：`history-assisted-java-20261012`、`history-isolated-java-20261012`、`history-isolated-java-repeat1-20261012` 和 `history-isolated-java-repeat2-20261012`。每组原本有 Codex 和 Claude 两个 Agent；第一组 Claude 的首次运行被中断，因此正式比较只计入它的 `retry1` 完成运行。计数来自每个运行目录中的 `agent-stream.jsonl`，只统计 Agent 实际发出的已完成命令，不把提示词中列出路径、骨架文档中的历史仓名称或最终源码里的普通类名算成搜索。

## 搜索频次

8 个正式完成的 Agent 运行共发出 48 次包含 `source-repositories` 路径的命令。其中 39 次包含 `ls`、`find`、`grep` 或 `rg` 等搜索/列目录操作，15 次明确用 `cat`、`sed` 等读取了历史源码；一条命令可能同时搜索和读取，所以两类数字不能相加。另有 1 次 Codex 命令只是检查六个仓库的修改时间，不能算有效搜索。

| Agent | 历史路径命令 | 明确读取源码的命令 | 说明 |
|---|---:|---:|---|
| Codex | 5 | 1 | 其中 1 次是实际读取 BullMQ `backoffs.ts`；其余主要是验证或短暂搜索 |
| Claude | 43 | 14 | 是历史仓使用的主体，跨多轮反复搜索并读取具体实现 |
| 合计 | 48 | 15 | 正式完成运行 |

按实验组看，第一组完成运行是 15 次历史命令、5 次源码读取；第二组是 11 次、3 次；第三组是 11 次、3 次；第四组是 11 次、3 次。第一组被中断的 Claude 首次尝试另有 7 次历史命令和 2 次源码读取，但不进入正式成绩。

按仓库统计时，一条同时访问多个仓库的命令会分别计入每个仓库，因此总数会大于 48 次：

| 历史仓 | 被访问的命令次数 |
|---|---:|
| bullmq | 16 |
| commons-fileupload | 12 |
| apscheduler | 11 |
| nopcommerce | 9 |
| keycloak | 6 |
| apache-camel | 2 |

最新的“删除历史仓提示词并关闭历史仓权限”的四轮无历史实验中，8 个 Agent 运行均没有出现历史仓路径命令，审计结果为 0 次；这和上面的可读历史仓实验是严格区分的。

## 具体读到了什么

可以确认 Agent 确实读到了若干可用于实现的源码片段，而不只是列目录：

- BullMQ：读取了 `src/classes/backoffs.ts`、`src/classes/job.ts` 等文件，Claude 明确提取了 `attemptsMade`、指数退避、抖动和耗尽后进入失败/死信的语义，并把它用于 `ExponentialRetryPolicy`、`BullMqRetryAdapter` 和重试调度逻辑。
- APScheduler：读取了 `_retry.py`、`triggers/interval.py`、`datastores/memory.py`、`datastores/sqlalchemy.py`、`executors/base.py` 等文件，提取了重试、到期窗口、并发限制、租约/检查点和跳过重叠执行等思路，用于 `QuartzReconciliationScheduler`、租约存储和对账调度。
- Commons FileUpload：读取了 `AbstractFileUpload.java`、`FileUploadByteCountLimitException.java` 等文件，参考了流式上传、大小限制和文件名处理，最终代码中的 `FilenameSafetyPolicy` 有明确的“adapted from Commons FileUpload”说明。
- nopCommerce：读取了 `OrderProcessingService.cs` 的下单流程片段，参考了订单校验、库存预留、提交和回滚的顺序，用于订单插件桥接和补偿流程。
- Keycloak 和 Apache Camel：轨迹里主要是目录、类名和 `grep` 定位，没有形成同等清晰的完整源码读取证据。因此只能说 Agent 找到了相关实现位置和概念，不能说已经详细复用了这两个仓库的具体代码。

最终源码中还能看到这些适配痕迹，例如 `ExponentialRetryPolicy.java`、`BullMqRetryAdapter.java`、`QuartzReconciliationScheduler.java`、`FilenameSafetyPolicy.java` 和 `KeycloakIdentityAdapter.java` 的注释明确写了 BullMQ、APScheduler、Commons FileUpload 或 Keycloak 风格。不过这些概念同时也出现在目标工程的 `docs/history-coverage.md` 和需求文件里，所以轨迹能够证明“读过并参考过源码”，不能证明某段实现完全来自历史仓，更不能把它认定为代码复制。

## 是否真的有帮助

有帮助的部分主要是算法和边界语义，而不是直接搬运代码。最清楚的证据是 Claude 在读取 BullMQ 后马上总结“指数退避 `delay * 2^(attemptsMade-1)` 加抖动”，随后在重试策略和适配器中实现了同类语义；读取 APScheduler 后把到期、租约和重叠调度规则写进对账调度器。Commons FileUpload 和 nopCommerce 也分别对应到附件校验和订单补偿逻辑。

但从最终通过率看，不能得出“开放历史仓稳定提升了 Agent”的结论。带历史仓可读权限的正式完成运行中，Codex 为 31、28、24、29/35，平均 28.0/35；Claude 为 29、24、28、32/35，平均 28.25/35。无历史仓的四轮中，Codex 为 29、31、29、28/35，平均 29.25/35；Claude 为 30、33、30、30/35，平均 30.75/35。实验没有固定模型采样种子，且历史可读组与后续无历史组还存在隔离方式、提示词版本和运行时间差异，因此这些均值只能说明“没有观察到稳定收益”，不能作为严格的单变量因果结论。

更实际的结论是：历史仓搜索频率并不高，而且主要集中在 Claude；很多运行只做了几次定向搜索，Codex 多轮甚至没有读取历史源码。历史仓确实提供了可用的设计参考，尤其适合重试退避、调度租约、文件上传边界和订单补偿这类通用机制，但它没有自动解决目标工程的接口契约、状态返回和副作用次数问题。最终失分仍主要来自目标骨架自身的入口兼容、租户校验、状态语义和幂等细节。

## 证据位置

- 可读历史仓实验：
  - `/home/ryanlyu/worktrees/weichai-wsl/experiments/enterprise-asset-upgrade/history-assisted-java-20261012/runs/`
  - `/home/ryanlyu/worktrees/weichai-wsl/experiments/enterprise-asset-upgrade/history-isolated-java-20261012/runs/`
  - `/home/ryanlyu/worktrees/weichai-wsl/experiments/enterprise-asset-upgrade/history-isolated-java-repeat1-20261012/runs/`
  - `/home/ryanlyu/worktrees/weichai-wsl/experiments/enterprise-asset-upgrade/history-isolated-java-repeat2-20261012/runs/`
- 轨迹文件：每个运行目录下的 `agent-stream.jsonl`，必要时还有 `trajectory.jsonl`。
- 运行成绩和完整实验条件：各实验目录下的 `comparison-results.json`、`experiment-manifest.json`。
- 当前报告对应的 WSL 文件：`/home/ryanlyu/worktrees/weichai-wsl/experiments/enterprise-asset-upgrade/history-search-audit.zh-CN.md`。
