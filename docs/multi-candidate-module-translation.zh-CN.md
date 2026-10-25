# 模块翻译的多候选参考

针对一个目标模块，工作台展示检索 Top4，开发人员可以选择 1～3 个不同的历史模块。点击候选切换选中状态；选择第三个后，其余候选暂停选择，已选候选仍可取消。检索结果不会自动成为选择。

## 选择依据

先检查需求、候选用途、公开接口和源文件，再判断它是否提供可复用的实现。第二、第三个候选应该补足不同的行为；排名相邻且文件高度重叠的模块通常没有必要一起选。没有覆盖的需求仍需要依据目标工程规范实现，不能把相似概念当作行为等价。

## 交接与执行

单候选保持原有历史视图布局。多个候选的视图为：

```text
history-view/
  manifest.json
  source/
    candidate-1/<历史相对路径>
    candidate-2/<历史相对路径>
    candidate-3/<历史相对路径>
```

目录编号对应所选候选的顺序，而非原始检索排名。同名文件通过目录隔离；manifest 记录各模块的 repository、revision、project、module、文件 hash，以及超出预算或无法读取的文件。每个历史模块沿用最多 8 个文件、128,000 字节的预算，不会直接暴露历史仓库原目录。

多个历史模块交给同一个 Analyzer，生成同一份 Plan，再由一个 Translator 实现同一个目标模块。Plan 仍只有 `summary`、`mappings`、`dependencies`、`steps`，其中 `mappings.source` 仍为字符串，可包含 `candidate-N/` 和源文件路径。

增加参考模块不增加目标 `writeFiles`。宿主继续校验候选身份、manifest 和文件 hash，执行编译、模块 Verifier、失败反馈修复、快照和回滚。Agent staging 排除 `.forexplore` 和旧拼写 `.forexpore` 中的运行记录，避免读取以前的实现快照或测试证据。

## 本地实验

实验驱动支持显式排名选择，例如选检索排名 1 和 3：

```bash
npm exec -- tsx scripts/run-target-module-pipeline.mts \
  --target /path/to/target-project \
  --module module-policies --reuse-plan --top-k 4 \
  --candidate-ranks 1,3 \
  --retrieval-from <已经审阅的Top4报告.json> \
  --out <本次结果.json>
```

先用 `--dry-run` 保存 Top4，审阅报告里的 `retrievedCandidates`，再选择排名。`--retrieval-from` 校验数据库、目标 revision、模块需求和 topK，确保单候选与多候选使用同一批检索结果。比较实验依次运行，不能同时编辑同一个目标目录。

结果包含检索清单、所选排名、历史视图身份、Plan、模型累计 token、阶段耗时、编译和 Verifier 结果。Codex `commands` 是截取的实际命令元数据，不包含命令输出；旧字段 `readFiles` 表示宿主提供的可见文件清单，不能据此断言模型逐个读取过这些文件。

每轮保存实现 snapshot，再恢复目标骨架并校验原始文件 hash。模块 Verifier 成功只说明该轮生成的测试通过，不等同于固定 hidden tests 或整套需求已经通过。
