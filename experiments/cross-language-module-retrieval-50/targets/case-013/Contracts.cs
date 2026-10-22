namespace ParallelModule;

/// <summary>为调度作业提供异步、线程、独立进程以及 GUI 事件线程的执行接口。控制并发容量，传递作业参数，并传播返回值或执行异常。</summary>
public interface IJobExecutionBackends
{
    Task StartAsync(object lifecycle);
    Task<object> RunJobAsync(object function, JobExecutionBackendsData job);
    Task StopAsync();
}
