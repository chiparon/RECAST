# 索引数据库初始化与导入恢复

## 当前行为

SeekDB 初始化包括表结构检查、缺失迁移和向量模型身份检查。数据库端口可连接，不代表这些步骤已经完成。

同一数据库的初始化使用 `GET_LOCK` 协调。锁名从数据库名称派生，Windows、WSL 和不同 VS Code 窗口使用同一规则。锁与所有初始化 SQL 必须使用同一条连接；连接断开后不会从连接池取得新连接继续执行旧的升级任务。

另一个初始化执行者持锁时，后来者等待。前一个宿主退出后，数据库可能仍在完成或取消表重定义；遇到明确的 DDL 冲突时，初始化会有限重试，并从表结构、迁移记录重新检查。已完成的字段修改不会重复执行，未记录的迁移版本会在检查通过后补记。权限、鉴权、语法和模型身份错误直接报告，不作为忙碌重试。

等待锁和冲突重试的预算默认是 10 分钟；初始化连接的单条 SQL 超时也为 10 分钟，与普通检索查询的 60 秒预算分开。调用方可用 `SeekDbIndexStoreConfig.initialization.timeoutMs` 调整。结束时释放锁、恢复查询超时；无法确认锁已释放的连接直接销毁，不放回池中。

普通应用启动仍允许自动执行缺失的结构升级。这次改动没有引入独立的企业发布迁移服务，也没有保证旧版客户端参与同一套锁协调；升级期间应使用同一版本的客户端。

## 用户反馈

- 等待其他窗口或升级时，候选模块与尚未启动的翻译服务显示黄色“准备中”。
- 页脚显示具体等待原因，完整文字可通过悬停查看；RECAST 输出记录迁移编号和阶段变化。
- 失败时显示初始化阶段及可取得的数据库错误码。绿色仍只表示服务就绪，不代表真实模型生成或项目验收通过。
- 目标工程恢复记录只在成功或用户明确取消后清除。初始化失败后仍保留，供同一窗口的下一次扩展宿主启动继续恢复；原有 30 分钟有效期仍适用。

无需通过删除数据库、清空向量或删除 Docker 数据卷来处理暂时性的升级冲突。

## 验证

普通测试覆盖锁等待、冲突后重新检查、等待超时、权限错误立即失败、连接清理、恢复记录与页面状态。

真实 SeekDB 测试使用独立的随机命名数据库，完成后清理该测试库。它验证两个初始化同时运行、DDL 已成功但迁移记录缺失时恢复，以及持锁子进程被强制终止后另一执行者继续。

Windows PowerShell：

```powershell
npm run workspace:check
$env:RECAST_TEST_SEEKDB = '1'
npm run test --workspace @forexplore/code-intelligence-service -- src/schema-initialization.live.test.ts
```

Linux/WSL（先按 AGENTS.md 同步源码，并在 Linux 工作目录运行）：

```sh
npm run workspace:check
RECAST_TEST_SEEKDB=1 npm run test --workspace @forexplore/code-intelligence-service -- src/schema-initialization.live.test.ts
```

连接读取 `CODE_INTELLIGENCE_SEEKDB_HOST/PORT/USER/PASSWORD`，默认本机 `2881` 端口。测试不调用模型，也不访问业务索引内容。
