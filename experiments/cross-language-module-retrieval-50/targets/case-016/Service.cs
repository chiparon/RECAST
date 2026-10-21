namespace ParallelModule;

/// <summary>在本地及 Redis、MQTT、数据库通知等传输后端间发布订阅调度事件。支持事件类型过滤、一次性订阅、订阅撤销和通知的序列化与恢复。</summary>
public sealed class DistributedSchedulingEvents : IDistributedSchedulingEvents
{
    public Task<string> SubscribeAsync(string event_type, bool one_shot) => throw new NotImplementedException("Business implementation pending");
    public Task PublishAsync(DistributedSchedulingEventsData scheduling_event) => throw new NotImplementedException("Business implementation pending");
    public Task UnsubscribeAsync(string token) => throw new NotImplementedException("Business implementation pending");
    public Task<DistributedSchedulingEventsData> RestoreNotificationAsync(byte[] payload) => throw new NotImplementedException("Business implementation pending");
}
