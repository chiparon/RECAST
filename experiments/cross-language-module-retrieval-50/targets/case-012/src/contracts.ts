import type { LeaderControlledRoutesData } from "./models.js";

/** 根据集群命名空间内的领导者和成员状态控制路由启动与停止。提供路由过滤、策略配置以及路由移除时释放集群视图的生命周期。 */
export interface LeaderControlledRoutesContract {
  on_leadership_change(namespace: string, leader: boolean): void;
  on_route_init(route: LeaderControlledRoutesData): void;
  on_route_remove(route: LeaderControlledRoutesData): void;
}
