namespace ParallelModule;

/// <summary>表达式语法树需要字面量、函数、二元和逻辑节点以及块边界。节点保留源 token，允许接纳左右子节点，并将树节点转换为可执行表达式。</summary>
public sealed class ExpressionNodeGraph : IExpressionNodeGraph
{
    public bool AcceptLeftNode(ExpressionNodeGraphData node) => throw new NotImplementedException("Business implementation pending");
    public bool AcceptRightNode(ExpressionNodeGraphData node) => throw new NotImplementedException("Business implementation pending");
    public ExpressionNodeGraphData CreateExpression(ExpressionNodeGraphData context, string expression) => throw new NotImplementedException("Business implementation pending");
}
