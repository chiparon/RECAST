# 全自动实现参考选择

完整项目驱动增加 `--auto-select-references`。重排模型在同一次调用中评分全部候选并选择 1–3 个实现参考，默认一个；不需要 `--candidate-ranks` 或第二个选择模型。选项和人工排名互斥。

选择依赖展示的方法体证据。名称、摘要、接口调用或界面展示不能证明候选实现了目标行为。第二、第三个参考必须提供当前模块需要的独立实现机制；宿主删除低相关及完全重复职责的补充参考，保留原始提案与删除理由。能力缺口单独记录，并交给 Analyzer，不能用更多相似候选假装满足需求。部分主参考可以保留，并不表示目标完整需求已被覆盖。

候选仍来自真实检索。模型在整个 shortlist 中选出的参考置于返回顺序开头，便于现有 Top4 传输携带它们；选择不限定为旧排名前三名。每个模块报告保存 `referenceSelection`、真实 `candidateIds` 和 `selectedCandidates`，以及候选身份与分析修订。复用 preview 时必须已有同一工程身份和需求的自动决定。

选择格式或候选身份失败会有限重试并明确报错，不能自动使用 hybrid 排名或默认 Top1 充当成功选择。旧的人工排序接口保持兼容。

运行示例：

    npx tsx scripts/run-target-module-pipeline.mts --target <clean-project> --auto-select-references --keep-project-until-end --integration-repair --out <report.json>

开发与 Integration 退出后，独立宿主评测才启动。隐藏测试与评测结果不进入参考选择和开发上下文。
