import type { SerializationFormatFactoryData } from "./models.js";
import type { SerializationFormatFactoryContract } from "./contracts.js";

/** 根据数据格式定义或注册引用创建序列化和反序列化组件。维护按格式定义类型注册的工厂，并把声明的属性应用到组件实例。 */
export class SerializationFormatFactory implements SerializationFormatFactoryContract {
  register_factory(definition_type: string, factory: unknown): void { throw new Error("Business implementation pending"); }
  resolve_format(definition: SerializationFormatFactoryData, reference: string): unknown { throw new Error("Business implementation pending"); }
  create_format(definition: SerializationFormatFactoryData): unknown { throw new Error("Business implementation pending"); }
}
