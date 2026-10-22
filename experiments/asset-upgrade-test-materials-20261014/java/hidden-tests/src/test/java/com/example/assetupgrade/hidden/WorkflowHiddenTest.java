package com.example.assetupgrade.hidden;

import com.example.assetupgrade.audit.*;
import com.example.assetupgrade.common.*;
import com.example.assetupgrade.retry.*;
import com.example.assetupgrade.security.*;
import com.example.assetupgrade.workflow.*;
import com.example.assetupgrade.workflow.port.*;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/** Evaluator-only workflow delivery tests, kept outside the target project. */
class WorkflowHiddenTest {
    private static final TenantId TENANT_A = new TenantId("tenant-a");
    private static final TenantId TENANT_B = new TenantId("tenant-b");
    private static final ActorId ACTOR = new ActorId("operator-1");
    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    private static final class Fixture {
        final AtomicInteger dispatches = new AtomicInteger();
        final AtomicInteger deadLetters = new AtomicInteger();
        final List<DeliveryAttempt> attempts = new ArrayList<>();
        final List<AuditEntry> audits = new ArrayList<>();
        final Map<String, EventEnvelope> envelopeRows = new ConcurrentHashMap<>();
        final Set<IdempotencyKey> completed = ConcurrentHashMap.newKeySet();
        boolean dispatchFails;
        int retryLimit = 2;
        final WorkflowDeliveryService service;

        Fixture() {
            TenantAuthorizer authorizer = (scope, permission, subject) -> new AuthorizationDecision(
                    !TENANT_B.equals(scope.tenantId()) && permission == Permission.WORKFLOW_DISPATCH,
                    "tenant/policy decision", Set.of(permission));
            WorkflowDispatcher dispatcher = (event, route, attemptNo) -> {
                dispatches.incrementAndGet();
                if (dispatchFails) throw new IllegalStateException("controlled dispatcher failure");
                return new DeliveryAttempt(event.eventId(), event.tenantId(), attemptNo, true,
                        DeliveryStatus.ACCEPTED, "delivered", NOW, NOW);
            };
            EventEnvelopeRepository envelopes = new EventEnvelopeRepository() {
                public Optional<EventEnvelope> find(TenantId tenant, String id) {
                    return Optional.ofNullable(envelopeRows.get(tenant.value() + ":" + id));
                }
                public void save(EventEnvelope envelope) {
                    envelopeRows.put(envelope.event().tenantId().value() + ":" + envelope.event().eventId(), envelope);
                }
            };
            DeliveryAttemptRepository attemptRepository = new DeliveryAttemptRepository() {
                public void append(DeliveryAttempt attempt) { attempts.add(attempt); }
                public List<DeliveryAttempt> find(TenantId tenant, String id) {
                    return attempts.stream().filter(a -> tenant.equals(a.tenantId()) && id.equals(a.eventId())).toList();
                }
            };
            AuditPort auditPort = new AuditPort() {
                public void append(AuditEntry entry) { audits.add(entry); }
                public List<AuditEntry> query(AuditQuery query) { return List.copyOf(audits); }
            };
            IdempotencyPort idempotency = new IdempotencyPort() {
                public boolean isCompleted(IdempotencyKey key) { return completed.contains(key); }
                public boolean tryMarkCompleted(IdempotencyKey key) { return completed.add(key); }
                public void remove(IdempotencyKey key) { completed.remove(key); }
            };
            RetryPolicy retryPolicy = new RetryPolicy() {
                public boolean canRetry(int attempt) { return attempt < retryLimit; }
                public Instant nextAttempt(Instant now, int attempt) { return now.plusSeconds(attempt); }
                public boolean shouldDeadLetter(int attempt) { return attempt >= retryLimit; }
            };
            DeadLetterPort deadLetterPort = (event, reason, attemptCount) -> deadLetters.incrementAndGet();
            service = new WorkflowDeliveryCoordinator(authorizer, dispatcher, envelopes, attemptRepository,
                    auditPort, idempotency, retryPolicy, deadLetterPort);
        }

        WorkflowDeliveryCommand command(TenantId commandTenant, TenantId eventTenant, WorkflowState state, String id) {
            var metadata = new CommandMetadata(commandTenant, ACTOR, new CorrelationId("corr-" + id), NOW);
            var event = new WorkflowEvent(id, eventTenant, "asset-" + id, "AssetUpgraded", state, NOW, Map.of("version", "2"));
            return new WorkflowDeliveryCommand(metadata, event, "asset-upgraded");
        }
    }

    @Test
    void approvedAuthorizedEventDispatchesOnceAndAuditRetainsIdentity() {
        Fixture f = new Fixture();
        var command = f.command(TENANT_A, TENANT_A, WorkflowState.APPROVED, "evt-1");
        WorkflowDeliveryResult result = f.service.deliver(command);
        assertTrue(result.accepted());
        assertEquals(DeliveryStatus.ACCEPTED, result.status());
        assertEquals(WorkflowState.COMPLETED, result.finalState());
        assertEquals(1, f.dispatches.get());
        assertEquals(1, f.attempts.size());
        assertEquals(TENANT_A, f.audits.get(0).tenantId());
        assertEquals(new CorrelationId("corr-evt-1"), f.audits.get(0).correlationId());
        assertEquals("evt-1", f.audits.get(0).subjectId());
    }

    @Test
    void newStateCannotPassApprovalGate() {
        Fixture f = new Fixture();
        var result = f.service.deliver(f.command(TENANT_A, TENANT_A, WorkflowState.NEW, "evt-new"));
        assertFalse(result.accepted());
        assertNotEquals(DeliveryStatus.ACCEPTED, result.status());
        assertEquals(0, f.dispatches.get());
        assertNotEquals(WorkflowState.COMPLETED, result.finalState());
    }

    @Test
    void crossTenantEventIsRejectedBeforeAnyDispatchSideEffect() {
        Fixture f = new Fixture();
        var result = f.service.deliver(f.command(TENANT_A, TENANT_B, WorkflowState.APPROVED, "evt-cross"));
        assertFalse(result.accepted());
        assertEquals(0, f.dispatches.get());
        assertEquals(0, f.attempts.size());
        assertNotEquals(WorkflowState.COMPLETED, result.finalState());
    }

    @Test
    void dispatcherFailureIsRecordedAsRetryableAndDoesNotCompleteEvent() {
        Fixture f = new Fixture();
        f.dispatchFails = true;
        var result = f.service.deliver(f.command(TENANT_A, TENANT_A, WorkflowState.APPROVED, "evt-retry"));
        assertFalse(result.accepted());
        assertTrue(result.status() == DeliveryStatus.RETRYABLE || result.status() == DeliveryStatus.DEAD_LETTERED);
        assertTrue(result.attemptNumber() >= 1);
        assertNotEquals(WorkflowState.COMPLETED, result.finalState());
    }

    @Test
    void duplicateCompletedEventDoesNotRepeatDispatchAttemptOrAuditSideEffect() {
        Fixture f = new Fixture();
        var command = f.command(TENANT_A, TENANT_A, WorkflowState.APPROVED, "evt-duplicate");
        var first = f.service.deliver(command);
        int auditCount = f.audits.size();
        var second = f.service.deliver(command);
        assertTrue(first.accepted());
        assertTrue(second.accepted());
        assertEquals(DeliveryStatus.DUPLICATE, second.status());
        assertEquals(1, f.dispatches.get());
        assertEquals(1, f.attempts.size());
        assertEquals(auditCount, f.audits.size());
    }

    @Test
    void retryBudgetExhaustionDeadLettersWithoutReportingCompletion() {
        Fixture f = new Fixture();
        f.dispatchFails = true;
        f.retryLimit = 1;
        var result = f.service.deliver(f.command(TENANT_A, TENANT_A, WorkflowState.APPROVED, "evt-dead"));
        assertFalse(result.accepted());
        assertEquals(DeliveryStatus.DEAD_LETTERED, result.status());
        assertEquals(WorkflowState.DEAD_LETTERED, result.finalState());
        assertEquals(1, f.deadLetters.get());
        assertNotEquals(WorkflowState.COMPLETED, result.finalState());
    }
}
