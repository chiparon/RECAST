package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for AttachmentContent.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public interface AttachmentContent { java.io.InputStream openStream(); long length(); }
