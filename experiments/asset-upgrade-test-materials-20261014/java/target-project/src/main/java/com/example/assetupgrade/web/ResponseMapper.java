package com.example.assetupgrade.web;

/**
 * Skeleton seam for ResponseMapper.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface ResponseMapper {
    Object execute(Object input);
}
