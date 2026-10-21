import type { ExpressionFunctionRegistryData } from "./models.js";
import type { ExpressionFunctionRegistryContract } from "./contracts.js";

/** 将表达式中的函数名称解析成可执行表达式。覆盖消息体、对象方法引用、集合操作以及日期时间函数，并保留错误的源位置。 */
export class ExpressionFunctionRegistry implements ExpressionFunctionRegistryContract {
  create_function(function_text: string, index: number, context: ExpressionFunctionRegistryData): unknown { throw new Error("Business implementation pending"); }
}
