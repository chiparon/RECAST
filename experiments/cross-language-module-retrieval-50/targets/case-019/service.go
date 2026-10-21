package parallelmodule

// 持续消费队列事件流，将 active、completed、failed、progress 等事件转换为监听通知，保留事件 ID 和任务 ID，支持停止监听与关闭连接。
type QueueEventSubscription struct {}

var _ QueueEventSubscriptionContract = (*QueueEventSubscription)(nil)

func (service *QueueEventSubscription) Run(last_event_id string) {
    panic("Business implementation pending")
}

func (service *QueueEventSubscription) Subscribe(event_type string, callback any) {
    panic("Business implementation pending")
}

func (service *QueueEventSubscription) Close() {
    panic("Business implementation pending")
}

