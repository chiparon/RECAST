package com.example.assetupgrade.hidden;

import com.example.assetupgrade.attachment.*;
import com.example.assetupgrade.attachment.port.*;
import com.example.assetupgrade.audit.*;
import com.example.assetupgrade.common.*;
import com.example.assetupgrade.retry.*;
import com.example.assetupgrade.security.*;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/** Evaluator-only attachment tests. This file lives outside the Agent-visible target tree. */
class AttachmentHiddenTest {
    private static final TenantId TENANT_A = new TenantId("tenant-a");
    private static final TenantId TENANT_B = new TenantId("tenant-b");
    private static final ActorId ACTOR = new ActorId("operator-1");
    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    private static final class Fixture {
        final AtomicInteger stored = new AtomicInteger();
        final AtomicInteger quarantined = new AtomicInteger();
        final AtomicInteger released = new AtomicInteger();
        final AtomicInteger events = new AtomicInteger();
        final List<AuditEntry> audits = new ArrayList<>();
        final Map<String, AttachmentMetadata> rows = new ConcurrentHashMap<>();
        final Set<IdempotencyKey> completed = ConcurrentHashMap.newKeySet();
        List<ServiceProblem> validationProblems = List.of();
        AttachmentScanResult scanResult = new AttachmentScanResult(true, "test-scanner", "sig-clean", "clean");
        final AttachmentIntakeService service;

        Fixture() {
            TenantAuthorizer authorizer = (scope, permission, subject) -> new AuthorizationDecision(
                    !TENANT_B.equals(scope.tenantId()) && permission == Permission.ATTACHMENT_SUBMIT,
                    "tenant/policy decision", Set.of(permission));
            AttachmentValidator validator = new AttachmentValidator() {
                public List<ServiceProblem> validateMetadata(AttachmentMetadata metadata) { return validationProblems; }
                public List<ServiceProblem> validateContentSignature(AttachmentMetadata metadata, AttachmentContent content) { return validationProblems; }
            };
            AttachmentScanner scanner = (metadata, content) -> scanResult;
            AttachmentRepository repository = new AttachmentRepository() {
                public Optional<AttachmentMetadata> find(TenantId tenant, String id) {
                    AttachmentMetadata row = rows.get(tenant.value() + ":" + id);
                    return Optional.ofNullable(row);
                }
                public void save(AttachmentMetadata metadata) {
                    rows.put(metadata.tenantId().value() + ":" + metadata.attachmentId(), metadata);
                    stored.incrementAndGet();
                }
            };
            QuarantinePort quarantine = new QuarantinePort() {
                public void quarantine(AttachmentMetadata metadata, QuarantineReason reason) { quarantined.incrementAndGet(); }
                public void release(TenantId tenant, String id) { released.incrementAndGet(); }
            };
            AttachmentEventPort eventPort = (metadata, correlation) -> events.incrementAndGet();
            AuditPort auditPort = new AuditPort() {
                public void append(AuditEntry entry) { audits.add(entry); }
                public List<AuditEntry> query(AuditQuery query) { return List.copyOf(audits); }
            };
            IdempotencyPort idempotency = new IdempotencyPort() {
                public boolean isCompleted(IdempotencyKey key) { return completed.contains(key); }
                public boolean tryMarkCompleted(IdempotencyKey key) { return completed.add(key); }
                public void remove(IdempotencyKey key) { completed.remove(key); }
            };
            service = new AttachmentIntakeHandler(authorizer, validator, scanner, repository, quarantine,
                    eventPort, auditPort, idempotency);
        }

        AttachmentIntakeCommand command(TenantId commandTenant, TenantId metadataTenant,
                                        String id, String name, String mime, byte[] bytes) {
            var metadata = new CommandMetadata(commandTenant, ACTOR, new CorrelationId("corr-" + id), NOW);
            var attachment = new AttachmentMetadata(id, metadataTenant, name, new AttachmentContentType(mime),
                    bytes.length, "sha256-" + id, AttachmentState.RECEIVED, false, NOW);
            AttachmentContent content = new AttachmentContent() {
                public java.io.InputStream openStream() { return new ByteArrayInputStream(bytes); }
                public long length() { return bytes.length; }
            };
            return new AttachmentIntakeCommand(metadata, attachment, content);
        }
    }

    @Test
    void validIntakeIsStoredInQuarantineAndAuditedOnce() {
        Fixture f = new Fixture();
        var command = f.command(TENANT_A, TENANT_A, "a1", "invoice.pdf", "application/pdf", "%PDF-test".getBytes());
        AttachmentIntakeResult result = f.service.intake(command);
        assertTrue(result.accepted());
        assertEquals(AttachmentState.QUARANTINED, result.state(), "intake must not release content before clean scan flow");
        assertEquals(1, f.stored.get());
        assertEquals(1, f.quarantined.get());
        assertEquals(1, f.audits.size());
        assertEquals(TENANT_A, f.audits.get(0).tenantId());
        assertEquals(new CorrelationId("corr-a1"), f.audits.get(0).correlationId());
    }

    @Test
    void crossTenantMetadataIsRejectedWithoutPersistingOrPublishing() {
        Fixture f = new Fixture();
        var result = f.service.intake(f.command(TENANT_A, TENANT_B, "a2", "invoice.pdf", "application/pdf", "%PDF-test".getBytes()));
        assertFalse(result.accepted());
        assertEquals(0, f.stored.get());
        assertEquals(0, f.events.get());
        assertNotEquals(AttachmentState.RELEASED, result.state());
    }

    @Test
    void validationFailureCannotCreateApprovalEventOrReleaseContent() {
        Fixture f = new Fixture();
        f.validationProblems = List.of(new ServiceProblem(ProblemCode.INVALID_INPUT, "unsafe filename or signature mismatch", "a3", Map.of()));
        var result = f.service.intake(f.command(TENANT_A, TENANT_A, "a3", "../secret.pdf", "application/pdf", "not-pdf".getBytes()));
        assertFalse(result.accepted());
        assertEquals(0, f.events.get());
        assertEquals(0, f.released.get());
        assertNotEquals(AttachmentState.RELEASED, result.state());
    }

    @Test
    void failedScanRemainsQuarantinedAndDoesNotPublish() {
        Fixture f = new Fixture();
        f.scanResult = new AttachmentScanResult(false, "test-scanner", "sig-malware", "infected");
        var result = f.service.intake(f.command(TENANT_A, TENANT_A, "a4", "invoice.pdf", "application/pdf", "%PDF-test".getBytes()));
        assertFalse(result.accepted());
        assertEquals(1, f.quarantined.get());
        assertEquals(0, f.released.get());
        assertEquals(0, f.events.get());
        assertNotEquals(AttachmentState.RELEASED, result.state());
    }

    @Test
    void repeatingSameCommandIsIdempotentAndHasNoDuplicateSideEffects() {
        Fixture f = new Fixture();
        var command = f.command(TENANT_A, TENANT_A, "a5", "invoice.pdf", "application/pdf", "%PDF-test".getBytes());
        var first = f.service.intake(command);
        var second = f.service.intake(command);
        assertTrue(first.accepted());
        assertTrue(second.accepted());
        assertEquals(1, f.stored.get());
        assertEquals(1, f.events.get());
        assertEquals(1, f.audits.size());
    }

    @Test
    void cleanScanIsRequiredBeforeRelease() {
        Fixture f = new Fixture();
        f.scanResult = new AttachmentScanResult(false, "test-scanner", "sig-unknown", "scan inconclusive");
        var intake = f.service.intake(f.command(TENANT_A, TENANT_A, "a6", "invoice.pdf", "application/pdf", "%PDF-test".getBytes()));
        assertFalse(intake.accepted());
        var release = f.service.release(TENANT_A, ACTOR, "a6", new CorrelationId("release-a6"));
        assertNotEquals(AttachmentState.RELEASED, release.state());
        assertEquals(0, f.released.get());
        assertEquals(0, f.events.get());
    }
}
