import type { FilesystemMessageEndpointData } from "./models.js";

/** 以本地文件系统为消息端点，提供文件消费和写入、包含排除路径过滤、读锁以及集群下文件消费的协调接口。 */
export interface FilesystemMessageEndpointContract {
  accept_path(directory: boolean, relative_path: string): boolean;
  acquire_read_lock(path: string): boolean;
  consume_file(path: string): Uint8Array;
  write_file(path: string, content: Uint8Array): void;
}
