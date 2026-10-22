package com.example.assetupgrade.reconciliation;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.common.TimeProvider;
import com.example.assetupgrade.reconciliation.port.CheckpointPort;
import com.example.assetupgrade.reconciliation.port.DueWindowPort;
import com.example.assetupgrade.workflow.EventEnvelope;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * Coordinates the persisted checkpoint and the tenant-scoped due window.
 *
 * <p>A run loads the last checkpoint for the {@code (tenant, job)} scope, derives the due window
 * from the checkpoint instant through the command instant, and asks {@link DueWindowPort} for the
 * due envelopes. After dispatch the advanced checkpoint is persisted so re-running the same
 * window cannot dispatch a completed event twice: the next run starts from the observed instant
 * and therefore does not rescan an interval that has already been reconciled.</p>
 *
 * <p>All lookups are tenant-keyed; a checkpoint or due envelope belonging to another tenant is
 * never returned by {@link DueWindowPort} and is additionally guarded here.</p>
 */
public final class ReconciliationCheckpointCoordinator {

    /** Lookback applied to the first run of a scope that has no checkpoint yet. */
    public static final Duration DEFAULT_LOOKBACK = Duration.ofMinutes(15);
    /** Page limit applied when a command does not declare one. */
    public static final int DEFAULT_LIMIT = 100;

    private final CheckpointPort checkpoints;
    private final DueWindowPort dueWindow;
    private final TimeProvider clock;
    private final Duration lookback;

    /** Creates an unconfigured coordinator; scans return no events. */
    public ReconciliationCheckpointCoordinator() {
        this(null, null, null, null);
    }

    /** Creates a coordinator over the checkpoint and due-window ports. */
    public ReconciliationCheckpointCoordinator(CheckpointPort checkpoints, DueWindowPort dueWindow) {
        this(checkpoints, dueWindow, null, null);
    }

    /** Creates a coordinator with an explicit clock and first-run lookback. */
    public ReconciliationCheckpointCoordinator(CheckpointPort checkpoints, DueWindowPort dueWindow,
                                               TimeProvider clock, Duration lookback) {
        this.checkpoints = checkpoints;
        this.dueWindow = dueWindow;
        this.clock = clock == null ? TimeProvider.system() : clock;
        Duration window = lookback == null ? DEFAULT_LOOKBACK : lookback;
        if (window.isNegative()) {
            throw new IllegalArgumentException("lookback must not be negative");
        }
        this.lookback = window;
    }

    /** @return the stored checkpoint for the tenant scope, when one exists. */
    public Optional<Checkpoint> find(TenantId tenantId, String jobName) {
        Objects.requireNonNull(tenantId, "tenantId");
        if (checkpoints == null) {
            return Optional.empty();
        }
        try {
            Optional<Checkpoint> found = checkpoints.get(tenantId, jobName);
            return found == null ? Optional.empty() : found;
        } catch (RuntimeException unreadable) {
            return Optional.empty();
        }
    }

    /** @return the stored checkpoint for the tenant scope, or {@code null} when absent. */
    public Checkpoint load(TenantId tenantId, String jobName) {
        return find(tenantId, jobName).orElse(null);
    }

    /** Derives the due window from the previous checkpoint and the run command. */
    public DueWindow windowFor(Checkpoint checkpoint, ReconciliationCommand command) {
        Objects.requireNonNull(command, "command");
        Instant to = command.now() == null ? clock.now() : command.now();
        Instant from = checkpoint == null || checkpoint.observedAt() == null
                ? to.minus(lookback)
                : checkpoint.observedAt();
        if (from.isAfter(to)) {
            from = to;
        }
        int limit = command.limit() > 0 ? command.limit() : DEFAULT_LIMIT;
        return new DueWindow(from, to, limit);
    }

    /** Scans the tenant's due window, never crossing into another tenant's records. */
    public List<EventEnvelope> scanDue(TenantId tenantId, DueWindow window) {
        Objects.requireNonNull(tenantId, "tenantId");
        if (dueWindow == null || window == null) {
            return List.of();
        }
        List<EventEnvelope> due = dueWindow.findDue(tenantId, window);
        return due == null ? List.of() : List.copyOf(due);
    }

    /** Advances and persists the checkpoint after a run observed {@code dispatched} events. */
    public Checkpoint advance(TenantId tenantId, String jobName, Checkpoint previous,
                              List<EventEnvelope> dispatched, Instant observedAt) {
        int processed = (previous == null ? 0 : previous.processed()) + (dispatched == null ? 0 : dispatched.size());
        String lastEventId = previous == null ? null : previous.lastEventId();
        if (dispatched != null && !dispatched.isEmpty()) {
            EventEnvelope last = dispatched.get(dispatched.size() - 1);
            if (last != null && last.event() != null) {
                lastEventId = last.event().eventId();
            }
        }
        Instant instant = observedAt == null ? clock.now() : observedAt;
        Checkpoint next = new Checkpoint(jobName, lastEventId, instant, processed);
        save(tenantId, next);
        return next;
    }

    /** Persists {@code checkpoint} for the tenant scope. */
    public void save(TenantId tenantId, Checkpoint checkpoint) {
        Objects.requireNonNull(tenantId, "tenantId");
        if (checkpoints == null || checkpoint == null) {
            return;
        }
        checkpoints.put(tenantId, checkpoint);
    }

    /** Builds a stable, tenant-scoped identifier for the checkpoint. */
    public static String checkpointId(TenantId tenantId, Checkpoint checkpoint) {
        if (checkpoint == null) {
            return null;
        }
        StringBuilder id = new StringBuilder();
        if (tenantId != null) {
            id.append(tenantId.value()).append(ReconciliationTenantFilter.SCOPE_SEPARATOR);
        }
        id.append(checkpoint.jobName() == null ? ReconciliationTenantFilter.DEFAULT_JOB : checkpoint.jobName());
        if (checkpoint.observedAt() != null) {
            id.append('@').append(checkpoint.observedAt().toEpochMilli());
        }
        return id.toString();
    }

    /** Instance alias of {@link #checkpointId(TenantId, Checkpoint)}. */
    public String idOf(TenantId tenantId, Checkpoint checkpoint) {
        return checkpointId(tenantId, checkpoint);
    }

    /** @return the backing due-window port, or {@code null} when none is configured. */
    public DueWindowPort dueWindowPort() {
        return dueWindow;
    }

    /** Compatibility seam; accepts a checkpoint or a command and scans its due window. */
    public Object execute(Object input) {
        if (input instanceof ReconciliationCommand command) {
            TenantId tenantId = command.metadata() == null ? null : command.metadata().tenantId();
            if (tenantId == null) {
                throw new IllegalArgumentException("reconciliation command must carry a tenant identity");
            }
            String jobName = command.jobName() == null || command.jobName().isBlank()
                    ? ReconciliationTenantFilter.DEFAULT_JOB : command.jobName().trim();
            return scanDue(tenantId, windowFor(load(tenantId, jobName), command));
        }
        throw new IllegalArgumentException("Expected a ReconciliationCommand");
    }
}
