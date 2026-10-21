import type { RoutingDslDefinitionsData } from "./models.js";

/** 定义集成路由、端点、数据格式和表达式的声明模型与构建接口。允许组合处理步骤、从模板实例化路由和设置模板参数，业务执行留给运行时。 */
export interface RoutingDslDefinitionsContract {
  define_route(route: RoutingDslDefinitionsData): unknown;
  add_output(route: RoutingDslDefinitionsData, processor: RoutingDslDefinitionsData): void;
  instantiate_template(template_id: string, parameters: { [key: string]: string }): RoutingDslDefinitionsData;
}
