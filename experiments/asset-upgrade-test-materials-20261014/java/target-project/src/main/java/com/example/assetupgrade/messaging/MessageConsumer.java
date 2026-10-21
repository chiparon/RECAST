package com.example.assetupgrade.messaging;

/**
 * Skeleton seam for MessageConsumer.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface MessageConsumer {
    Object execute(Object input);
}
