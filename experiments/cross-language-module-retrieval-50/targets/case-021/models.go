package parallelmodule

// 管理队列 Redis 连接和集群客户端的初始化、就绪等待、断开与重连。探测服务器版本及类型，加载运行脚本，并区分自有连接和共享连接的关闭行为。
type QueueConnectionLifecycleData struct {
    Host string
    ServerVersion string
    Shared bool
    Blocking bool
}

