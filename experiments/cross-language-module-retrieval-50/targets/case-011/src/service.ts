import type { RoutingDslDefinitionsData } from "./models.js";
import type { RoutingDslDefinitionsContract } from "./contracts.js";

/** 定义集成路由、端点、数据格式和表达式的声明模型与构建接口。允许组合处理步骤、从模板实例化路由和设置模板参数，业务执行留给运行时。 */
export class RoutingDslDefinitions implements RoutingDslDefinitionsContract {
  define_route(route: RoutingDslDefinitionsData): unknown { throw new Error("Business implementation pending"); }
  add_output(route: RoutingDslDefinitionsData, processor: RoutingDslDefinitionsData): void { throw new Error("Business implementation pending"); }
  instantiate_template(template_id: string, parameters: { [key: string]: string }): RoutingDslDefinitionsData { throw new Error("Business implementation pending"); }
}
