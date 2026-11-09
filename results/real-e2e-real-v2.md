# 真实多语言项目端到端交付基准

批次 real-v2。已校准 3 个项目，已记录 27 次终态尝试。每题采用三种模型、三种方法，每个组合运行一次。

供应商共收到 573 次请求，已报告 7,666,328 tokens。缺少用量回传的请求数为 0。单次任务的最高已报告用量为 948,173 tokens。

## 交付结果

| 模型 | 方法 | 通过/已测 | 交付通过率 | 平均用时（秒） | 平均 tokens/task | 调用前失败 | 待完成 |
|---|---|---:|---:|---:|---:|---:|---:|
| ALL | recast | 9/9 | 100.0% | 153.1 | 314,368 | 0 | 0 |
| ALL | sag2sql | 8/9 | 88.9% | 156.3 | 364,692 | 0 | 0 |
| ALL | rawagent | 6/9 | 66.7% | 72.7 | 172,754 | 0 | 0 |

| 项目 | recast 通过 | sag2sql 通过 | rawagent 通过 |
|---|---:|---:|---:|
| bullmq-priority | 3/3 | 3/3 | 3/3 |
| coverage-html-contexts | 3/3 | 2/3 | 2/3 |
| django-i18n | 3/3 | 3/3 | 1/3 |

| 模型 | 方法 | 通过/已测 | 交付通过率 | 平均用时（秒） | 平均 tokens/task | 调用前失败 | 待完成 |
|---|---|---:|---:|---:|---:|---:|---:|
| gpt-6-luna | recast | 3/3 | 100.0% | 103.8 | 194,703 | 0 | 0 |
| gpt-6-luna | sag2sql | 3/3 | 100.0% | 131.7 | 277,438 | 0 | 0 |
| gpt-6-luna | rawagent | 2/3 | 66.7% | 72.2 | 168,162 | 0 | 0 |
| gpt-6.1-sol | recast | 3/3 | 100.0% | 149.2 | 137,664 | 0 | 0 |
| gpt-6.1-sol | sag2sql | 3/3 | 100.0% | 167.6 | 283,471 | 0 | 0 |
| gpt-6.1-sol | rawagent | 3/3 | 100.0% | 47.7 | 79,248 | 0 | 0 |
| deepseek-flash | recast | 3/3 | 100.0% | 206.1 | 610,737 | 0 | 0 |
| deepseek-flash | sag2sql | 2/3 | 66.7% | 169.5 | 533,167 | 0 | 0 |
| deepseek-flash | rawagent | 1/3 | 33.3% | 98.1 | 270,852 | 0 | 0 |

通过率分母为有终态记录的尝试。平均用时从方法启动计至外部评分结束，包含失败、重试和 SAG2 建库。tokens/task 为各任务所有模型请求的已报告总 token 之和再取算术平均，包括输入、输出及重试。首次模型调用前发生的错误单列计数，其实际用时及零 token 计入端到端均值。回传缺失时保留观测下界（≥），待完成的任务留空。

### 同任务、同模型的配对结果

| 方法 / 对照 | 配对数 | 仅方法通过 | 仅对照通过 | 两者通过 | 两者通过的平均时间差（秒） | 平均 token 差 | 用量完整配对数 |
|---|---:|---:|---:|---:|---:|---:|---:|
| recast / rawagent | 9 | 3 | 0 | 6 | 91.1 | 157,821 | 6 |
| sag2sql / rawagent | 9 | 2 | 0 | 6 | 104.6 | 261,149 | 6 |
| sag2sql / recast | 9 | 0 | 1 | 8 | 4.6 | 53,275 | 8 |

差值按左侧方法减右侧对照计算。负值表示左侧方法在配对中更省时或更省 token。耗时差只使用双方都交付成功的配对，token 差还要求双方用量完整。

## 任务与输入

| 项目 | 生产源码行（物理/非空） | 按语言的物理行 | 文件（冻结/可读） | 实现范围 |
|---|---:|---|---:|---|
| bullmq-priority | 26,663 / 23,450 | TypeScript 21,482、Lua 5,181 | 218 / 217 | src/classes/queue-keys.ts、src/commands/changePriority-7.lua、src/commands/getCountsPerPriority-2.lua |
| coverage-html-contexts | 18,601 / 15,275 | Python 15,197、C 1,609、SCSS 760、JavaScript 721、HTML 314 | 71 / 61 | coverage/html_context.py、coverage/htmlfiles/context_view.js |
| django-i18n | 66,422 / 56,741 | Python 65,910、JavaScript 512 | 206 / 204 | django/views/i18n.py、django/views/templates/i18n_catalog.js |

每题从固定上游版本导出真实项目代码，移除指定实现。三种方法拿到相同需求、源码字节、可读文件清单、可写范围和公开测试。规模栏统计输入树中列入清单的生产源码。工作量是已有项目中的跨语言模块交付。

- bullmq-priority 的 9 次通过交付相对起始提交实际新增 63–135 行，删除 5–26 行（Git numstat，可写模块）。
- coverage-html-contexts 的 7 次通过交付相对起始提交实际新增 34–125 行，删除 4–7 行（Git numstat，可写模块）。
- django-i18n 的 7 次通过交付相对起始提交实际新增 44–91 行，删除 5 行（Git numstat，可写模块）。

- BullMQ 题要求 TypeScript 层生成队列键，并用 Redis Lua 脚本修改任务优先级、按优先级读取任务数。联合验收在隔离的原生 Redis 上运行。
- coverage.py 题要求 Python 报告写入器分配、编码执行上下文，浏览器 JavaScript 展开指定源码行的上下文名称。联合验收通过真实 HTML 报告传递数据。
- Django 题要求 Python 视图组合多级翻译目录和复数规则，浏览器 JavaScript 使用生成的目录进行带上下文的单复数翻译。联合验收覆盖本地化管理界面的日历。

- bullmq-priority 的输入指纹为 98eee20c3e69036af7e41449272004d942936274b21b1686c8e3a0beef7fdaa0。参考实现通过 5/5 项隐藏检查，起始版本通过 0/5 项。逐一移除实现的 3 个对照均触发验收失败。评分材料指纹为 f9d0a2eea8caa6e5d821558f27dea33ceed4097a71a51d38d0da888e460feb06。[上游固定版本](https://github.com/taskforcesh/bullmq/tree/b2aa09331e60ca92cefcf78cca7cf0b706dc7eb4)
- coverage-html-contexts 的输入指纹为 fa5f82570758ba93ebf69ddb59a1605af8485c7745f4a7c814de4fd93541caed。参考实现通过 4/4 项隐藏检查，起始版本通过 0/4 项。逐一移除实现的 2 个对照均触发验收失败。评分材料指纹为 bf44695ecd9e6de8833b8d97bf42fb36edc24e4cb0fc5b34da627defd763ece0。[上游固定版本](https://github.com/nedbat/coveragepy/tree/7e5373eadff4753bb9273dad43bdee98bff65af0)
- django-i18n 的输入指纹为 10a5249466b723d1d9a0b5d22c1f5c1983c18e89c7c587073ae3596fd0189cb2。参考实现通过 5/5 项隐藏检查，起始版本通过 0/5 项。逐一移除实现的 2 个对照均触发验收失败。评分材料指纹为 4cfb1a2a5e85b620b626dd15cb06cc151066906428aa41c52872084c3ecf28f1。[上游固定版本](https://github.com/django/django/tree/c941d0deec0ea08a30670be0fac879f2372f071b)

## 方法与评分

- recast 运行 RECAST 项目工作流，按模块调度实现、编译、公开验证和集成修复。
- sag2sql 在相同工作流中加入 SAG2 SQLite BM25 检索，候选来自共同输入的公开源码。
- rawagent 在单个会话中自主读取、编辑、构建和测试，全程由同一模型决定下一步。
- 三组共享模型接入配置。运行器取消任务 token 预算并省略请求的最大输出 token 参数。模型服务自身的上下文窗口和每次调用的技术限制仍适用。
- 交付成功要求生成 Git 提交、通过公开验证、提交树与实际产物一致，并在独立干净副本上通过全部外部检查。

### SQLite 实际建库范围

| 项目 | 模型 | 候选源码文件 | 实际入库文件 | 入库文件扩展名 | 冷建库（秒） |
|---|---|---:|---:|---|---:|
| bullmq-priority | gpt-6-luna | 213 | 99 | .ts 99 | 6.93 |
| bullmq-priority | gpt-6.1-sol | 213 | 99 | .ts 99 | 5.69 |
| bullmq-priority | deepseek-flash | 213 | 99 | .ts 99 | 6.96 |
| coverage-html-contexts | gpt-6-luna | 52 | 52 | .c 4、.h 5、.js 1、.py 42 | 4.23 |
| coverage-html-contexts | gpt-6.1-sol | 52 | 52 | .c 4、.h 5、.js 1、.py 42 | 4.57 |
| coverage-html-contexts | deepseek-flash | 52 | 52 | .c 4、.h 5、.js 1、.py 42 | 4.09 |
| django-i18n | gpt-6-luna | 201 | 201 | .js 2、.py 199 | 6.91 |
| django-i18n | gpt-6.1-sol | 201 | 201 | .js 2、.py 199 | 6.98 |
| django-i18n | deepseek-flash | 201 | 201 | .js 2、.py 199 | 18.68 |

候选数来自冻结输入。入库数来自扫描器实际识别并交给 SQLite 检索的文件清单。冷建库时间包含复制候选源码、扫描、建立模块投影和索引初始化，已计入端到端用时。缺少运行记录的格子用 — 表示。

## 逐任务交付

| 项目 | 模型 | 方法 | 结果 | 用时（秒） | 已观测 tokens | 验收与失败原因 |
|---|---|---|---|---:|---:|---|
| bullmq-priority | gpt-6-luna | recast | 通过 | 133.1 | 274,746 | 隐藏检查 5/5 |
| bullmq-priority | gpt-6-luna | sag2sql | 通过 | 106 | 209,842 | 隐藏检查 5/5 |
| bullmq-priority | gpt-6-luna | rawagent | 通过 | 51.6 | 207,210 | 隐藏检查 5/5 |
| bullmq-priority | gpt-6.1-sol | recast | 通过 | 159.3 | 195,818 | 隐藏检查 5/5 |
| bullmq-priority | gpt-6.1-sol | sag2sql | 通过 | 173.1 | 360,550 | 隐藏检查 5/5 |
| bullmq-priority | gpt-6.1-sol | rawagent | 通过 | 41.2 | 163,207 | 隐藏检查 5/5 |
| bullmq-priority | deepseek-flash | recast | 通过 | 197.4 | 948,173 | 隐藏检查 5/5 |
| bullmq-priority | deepseek-flash | sag2sql | 通过 | 188 | 909,773 | 隐藏检查 5/5 |
| bullmq-priority | deepseek-flash | rawagent | 通过 | 62.3 | 248,463 | 隐藏检查 5/5 |
| coverage-html-contexts | gpt-6-luna | recast | 通过 | 68.8 | 103,286 | 隐藏检查 4/4 |
| coverage-html-contexts | gpt-6-luna | sag2sql | 通过 | 131.8 | 389,140 | 隐藏检查 4/4 |
| coverage-html-contexts | gpt-6-luna | rawagent | 通过 | 43.9 | 98,855 | 隐藏检查 4/4 |
| coverage-html-contexts | gpt-6.1-sol | recast | 通过 | 104.5 | 101,103 | 隐藏检查 4/4 |
| coverage-html-contexts | gpt-6.1-sol | sag2sql | 通过 | 119.8 | 195,461 | 隐藏检查 4/4 |
| coverage-html-contexts | gpt-6.1-sol | rawagent | 通过 | 31.6 | 44,404 | 隐藏检查 4/4 |
| coverage-html-contexts | deepseek-flash | recast | 通过 | 133 | 359,391 | 隐藏检查 4/4 |
| coverage-html-contexts | deepseek-flash | sag2sql | 失败 | 125 | 386,106 | 隐藏检查失败（wide-context-report） |
| coverage-html-contexts | deepseek-flash | rawagent | 失败 | 61.7 | 235,693 | 隐藏检查失败（rank-and-pack、wide-context-report） |
| django-i18n | gpt-6-luna | recast | 通过 | 109.5 | 206,076 | 隐藏检查 5/5 |
| django-i18n | gpt-6-luna | sag2sql | 通过 | 157.5 | 233,332 | 隐藏检查 5/5 |
| django-i18n | gpt-6-luna | rawagent | 失败 | 121.2 | 198,422 | 公开验收失败。隐藏检查失败（browser-context-plural、browser-reload、localized-admin-calendar）。无交付提交 |
| django-i18n | gpt-6.1-sol | recast | 通过 | 183.8 | 116,070 | 隐藏检查 5/5 |
| django-i18n | gpt-6.1-sol | sag2sql | 通过 | 209.8 | 294,403 | 隐藏检查 5/5 |
| django-i18n | gpt-6.1-sol | rawagent | 通过 | 70.2 | 30,134 | 隐藏检查 5/5 |
| django-i18n | deepseek-flash | recast | 通过 | 287.9 | 524,648 | 隐藏检查 5/5 |
| django-i18n | deepseek-flash | sag2sql | 通过 | 195.5 | 303,622 | 隐藏检查 5/5 |
| django-i18n | deepseek-flash | rawagent | 失败 | 170.2 | 328,400 | 隐藏检查失败（catalog-metadata） |

## 模型标识与数据

- gpt-6-luna → gpt-6-luna
- gpt-6.1-sol → gpt-6.1-sol
- deepseek-flash → deepseek-flash

本次运行使用的 `deepseek-flash` 对应 DeepSeek V4.1-Flash-1017。[DeepSeek 更新日志](https://api-docs.deepseek.com/updates/)

逐次 CSV 保留冻结输入指纹、交付提交、各类 token 和缺失用量请求数。汇总 CSV 同时提供按模型及跨模型等权任务平均。每题每格只有一次采样，项目、模型和方法的交互会影响排序。
