package parallelmodule

// 把 Valkey Glide 的 customCommand 和批处理接口适配成统一 Redis 客户端。转换字符串与二进制参数，归一化哈希响应，支持脚本执行和事务批次。
type GlideCommandCompatibilityContract interface {
    CustomCommand(arguments [][]byte) any
    NormalizeHashReply(reply any) map[string]string
    ExecuteBatch(commands []*GlideCommandCompatibilityData, atomic bool) []any
}
