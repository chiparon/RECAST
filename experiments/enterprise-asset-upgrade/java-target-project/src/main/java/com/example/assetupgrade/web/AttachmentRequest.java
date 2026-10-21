package com.example.assetupgrade.web;

import com.example.assetupgrade.attachment.AttachmentContent;
import com.example.assetupgrade.attachment.AttachmentContentType;
import com.example.assetupgrade.attachment.AttachmentIntakeCommand;
import com.example.assetupgrade.attachment.AttachmentMetadata;
import com.example.assetupgrade.attachment.AttachmentState;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.TenantId;

/**
 * Public web request describing one attachment submission.
 *
 * <p>Translated from the APScheduler shared-model normalisation pattern
 * ({@code _structures.py}): the canonical constructor trims identifiers, defaults the
 * declared media type and clamps a negative content length, and the {@code to*} helpers
 * derive the typed domain records without leaking a provider type. The tenant, actor and
 * correlation identity are carried as textual values because they arrive from the
 * transport layer; they are resolved into typed identities by
 * {@link RequestContextResolver}.</p>
 *
 * @param attachmentId       the client-visible attachment identity
 * @param tenantId           the tenant the caller declares
 * @param actorId            the actor the caller declares
 * @param correlationId      the caller-supplied correlation identity, or {@code null}
 * @param fileName           the original file name
 * @param declaredContentType the declared media type
 * @param contentLength      the declared content length in bytes
 * @param content            the readable payload
 */
public record AttachmentRequest(
        String attachmentId,
        String tenantId,
        String actorId,
        String correlationId,
        String fileName,
        String declaredContentType,
        long contentLength,
        AttachmentContent content) {

    public AttachmentRequest {
        attachmentId = trim(attachmentId);
        tenantId = trim(tenantId);
        actorId = trim(actorId);
        correlationId = trim(correlationId);
        fileName = trim(fileName);
        declaredContentType = trim(declaredContentType);
        contentLength = Math.max(contentLength, 0L);
    }

    private static String trim(String value) {
        return value == null ? null : value.trim();
    }

    /** @return the declared media type as a typed declaration, defaulting to octet-stream. */
    public AttachmentContentType contentType() {
        return AttachmentContentType.of(declaredContentType);
    }

    /** @return the attachment metadata derived from this request for the declared tenant. */
    public AttachmentMetadata toMetadata() {
        return toMetadata(tenantId == null ? null : TenantId.of(tenantId));
    }

    /** @return the attachment metadata derived from this request for {@code tenant}. */
    public AttachmentMetadata toMetadata(TenantId tenant) {
        return new AttachmentMetadata(attachmentId, tenant, fileName, contentType(), contentLength,
                null, AttachmentState.RECEIVED, false, null);
    }

    /** @return the intake command bridging this request for {@code metadata}. */
    public AttachmentIntakeCommand toCommand(CommandMetadata metadata) {
        TenantId tenant = metadata == null ? null : metadata.tenantId();
        return new AttachmentIntakeCommand(metadata, toMetadata(tenant), content);
    }

    /** @return a copy of this request bound to an explicit correlation identity. */
    public AttachmentRequest withCorrelationId(String newCorrelationId) {
        return new AttachmentRequest(attachmentId, tenantId, actorId, trim(newCorrelationId), fileName,
                declaredContentType, contentLength, content);
    }

    /** @return a copy of this request bound to an explicit tenant, actor and correlation. */
    public AttachmentRequest withIdentity(String newTenantId, String newActorId, String newCorrelationId) {
        return new AttachmentRequest(attachmentId, trim(newTenantId), trim(newActorId), trim(newCorrelationId),
                fileName, declaredContentType, contentLength, content);
    }
}
