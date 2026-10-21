/** 定义上传文件项、表单字段和工厂契约，按大小阈值选择内存或磁盘存储。提供内容读取、写入目标文件和删除资源接口，保留字段名、原文件名和头信息。 */
export interface ThresholdUploadItemStorageData {
  field_name: string;
  file_name: string;
  content_type: string;
  size: number;
  in_memory: boolean;
}

