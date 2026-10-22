package com.example.assetupgrade.hidden;

import com.example.assetupgrade.audit.*;
import com.example.assetupgrade.common.*;
import com.example.assetupgrade.order.*;
import com.example.assetupgrade.order.port.*;
import com.example.assetupgrade.persistence.TransactionPort;
import com.example.assetupgrade.retry.*;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.*;

/** Black-box acceptance tests for the atomic order/plugin bridge. */
class OrderHiddenTests {
    static final Instant NOW = Instant.parse("2026-01-01T12:00:00Z");
    static final TenantId TENANT = new TenantId("tenant-a");

    @Test void validCommandReservesCommitsAndAuditsOnce() {
        Fixture f = new Fixture(); OrderResult r = f.bridge().submit(f.command());
        assertTrue(r.accepted()); assertEquals(1, f.reserves.get()); assertEquals(1, f.commits.get());
        assertEquals(1, f.audits.size()); assertTrue(f.completed);
    }

    @Test void invalidOrderStopsBeforeInventory() {
        Fixture f = new Fixture(); f.invalid = true;
        OrderResult r = f.bridge().submit(f.command());
        assertFalse(r.accepted()); assertEquals(0, f.reserves.get()); assertEquals(OrderStatus.REJECTED, r.status());
    }

    @Test void duplicateCommandReturnsExistingOutcomeWithoutSideEffects() {
        Fixture f = new Fixture(); f.completed = true;
        OrderResult r = f.bridge().submit(f.command());
        assertTrue(r.accepted() || r.status() == OrderStatus.ACCEPTED); assertEquals(0, f.reserves.get()); assertEquals(0, f.commits.get());
    }

    @Test void commitFailureReleasesReservationAndRemovesIdempotency() {
        Fixture f = new Fixture(); f.commitFails = true;
        OrderResult r = f.bridge().submit(f.command());
        assertFalse(r.accepted()); assertTrue(f.releases.get() >= 1); assertFalse(f.completed); assertEquals(OrderStatus.ROLLED_BACK, r.status());
    }

    @Test void auditFailureRollsBackAndLeavesRetryableState() {
        Fixture f = new Fixture(); f.auditFails = true;
        OrderResult r = f.bridge().submit(f.command());
        assertFalse(r.accepted()); assertTrue(f.releases.get() >= 1); assertFalse(f.completed); assertEquals(OrderStatus.ROLLED_BACK, r.status());
    }

    @Test void tenantIsPassedToPluginAndInventoryBoundaries() {
        Fixture f = new Fixture(); f.bridge().submit(f.command());
        assertEquals(TENANT, f.pluginTenant); assertEquals(TENANT, f.inventoryTenant);
    }

    static final class Fixture {
        final AtomicInteger reserves = new AtomicInteger(), releases = new AtomicInteger(), commits = new AtomicInteger();
        final List<AuditEntry> audits = new ArrayList<>(); boolean invalid, completed, commitFails, auditFails;
        TenantId pluginTenant, inventoryTenant; Reservation reservation;
        OrderCommand command() { OrderRequest o = new OrderRequest("o-1", TENANT, new ActorId("actor"), List.of(new OrderLine("sku", 2, 100)), "USD"); return new OrderCommand(new CommandMetadata(TENANT, o.actorId(), new CorrelationId("c-1"), NOW), o, "plugin"); }
        OrderPluginBridge bridge() {
            OrderValidator validator = o -> invalid ? List.of(new ServiceProblem(ProblemCode.INVALID_INPUT, "invalid", o.orderId(), Map.of())) : List.of();
            InventoryPort inventory = new InventoryPort() { public Reservation reserve(OrderRequest o) { inventoryTenant=o.tenantId(); reserves.incrementAndGet(); reservation=new Reservation("r-1",o.tenantId(),o.orderId(),Map.of("sku",2),NOW.plusSeconds(60),false); return reservation; } public void release(TenantId t,String id){ releases.incrementAndGet(); } };
            OrderCommitPort committer = (o,r) -> { commits.incrementAndGet(); if (commitFails) throw new IllegalStateException("commit"); };
            ReservationLedgerPort ledger = new ReservationLedgerPort() { public Optional<Reservation> find(TenantId t,String id){ return Optional.ofNullable(reservation); } public void save(Reservation r){} public void release(TenantId t,String id){ releases.incrementAndGet(); } };
            OrderRepository orders = new OrderRepository() { public Optional<OrderSnapshot> find(TenantId t,String id){ return completed ? Optional.of(new OrderSnapshot(command().order(), OrderStatus.ACCEPTED, reservation, 200, NOW, 1)) : Optional.empty(); } public void save(OrderSnapshot s){} };
            PluginRegistryPort plugins = (t,id) -> { pluginTenant=t; return Optional.of(new PluginDescriptor(id,t,"1",Set.of("order.submit"),true,Map.of())); };
            AuditPort audit = new AuditPort() { public void append(AuditEntry e){ if(auditFails) throw new IllegalStateException("audit"); audits.add(e); } public List<AuditEntry> query(AuditQuery q){ return List.of(); } };
            IdempotencyPort idem = new IdempotencyPort() { public boolean isCompleted(IdempotencyKey k){ return completed; } public boolean tryMarkCompleted(IdempotencyKey k){ if(completed)return false; completed=true; return true; } public void remove(IdempotencyKey k){ completed=false; } };
            TransactionPort tx = new TransactionPort() { public <T> T inTransaction(Supplier<T> operation){ return operation.get(); } };
            return new OrderLifecycleCoordinator(validator, inventory, committer, ledger, orders, plugins, audit, idem, tx);
        }
    }
}
