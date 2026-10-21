/** 把新版 Servlet 请求适配为 multipart 上传请求上下文，提供内容类型、长度、字符编码及输入流，再调用解析器迭代或收集上传项，并在容器销毁时结束临时文件清理。 */
export interface ModernServletUploadBridgeData {
  content_type: string;
  content_length: number;
  character_encoding: string;
  body: Uint8Array;
}

