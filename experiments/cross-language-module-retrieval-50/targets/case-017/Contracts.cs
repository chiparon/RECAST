namespace ParallelModule;

/// <summary>提供内存、文档数据库和 SQL 存储后端，管理任务、调度和作业。支持添加冲突策略、到期调度与作业的租约领取、释放及结果持久化。</summary>
public interface ILeasedSchedulePersistence
{
    Task AddTaskAsync(LeasedSchedulePersistenceData task);
    Task AddScheduleAsync(LeasedSchedulePersistenceData schedule, string conflict_policy);
    Task<List<LeasedSchedulePersistenceData>> AcquireSchedulesAsync(string scheduler_id, int limit);
    Task ReleaseSchedulesAsync(string scheduler_id, List<LeasedSchedulePersistenceData> schedules);
    Task<List<LeasedSchedulePersistenceData>> AcquireJobsAsync(string scheduler_id, int limit);
}
