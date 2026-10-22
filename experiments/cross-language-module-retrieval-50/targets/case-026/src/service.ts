import type { ModernServletUploadBridgeData } from "./models.js";
import type { ModernServletUploadBridgeContract } from "./contracts.js";

/** 把新版 Servlet 请求适配为 multipart 上传请求上下文，提供内容类型、长度、字符编码及输入流，再调用解析器迭代或收集上传项，并在容器销毁时结束临时文件清理。 */
export class ModernServletUploadBridge implements ModernServletUploadBridgeContract {
  is_multipart_content(request: ModernServletUploadBridgeData): boolean { throw new Error("Business implementation pending"); }
  parse_request(request: ModernServletUploadBridgeData): Array<ModernServletUploadBridgeData> { throw new Error("Business implementation pending"); }
  get_item_iterator(request: ModernServletUploadBridgeData): unknown { throw new Error("Business implementation pending"); }
  context_destroyed(): void { throw new Error("Business implementation pending"); }
}
