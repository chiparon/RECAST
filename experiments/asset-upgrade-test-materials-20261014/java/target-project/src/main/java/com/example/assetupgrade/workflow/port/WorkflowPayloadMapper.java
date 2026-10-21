package com.example.assetupgrade.workflow.port;

/**
 * Skeleton seam for WorkflowPayloadMapper.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface WorkflowPayloadMapper {
    java.util.Map<String, Object> map(com.example.assetupgrade.workflow.WorkflowEvent event);
    /** Generic compatibility seam; typed methods define the contract. */
    default Object execute(Object input) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }
}
