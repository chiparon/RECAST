package com.example.assetupgrade.web;

/**
 * Skeleton seam for OrderRequestDto.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record OrderRequestDto(String marker, java.util.Map<String,String> attributes) {}
