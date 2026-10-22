package parallelmodule

// 实现 BPMN XML 与流程模型之间的双向转换。按 XML 元素及模型类型注册转换器，解析命名空间和扩展属性，支持 schema 校验与 XML 输出。
type WorkflowXmlConversionData struct {
    Xml []byte
    NamespaceUri string
    ValidateSchema bool
    Encoding string
}

