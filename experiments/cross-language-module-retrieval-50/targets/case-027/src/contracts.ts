import type { ThresholdUploadItemStorageData } from "./models.js";

/** 定义上传文件项、表单字段和工厂契约，按大小阈值选择内存或磁盘存储。提供内容读取、写入目标文件和删除资源接口，保留字段名、原文件名和头信息。 */
export interface ThresholdUploadItemStorageContract {
  create_item(metadata: ThresholdUploadItemStorageData, threshold: number): ThresholdUploadItemStorageData;
  read_content(item: ThresholdUploadItemStorageData): Uint8Array;
  write_item(item: ThresholdUploadItemStorageData, destination: string): void;
  delete_item(item: ThresholdUploadItemStorageData): void;
}
