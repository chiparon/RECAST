import type { SerializationFormatFactoryData } from "./models.js";

/** 根据数据格式定义或注册引用创建序列化和反序列化组件。维护按格式定义类型注册的工厂，并把声明的属性应用到组件实例。 */
export interface SerializationFormatFactoryContract {
  register_factory(definition_type: string, factory: unknown): void;
  resolve_format(definition: SerializationFormatFactoryData, reference: string): unknown;
  create_format(definition: SerializationFormatFactoryData): unknown;
}
