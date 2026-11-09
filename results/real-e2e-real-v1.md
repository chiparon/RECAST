# 真实多语言项目端到端交付基准

批次 real-v1。已校准 1 个项目，已记录 9 次终态尝试。每题采用三种模型、三种方法，每个组合运行一次。

供应商共收到 70 次请求，已报告 1,067,829 tokens。缺少用量回传的请求数为 0。单次任务的最高已报告用量为 442,523 tokens。

本批为先导试验，只计 Django 的九个组合。工作流使用早期模块任务说明，coverage.py 仅用于校准。正式批次使用修订后的模块任务说明。

## 交付结果

| 模型 | 方法 | 通过/已测 | 交付通过率 | 平均用时（秒） | 平均 tokens/task | 调用前失败 | 待完成 |
|---|---|---:|---:|---:|---:|---:|---:|
| ALL | recast | 0/3 | 0.0% | 98.3 | 156,951 | 0 | 0 |
| ALL | sag2sql | 0/3 | 0.0% | 36.9 | 27,336 | 0 | 0 |
| ALL | rawagent | 1/3 | 33.3% | 85.7 | 171,657 | 0 | 0 |

| 项目 | recast 通过 | sag2sql 通过 | rawagent 通过 |
|---|---:|---:|---:|
| django-i18n | 0/3 | 0/3 | 1/3 |

| 模型 | 方法 | 通过/已测 | 交付通过率 | 平均用时（秒） | 平均 tokens/task | 调用前失败 | 待完成 |
|---|---|---:|---:|---:|---:|---:|---:|
| gpt-6-luna | recast | 0/1 | 0.0% | 24.1 | 17,499 | 0 | 0 |
| gpt-6-luna | sag2sql | 0/1 | 0.0% | 24.8 | 22,910 | 0 | 0 |
| gpt-6-luna | rawagent | 0/1 | 0.0% | 80.7 | 204,673 | 0 | 0 |
| gpt-6.1-sol | recast | 0/1 | 0.0% | 15.3 | 10,830 | 0 | 0 |
| gpt-6.1-sol | sag2sql | 0/1 | 0.0% | 32.6 | 16,252 | 0 | 0 |
| gpt-6.1-sol | rawagent | 1/1 | 100.0% | 60.4 | 126,815 | 0 | 0 |
| deepseek-flash | recast | 0/1 | 0.0% | 255.6 | 442,523 | 0 | 0 |
| deepseek-flash | sag2sql | 0/1 | 0.0% | 53.5 | 42,845 | 0 | 0 |
| deepseek-flash | rawagent | 0/1 | 0.0% | 116.1 | 183,482 | 0 | 0 |

通过率分母为有终态记录的尝试。平均用时从方法启动计至外部评分结束，包含失败、重试和 SAG2 建库。tokens/task 为各任务所有模型请求的已报告总 token 之和再取算术平均，包括输入、输出及重试。首次模型调用前发生的错误单列计数，其实际用时及零 token 计入端到端均值。回传缺失时保留观测下界（≥），待完成的任务留空。

### 同任务、同模型的配对结果

| 方法 / 对照 | 配对数 | 仅方法通过 | 仅对照通过 | 两者通过 | 两者通过的平均时间差（秒） | 平均 token 差 | 用量完整配对数 |
|---|---:|---:|---:|---:|---:|---:|---:|
| recast / rawagent | 3 | 0 | 1 | 0 | — | — | 0 |
| sag2sql / rawagent | 3 | 0 | 1 | 0 | — | — | 0 |
| sag2sql / recast | 3 | 0 | 0 | 0 | — | — | 0 |

差值按左侧方法减右侧对照计算。负值表示左侧方法在配对中更省时或更省 token。耗时差只使用双方都交付成功的配对，token 差还要求双方用量完整。

## 任务与输入

| 项目 | 生产源码行（物理/非空） | 按语言的物理行 | 文件（冻结/可读） | 实现范围 |
|---|---:|---|---:|---|
| django-i18n | 66,422 / 56,741 | Python 65,910、JavaScript 512 | 206 / 204 | django/views/i18n.py、django/views/templates/i18n_catalog.js |

每题从固定上游版本导出真实项目代码，移除指定实现。三种方法拿到相同需求、源码字节、可读文件清单、可写范围和公开测试。规模栏统计输入树中列入清单的生产源码。工作量是已有项目中的跨语言模块交付。

- django-i18n 的 1 次通过交付相对起始提交实际新增 49 行，删除 5 行（Git numstat，可写模块）。

- Django 题要求 Python 视图组合多级翻译目录和复数规则，浏览器 JavaScript 使用生成的目录进行带上下文的单复数翻译。联合验收覆盖本地化管理界面的日历。

- django-i18n 的输入指纹为 10a5249466b723d1d9a0b5d22c1f5c1983c18e89c7c587073ae3596fd0189cb2。参考实现通过 5/5 项隐藏检查，起始版本通过 0/5 项。逐一移除实现的 2 个对照均触发验收失败。[上游固定版本](https://github.com/django/django/tree/c941d0deec0ea08a30670be0fac879f2372f071b)

## 方法与评分

- recast 运行 RECAST 项目工作流，按模块调度实现、编译、公开验证和集成修复。
- sag2sql 在相同工作流中加入 SAG2 SQLite BM25 检索，候选来自共同输入的公开源码。
- rawagent 在单个会话中自主读取、编辑、构建和测试，全程由同一模型决定下一步。
- 三组共享模型接入配置。运行器取消任务 token 预算并省略请求的最大输出 token 参数。模型服务自身的上下文窗口和每次调用的技术限制仍适用。
- 交付成功要求生成 Git 提交、通过公开验证、提交树与实际产物一致，并在独立干净副本上通过全部外部检查。

### SQLite 实际建库范围

| 项目 | 模型 | 候选源码文件 | 实际入库文件 | 入库文件扩展名 | 冷建库（秒） |
|---|---|---:|---:|---|---:|
| django-i18n | gpt-6-luna | 201 | 201 | .js 2、.py 199 | 8.23 |
| django-i18n | gpt-6.1-sol | 201 | 201 | .js 2、.py 199 | 7.46 |
| django-i18n | deepseek-flash | 201 | 201 | .js 2、.py 199 | 6.35 |

候选数来自冻结输入。入库数来自扫描器实际识别并交给 SQLite 检索的文件清单。冷建库时间包含复制候选源码、扫描、建立模块投影和索引初始化，已计入端到端用时。缺少运行记录的格子用 — 表示。

## 逐任务交付

| 项目 | 模型 | 方法 | 结果 | 用时（秒） | 已观测 tokens | 验收与失败原因 |
|---|---|---|---|---:|---:|---|
| django-i18n | gpt-6-luna | recast | 失败 | 24.1 | 17,499 | 模型报告所需模块超出当前步骤的写入范围。隐藏检查失败（catalog-fallback、catalog-metadata、browser-context-plural、browser-reload、localized-admin-calendar）。无交付提交 |
| django-i18n | gpt-6-luna | sag2sql | 失败 | 24.8 | 22,910 | 模型报告所需模块超出当前步骤的写入范围。隐藏检查失败（catalog-fallback、catalog-metadata、browser-context-plural、browser-reload、localized-admin-calendar）。无交付提交 |
| django-i18n | gpt-6-luna | rawagent | 失败 | 80.7 | 204,673 | 公开验收失败。隐藏检查失败（browser-context-plural、browser-reload、localized-admin-calendar）。无交付提交 |
| django-i18n | gpt-6.1-sol | recast | 失败 | 15.3 | 10,830 | 模型报告所需模块超出当前步骤的写入范围。隐藏检查失败（catalog-fallback、catalog-metadata、browser-context-plural、browser-reload、localized-admin-calendar）。无交付提交 |
| django-i18n | gpt-6.1-sol | sag2sql | 失败 | 32.6 | 16,252 | 模型报告所需模块超出当前步骤的写入范围。隐藏检查失败（catalog-fallback、catalog-metadata、browser-context-plural、browser-reload、localized-admin-calendar）。无交付提交 |
| django-i18n | gpt-6.1-sol | rawagent | 通过 | 60.4 | 126,815 | 隐藏检查 5/5 |
| django-i18n | deepseek-flash | recast | 失败 | 255.6 | 442,523 | 隐藏检查失败（catalog-fallback、catalog-metadata） |
| django-i18n | deepseek-flash | sag2sql | 失败 | 53.5 | 42,845 | 模型报告所需模块超出当前步骤的写入范围。隐藏检查失败（catalog-fallback、catalog-metadata、browser-context-plural、browser-reload、localized-admin-calendar）。无交付提交 |
| django-i18n | deepseek-flash | rawagent | 失败 | 116.1 | 183,482 | 隐藏检查失败（catalog-fallback） |

## 模型标识与数据

- gpt-6-luna → gpt-6-luna
- gpt-6.1-sol → gpt-6.1-sol
- deepseek-flash → deepseek-flash

本次运行使用的 `deepseek-flash` 对应 DeepSeek V4.1-Flash-1017。[DeepSeek 更新日志](https://api-docs.deepseek.com/updates/)

逐次 CSV 保留冻结输入指纹、交付提交、各类 token 和缺失用量请求数。汇总 CSV 同时提供按模型及跨模型等权任务平均。每题每格只有一次采样，项目、模型和方法的交互会影响排序。
