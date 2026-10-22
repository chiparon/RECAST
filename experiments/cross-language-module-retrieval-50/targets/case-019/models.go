package parallelmodule

// 持续消费队列事件流，将 active、completed、failed、progress 等事件转换为监听通知，保留事件 ID 和任务 ID，支持停止监听与关闭连接。
type QueueEventSubscriptionData struct {
    EventId string
    JobId string
    EventType string
    Progress any
}

