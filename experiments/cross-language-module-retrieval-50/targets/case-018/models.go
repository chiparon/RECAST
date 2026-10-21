package parallelmodule

// 适配由调用者提供的 Redis 客户端，统一哈希、集合和有序集合命令及事务调用。支持脚本定义、SHA 执行和连接关闭错误转换。
type RedisDriverCommandAdapterData struct {
    Command string
    Keys []string
    Arguments []string
    ScriptSha string
}

