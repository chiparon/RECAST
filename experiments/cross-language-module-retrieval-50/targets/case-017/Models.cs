namespace ParallelModule;

/// <summary>提供内存、文档数据库和 SQL 存储后端，管理任务、调度和作业。支持添加冲突策略、到期调度与作业的租约领取、释放及结果持久化。</summary>
public sealed record LeasedSchedulePersistenceData
{
    public string TaskId { get; init; } = default!;
    public string SchedulerId { get; init; } = default!;
    public string LeaseExpiresAt { get; init; } = default!;
    public string ConflictPolicy { get; init; } = default!;
}

