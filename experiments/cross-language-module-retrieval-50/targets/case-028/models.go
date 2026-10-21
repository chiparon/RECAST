package parallelmodule

// 定义 BPMN 流程模型，表示活动、事件、网关、泳道、顺序流、子流程与扩展属性。支持按标识查找流程元素、管理图形布局信息和复制模型元素。
type WorkflowDefinitionModelData struct {
    ElementId string
    ElementType string
    Incoming []string
    Outgoing []string
    Extensions map[string]string
}

