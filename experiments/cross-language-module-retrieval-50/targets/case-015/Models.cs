namespace ParallelModule;

/// <summary>给调度器、触发器、执行器、持久化存储和事件代理提供共享模型和接口，表达任务、调度、作业、租约、运行结果、事件和序列化边界。</summary>
public sealed record SchedulingSharedContractsData
{
    public string TaskId { get; init; } = default!;
    public string ScheduleId { get; init; } = default!;
    public string JobId { get; init; } = default!;
    public string LeaseExpiresAt { get; init; } = default!;
}

