/** 在 XML 文本、字节流、DOM 文档和流式读取器之间转换，支持字符编码和转换错误报告，供消息处理流水线复用。 */
export interface XmlRepresentationConversionData {
  content: Uint8Array;
  encoding: string;
  system_id: string;
}

