import type { IntegrationManagementContractsData } from "./models.js";
import type { IntegrationManagementContractsContract } from "./contracts.js";

/** 定义集成运行时的管理接口，暴露上下文和路由的身份、状态、运行时间、性能统计与生命周期控制。这里提供管理契约，不实现实际管理服务器。 */
export class IntegrationManagementContracts implements IntegrationManagementContractsContract {
  get_state(resource_id: string): string { throw new Error("Business implementation pending"); }
  get_statistics(resource_id: string): IntegrationManagementContractsData { throw new Error("Business implementation pending"); }
  start_route(route_id: string): void { throw new Error("Business implementation pending"); }
  stop_route(route_id: string): void { throw new Error("Business implementation pending"); }
}
