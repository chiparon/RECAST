package com.example.assetupgrade.attachment.port;

/**
 * Publication boundary for an attachment's approval event.
 *
 * <p>Publishing is only ever requested by the application layer after an attachment has
 * passed a clean scan and been released; the port must not be invoked for an unscanned or
 * rejected attachment.</p>
 */
public interface AttachmentEventPort {

    /** Publishes the approval event for {@code metadata} with the operation's correlation identity. */
    void publish(com.example.assetupgrade.attachment.AttachmentMetadata metadata,
                 com.example.assetupgrade.common.CorrelationId correlationId);

    /** Compatibility seam; the typed contract is {@link #publish}. */
    default Object execute(Object input) {
        if (input instanceof PublishRequest request) {
            publish(request.metadata(), request.correlationId());
            return null;
        }
        throw new IllegalArgumentException("Expected a PublishRequest");
    }

    /** Request holder accepted by the compatibility seam. */
    record PublishRequest(com.example.assetupgrade.attachment.AttachmentMetadata metadata,
                          com.example.assetupgrade.common.CorrelationId correlationId) {
    }
}
