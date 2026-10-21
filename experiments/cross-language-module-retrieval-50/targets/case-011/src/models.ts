/** 定义集成路由、端点、数据格式和表达式的声明模型与构建接口。允许组合处理步骤、从模板实例化路由和设置模板参数，业务执行留给运行时。 */
export interface RoutingDslDefinitionsData {
  route_id: string;
  input_uri: string;
  outputs: Array<RoutingDslDefinitionsData>;
  template_parameters: { [key: string]: string };
}

