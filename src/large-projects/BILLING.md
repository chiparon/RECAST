# 人民币计费口径

本批次固定使用 2026-11-09 的价目表。逐次记录保留供应商名称、模型、服务层级、请求开始时间、输入、输出、缓存读取、供应商提供的缓存写入与 TTL 分项。每个 HTTP 尝试独立计价，随后按任务汇总。推理 Token 已算入输出。表中金额为每百万 Token 的单价。[OpenAI 定价](https://developers.openai.com/api/docs/pricing) · [DeepSeek 人民币定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

| 模型和费率 | 币种 | 未缓存输入 | 缓存读取 | 写入 30 分钟 | 写入 12 小时 | 输出 |
|---|---|---:|---:|---:|---:|---:|
| GPT-6 Luna 标准 | USD | 0.10 | 0.01 | 0.125 | 0.25 | 0.50 |
| GPT-6.1 Sol 标准 | USD | 2.00 | 0.10 | 2.50 | 5.00 | 10.00 |
| DeepSeek V4.1 Flash 空闲 | CNY | 1.00 | 0.02 | — | — | 4.00 |
| DeepSeek V4.1 Flash 高峰 | CNY | 2.00 | 0.04 | — | — | 8.00 |

OpenAI 的单次请求超过 272,000 个输入 Token 时，该请求的输入和缓存单价乘 2，输出单价乘 1.5。缓存读取、写入和普通输入使用互斥计数。写入按两种有效期分别计价，默认有效期为 30 分钟。本实验使用全球 Responses API 端点。任务跨过阈值的判断逐次进行。账本按实际服务层级应用其倍率。[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) · [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) · [缓存计量字段](https://developers.openai.com/api/docs/guides/prompt-caching)

美元费用按国家外汇管理局公布的 2026-11-09 人民币汇率中间价统一换算。该日 100 美元折合 671.88 元，故 1 美元折合 6.7188 元。按请求保留计算精度，汇总后按显示位数取整。这个固定折算率用于比较同批任务。[当日汇率](https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do?startDate=2026-11-09&endDate=2026-11-09&queryYN=true) · [国家外汇管理局对计价单位的说明](https://www.safe.gov.cn/safe/rmbhlzjj/index.html)

DeepSeek 直接使用人民币钱包的价格。请求以开始时的北京时间归类。中国法定节假日以外的周一至周五，09:00 至 12:00 及 14:00 至 18:00 执行高峰费率，其他时间执行空闲费率。本实验使用客户端本地工具进行仓库操作。[DeepSeek 计费与缓存覆盖](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) · [2026 年放假安排](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)

### 用量重算与账户核对

价目表重算包含有用量的重试。缺少缓存分项时，费用区间用其余输入的可行计费类别求上下界，例如固定 30 分钟写入时，未分类的未命中输入可按普通输入或 30 分钟写入计价。完全缺失用量的尝试只保留全任务的已知下界。任何重算金额都按公开费率展示。

2026-11-09 用现有 OpenAI 项目密钥只读访问组织 Costs API，返回 HTTP 403。该端点使用管理员权限，费用按天聚合，可以按项目、API key 和费用项目分组。此批次公开的 OpenAI 逐任务人民币费用取自请求计量重算。[OpenAI Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs)

同日 DeepSeek 余额接口返回 HTTP 200，账户使用单一 CNY 钱包。串行 DeepSeek 试验在计时区间外分别读取开始和结束余额。报告只保存账户总余额、充值余额、赠送余额的减少额、时间和查询状态。十进制余额先按供应商返回的小数位对齐计算差值。该差值描述账户在这个时间窗内的净扣减，可能包含账户其他活动或延迟入账。查询失败保留缺失状态。报表同时展示价目表重算与账户差额，避免把账户净扣减归作单个请求的发票。[DeepSeek 余额接口](https://api-docs.deepseek.com/api/get-user-balance/)
