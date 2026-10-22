# Asset Upgrade Gateway 测试材料

只保留两套骨架、需求、hidden test 和必要运行文件。Java 已统一为完整需求版本，35 条测试放在同一个测试目录。重复版本、独立 10 条副本、JSON 清单、历史覆盖说明和实验报告已从本资料包移除。

| 内容 | C# | Java |
|---|---|---|
| 骨架 | `csharp/target-project/` | `java/target-project/` |
| 需求 | `csharp/target-project/requirements/` | `java/target-project/requirements/` |
| Hidden test | `csharp/hidden-tests/Program.cs` | `java/hidden-tests/src/test/java/com/example/assetupgrade/hidden/` |
| 测试数量 | 24 | 35 |

Java 测试目录内：

- `AttachmentHiddenTest.java`：6 条附件测试。
- `WorkflowHiddenTest.java`：6 条工作流测试。
- `ReconciliationHiddenTests.java`：7 条对账测试。
- `OrderHiddenTests.java`：6 条订单测试。
- `FullEngineeringHiddenTest.java`：新增 10 条工程测试。
- `EngineeringProjectAccess.java`：必要的调用适配类，不额外计数。

新增工程测试覆盖配置合并、配置校验、JDBC 持久化、事务、消息序列化、路由过滤、租户边界、指标、就绪检查和应用装配。

## 执行验收

在资料包根目录使用具备相应工具的 Bash 环境执行。C# 需要 .NET 8；Java 需要 JDK 21、Maven 和 Python 3，并设置 `JAVA_HOME`，可选设置 `MAVEN_BIN`。

```bash
# C#，24 条
bash csharp/hidden-tests/run-hidden-evaluation.sh --target /path/to/completed-csharp-project --output /path/to/csharp-result.json

# Java，35 条一起执行
bash java/hidden-tests/run-hidden-tests.sh /path/to/completed-java-project all
```

测试应针对实现完成的项目副本运行，空骨架预期不通过。给实现 Agent 提供对应 target-project 目录；hidden-tests 留给评估端。本次整理保持生产骨架、需求和测试源码不变，仅调整目录、说明和 C# 测试启动脚本中的定位路径。已检查复制一致性和测试数量，未重新执行验收。
