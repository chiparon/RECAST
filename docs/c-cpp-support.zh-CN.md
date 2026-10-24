# C／C++ 配置与支持边界

RECAST 的全自动项目流水线已接通 C／C++：导入骨架、结构解析与建模、历史库检索、模块实现、CMake 构建、生成行为测试、收集函数覆盖率、集成验收。操作入口与其他语言相同：导入目标骨架，完成建模，填写需求并点击“开始执行”。

升级后，已经导入的 C／C++ 仓库请刷新索引并重新建模，以获得新的 CMake 项目边界。索引器版本已更新，重建时会重新分析旧版本结果，无需手动删除数据库或缓存。

## 支持范围

| 环节 | 当前行为 |
| --- | --- |
| 源码解析 | `.c`、`.h`、`.cpp`、`.cc`、`.cxx`、`.hpp`、`.hh`、`.hxx`；`.h` 使用兼容 C 声明的 C++ 语法解析器 |
| 项目识别 | 识别 CMakeLists.txt；普通 add_subdirectory 子目录归属于上层工程，显式 project() 的嵌套工程独立登记 |
| 生成计划 | 支持 C、C++ 和两者混合的模块；保留单文件唯一写入者及模块依赖顺序 |
| 默认构建 | 在 `.recast-build` 中配置并构建真实 CMake 工程，不只做单文件语法检查 |
| 行为验证 | 生成独立的 C/C++ 测试程序，通过 CTest 执行，通过 GCC/gcov 判断目标函数是否实际执行 |
| C++ 身份 | 使用文件路径、限定名称和源码声明位置区分命名空间、类方法、重载；无法唯一定位时保持“未确定” |
| 错误证据 | 已执行失败的断言仍走原有独立纠错复核流程，后续全绿不会自动清掉历史失败 |

自动行为验收当前要求 **CMake 3.21+、GCC/G++、与编译器版本一致的 gcov**，并至少提供一个可链接的库目标。支持静态库、共享库、对象库及接口库；接口库的未实例化模板/内联函数可能没有覆盖率记录，系统不会把缺失记录判为通过。

MSVC／Clang 工程可以使用正常的 CMake 构建配置，但它们的覆盖率格式尚未接入该行为验证适配器。纯 Makefile、Meson、交叉编译、嵌入式硬件测试、仅含可执行目标的工程，尚不属于默认自动行为验收范围。可以将业务逻辑抽成库并保留原应用入口；自定义编译命令只改变构建步骤，不自动补齐覆盖率适配。

## 同平台准备工具

Windows 建议使用 MinGW-w64 的 GCC、G++、gcov、mingw32-make，另安装 Windows CMake，并将工具的 bin 目录加入启动 VS Code 的 PATH。若已安装 MSYS2，可使用其 UCRT64 工具包。避免把 MSYS2 的 Unix shell 命令包装器当作 Windows 原生编译器。重新启动扩展前确认：

```powershell
cmake --version
ctest --version
gcc --version
g++ --version
gcov --version
mingw32-make --version
```

WSL／Ubuntu：

```bash
sudo apt-get update
sudo apt-get install -y cmake build-essential
cmake --version
gcc --version
g++ --version
gcov --version
```

工具链须安装在实际运行扩展的平台。Windows 上的编译器不能替代 WSL 编译器，反之亦然。CMake 配置目录也不能跨平台复用。

可通过环境变量 `CMAKE_COMMAND`、`GCOV_COMMAND` 指定可执行文件路径；`CC`、`CXX` 和 `CMAKE_GENERATOR` 按 CMake 的规则选择编译器和生成器。未指定生成器时，Windows 检测到 GCC 会优先使用 `MinGW Makefiles`。这些变量应在启动扩展之前设置。

## 骨架约定

将业务能力暴露为 CMake 库目标，并使用 PUBLIC／INTERFACE 属性声明头文件目录、编译特性和传递依赖。这样测试与真实应用使用相同的接口和依赖。例如：

```cmake
cmake_minimum_required(VERSION 3.21)
project(OrderCore LANGUAGES C CXX)
add_library(order_core src/order.cpp src/codec.c)
target_include_directories(order_core PUBLIC include)
target_compile_features(order_core PUBLIC cxx_std_17)
# 保留现有应用入口：
# add_executable(order_app src/main.cpp)
# target_link_libraries(order_app PRIVATE order_core)
```

纯 C 工程可声明 `LANGUAGES C` 并使用 `.c` 实现。C 与 C++ 混用时，公共 C 头文件应提供 `#ifdef __cplusplus` / `extern "C"` 链接声明。现有第三方依赖仍由目标工程正常提供；RECAST 不会自动猜测或安装业务库。

单个库无需额外配置。多个库，或需要关闭示例/自带测试时，在目标根目录添加可选的 `.recast-native.json`：

```json
{
  "testTargets": ["order_core", "shared_contracts"],
  "configureArgs": ["-DBUILD_EXAMPLES=OFF"]
}
```

`testTargets` 指向待测 CMake 库目标。`configureArgs` 只接受独立的 `-DNAME=value` 参数，不接受 shell 命令或改变源/构建目录的参数。没有显式目标且存在多个库时，系统会报告配置歧义。依赖库通常通过库目标的传递依赖自动获得。

## 验收如何避免误判

Host 为每次验证建立独立的测试目录和构建目录，不修改生产 CMakeLists.txt。Agent 只能在授权测试目录内编写测试源码与夹具；每个测试源码包含一个 `main`，作为一个独立 CTest 用例。测试链接真实生产库，使用退出码表达断言是否通过，不要求联网下载 GoogleTest 或 Catch2。

一次行为验收至少要有真实测试执行成功，并证明每个被验收的目标函数实际执行。覆盖率不足、没有运行目标函数、重载身份歧义、断言失败或历史失败未完成复核，均不能得到完整验收通过。覆盖率用于证明执行发生，需求是否正确则由生成的断言判断；覆盖率本身不证明需求完整。

每次运行会重新生成测试结果和覆盖率数据，结束后清理临时构建。超时会终止原生构建/测试子进程。持久失败证据保存在 `.forexplore/translation-verifier-evidence`。`.recast-build`、`.translation-verifier-tests`、`.translation-verifier-coverage` 不参与源码索引或提交。

验证前会检查 CMake/gcov 是否可用；实际配置还会检查编译器是否为 GCC。缺工具、库目标歧义、编译错误、覆盖率缺失分别保留具体诊断，不会因“构建退出码为零”而冒充行为通过。

## 开发者回归

原生真实测试不会隐式安装工具，需先按上文准备环境：

```powershell
$env:RECAST_NATIVE_E2E='1'
Set-Location services/translation-verifier
npm exec -- vitest run e2e/native-coverage.e2e.test.ts
```

```bash
cd services/translation-verifier
RECAST_NATIVE_E2E=1 npm exec -- vitest run e2e/native-coverage.e2e.test.ts
```

测试使用真实 C、C++ 库、头文件、命名空间和重载，检查正常断言、错误断言、未调用目标函数、历史失败保留及编译失败后的旧结果隔离。
