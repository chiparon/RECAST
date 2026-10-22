package parallelmodule

// 从任务队列领取作业并运行处理器，维护锁与进度，处理失败和重试，并提供暂停、恢复及优雅关闭。消费状态通过事件通知给调用者。
type QueueJobConsumerContract interface {
    ProcessJob(job *QueueJobConsumerData, token string) any
    Pause()
    Resume()
    Close(force bool)
}
