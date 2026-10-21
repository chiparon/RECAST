import type { FilesystemMessageEndpointData } from "./models.js";
import type { FilesystemMessageEndpointContract } from "./contracts.js";

/** 以本地文件系统为消息端点，提供文件消费和写入、包含排除路径过滤、读锁以及集群下文件消费的协调接口。 */
export class FilesystemMessageEndpoint implements FilesystemMessageEndpointContract {
  accept_path(directory: boolean, relative_path: string): boolean { throw new Error("Business implementation pending"); }
  acquire_read_lock(path: string): boolean { throw new Error("Business implementation pending"); }
  consume_file(path: string): Uint8Array { throw new Error("Business implementation pending"); }
  write_file(path: string, content: Uint8Array): void { throw new Error("Business implementation pending"); }
}
