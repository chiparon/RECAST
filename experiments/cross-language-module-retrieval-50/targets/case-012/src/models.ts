/** 根据集群命名空间内的领导者和成员状态控制路由启动与停止。提供路由过滤、策略配置以及路由移除时释放集群视图的生命周期。 */
export interface LeaderControlledRoutesData {
  namespace: string;
  route_id: string;
  leader: boolean;
  initial_delay_seconds: number;
}

