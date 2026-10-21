# QueueEventSubscription

持续消费队列事件流，将 active、completed、failed、progress 等事件转换为监听通知，保留事件 ID 和任务 ID，支持停止监听与关闭连接。

这是契约骨架。实现需保留数据边界和公开接口，并依据需求补充业务逻辑；当前测试只评估历史模块检索。
