package com.example.assetupgrade.attachment;

/**
 * Skeleton seam for AttachmentIntakeHandler.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public final class AttachmentIntakeHandler implements AttachmentIntakeService {
    private final com.example.assetupgrade.security.TenantAuthorizer authorizer;
    private final AttachmentValidator validator;
    private final com.example.assetupgrade.attachment.port.AttachmentScanner scanner;
    private final com.example.assetupgrade.attachment.port.AttachmentRepository repository;
    private final com.example.assetupgrade.attachment.port.QuarantinePort quarantine;
    private final com.example.assetupgrade.attachment.port.AttachmentEventPort events;
    private final com.example.assetupgrade.audit.AuditPort audit;
    private final com.example.assetupgrade.retry.IdempotencyPort idempotency;

    public AttachmentIntakeHandler() {
        this(null, null, null, null, null, null, null, null);
    }

    public AttachmentIntakeHandler(
            com.example.assetupgrade.security.TenantAuthorizer authorizer,
            AttachmentValidator validator,
            com.example.assetupgrade.attachment.port.AttachmentScanner scanner,
            com.example.assetupgrade.attachment.port.AttachmentRepository repository,
            com.example.assetupgrade.attachment.port.QuarantinePort quarantine,
            com.example.assetupgrade.attachment.port.AttachmentEventPort events,
            com.example.assetupgrade.audit.AuditPort audit,
            com.example.assetupgrade.retry.IdempotencyPort idempotency) {
        this.authorizer = authorizer;
        this.validator = validator;
        this.scanner = scanner;
        this.repository = repository;
        this.quarantine = quarantine;
        this.events = events;
        this.audit = audit;
        this.idempotency = idempotency;
    }

    @Override
    public AttachmentIntakeResult intake(AttachmentIntakeCommand command) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }

    @Override
    public AttachmentIntakeResult release(com.example.assetupgrade.common.TenantId tenantId,
                                           com.example.assetupgrade.common.ActorId actorId,
                                           String attachmentId,
                                           com.example.assetupgrade.common.CorrelationId correlationId) {
        throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent");
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) return intake(command);
        throw new IllegalArgumentException("Expected AttachmentIntakeCommand");
    }
}
