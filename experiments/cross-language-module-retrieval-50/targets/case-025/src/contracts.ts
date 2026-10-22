import type { LegacyServletUploadBridgeData } from "./models.js";

/** 把旧版 Servlet 请求适配为 multipart 上传请求上下文，暴露内容类型、长度、字符编码和输入流，调用解析器取得文件项，并随容器生命周期管理临时文件清理。 */
export interface LegacyServletUploadBridgeContract {
  is_multipart_content(request: LegacyServletUploadBridgeData): boolean;
  parse_request(request: LegacyServletUploadBridgeData): Array<LegacyServletUploadBridgeData>;
  get_item_iterator(request: LegacyServletUploadBridgeData): unknown;
  context_destroyed(): void;
}
