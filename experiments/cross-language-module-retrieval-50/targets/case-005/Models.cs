namespace ParallelModule;

/// <summary>为路由模型提供 XML 对象绑定上下文和 XML 转储。转储过程中处理命名空间、源码位置信息以及端点 DSL 的 URI 表达方式。</summary>
public sealed record RouteXmlMarshallingData
{
    public string RouteId { get; init; } = default!;
    public string NamespaceUri { get; init; } = default!;
    public string SourceLocation { get; init; } = default!;
    public string Xml { get; init; } = default!;
}

