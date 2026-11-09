# 十万行级多语言项目交付基准

16/36 次通过独立交付验收，共回传 11,883,770 tokens，公开价人民币合计 ¥12.9245。

## 交付表现

冻结仓库 https://github.com/django/django，版本 c941d0deec0ea08a30670be0fac879f2372f071b。正式批次覆盖 3 项需求、3 个模型和 4 种方法，每格一次。

交付成功要求得到 Git 提交并通过公开构建、项目测试、外部行为验收及完整性检查。用时为方法启动至外部验收完成的墙钟秒数，包含索引、重试和试验内的网络恢复等待。环境准备、试验前连续两次模型目录连通性检查和余额查询都在计时区间之外。平均指标以全部尝试为分母。串行交付/小时以通过次数除以该组全部尝试的累计用时。

| 方法 / 模型 | 交付通过 | 平均秒/任务 | tokens/task | 公开价 ¥/任务 | 串行交付/小时 |
| --- | --- | --- | --- | --- | --- |
| RECAST | 3/9 · 33.3% | 200.7 | 352,619 | 0.4642 | 6.0 |
| SAG2-SQLite | 3/9 · 33.3% | 205.3 | 395,293 | 0.6019 | 5.8 |
| rawagent | 5/9 · 55.6% | 97.0 | 212,065 | 0.1329 | 20.6 |
| Codex CLI | 5/9 · 55.6% | 122.6 | 360,442 | 0.2370 | 16.3 |

| 任务 | RECAST 通过 | SAG2-SQLite 通过 | rawagent 通过 | Codex CLI 通过 |
| --- | --- | --- | --- | --- |
| Relational autocomplete in Django admin | 2/3 | 2/3 | 2/3 | 3/3 |
| Slug prepopulation across Django admin forms and inlines | 0/3 | 0/3 | 2/3 | 1/3 |
| Enable and disable password login through Django admin | 1/3 | 1/3 | 1/3 | 1/3 |

## 同模型比较

三组模型请求 ID 为 gpt-6-luna、gpt-6.1-sol 和 deepseek-flash。DeepSeek 在本批运行时将 deepseek-flash 映射至 V4.1-Flash-1017。

| 方法 / 模型 | 交付通过 | 平均秒/任务 | tokens/task | 公开价 ¥/任务 | 串行交付/小时 |
| --- | --- | --- | --- | --- | --- |
| gpt-6-luna / RECAST | 0/3 · 0.0% | 187.9 | 362,497 | 0.0823 | 0.0 |
| gpt-6-luna / SAG2-SQLite | 0/3 · 0.0% | 183.9 | 455,574 | 0.1061 | 0.0 |
| gpt-6-luna / rawagent | 0/3 · 0.0% | 76.6 | 129,780 | 0.0306 | 0.0 |
| gpt-6-luna / Codex CLI | 1/3 · 33.3% | 126.7 | 442,517 | 0.0719 | 9.5 |
| gpt-6.1-sol / RECAST | 2/3 · 66.7% | 187.4 | 181,396 | 1.1350 | 12.8 |
| gpt-6.1-sol / SAG2-SQLite | 2/3 · 66.7% | 194.6 | 308,231 | 1.5146 | 12.3 |
| gpt-6.1-sol / rawagent | 3/3 · 100.0% | 56.4 | 45,934 | 0.2618 | 63.9 |
| gpt-6.1-sol / Codex CLI | 3/3 · 100.0% | 85.7 | 197,689 | 0.5377 | 42.0 |
| deepseek-flash / RECAST | 1/3 · 33.3% | 226.9 | 513,965 | 0.1752 | 5.3 |
| deepseek-flash / SAG2-SQLite | 1/3 · 33.3% | 237.4 | 422,073 | 0.1851 | 5.1 |
| deepseek-flash / rawagent | 2/3 · 66.7% | 158.1 | 460,480 | 0.1064 | 15.2 |
| deepseek-flash / Codex CLI | 1/3 · 33.3% | 155.3 | 441,120 | 0.1015 | 7.7 |

## Codex harness 与配对结果

Codex CLI 版本 codex-cli 0.167.0-alpha.3.2，按供应商 API key 使用与其他方法相同的三个模型。Codex CLI 自主完成一次项目任务，使用基准配置的读写与公开检查工具。该配置限制原生 shell、联网及工作区外读写。

Codex CLI 完成交付 5/9 次，rawagent 完成 5/9 次。rawagent 在单个模型会话中自主使用项目工具。RECAST 按模块调度分析、实现和验证。SAG2-SQLite 在同一流水线中加入冷建 SQLite 检索。

在 Codex CLI 与 rawagent 的配对中，仅 Codex CLI 通过的组合为「django-admin-autocomplete / gpt-6-luna」，仅 rawagent 通过的组合为「django-admin-prepopulate / deepseek-flash」。

配对的差值均按左侧减右侧。同一模型同一需求的两种方法都通过时才计算用时与费用差。Token 差还要求双方用量完整，括号内为计入配对数。

| 方法 / 对照 | 配对 | 仅左侧通过 | 仅右侧通过 | 均通过 | 平均秒差 | 平均 Token 差 | 平均公开价 ¥ 差 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Codex CLI / rawagent | 9 | 1 | 1 | 4 | 15.4 | 50,937 (4) | 0.1985 |
| RECAST / rawagent | 9 | 0 | 2 | 3 | 106.3 | 104,288 (3) | 0.5749 |
| SAG2-SQLite / RECAST | 9 | 0 | 0 | 3 | -9.3 | -19,674 (3) | 0.2096 |

## 人民币费用核对

本批固定 2026-11-09 的公开价，按每次请求回传的输入、缓存、输出和服务层级计价。美元按当日国家外汇管理局中间价 1 USD = 6.7188 CNY 折算，DeepSeek 使用人民币钱包价格。

正式批次已观测到 0 次 OpenAI 请求达到长上下文费率。可归类的 DeepSeek 请求有 253 次空闲、0 次高峰。

下表以百万 Token 为单位。OpenAI 单次输入超过 272,000 Token 时，整次请求的输入及缓存单价乘 2、输出乘 1.5。推理 Token 已包含在输出中。DeepSeek 按请求开始时的北京时间选择费率，周一至周五 09:00–12:00、14:00–18:00 为高峰，周末及中国法定节假日全天为空闲时段。

正式批次共有 730 次 HTTP 尝试，报告 11,883,770 tokens。公开价合计 ¥12.9245。缺少用量的尝试 0 次，价目分项有界估算 0 次，无法上界定价 0 次。

DeepSeek 的 12/12 个任务有实际账户窗口余额差，合计 ¥1.6200，对应 DeepSeek 全部任务的公开价为 ¥1.7046。金额使用开始余额减去结束余额，仅导出差值。有记录的窗口互不重叠。 同账户其他流量、充值或延迟入账都可能影响差额。

OpenAI 组织 Costs API 对现有项目密钥返回 HTTP 403。OpenAI 的逐任务费用来自公开价重算。缓存分项缺失时按可行单价给出上下界，若某次请求缺少总用量则只给出下界。表格显示到 4 位小数。

DeepSeek 的整段账户窗口从同一份期初余额分别计算运行结束时和约 30 秒后的累计净扣减。任务即时窗口与这两个累计读数覆盖相同活动，各自单列比较。延后读数也可能包含共享账户的其他交易。

| 每百万 Token 单价 | 币种 | 未缓存输入 | 缓存读取 | 写入 30 分钟 | 写入 12 小时 | 输出 |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6-luna · 标准短上下文 | USD | 0.1 | 0.01 | 0.125 | 0.25 | 0.5 |
| gpt-6.1-sol · 标准短上下文 | USD | 2 | 0.1 | 2.5 | 5 | 10 |
| deepseek-flash · 空闲 | CNY | 1 | 0.02 | — | — | 4 |
| deepseek-flash · 高峰 | CNY | 2 | 0.04 | — | — | 8 |

| 方法 | 公开价合计 ¥ | 公开价 ¥/任务 | DeepSeek 已观测窗口 | DeepSeek 窗口净扣减合计 ¥ | 充值余额扣减 ¥ | 赠送余额扣减 ¥ |
| --- | --- | --- | --- | --- | --- | --- |
| RECAST | 4.1774 | 0.4642 | 3/3 | 0.5300 | 0.5300 | 0.0000 |
| SAG2-SQLite | 5.4174 | 0.6019 | 3/3 | 0.5600 | 0.5600 | 0.0000 |
| rawagent | 1.1963 | 0.1329 | 3/3 | 0.2400 | 0.2400 | 0.0000 |
| Codex CLI | 2.1334 | 0.2370 | 3/3 | 0.2900 | 0.2900 | 0.0000 |

| 整段窗口（UTC） | 所含任务 | 这些任务的公开价 ¥ | 任务即时窗口净扣减合计 ¥ | 截至结束净扣减 ¥ | 延后 30 秒净扣减 ¥ | 延后充值/赠送扣减 ¥ | 余额查询 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-09T14:33:04.618Z ～ 2026-11-09T15:12:28.954Z | 12 | 1.7046 | 1.6200 (12/12) | 1.6200 | 1.6200 | 1.6200 / 0.0000 | 两次均返回 |

## 本次搭建与测量支出

正式结果的通过率、用时和 ¥/任务仅采用 large-v3。large-v1 在 Windows 文件替换报错后停止派发。large-v2 在两家模型接口出现连接故障后停止派发。两个批次均保留当时已启动任务的最终记录。预检包括接入连通性和 Codex 工具调用。

网络异常批次共 16 次终态尝试，其中 2 次通过，13 次记录了传输终止原因。9 次尝试没有任何用量回传，5 次尝试只收到了部分请求的用量。

large-v2 的整段 DeepSeek 账户观察覆盖 7 个任务。运行结束时净扣减 ¥0.1300，延后 30 秒为 ¥0.2100。

上述各阶段已记录费用对应 965 次请求和 14,699,141 个已报告 Token，公开价总计至少 ¥17.3798。账户栏仅汇总有开始和结束快照的 DeepSeek 窗口。

| 阶段 | 已记录运行 | HTTP 尝试 | 无用量回传 | 已报告 tokens | 公开价合计 ¥ | 余额窗口数 | 窗口净扣减合计 ¥ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 正式评测 large-v3 | 36 | 730 | 0 | 11,883,770 | 12.9245 | 12 | 1.6200 |
| 宿主故障先导 large-v1 | 5 | 71 | 0 | 1,079,952 | 1.5764 | 2 | 0.0200 |
| 网络异常批次 large-v2 | 16 | 146 | 33 | ≥1,614,950 | ≥2.6854 | 2 | 0.0000 |
| 接入与工具预检 | 6 | 18 | 0 | 120,469 | 0.1935 | 0 | — |

## 任务规模与冻结输入

每种方法使用相同的起始源码、项目需求、模块清单、受控可读文件、可写范围及验收。规模分别统计每个骨架的生产源码物理行和实际工具可读源码行。重复使用同一仓库的各题分别计数。模型请求没有任务累计 Token 或费用上限。

各题在固定的 Django 工程内恢复一种后台功能，每题开放两个或三个 Python、JavaScript 生产文件。每种模型和方法每题只运行一次。通过率和均值描述本批需求与工具配置。

| 任务 | 生产源码行 | 工具可读源码行 | 冻结/可读文件 | 可写模块 | 生产语言（行） | 骨架/参考验收 |
| --- | --- | --- | --- | --- | --- | --- |
| Relational autocomplete in Django admin | 156,424 | 126,837 | 923 / 256 | django/contrib/admin/widgets.py、django/contrib/admin/static/admin/js/autocomplete.js | Python 145,747、CSS 4,627、JavaScript 2,894、HTML 3,156 | 0/5 / 5/5 |
| Slug prepopulation across Django admin forms and inlines | 156,392 | 126,581 | 923 / 256 | django/contrib/admin/templatetags/admin_modify.py、django/contrib/admin/static/admin/js/prepopulate.js、django/contrib/admin/static/admin/js/prepopulate_init.js | Python 145,738、CSS 4,627、JavaScript 2,871、HTML 3,156 | 0/5 / 5/5 |
| Enable and disable password login through Django admin | 156,423 | 126,594 | 923 / 256 | django/contrib/auth/forms.py、django/contrib/admin/static/admin/js/unusable_password_field.js | Python 145,742、CSS 4,627、JavaScript 2,898、HTML 3,156 | 1/5 / 5/5 |

## 逐任务记录

| django-admin-autocomplete | 模型 | 交付 | 秒 | tokens/task | 公开价 ¥ | DeepSeek 窗口 ¥ | 验收结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RECAST | gpt-6-luna | 失败 | 172.3 | 378,371 | 0.0804 | — | 未通过 widget-attributes、dynamic-inline |
| SAG2-SQLite | gpt-6-luna | 失败 | 224.8 | 781,123 | 0.1510 | — | 未通过 widget-attributes、dynamic-inline |
| rawagent | gpt-6-luna | 失败 | 65.5 | 158,926 | 0.0409 | — | 未通过 widget-attributes、dynamic-inline、relational-pagination、empty-result、permission-boundary。缺少交付提交。Public compilation failed: Traceback (most recent call last): |
| Codex CLI | gpt-6-luna | 通过 | 102.8 | 440,003 | 0.0652 | — | 通过 |
| RECAST | gpt-6.1-sol | 通过 | 186.9 | 203,854 | 1.1966 | — | 通过 |
| SAG2-SQLite | gpt-6.1-sol | 通过 | 181.6 | 300,607 | 1.4748 | — | 通过 |
| rawagent | gpt-6.1-sol | 通过 | 55.6 | 42,256 | 0.2357 | — | 通过 |
| Codex CLI | gpt-6.1-sol | 通过 | 75.6 | 194,386 | 0.5593 | — | 通过 |
| RECAST | deepseek-flash | 通过 | 225.9 | 667,193 | 0.1977 | 0.2500 | 通过 |
| SAG2-SQLite | deepseek-flash | 通过 | 171.0 | 337,965 | 0.1367 | 0.0900 | 通过 |
| rawagent | deepseek-flash | 通过 | 133.7 | 619,003 | 0.1064 | 0.0000 | 通过 |
| Codex CLI | deepseek-flash | 通过 | 107.6 | 367,485 | 0.0727 | 0.0400 | 通过 |

| django-admin-prepopulate | 模型 | 交付 | 秒 | tokens/task | 公开价 ¥ | DeepSeek 窗口 ¥ | 验收结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RECAST | gpt-6-luna | 失败 | 184.1 | 297,874 | 0.0851 | — | 未通过 inline-registration、rendered-inline-unicode |
| SAG2-SQLite | gpt-6-luna | 失败 | 180.5 | 324,698 | 0.1018 | — | 未通过 inline-registration、rendered-inline-unicode |
| rawagent | gpt-6-luna | 失败 | 83.1 | 139,423 | 0.0270 | — | 未通过 inline-registration、rendered-inline-unicode |
| Codex CLI | gpt-6-luna | 失败 | 161.1 | 655,505 | 0.0893 | — | 未通过 slug-events-and-overrides、inline-registration、rendered-inline-unicode |
| RECAST | gpt-6.1-sol | 失败 | 224.1 | 193,489 | 1.2784 | — | 未通过 inline-registration |
| SAG2-SQLite | gpt-6.1-sol | 失败 | 218.7 | 303,788 | 1.7272 | — | 未通过 inline-registration |
| rawagent | gpt-6.1-sol | 通过 | 57.6 | 51,778 | 0.2920 | — | 通过 |
| Codex CLI | gpt-6.1-sol | 通过 | 112.3 | 248,304 | 0.5820 | — | 通过 |
| RECAST | deepseek-flash | 失败 | 258.3 | 544,818 | 0.1845 | 0.1700 | 未通过 inline-metadata、inline-registration |
| SAG2-SQLite | deepseek-flash | 失败 | 306.2 | 594,077 | 0.2466 | 0.2900 | 未通过 inline-registration |
| rawagent | deepseek-flash | 通过 | 172.6 | 326,551 | 0.0991 | 0.1000 | 通过 |
| Codex CLI | deepseek-flash | 失败 | 115.0 | 343,396 | 0.0742 | 0.0900 | 未通过 slug-events-and-overrides、inline-registration、rendered-inline-unicode |

| django-admin-password | 模型 | 交付 | 秒 | tokens/task | 公开价 ¥ | DeepSeek 窗口 ¥ | 验收结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RECAST | gpt-6-luna | 失败 | 207.2 | 411,247 | 0.0814 | — | 未通过 enabled-validation |
| SAG2-SQLite | gpt-6-luna | 失败 | 146.5 | 260,901 | 0.0656 | — | 未通过 enabled-validation、sqlite-password-persistence |
| rawagent | gpt-6-luna | 失败 | 81.4 | 90,992 | 0.0238 | — | 未通过 enabled-validation |
| Codex CLI | gpt-6-luna | 失败 | 116.4 | 232,044 | 0.0611 | — | 未通过 enabled-validation |
| RECAST | gpt-6.1-sol | 通过 | 151.2 | 146,845 | 0.9301 | — | 通过 |
| SAG2-SQLite | gpt-6.1-sol | 通过 | 183.5 | 320,299 | 1.3417 | — | 通过 |
| rawagent | gpt-6.1-sol | 通过 | 55.9 | 43,768 | 0.2577 | — | 通过 |
| Codex CLI | gpt-6.1-sol | 通过 | 69.1 | 150,377 | 0.4719 | — | 通过 |
| RECAST | deepseek-flash | 失败 | 196.5 | 329,883 | 0.1433 | 0.1100 | 未通过 enabled-validation |
| SAG2-SQLite | deepseek-flash | 失败 | 234.9 | 334,176 | 0.1720 | 0.1800 | 未通过 enabled-validation |
| rawagent | deepseek-flash | 失败 | 168.0 | 435,887 | 0.1137 | 0.1400 | 未通过 enabled-validation |
| Codex CLI | deepseek-flash | 失败 | 243.2 | 612,478 | 0.1578 | 0.1600 | 未通过 enabled-validation |

## 证据与价格来源

批次 large-v3，RECAST 版本 5ba062a437142a40f15bf886114ae6065a154b25，实现指纹 058a219cd91c875c55ce0bbc14f8fdd2e4f7b9753356df9f70cfadfb4c1c9c3c。

[固定上游版本](https://github.com/django/django/tree/c941d0deec0ea08a30670be0fac879f2372f071b) · [OpenAI 全球价目表](https://developers.openai.com/api/docs/pricing) · [OpenAI 缓存计费规则](https://developers.openai.com/api/docs/guides/prompt-caching) · [OpenAI Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs) · [DeepSeek 人民币价目表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) · [DeepSeek 余额接口](https://api-docs.deepseek.com/api/get-user-balance/) · [国家外汇管理局当日人民币中间价](https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do?startDate=2026-11-09&endDate=2026-11-09&queryYN=true)
