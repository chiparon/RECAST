# GlideCommandCompatibility

把 Valkey Glide 的 customCommand 和批处理接口适配成统一 Redis 客户端。转换字符串与二进制参数，归一化哈希响应，支持脚本执行和事务批次。

这是契约骨架。实现需保留数据边界和公开接口，并依据需求补充业务逻辑；当前测试只评估历史模块检索。
