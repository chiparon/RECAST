namespace ParallelModule;

/// <summary>定义轻量表达式语言的词法单元和操作符类型。保留 token 的文本、起始位置和长度，区分二元、逻辑、三元和一元运算，以及语法错误位置。</summary>
public sealed class ExpressionLexicalTypes : IExpressionLexicalTypes
{
    public string ResolveOperator(string text) => throw new NotImplementedException("Business implementation pending");
    public ExpressionLexicalTypesData ClassifyToken(string text, int index) => throw new NotImplementedException("Business implementation pending");
}
