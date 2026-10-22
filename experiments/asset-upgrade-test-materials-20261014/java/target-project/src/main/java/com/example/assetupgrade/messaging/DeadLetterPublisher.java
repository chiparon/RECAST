package com.example.assetupgrade.messaging;

/**
 * Skeleton seam for DeadLetterPublisher.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface DeadLetterPublisher {
    Object execute(Object input);
}
