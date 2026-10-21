package com.example.assetupgrade.application;

/**
 * Skeleton seam for CommandValidator.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface CommandValidator {
    Object execute(Object input);
}
