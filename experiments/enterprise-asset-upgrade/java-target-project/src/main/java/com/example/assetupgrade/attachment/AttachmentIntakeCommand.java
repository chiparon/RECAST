package com.example.assetupgrade.attachment;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;

/**
 * Command carrying the identity metadata, the declared attachment description and the
 * payload stream accepted by the intake boundary.
 *
 * <p>The record components {@code metadata, attachment, content} are the public contract.
 * Convenience accessors expose the tenant, actor, correlation identity and attachment id
 * without unwrapping the nested records.</p>
 */
public record AttachmentIntakeCommand(CommandMetadata metadata, AttachmentMetadata attachment, AttachmentContent content) {

    /** @return the tenant that owns the command. */
    public TenantId tenantId() {
        return metadata == null ? null : metadata.tenantId();
    }

    /** @return the actor submitting the command. */
    public ActorId actorId() {
        return metadata == null ? null : metadata.actorId();
    }

    /** @return the correlation identity propagated across the operation. */
    public CorrelationId correlationId() {
        return metadata == null ? null : metadata.correlationId();
    }

    /** @return the identifier of the attachment being submitted. */
    public String attachmentId() {
        return attachment == null ? null : attachment.attachmentId();
    }
}
