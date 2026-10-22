namespace ParallelModule;

/// <summary>将路由级 HTTP 请求和响应绑定规则与全局默认项合并，创建入站和出站数据绑定。支持 JSON/XML 格式选择、内容类型和客户端请求校验。</summary>
public sealed record HttpPayloadBindingData
{
    public string Component { get; init; } = default!;
    public string Consumes { get; init; } = default!;
    public string Produces { get; init; } = default!;
    public bool ClientRequestValidation { get; init; } = default!;
}

