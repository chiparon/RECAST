package parallelmodule

// 管理隔离执行作业的进程或线程池，根据处理器文件分配、复用与回收执行单元，跟踪空闲和占用状态，并在清理时终止子进程。
type IsolatedWorkerProcessPoolContract interface {
    Retain(processor_file string) *IsolatedWorkerProcessPoolData
    Release(child *IsolatedWorkerProcessPoolData)
    Remove(child *IsolatedWorkerProcessPoolData)
    Clean()
}
