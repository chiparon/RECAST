package com.example.assetupgrade.attachment;

import com.example.assetupgrade.attachment.port.AttachmentEventPort;
import com.example.assetupgrade.attachment.port.AttachmentFingerprintPort;
import com.example.assetupgrade.attachment.port.AttachmentLockPort;
import com.example.assetupgrade.attachment.port.AttachmentMetadataStore;
import com.example.assetupgrade.attachment.port.AttachmentRepository;
import com.example.assetupgrade.attachment.port.AttachmentScanner;
import com.example.assetupgrade.attachment.port.ObjectStoragePort;
import com.example.assetupgrade.attachment.port.QuarantinePort;
import com.example.assetupgrade.attachment.port.UploadStreamPort;
import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.observability.MetricPort;
import com.example.assetupgrade.retry.IdempotencyKey;
import com.example.assetupgrade.retry.IdempotencyPort;
import com.example.assetupgrade.security.AuthorizationDecision;
import com.example.assetupgrade.security.Permission;
import com.example.assetupgrade.security.TenantAuthorizer;
import com.example.assetupgrade.security.TenantScope;

import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Tenant-aware attachment intake and release boundary.
 *
 * <p>Intake validates the tenant and actor, screens the metadata and payload, computes a
 * content fingerprint, holds the attachment in quarantine, scans it through the configured
 * {@link AttachmentScanner} and only releases it (publishing its approval event) when the
 * scan is clean. A rejected, cross-tenant, unsafe, oversized, signature-mismatched or
 * unscanned attachment never produces an approval event.</p>
 *
 * <p>Commands are idempotent per tenant: the tenant-qualified command key is claimed before
 * work begins and a replayed command returns the stored outcome without repeating the side
 * effects or writing a second audit record. A failed command releases the claim so a later
 * retry can proceed. Release is a separate, lock-guarded, idempotent operation that refuses
 * to publish for an attachment that has not passed a clean scan.</p>
 */
public final class AttachmentIntakeHandler implements AttachmentIntakeService {

    /** Operation name used to build the tenant-qualified idempotency key. */
    public static final String INTAKE_OPERATION = "attachment.intake";

    private final TenantAuthorizer authorizer;
    private final AttachmentValidator validator;
    private final AttachmentScanner scanner;
    private final AttachmentRepository repository;
    private final QuarantinePort quarantine;
    private final AttachmentEventPort events;
    private final com.example.assetupgrade.audit.AuditPort audit;
    private final IdempotencyPort idempotency;

    private final AttachmentFingerprintPort fingerprints;
    private final AttachmentLockPort locks;
    private final AttachmentMetadataStore metadataStore;
    private final ObjectStoragePort storage;
    private final UploadStreamPort uploadStream;

    private final FilenameSafetyPolicy filenames = new FilenameSafetyPolicy();
    private final AttachmentScanHandler scanHandler;
    private final AttachmentQuarantineCoordinator quarantineCoordinator;
    private final AttachmentReleaseCoordinator releaseCoordinator;
    private final AttachmentAuditHandler auditHandler;
    private final AttachmentDuplicateHandler duplicateHandler;
    private final AttachmentMetricsHandler metrics;
    private final ConcurrentHashMap<String, ReentrantLock> fallbackLocks = new ConcurrentHashMap<>();

    /** Creates an unconfigured handler; every operation fails closed. */
    public AttachmentIntakeHandler() {
        this(null, null, null, null, null, null, null, null);
    }

    /** Creates the handler with the collaborators declared by the intake service. */
    public AttachmentIntakeHandler(
            TenantAuthorizer authorizer,
            AttachmentValidator validator,
            AttachmentScanner scanner,
            AttachmentRepository repository,
            QuarantinePort quarantine,
            AttachmentEventPort events,
            com.example.assetupgrade.audit.AuditPort audit,
            IdempotencyPort idempotency) {
        this(authorizer, validator, scanner, repository, quarantine, events, audit, idempotency,
                null, null, null, null, null, null);
    }

    /**
     * Creates the handler with the full set of optional collaborators.
     *
     * <p>A {@code null} optional collaborator degrades gracefully: fingerprints are computed
     * locally, locking falls back to an in-process striped lock, metadata is stored through the
     * repository and object storage/metrics emission is skipped.</p>
     */
    public AttachmentIntakeHandler(
            TenantAuthorizer authorizer,
            AttachmentValidator validator,
            AttachmentScanner scanner,
            AttachmentRepository repository,
            QuarantinePort quarantine,
            AttachmentEventPort events,
            com.example.assetupgrade.audit.AuditPort audit,
            IdempotencyPort idempotency,
            AttachmentFingerprintPort fingerprints,
            AttachmentLockPort locks,
            AttachmentMetadataStore metadataStore,
            ObjectStoragePort storage,
            UploadStreamPort uploadStream,
            MetricPort metrics) {
        this.authorizer = authorizer;
        this.validator = validator == null ? AttachmentValidator.defaults() : validator;
        this.scanner = scanner;
        this.repository = repository;
        this.quarantine = quarantine;
        this.events = events;
        this.audit = audit;
        this.idempotency = idempotency;
        this.fingerprints = fingerprints;
        this.locks = locks;
        this.metadataStore = metadataStore;
        this.storage = storage;
        this.uploadStream = uploadStream;

        this.scanHandler = new AttachmentScanHandler(scanner);
        this.quarantineCoordinator = new AttachmentQuarantineCoordinator(quarantine, repository);
        this.releaseCoordinator = new AttachmentReleaseCoordinator(quarantine, events, repository);
        this.auditHandler = new AttachmentAuditHandler(audit);
        this.duplicateHandler = new AttachmentDuplicateHandler(idempotency, repository);
        this.metrics = new AttachmentMetricsHandler(metrics);
    }

    @Override
    public AttachmentIntakeResult intake(AttachmentIntakeCommand command) {
        metrics.intakeAttempt();
        if (command == null) {
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED,
                    ServiceProblem.of(ProblemCode.INVALID_INPUT, "attachment command is required"));
        }
        CommandMetadata commandMetadata = command.metadata();
        AttachmentMetadata declared = command.attachment();
        AttachmentContent content = command.content();
        if (commandMetadata == null || declared == null) {
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED,
                    ServiceProblem.of(ProblemCode.INVALID_INPUT, "command metadata and attachment are required"));
        }

        TenantId tenantId = commandMetadata.tenantId();
        ActorId actorId = commandMetadata.actorId();
        CorrelationId correlationId = commandMetadata.correlationId();
        String attachmentId = declared.attachmentId();

        if (!declared.belongsTo(tenantId)) {
            return deny(tenantId, attachmentId, correlationId,
                    "attachment tenant does not match the command tenant");
        }

        AuthorizationDecision decision = authorize(tenantId, actorId, Permission.ATTACHMENT_SUBMIT, attachmentId);
        if (decision.isDenied()) {
            return deny(tenantId, attachmentId, correlationId,
                    decision.reason() == null || decision.reason().isBlank() ? "submission denied" : decision.reason());
        }

        IdempotencyKey key = IdempotencyKey.of(tenantId, INTAKE_OPERATION, attachmentId);
        if (duplicateHandler.isDuplicate(key) || !duplicateHandler.claim(key)) {
            return duplicateResult(tenantId, attachmentId);
        }

        List<ServiceProblem> problems = new ArrayList<>();
        problems.addAll(validator.validateMetadata(declared));
        problems.addAll(validator.validateContentSignature(declared, content));
        if (!problems.isEmpty()) {
            return quarantineAndReject(tenantId, declared, correlationId, key, problems, QuarantineReason.from(problems));
        }

        String fingerprint = fingerprint(declared, content);
        AttachmentMetadata prepared = declared
                .withFileName(filenames.normalize(declared.fileName()))
                .withContentHash(fingerprint)
                .withState(AttachmentState.SCANNING)
                .withScanned(false);

        try {
            save(prepared);
            if (storage != null && content != null) {
                storage.store(prepared, content);
            }
        } catch (RuntimeException storageFailure) {
            return quarantineAndReject(tenantId, prepared, correlationId, key,
                    List.of(ServiceProblem.of(ProblemCode.STORAGE_FAILURE,
                            "attachment could not be stored: " + describe(storageFailure), attachmentId)),
                    QuarantineReason.STORAGE_ERROR);
        }

        AttachmentMetadata held = quarantineCoordinator.quarantine(prepared, QuarantineReason.SCAN_PENDING);
        AttachmentMetadata scannedSource = held == null ? prepared : held;

        AttachmentScanResult scanResult = scanHandler.scan(scannedSource, content);
        if (!scanHandler.isClean(scanResult)) {
            List<ServiceProblem> scanProblems = List.of(ServiceProblem.of(ProblemCode.QUARANTINED,
                    "attachment did not pass scanning: " + scanResult.summary(), attachmentId));
            return quarantineAndReject(tenantId, scannedSource, correlationId, key, scanProblems,
                    QuarantineReason.SCAN_FAILED);
        }

        AttachmentMetadata scanned = scannedSource.withScanned(true).withState(AttachmentState.SCANNED);
        save(scanned);
        AttachmentMetadata released = releaseCoordinator.release(scanned, correlationId);
        if (released == null) {
            released = scanned;
        }
        save(released);
        metrics.accepted();
        metrics.released();
        auditHandler.recordIntake(tenantId, released, correlationId, "release");
        return AttachmentIntakeResult.accepted(AttachmentState.RELEASED, released.contentHash());
    }

    @Override
    public AttachmentIntakeResult release(TenantId tenantId, ActorId actorId, String attachmentId,
                                          CorrelationId correlationId) {
        if (tenantId == null || attachmentId == null || attachmentId.isBlank()) {
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED,
                    ServiceProblem.of(ProblemCode.INVALID_INPUT, "tenant and attachment id are required"));
        }
        AuthorizationDecision decision = authorize(tenantId, actorId, Permission.ATTACHMENT_RELEASE, attachmentId);
        if (decision.isDenied()) {
            return deny(tenantId, attachmentId, correlationId,
                    decision.reason() == null || decision.reason().isBlank() ? "release denied" : decision.reason());
        }

        AttachmentMetadata stored = find(tenantId, attachmentId);
        if (stored == null) {
            return AttachmentIntakeResult.rejected(AttachmentState.REJECTED,
                    ServiceProblem.of(ProblemCode.NOT_FOUND, "attachment was not found", attachmentId));
        }
        if (!stored.belongsTo(tenantId)) {
            return deny(tenantId, attachmentId, correlationId, "attachment belongs to another tenant");
        }
        if (stored.state() == AttachmentState.RELEASED) {
            metrics.duplicate();
            return AttachmentIntakeResult.duplicate(stored.state(), stored.contentHash());
        }
        if (!releaseCoordinator.canRelease(stored)) {
            metrics.denied();
            auditHandler.recordDenial(tenantId, attachmentId, correlationId, "release blocked: attachment is not cleanly scanned");
            return AttachmentIntakeResult.rejected(stored.state(),
                    ServiceProblem.of(ProblemCode.QUARANTINED,
                            "attachment has not passed a clean scan and cannot be released", attachmentId));
        }

        Lock lock = lockFor(tenantId, attachmentId);
        lock.lock();
        try {
            AttachmentMetadata current = find(tenantId, attachmentId);
            if (current == null) {
                return AttachmentIntakeResult.rejected(AttachmentState.REJECTED,
                        ServiceProblem.of(ProblemCode.NOT_FOUND, "attachment was not found", attachmentId));
            }
            if (!current.belongsTo(tenantId)) {
                return deny(tenantId, attachmentId, correlationId, "attachment belongs to another tenant");
            }
            if (current.state() == AttachmentState.RELEASED) {
                metrics.duplicate();
                return AttachmentIntakeResult.duplicate(current.state(), current.contentHash());
            }
            if (!releaseCoordinator.canRelease(current)) {
                metrics.denied();
                auditHandler.recordDenial(tenantId, attachmentId, correlationId, "release blocked: attachment is not cleanly scanned");
                return AttachmentIntakeResult.rejected(current.state(),
                        ServiceProblem.of(ProblemCode.QUARANTINED,
                                "attachment has not passed a clean scan and cannot be released", attachmentId));
            }
            AttachmentMetadata released = releaseCoordinator.release(current, correlationId);
            if (released == null) {
                return AttachmentIntakeResult.rejected(current.state(),
                        ServiceProblem.of(ProblemCode.QUARANTINED, "attachment cannot be released", attachmentId));
            }
            metrics.released();
            auditHandler.recordIntake(tenantId, released, correlationId, "release");
            return AttachmentIntakeResult.accepted(AttachmentState.RELEASED, released.contentHash());
        } finally {
            lock.unlock();
        }
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof AttachmentIntakeCommand command) {
            return intake(command);
        }
        throw new IllegalArgumentException("Expected AttachmentIntakeCommand");
    }

    private AttachmentIntakeResult deny(TenantId tenantId, String attachmentId, CorrelationId correlationId,
                                         String reason) {
        metrics.denied();
        if (tenantId != null) {
            auditHandler.recordDenial(tenantId, attachmentId, correlationId, reason);
        }
        return AttachmentIntakeResult.rejected(AttachmentState.REJECTED,
                ServiceProblem.of(ProblemCode.TENANT_DENIED, reason, attachmentId));
    }

    private AttachmentIntakeResult quarantineAndReject(TenantId tenantId, AttachmentMetadata metadata,
                                                       CorrelationId correlationId, IdempotencyKey key,
                                                       List<ServiceProblem> problems, QuarantineReason reason) {
        AttachmentMetadata rejected = metadata.withScanned(false).withState(AttachmentState.REJECTED);
        save(rejected);
        quarantineCoordinator.quarantine(rejected, reason);
        duplicateHandler.release(key);
        metrics.rejected();
        metrics.quarantined();
        if (tenantId != null) {
            auditHandler.recordQuarantine(tenantId, rejected, correlationId, reason, problems);
        }
        return AttachmentIntakeResult.rejected(AttachmentState.REJECTED, rejected.contentHash(), problems);
    }

    private AttachmentIntakeResult duplicateResult(TenantId tenantId, String attachmentId) {
        metrics.duplicate();
        Optional<AttachmentMetadata> existing = duplicateHandler.existing(tenantId, attachmentId);
        AttachmentState state = existing.map(AttachmentMetadata::state).orElse(AttachmentState.RELEASED);
        String fingerprint = existing.map(AttachmentMetadata::contentHash).orElse(null);
        return AttachmentIntakeResult.duplicate(state, fingerprint);
    }

    private AuthorizationDecision authorize(TenantId tenantId, ActorId actorId, Permission permission,
                                            String subjectId) {
        if (authorizer == null) {
            return AuthorizationDecision.allow(Set.of(permission));
        }
        TenantScope scope = TenantScope.of(tenantId, actorId, Set.of(), Set.of(), null);
        AuthorizationDecision decision = authorizer.authorize(scope, permission, subjectId);
        if (decision == null) {
            return AuthorizationDecision.deny("authorizer returned no decision");
        }
        return decision;
    }

    private String fingerprint(AttachmentMetadata metadata, AttachmentContent content) {
        if (fingerprints != null && content != null) {
            try {
                String computed = fingerprints.fingerprint(content);
                if (computed != null && !computed.isBlank()) {
                    return computed;
                }
            } catch (RuntimeException ignored) {
                // fall back to the declared hash or a locally computed digest
            }
        }
        if (metadata.contentHash() != null && !metadata.contentHash().isBlank()) {
            return metadata.contentHash();
        }
        return sha256(content);
    }

    private static String sha256(AttachmentContent content) {
        if (content == null) {
            return null;
        }
        try (InputStream stream = content.openStream()) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (IOException | NoSuchAlgorithmException | RuntimeException ex) {
            return null;
        }
    }

    private void save(AttachmentMetadata metadata) {
        if (metadata == null) {
            return;
        }
        if (repository != null) {
            repository.save(metadata);
        } else if (metadataStore != null) {
            metadataStore.record(metadata);
        }
    }

    private AttachmentMetadata find(TenantId tenantId, String attachmentId) {
        if (repository != null) {
            return repository.find(tenantId, attachmentId).orElseGet(() -> recordFromStore(tenantId, attachmentId));
        }
        return recordFromStore(tenantId, attachmentId);
    }

    private AttachmentMetadata recordFromStore(TenantId tenantId, String attachmentId) {
        if (metadataStore == null) {
            return null;
        }
        return metadataStore.find(tenantId, attachmentId).orElse(null);
    }

    private Lock lockFor(TenantId tenantId, String attachmentId) {
        if (locks != null) {
            Lock lock = locks.lock(tenantId, attachmentId);
            if (lock != null) {
                return lock;
            }
        }
        return fallbackLocks.computeIfAbsent(tenantId.value() + ':' + attachmentId, key -> new ReentrantLock());
    }

    private static String describe(RuntimeException failure) {
        return failure.getMessage() == null || failure.getMessage().isBlank()
                ? failure.getClass().getSimpleName()
                : failure.getMessage();
    }

    /** @return the fingerprint port, or {@code null} when none is configured. */
    public AttachmentFingerprintPort fingerprintPort() {
        return fingerprints;
    }

    /** @return the metadata store, or {@code null} when none is configured. */
    public AttachmentMetadataStore metadataStore() {
        return metadataStore;
    }

    /** @return the object storage port, or {@code null} when none is configured. */
    public ObjectStoragePort objectStorage() {
        return storage;
    }

    /** @return the upload stream port, or {@code null} when none is configured. */
    public UploadStreamPort uploadStream() {
        return uploadStream;
    }

    /** @return the scanner port backing this handler, or {@code null} when none is configured. */
    public AttachmentScanner scanner() {
        return scanner;
    }

    /** @return the audit sink backing this handler, or {@code null} when none is configured. */
    public com.example.assetupgrade.audit.AuditPort audit() {
        return audit;
    }

    /** @return the time source used by the audit handler. */
    public TimeProvider clock() {
        return TimeProvider.system();
    }
}
