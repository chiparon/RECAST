namespace ParallelModule;

/// <summary>把声明式表达式定义转换为运行时表达式或谓词。允许按定义类型注册构造器，解析语言与脚本来源，并设置表达式的结果类型和配置项。</summary>
public sealed class RuntimeExpressionFactory : IRuntimeExpressionFactory
{
    public void RegisterFactory(string definition_type, object factory) => throw new NotImplementedException("Business implementation pending");
    public object CreateExpression(RuntimeExpressionFactoryData definition, RuntimeExpressionFactoryData context) => throw new NotImplementedException("Business implementation pending");
    public object CreatePredicate(RuntimeExpressionFactoryData definition, RuntimeExpressionFactoryData context) => throw new NotImplementedException("Business implementation pending");
}
