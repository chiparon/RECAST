package com.example.assetupgrade.attachment;

import com.example.assetupgrade.audit.AuditAction;
import com.example.assetupgrade.audit.AuditEntry;
import com.example.assetupgrade.audit.AuditPort;
import com.example.assetupgrade.audit.AuditStatus;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Writes tenant-scoped audit evidence for attachment intake, quarantine and release.
 *
 * <p>Every record carries the owning tenant, the attachment identifier as subject, the
 * {@link AuditAction} kind, the final {@link AuditStatus} and the correlation identity
 * propagated across the operation. Details always include the attachment identifier so the
 * evidence can be joined back to the stored metadata.</p>
 */
public final class AttachmentAuditHandler {

    /** Detail key holding the attachment identifier. */
    public static final String ATTACHMENT_ID = "attachmentId";
    /** Detail key holding the normalised file name. */
    public static final String FILE_NAME = "fileName";
    /** Detail key holding the lifecycle state. */
    public static final String STATE = "state";
    /** Detail key holding the content fingerprint. */
    public static final String FINGERPRINT = "fingerprint";
    /** Detail key holding the quarantine reason. */
    public static final String REASON = "reason";
    /** Detail key holding the processing phase. */
    public static final String PHASE = "phase";

    private final AuditPort audit;
    private final TimeProvider clock;

    /** Creates a handler with no sink; records are built but not persisted. */
    public AttachmentAuditHandler() {
        this(null, null);
    }

    /** Creates a handler writing through {@code audit}. */
    public AttachmentAuditHandler(AuditPort audit) {
        this(audit, null);
    }

    /** Creates a handler writing through {@code audit} using {@code clock} for the occurrence instant. */
    public AttachmentAuditHandler(AuditPort audit, TimeProvider clock) {
        this.audit = audit;
        this.clock = clock == null ? TimeProvider.system() : clock;
    }

    /** Builds and writes one audit entry; returns the entry that was written. */
    public AuditEntry record(TenantId tenantId, String subjectId, AuditAction action, AuditStatus status,
                             CorrelationId correlationId, Map<String, String> details) {
        AuditEntry entry = new AuditEntry(tenantId, subjectId, action, status, correlationId, clock.now(), details);
        if (audit != null) {
            audit.append(entry);
        }
        return entry;
    }

    /** Records a successful intake or release. */
    public AuditEntry recordIntake(TenantId tenantId, AttachmentMetadata metadata, CorrelationId correlationId,
                                   String phase) {
        Map<String, String> details = baseDetails(metadata);
        details.put(PHASE, phase == null ? "intake" : phase);
        return record(tenantId, metadata.attachmentId(), AuditAction.ATTACHMENT_INTAKE, AuditStatus.ACCEPTED,
                correlationId, details);
    }

    /** Records a quarantine decision and the problems that caused it. */
    public AuditEntry recordQuarantine(TenantId tenantId, AttachmentMetadata metadata, CorrelationId correlationId,
                                       QuarantineReason reason, List<ServiceProblem> problems) {
        Map<String, String> details = baseDetails(metadata);
        details.put(REASON, reason == null ? QuarantineReason.SCAN_PENDING.name() : reason.name());
        details.put(PHASE, "quarantine");
        if (problems != null && !problems.isEmpty()) {
            details.put("problemCount", Integer.toString(problems.size()));
            ServiceProblem first = problems.get(0);
            if (first != null) {
                details.put("problemCode", first.code().name());
                details.put("problem", first.message());
            }
        }
        return record(tenantId, metadata.attachmentId(), AuditAction.ATTACHMENT_QUARANTINE,
                AuditStatus.QUARANTINED, correlationId, details);
    }

    /** Records a security denial, for example a cross-tenant or unauthorised submission. */
    public AuditEntry recordDenial(TenantId tenantId, String attachmentId, CorrelationId correlationId,
                                   String reason) {
        Map<String, String> details = new LinkedHashMap<>();
        if (attachmentId != null) {
            details.put(ATTACHMENT_ID, attachmentId);
        }
        details.put(REASON, reason == null ? "denied" : reason);
        details.put(PHASE, "security");
        return record(tenantId, attachmentId, AuditAction.SECURITY_DENIAL, AuditStatus.REJECTED, correlationId, details);
    }

    /** @return the backing audit port, or {@code null} when none is configured. */
    public AuditPort port() {
        return audit;
    }

    private static Map<String, String> baseDetails(AttachmentMetadata metadata) {
        Map<String, String> details = new LinkedHashMap<>();
        if (metadata != null) {
            details.put(ATTACHMENT_ID, metadata.attachmentId());
            details.put(FILE_NAME, metadata.fileName());
            details.put(STATE, metadata.state().name());
            if (metadata.contentHash() != null) {
                details.put(FINGERPRINT, metadata.contentHash());
            }
        }
        return details;
    }

    /** Compatibility seam; accepts an {@link AttachmentIntakeCommand} and records an intake entry. */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return recordIntake(command.metadata().tenantId(), command.attachment(),
                    command.metadata().correlationId(), "intake");
        }
        throw new IllegalArgumentException("Expected an AttachmentIntakeCommand");
    }
}
