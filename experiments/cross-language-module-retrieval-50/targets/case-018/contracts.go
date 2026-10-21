package parallelmodule

// 适配由调用者提供的 Redis 客户端，统一哈希、集合和有序集合命令及事务调用。支持脚本定义、SHA 执行和连接关闭错误转换。
type RedisDriverCommandAdapterContract interface {
    DefineScript(name string, source string, key_count int)
    ExecuteScript(name string, keys []string, args []string) any
    ExecuteTransaction(commands []*RedisDriverCommandAdapterData) []any
}
