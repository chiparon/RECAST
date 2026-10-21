import type { IntegrationManagementContractsData } from "./models.js";

/** 定义集成运行时的管理接口，暴露上下文和路由的身份、状态、运行时间、性能统计与生命周期控制。这里提供管理契约，不实现实际管理服务器。 */
export interface IntegrationManagementContractsContract {
  get_state(resource_id: string): string;
  get_statistics(resource_id: string): IntegrationManagementContractsData;
  start_route(route_id: string): void;
  stop_route(route_id: string): void;
}
