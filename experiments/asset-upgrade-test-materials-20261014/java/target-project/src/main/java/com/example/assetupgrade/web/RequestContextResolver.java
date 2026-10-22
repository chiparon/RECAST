package com.example.assetupgrade.web;

/**
 * Skeleton seam for RequestContextResolver.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface RequestContextResolver {
    Object execute(Object input);
}
