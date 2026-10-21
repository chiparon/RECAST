这份数据用于检查现有模块检索链路能否把一个跨语言目标骨架，匹配回历史仓中对应的原始模块。数据位于 WSL 工作树，数据已构造；目标建模和正式跑测入口的准备由 experiment.mts 完成。prepare 会在原 SeekDB 中新增目标仓库及其索引，历史仓 revision、建模结果和源码不重建；run 才会开始正式检索实验。

本次冻结的是 `forexplore_asset_upgrade_20261004` 中 7 个历史仓当前活动 revision 的 716 个 ready 模块节点。716 个节点既有父子层级，也有纯构建文件和测试模块，因此先筛选有生产源码、没有子节点的模块，并排除名称明确表示测试、构建、文档和版本迁移的节点，得到 395 个可抽样节点。这里的“无子节点”按实际父子关系判断，不要求建模 refinement 一定标记为 leaf。使用 Python 标准库随机数生成器和固定种子 20261010，按仓库分层、无放回抽样 50 个。各仓库的配额是人为设定的覆盖配额，结果不能直接解释成按原始 716 个节点数量加权的总体成功率。

| 历史仓 | 抽样数 |
|---|---:|
| apache-camel | 12 |
| apscheduler | 5 |
| bullmq | 7 |
| commons-fileupload | 3 |
| flowable-engine | 2 |
| keycloak | 6 |
| nopcommerce | 15 |

50 个样本均有不同的标准答案身份。目标语言分为 Python、C#、TypeScript、Go 和 Java，各 10 个工程，共 155 个源码文件。每个目标语言均与对应历史模块的源码语言不同。C# 使用 .NET 8 类库，Java 使用 Java 17 源码级别，TypeScript 启用 strict 类型检查，Go 使用独立 go.mod，Python 使用标准 src 布局。语言配额是固定的，分配由 case-designs.json 显式记录，50 个抽样答案身份与第一版一致；这仍没有覆盖所有语言方向组合。

每个骨架是独立目标工程。它包含重新组织的中文需求、具有领域含义的数据类型、公开接口和抛出未实现异常的业务方法。模型类直接保留字段边界，不添加虚构的 CRUD 服务。没有把历史实现复制进目标代码，也没有把原始模块名称、模块 ID、revision 或答案路径写进目标工程。领域术语、通用 API 概念和 Redis、BPMN、Servlet 等功能本身需要的技术词保留，因此这是跨语言契约检索数据，不是同时消除所有词汇重合的匿名检索测试。

需求与接口参考了真实历史源码及当前模块边界，但骨架表达的是代表性公开契约，不是把大型历史模块的全部类型与 API 一比一转换。有的答案模块含数百个生产文件，对应骨架仍仅表达该模块的核心职责。它适合先做模块检索实验，不能用来证明行为等价、完整迁移正确性或实现覆盖率。`oracle/answers.json` 记录每个答案完整源文件清单和生产源码哈希，便于之后审阅和扩展契约。

`targets/case-001` 到 `targets/case-050` 是实际目标工程，工程内部的 README 是该样本的开发需求。`queries.json` 只包含目标路径、目标语言、需求、模块名和源码清单，可以供评测宿主读取。`oracle/answers.json` 保存标准答案的 repositoryId、revision、projectId、moduleId，以及模块产物身份和哈希。`oracle/catalog-snapshot.json` 保存完整 716 个节点的抽样快照，`oracle/evidence/` 保存限量原始源码片段，仅供离线审阅，不能进入目标建模或重排上下文。`case-designs.json` 和生成器属于数据制作工具，也不应纳入目标工程。

使用前先在 WSL 工作树运行 `npm run workspace:check`。重新生成数据可执行：

```bash
python3 experiments/cross-language-module-retrieval-50/build_dataset.py
python3 experiments/cross-language-module-retrieval-50/validate_dataset.py
```

重新生成依赖当前 `experiments/enterprise-asset-upgrade/reference-sources` 中的历史源码。快照固定了答案 revision 和抽样结果，生产源码哈希用来检查本地源码后续是否发生变化。源码哈希反映数据构造时读取的本地文件，准备阶段已逐项与 SeekDB 内的源码快照哈希核对。

进入正式实验时，每次只把一个 `targets/case-NNN` 当作目标仓库，调用正常结构解析、依赖提取和项目建模链路。实验入口固定“一个完整骨架 = 一个评测模块”：`fixed-boundary.ts` 把当前骨架的全部候选文件组作为一个不可再分的分析单元提交给 Agent，保留源码片段、接口和内部依赖证据，让 Agent 生成名称与职责说明。它不读取历史答案，也不从答案决定模块边界；正常开发入口的 Agent 自由划分行为不受影响。已有的完整单模块结果复用，已有的多节点树重新建模，再通过正常的证据、版本、计划哈希校验及全文/向量索引发布。每个样本必须恰好一个已发布模块，包含全部骨架源码；准备与预检都会检查，不再取拆分后的某个业务入口节点。这个实验固定了目标建模边界，衡量的是跨语言模块检索，不评估 Agent 自动划分模块的质量。随后将该目标模块和 `queries.json` 中的需求交给正常模块检索入口，保留正式服务已有的召回数量与重排配置，最终请求 Top4。检索范围继续使用完整 7 个历史仓的活动 revision，不能缩小为抽中的 50 个答案，也不能额外把答案塞进候选集合。`evaluation-config.json` 描述实验口径，`experiment.mts` 是已接通生产实现的自动准备和评测驱动。

评测宿主可以读取 oracle 判分，但目标建模、召回查询和重排模型均不得读取 oracle。不要把整个数据集根目录作为目标工程导入，否则标准答案和源码证据也可能被扫描。Python 工程采用标准 src 布局；导入验证时将该 case 的 `src` 加到 Python 搜索路径，或按正式解析器的源码扫描机制读取。

记录标准答案是否进入重排前候选集合、最终排名、Hit@1、Hit@4、MRR，以及建模和检索各阶段耗时。前者衡量召回是否漏掉答案，后者衡量重排能否把正确候选放到前面。样本 case-025 和 case-026 来自不同 Servlet 版本的上传适配模块，功能高度相近，跨语言骨架无法严格保留其 Java 容器类型差异；oracle 显式列出另外的 Servlet 适配模块作为等价参考。严格身份命中与等价参考命中应分别报告，这些等价标签仍需要人工审核，不能据此把所有同名或近似模块都当成正确答案。

当前检查包括 50 个唯一历史答案、全部样本确实切换语言、Python AST 和骨架方法检查、目标目录答案身份泄漏检查、历史生产源码哈希检查、10 个 Python 包导入，及各 10 个 C#、TypeScript、Go、Java 工程的编译或类型检查。所有业务方法保持未实现，编译通过只说明骨架可用。检索召回率和重排成功率需要后续真实运行才能得到。

每种语言的工具链检查可以单独运行：

```bash
python3 experiments/cross-language-module-retrieval-50/validate_toolchains.py --language Python
python3 experiments/cross-language-module-retrieval-50/validate_toolchains.py --language "C#"
python3 experiments/cross-language-module-retrieval-50/validate_toolchains.py --language TypeScript
python3 experiments/cross-language-module-retrieval-50/validate_toolchains.py --language Go
python3 experiments/cross-language-module-retrieval-50/validate_toolchains.py --language Java
```

检查使用本平台的 Node/TypeScript、dotnet、Java 和 Go 工具链。Java 和 Go 可以在平台运行时目录 ~/.local/share/recast/toolchains 下发现，不会安装到仓库 node_modules 中。toolchain-reports/ 分语言保存检查结果；所有生成的 bin、obj 与编译缓存均不属于目标源码或查询输入。Go 的 go test 在本数据中仅用于编译包，没有执行行为测试。

正式实验的准备和运行统一从 WSL 仓库根目录执行，不需要打开 VS Code，也不需要改 npm run dev:extension。驱动复用 CodeIntelligenceHost 的导入索引和项目建模链路，以及 production searchModules、ConfiguredModelReranker 和 adaptation HTTP 重排接口，不使用自建检索算法。模型设置只在驱动进程中读取适配服务 .env，要求实验模型为 DeepSeek，不写个人 Codex 配置；日志和结果不包含 API Key。

```bash
# 只读核对全部历史仓身份、revision、模块产物与索引源码哈希
npx tsx experiments/cross-language-module-retrieval-50/experiment.mts audit

# 给 50 个目标骨架建立结构索引、Agent 模块模型和全文/向量检索视图
# 已准备且指纹与 revision 未变化的样本自动复用，失败样本可以续跑
npx tsx experiments/cross-language-module-retrieval-50/experiment.mts prepare

# 检查所有准备结果，再用两个合成候选检查真实 LLM 重排端点
# 这不会对 50 个正式样本进行检索
npx tsx experiments/cross-language-module-retrieval-50/experiment.mts preflight

# 正式实验开始时执行；默认每个样本一轮，保持生产的 Top4 和候选宽度
npx tsx experiments/cross-language-module-retrieval-50/experiment.mts run --rounds 1
```

可以用 `--cases case-001,case-018` 指定准备、预检或正式跑测的样本。部分样本预检通过仅代表该子集，不代表完整 50 个已就绪。驱动固定使用原数据库和完整七仓历史范围，运行前会拒绝历史 revision、答案产物或 embedding 指纹变化；目标源码或目标 revision 变化则要求重新 prepare，不自动沿用过期结果。

results/prepared.json 保存目标真实仓库、revision、project、所选模块及其指纹。results/history-audit.json 保存历史索引审计，results/readiness.json 保存最终预检结果。每轮正式实验逐样本保存到 results/run-时间.json，包含重排前候选身份、最终 Top4、精确与等价命中、MRR@4 和生产链路的分段耗时。候选由 production searchModules 的可选只读观测入口复制出来，观测回调不能修改排序输入，默认调用无额外复制开销。正式源码没有更改召回、融合、初排或模型重排策略。

预重排召回指标衡量进入重排候选集合的模块，不代表所有原始全文/向量命中文档。当前生产实现请求 Top4 时，重排候选上限通常为 16，而不是旧说明中的 8；驱动不覆盖这个上限。MRR@4 在答案不在最终 Top4 时记零，并不假设已经获知截断后候选的全排名。错误及重排 fallback 单列报告，并在主要指标中记零，分母保留所有请求的样本轮次，避免失败样本被排除后夸大结果。

时间统计不把离线准备时间混入在线检索时间：modelingMs 单列记录在 prepared.json，正式请求记录 queueMs、recallAndAggregateMs、candidatePrepareMs、rerankMs、revisionCheckMs、executionMs 和 totalMs，并额外保留宿主 wallMs。每轮串行运行；真实调用保留生产缓存状态，第一轮与后续轮次分别保存，不将热缓存表现误称为无缓存性能。

2026-10-10 的固定边界准备结果：50 个目标工程各发布一个完整评测模块，50 个查询目标的骨架源码覆盖率均为 100%。原先拆成多节点的样本已重新建模，不再存在只取局部子模块的查询。全部历史建模提案通过重新计算计划哈希及结构 revision 绑定检查，50 个标准答案的三类模块摘要视图存在，1,495 个生产源码哈希与索引一致。正式 50 样本检索尚未运行。结果与数据都在 WSL 工作树；如果后续切换 Windows，仍需遵守平台工作树同步规则，不能直接沿用 WSL 本地目标路径。
