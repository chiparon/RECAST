namespace ParallelModule;

/// <summary>计算一次性日期、固定间隔、日历间隔和 cron 规则的后续触发时间，支持规则组合和时区，并保存及恢复触发器状态。</summary>
public sealed class ScheduleTimeRules : IScheduleTimeRules
{
    public Task<string?> NextAsync() => throw new NotImplementedException("Business implementation pending");
    public Task<ScheduleTimeRulesData> SaveStateAsync() => throw new NotImplementedException("Business implementation pending");
    public Task RestoreStateAsync(ScheduleTimeRulesData state) => throw new NotImplementedException("Business implementation pending");
}
