package com.example.assetupgrade.hidden;

import com.example.assetupgrade.audit.*;
import com.example.assetupgrade.common.*;
import com.example.assetupgrade.reconciliation.*;
import com.example.assetupgrade.reconciliation.port.*;
import com.example.assetupgrade.security.*;
import com.example.assetupgrade.workflow.*;
import org.junit.jupiter.api.Test;

import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/** Black-box acceptance tests for tenant-scoped retry reconciliation. */
class ReconciliationHiddenTests {
    static final Instant NOW = Instant.parse("2026-01-01T12:00:00Z");
    static final TenantId A = new TenantId("tenant-a");
    static final TenantId B = new TenantId("tenant-b");

    @Test void dispatchesDueEventsAndClosesSuccessfulRetry() {
        EventEnvelope e = envelope(A, "e-1", NOW.minusSeconds(10));
        F f = new F(new ArrayList<>(List.of(e)), new WorkflowDeliveryResult(true, DeliveryStatus.ACCEPTED, WorkflowState.COMPLETED, 2, List.of()));
        ReconciliationReport r = f.service().run(command(A));
        assertEquals(1, r.examined()); assertEquals(1, r.succeeded());
        assertEquals(List.of("e-1"), f.closed); assertEquals(1, f.delivered.get());
        assertEquals(1, f.audits.size()); assertEquals(1, f.checkpoints.size());
    }

    @Test void failedDispatchIncrementsRetryAndDoesNotClose() {
        EventEnvelope e = envelope(A, "e-2", NOW.minusSeconds(10));
        F f = new F(new ArrayList<>(List.of(e)), new WorkflowDeliveryResult(false, DeliveryStatus.RETRYABLE, WorkflowState.RETRY_PENDING, 2, List.of()));
        ReconciliationReport r = f.service().run(command(A));
        assertEquals(1, r.failed()); assertTrue(f.closed.isEmpty()); assertEquals(1, f.retryMarked.size());
    }

    @Test void futureEventsAreExcludedByDueWindow() {
        F f = new F(new ArrayList<>(List.of(envelope(A, "future", NOW.plusSeconds(30)))), accepted());
        ReconciliationReport r = f.service().run(command(A));
        assertEquals(0, r.examined()); assertEquals(0, f.delivered.get());
    }

    @Test void anotherTenantIsNeverReadOrMutated() {
        EventEnvelope a = envelope(A, "a", NOW.minusSeconds(1));
        EventEnvelope b = envelope(B, "b", NOW.minusSeconds(1));
        F f = new F(new ArrayList<>(List.of(a, b)), accepted()); f.service().run(command(A));
        assertEquals(List.of(A), f.queriedTenants); assertFalse(f.closed.contains("b"));
    }

    @Test void repeatedWindowDoesNotDispatchCompletedEventTwice() {
        F f = new F(new ArrayList<>(List.of(envelope(A, "same", NOW.minusSeconds(1)))), accepted());
        f.service().run(command(A)); f.service().run(command(A));
        assertEquals(1, f.delivered.get());
    }

    @Test void leaseIsClaimedAndReleasedAfterRun() {
        F f = new F(new ArrayList<>(List.of(envelope(A, "lease", NOW.minusSeconds(1)))), accepted());
        f.service().run(command(A)); assertEquals(1, f.claims); assertEquals(1, f.releases);
    }

    @Test void emptyRunStillWritesAuditAndCheckpoint() {
        F f = new F(new ArrayList<>(), accepted()); ReconciliationReport r = f.service().run(command(A));
        assertEquals(0, r.examined()); assertEquals(1, f.audits.size()); assertEquals(1, f.checkpoints.size());
    }

    private static WorkflowDeliveryResult accepted() { return new WorkflowDeliveryResult(true, DeliveryStatus.ACCEPTED, WorkflowState.COMPLETED, 1, List.of()); }
    private static EventEnvelope envelope(TenantId t, String id, Instant due) {
        WorkflowEvent e = new WorkflowEvent(id, t, "asset", "upgrade", WorkflowState.RETRY_PENDING, NOW.minusSeconds(20), Map.of());
        return new EventEnvelope(e, EventProcessingStage.RETRY_PENDING, 1, due, "route", new CorrelationId("corr-" + id));
    }
    private static ReconciliationCommand command(TenantId t) {
        return new ReconciliationCommand(new CommandMetadata(t, new ActorId("scheduler"), new CorrelationId("run"), NOW), NOW, 50, "retry");
    }

    static final class F {
        final List<EventEnvelope> events; final WorkflowDeliveryResult result; final List<TenantId> queriedTenants = new ArrayList<>();
        final List<String> closed = new ArrayList<>(), retryMarked = new ArrayList<>(); final List<AuditEntry> audits = new ArrayList<>();
        final List<Checkpoint> checkpoints = new ArrayList<>(); final AtomicInteger delivered = new AtomicInteger(); int claims, releases;
        F(List<EventEnvelope> e, WorkflowDeliveryResult r) { events = e; result = r; }
        ReconciliationService service() {
            TenantAuthorizer auth = (scope, p, subject) -> new AuthorizationDecision(true, "ok", Set.of(p));
            DueWindowPort due = (tenant, window) -> { queriedTenants.add(tenant); return events.stream().filter(x -> x.event().tenantId().equals(tenant) && !x.nextAttemptAt().isAfter(window.to())).toList(); };
            RetryableEventPort retry = new RetryableEventPort() {
                public void markRetryable(EventEnvelope e, Instant t) { retryMarked.add(e.event().eventId()); }
                public void close(EventEnvelope e) { closed.add(e.event().eventId()); events.remove(e); }
            };
            LeasePort lease = new LeasePort() {
                public Optional<LeaseClaim> tryClaim(TenantId t, String k, Duration d) { claims++; return Optional.of(new LeaseClaim(k,t,NOW.plus(d),"test")); }
                public void release(LeaseClaim c) { releases++; }
            };
            CheckpointPort cp = new CheckpointPort() {
                public Optional<Checkpoint> get(TenantId t, String j) { return Optional.empty(); }
                public void put(TenantId t, Checkpoint c) { checkpoints.add(c); }
            };
            AuditPort audit = new AuditPort() { public void append(AuditEntry e) { audits.add(e); } public List<AuditEntry> query(AuditQuery q) { return List.of(); } };
            WorkflowDeliveryService workflow = c -> { delivered.incrementAndGet(); return result; };
            return new ReconciliationOrchestrator(auth, due, retry, lease, cp, audit, workflow);
        }
    }
}
