package com.example.assetupgrade.observability;

/**
 * Skeleton seam for AuditDecorator.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AuditDecorator {
    Object execute(Object input);
}
