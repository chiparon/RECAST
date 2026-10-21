namespace ParallelModule;

/// <summary>给调度器、触发器、执行器、持久化存储和事件代理提供共享模型和接口，表达任务、调度、作业、租约、运行结果、事件和序列化边界。</summary>
public sealed class SchedulingSharedContracts : ISchedulingSharedContracts
{
    public Task<string?> NextAsync() => throw new NotImplementedException("Business implementation pending");
    public Task<byte[]> SerializeAsync(SchedulingSharedContractsData value) => throw new NotImplementedException("Business implementation pending");
    public Task<SchedulingSharedContractsData> DeserializeAsync(byte[] payload) => throw new NotImplementedException("Business implementation pending");
    public Task UnsubscribeAsync(string token) => throw new NotImplementedException("Business implementation pending");
}
