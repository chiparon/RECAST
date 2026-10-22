import type { ThresholdUploadItemStorageData } from "./models.js";
import type { ThresholdUploadItemStorageContract } from "./contracts.js";

/** 定义上传文件项、表单字段和工厂契约，按大小阈值选择内存或磁盘存储。提供内容读取、写入目标文件和删除资源接口，保留字段名、原文件名和头信息。 */
export class ThresholdUploadItemStorage implements ThresholdUploadItemStorageContract {
  create_item(metadata: ThresholdUploadItemStorageData, threshold: number): ThresholdUploadItemStorageData { throw new Error("Business implementation pending"); }
  read_content(item: ThresholdUploadItemStorageData): Uint8Array { throw new Error("Business implementation pending"); }
  write_item(item: ThresholdUploadItemStorageData, destination: string): void { throw new Error("Business implementation pending"); }
  delete_item(item: ThresholdUploadItemStorageData): void { throw new Error("Business implementation pending"); }
}
