import type { LegacyServletUploadBridgeData } from "./models.js";
import type { LegacyServletUploadBridgeContract } from "./contracts.js";

/** 把旧版 Servlet 请求适配为 multipart 上传请求上下文，暴露内容类型、长度、字符编码和输入流，调用解析器取得文件项，并随容器生命周期管理临时文件清理。 */
export class LegacyServletUploadBridge implements LegacyServletUploadBridgeContract {
  is_multipart_content(request: LegacyServletUploadBridgeData): boolean { throw new Error("Business implementation pending"); }
  parse_request(request: LegacyServletUploadBridgeData): Array<LegacyServletUploadBridgeData> { throw new Error("Business implementation pending"); }
  get_item_iterator(request: LegacyServletUploadBridgeData): unknown { throw new Error("Business implementation pending"); }
  context_destroyed(): void { throw new Error("Business implementation pending"); }
}
