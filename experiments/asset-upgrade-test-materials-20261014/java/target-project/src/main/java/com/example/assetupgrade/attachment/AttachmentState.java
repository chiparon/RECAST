package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for AttachmentState.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public enum AttachmentState { RECEIVED, SCANNING, QUARANTINED, SCANNED, RELEASED, REJECTED }
