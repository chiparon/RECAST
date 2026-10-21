/** 以本地文件系统为消息端点，提供文件消费和写入、包含排除路径过滤、读锁以及集群下文件消费的协调接口。 */
export interface FilesystemMessageEndpointData {
  directory: string;
  includes: Array<string>;
  excludes: Array<string>;
  read_lock: string;
}

