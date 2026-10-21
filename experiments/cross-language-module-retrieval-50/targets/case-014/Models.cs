namespace ParallelModule;

/// <summary>计算一次性日期、固定间隔、日历间隔和 cron 规则的后续触发时间，支持规则组合和时区，并保存及恢复触发器状态。</summary>
public sealed record ScheduleTimeRulesData
{
    public string StartTime { get; init; } = default!;
    public string Timezone { get; init; } = default!;
    public string Expression { get; init; } = default!;
    public bool Completed { get; init; } = default!;
}

