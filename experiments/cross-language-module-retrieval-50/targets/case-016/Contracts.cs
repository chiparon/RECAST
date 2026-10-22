namespace ParallelModule;

/// <summary>在本地及 Redis、MQTT、数据库通知等传输后端间发布订阅调度事件。支持事件类型过滤、一次性订阅、订阅撤销和通知的序列化与恢复。</summary>
public interface IDistributedSchedulingEvents
{
    Task<string> SubscribeAsync(string event_type, bool one_shot);
    Task PublishAsync(DistributedSchedulingEventsData scheduling_event);
    Task UnsubscribeAsync(string token);
    Task<DistributedSchedulingEventsData> RestoreNotificationAsync(byte[] payload);
}
