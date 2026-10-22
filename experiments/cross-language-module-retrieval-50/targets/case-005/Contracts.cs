namespace ParallelModule;

/// <summary>为路由模型提供 XML 对象绑定上下文和 XML 转储。转储过程中处理命名空间、源码位置信息以及端点 DSL 的 URI 表达方式。</summary>
public interface IRouteXmlMarshalling
{
    object CreateContext(RouteXmlMarshallingData context);
    string DumpModel(RouteXmlMarshallingData model, bool resolve_placeholders);
    Dictionary<string, string> ExtractNamespaces(RouteXmlMarshallingData model);
}
