/** 定义集成运行时的管理接口，暴露上下文和路由的身份、状态、运行时间、性能统计与生命周期控制。这里提供管理契约，不实现实际管理服务器。 */
export interface IntegrationManagementContractsData {
  route_id: string;
  state: string;
  uptime_millis: number;
  completed_exchanges: number;
}

