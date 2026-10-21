/** 把旧版 Servlet 请求适配为 multipart 上传请求上下文，暴露内容类型、长度、字符编码和输入流，调用解析器取得文件项，并随容器生命周期管理临时文件清理。 */
export interface LegacyServletUploadBridgeData {
  content_type: string;
  content_length: number;
  character_encoding: string;
  body: Uint8Array;
}

