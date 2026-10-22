import type { XmlRepresentationConversionData } from "./models.js";
import type { XmlRepresentationConversionContract } from "./contracts.js";

/** 在 XML 文本、字节流、DOM 文档和流式读取器之间转换，支持字符编码和转换错误报告，供消息处理流水线复用。 */
export class XmlRepresentationConversion implements XmlRepresentationConversionContract {
  to_document(source: XmlRepresentationConversionData): unknown { throw new Error("Business implementation pending"); }
  to_text(document: unknown, encoding: string): string { throw new Error("Business implementation pending"); }
  to_stream(source: XmlRepresentationConversionData): unknown { throw new Error("Business implementation pending"); }
}
