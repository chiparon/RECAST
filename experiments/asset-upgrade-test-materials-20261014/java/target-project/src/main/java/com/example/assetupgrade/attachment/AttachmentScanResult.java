package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for AttachmentScanResult.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public record AttachmentScanResult(boolean clean, String scannerName, String signature, String detail) {}
