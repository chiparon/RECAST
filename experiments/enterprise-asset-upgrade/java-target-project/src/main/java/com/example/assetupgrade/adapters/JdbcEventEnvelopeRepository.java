package com.example.assetupgrade.adapters;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.StorageFailureException;
import com.example.assetupgrade.reconciliation.Checkpoint;
import com.example.assetupgrade.reconciliation.DueWindow;
import com.example.assetupgrade.reconciliation.port.CheckpointPort;
import com.example.assetupgrade.reconciliation.port.DueWindowPort;
import com.example.assetupgrade.reconciliation.port.RetryableEventPort;
import com.example.assetupgrade.workflow.DeliveryAttempt;
import com.example.assetupgrade.workflow.DeliveryStatus;
import com.example.assetupgrade.workflow.EventEnvelope;
import com.example.assetupgrade.workflow.EventProcessingStage;
import com.example.assetupgrade.workflow.WorkflowEvent;
import com.example.assetupgrade.workflow.WorkflowState;
import com.example.assetupgrade.workflow.port.EventEnvelopeRepository;
import com.example.assetupgrade.workflow.port.WorkflowEventStore;
import com.example.assetupgrade.workflow.port.WorkflowStateStore;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Event-envelope and workflow-state persistence adapter.
 *
 * <p>Implements the workflow/state ports plus the reconciliation-facing due-window, retryable-event
 * and checkpoint ports. Envelopes are keyed by {@code (tenantId, eventId)} and delivery attempts are
 * recorded per event; every read and mutation is tenant-scoped and can never observe another
 * tenant's record. {@link #findDue(TenantId, Instant, int)} and
 * {@link #findDue(TenantId, DueWindow)} only return events whose retry window has elapsed and whose
 * retry budget is still open. {@link #markRetryable(EventEnvelope, Instant)} schedules the next
 * attempt while {@link #close(EventEnvelope)} advances the processing stage and clears the retry
 * slot so a re-run of the same window never dispatches a completed event twice.</p>
 *
 * <p>Delivery attempts are persisted through {@link #appendAttempt(DeliveryAttempt)} and read back
 * through {@link #findAttempts(TenantId, String)}. When a {@link DataSource} is configured the
 * adapter persists through JDBC; otherwise it keeps a coherent, tenant-isolated in-memory store.</p>
 */
public final class JdbcEventEnvelopeRepository
        implements EventEnvelopeRepository, WorkflowStateStore, WorkflowEventStore,
        RetryableEventPort, DueWindowPort, CheckpointPort {

    private static final String FIELD_SEPARATOR = "\u001d";
    private static final String ENTRY_SEPARATOR = "\u001e";
    private static final String MAP_SEPARATOR = "\u001f";

    private final Map<String, Map<String, EventEnvelope>> envelopesByTenant = new ConcurrentHashMap<>();
    private final Map<String, Map<String, List<DeliveryAttempt>>> attemptsByTenant = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Checkpoint>> checkpointsByTenant = new ConcurrentHashMap<>();
    private final DataSource dataSource;
    private final AtomicBoolean schemaReady = new AtomicBoolean(false);

    /** Creates a coherent in-memory envelope repository. */
    public JdbcEventEnvelopeRepository() {
        this(null);
    }

    /** Creates a JDBC-backed envelope repository. */
    public JdbcEventEnvelopeRepository(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    /** @return a coherent in-memory envelope repository. */
    public static JdbcEventEnvelopeRepository local() {
        return new JdbcEventEnvelopeRepository();
    }

    /** @return {@code true} when an external {@link DataSource} is configured. */
    public boolean isConfigured() {
        return dataSource != null;
    }

    // ------------------------------------------------------------------ EventEnvelopeRepository / WorkflowStateStore

    @Override
    public Optional<EventEnvelope> find(TenantId tenantId, String eventId) {
        if (tenantId == null || eventId == null || eventId.isBlank()) {
            return Optional.empty();
        }
        String id = eventId.trim();
        if (dataSource != null) {
            return findJdbc(tenantId, id);
        }
        Map<String, EventEnvelope> tenantEnvelopes = envelopesByTenant.get(tenantId.value());
        if (tenantEnvelopes == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(tenantEnvelopes.get(id));
    }

    @Override
    public void save(EventEnvelope envelope) {
        Objects.requireNonNull(envelope, "envelope");
        TenantId tenantId = requireTenant(envelope);
        String eventId = requireEventId(envelope);
        if (dataSource != null) {
            saveJdbc(tenantId, eventId, envelope);
            return;
        }
        tenantEnvelopes(tenantId).put(eventId, envelope);
    }

    // ------------------------------------------------------------------ WorkflowEventStore

    @Override
    public List<EventEnvelope> findDue(TenantId tenantId, Instant now, int limit) {
        if (tenantId == null || limit <= 0) {
            return List.of();
        }
        Instant reference = now == null ? Instant.now() : now;
        if (dataSource != null) {
            return findDueJdbc(tenantId, null, reference, limit);
        }
        return scanDue(tenantId, null, reference, limit);
    }

    // ------------------------------------------------------------------ DueWindowPort

    @Override
    public List<EventEnvelope> findDue(TenantId tenantId, DueWindow window) {
        if (tenantId == null) {
            return List.of();
        }
        int limit = window == null ? Integer.MAX_VALUE : window.limit();
        Instant from = window == null ? null : window.from();
        Instant to = window == null ? null : window.to();
        if (limit <= 0) {
            return List.of();
        }
        if (dataSource != null) {
            return findDueJdbc(tenantId, from, to, limit);
        }
        return scanDue(tenantId, from, to, limit);
    }

    // ------------------------------------------------------------------ RetryableEventPort

    @Override
    public void markRetryable(EventEnvelope envelope, Instant nextAttemptAt) {
        Objects.requireNonNull(envelope, "envelope");
        Objects.requireNonNull(nextAttemptAt, "nextAttemptAt");
        EventEnvelope retryable = new EventEnvelope(envelope.event(), EventProcessingStage.RETRY_PENDING,
                envelope.deliveryAttempt(), nextAttemptAt, envelope.routeKey(), envelope.correlationId());
        save(retryable);
    }

    @Override
    public void close(EventEnvelope envelope) {
        Objects.requireNonNull(envelope, "envelope");
        EventEnvelope completed = new EventEnvelope(envelope.event(), EventProcessingStage.COMPLETED,
                envelope.deliveryAttempt(), null, envelope.routeKey(), envelope.correlationId());
        save(completed);
    }

    // ------------------------------------------------------------------ CheckpointPort

    @Override
    public Optional<Checkpoint> get(TenantId tenantId, String jobName) {
        if (tenantId == null || jobName == null || jobName.isBlank()) {
            return Optional.empty();
        }
        String name = jobName.trim();
        if (dataSource != null) {
            return getCheckpointJdbc(tenantId, name);
        }
        Map<String, Checkpoint> tenantCheckpoints = checkpointsByTenant.get(tenantId.value());
        if (tenantCheckpoints == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(tenantCheckpoints.get(name));
    }

    @Override
    public void put(TenantId tenantId, Checkpoint checkpoint) {
        Objects.requireNonNull(tenantId, "tenantId");
        Objects.requireNonNull(checkpoint, "checkpoint");
        String jobName = checkpoint.jobName() == null || checkpoint.jobName().isBlank()
                ? "reconciliation"
                : checkpoint.jobName().trim();
        if (dataSource != null) {
            putCheckpointJdbc(tenantId, jobName, checkpoint);
            return;
        }
        tenantCheckpoints(tenantId).put(jobName, checkpoint);
    }

    // ------------------------------------------------------------------ delivery attempts

    /** Records a delivery attempt for its tenant/event. */
    public void appendAttempt(DeliveryAttempt attempt) {
        Objects.requireNonNull(attempt, "attempt");
        TenantId tenantId = Objects.requireNonNull(attempt.tenantId(), "attempt.tenantId");
        String eventId = attempt.eventId() == null ? "" : attempt.eventId().trim();
        if (dataSource != null) {
            appendAttemptJdbc(tenantId, eventId, attempt);
            return;
        }
        tenantAttempts(tenantId).computeIfAbsent(eventId, key -> new ArrayList<>()).add(attempt);
    }

    /** Alias of {@link #appendAttempt(DeliveryAttempt)} matching {@code DeliveryAttemptRepository}. */
    public void append(DeliveryAttempt attempt) {
        appendAttempt(attempt);
    }

    /** Alias of {@link #findAttempts(TenantId, String)}. */
    public List<DeliveryAttempt> attempts(TenantId tenantId, String eventId) {
        return findAttempts(tenantId, eventId);
    }

    /** @return the delivery attempts recorded for {@code tenantId}/{@code eventId}. */
    public List<DeliveryAttempt> findAttempts(TenantId tenantId, String eventId) {
        if (tenantId == null || eventId == null) {
            return List.of();
        }
        String id = eventId.trim();
        if (dataSource != null) {
            return findAttemptsJdbc(tenantId, id);
        }
        Map<String, List<DeliveryAttempt>> tenantAttempts = attemptsByTenant.get(tenantId.value());
        if (tenantAttempts == null) {
            return List.of();
        }
        List<DeliveryAttempt> attempts = tenantAttempts.get(id);
        return attempts == null ? List.of() : List.copyOf(attempts);
    }

    // ------------------------------------------------------------------ scanning

    private List<EventEnvelope> scanDue(TenantId tenantId, Instant from, Instant to, int limit) {
        Map<String, EventEnvelope> tenantEnvelopes = envelopesByTenant.get(tenantId.value());
        if (tenantEnvelopes == null || tenantEnvelopes.isEmpty()) {
            return List.of();
        }
        List<EventEnvelope> due = new ArrayList<>();
        for (EventEnvelope envelope : tenantEnvelopes.values()) {
            if (isDue(envelope, from, to)) {
                due.add(envelope);
            }
        }
        due.sort(Comparator.comparing(EventEnvelope::nextAttemptAt));
        return due.size() > limit ? List.copyOf(due.subList(0, limit)) : List.copyOf(due);
    }

    private static boolean isDue(EventEnvelope envelope, Instant from, Instant to) {
        if (envelope == null || !isRetryable(envelope.stage())) {
            return false;
        }
        Instant next = envelope.nextAttemptAt();
        if (next == null) {
            return false;
        }
        if (to != null && next.isAfter(to)) {
            return false;
        }
        return from == null || !next.isBefore(from);
    }

    private static boolean isRetryable(EventProcessingStage stage) {
        return stage != EventProcessingStage.COMPLETED && stage != EventProcessingStage.DEAD_LETTERED;
    }

    private Map<String, EventEnvelope> tenantEnvelopes(TenantId tenantId) {
        return envelopesByTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>());
    }

    private Map<String, List<DeliveryAttempt>> tenantAttempts(TenantId tenantId) {
        return attemptsByTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>());
    }

    private Map<String, Checkpoint> tenantCheckpoints(TenantId tenantId) {
        return checkpointsByTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>());
    }

    private static TenantId requireTenant(EventEnvelope envelope) {
        if (envelope.event() == null || envelope.event().tenantId() == null) {
            throw new IllegalArgumentException("envelope.event().tenantId is required");
        }
        return envelope.event().tenantId();
    }

    private static String requireEventId(EventEnvelope envelope) {
        if (envelope.event() == null || envelope.event().eventId() == null || envelope.event().eventId().isBlank()) {
            throw new IllegalArgumentException("envelope.event().eventId is required");
        }
        return envelope.event().eventId().trim();
    }

    // ------------------------------------------------------------------ encoding

    private static String encodeEvent(WorkflowEvent event) {
        return safe(event.eventId()) + FIELD_SEPARATOR
                + safe(event.tenantId() == null ? null : event.tenantId().value()) + FIELD_SEPARATOR
                + safe(event.assetId()) + FIELD_SEPARATOR
                + safe(event.eventType()) + FIELD_SEPARATOR
                + safe(event.state() == null ? null : event.state().name()) + FIELD_SEPARATOR
                + safe(event.occurredAt() == null ? null : event.occurredAt().toString()) + FIELD_SEPARATOR
                + encodeMap(event.attributes());
    }

    private static WorkflowEvent decodeEvent(String encoded) {
        String[] parts = split(encoded, 7);
        Map<String, String> attributes = decodeMap(parts[6]);
        return new WorkflowEvent(emptyToNull(parts[0]),
                parts[1].isEmpty() ? null : TenantId.of(parts[1]),
                emptyToNull(parts[2]),
                emptyToNull(parts[3]),
                parts[4].isEmpty() ? null : WorkflowState.valueOf(parts[4]),
                parts[5].isEmpty() ? null : Instant.parse(parts[5]),
                attributes);
    }

    private static String encodeEnvelope(EventEnvelope envelope) {
        return encodeEvent(envelope.event()) + ENTRY_SEPARATOR
                + safe(envelope.stage() == null ? null : envelope.stage().name()) + FIELD_SEPARATOR
                + envelope.deliveryAttempt() + FIELD_SEPARATOR
                + safe(envelope.nextAttemptAt() == null ? null : envelope.nextAttemptAt().toString()) + FIELD_SEPARATOR
                + safe(envelope.routeKey()) + FIELD_SEPARATOR
                + safe(envelope.correlationId() == null ? null : envelope.correlationId().value());
    }

    private static EventEnvelope decodeEnvelope(String encoded) {
        int split = encoded.indexOf(ENTRY_SEPARATOR);
        String eventPart = split < 0 ? encoded : encoded.substring(0, split);
        String rest = split < 0 ? "" : encoded.substring(split + 1);
        String[] parts = split(rest, 5);
        return new EventEnvelope(decodeEvent(eventPart),
                parts[0].isEmpty() ? null : EventProcessingStage.valueOf(parts[0]),
                parseInt(parts[1]),
                parts[2].isEmpty() ? null : Instant.parse(parts[2]),
                emptyToNull(parts[3]),
                parts[4].isEmpty() ? null : CorrelationId.of(parts[4]));
    }

    private static String encodeAttempt(DeliveryAttempt attempt) {
        return safe(attempt.eventId()) + FIELD_SEPARATOR
                + safe(attempt.tenantId() == null ? null : attempt.tenantId().value()) + FIELD_SEPARATOR
                + attempt.attemptNumber() + FIELD_SEPARATOR
                + attempt.accepted() + FIELD_SEPARATOR
                + safe(attempt.status() == null ? null : attempt.status().name()) + FIELD_SEPARATOR
                + safe(attempt.detail()) + FIELD_SEPARATOR
                + safe(attempt.startedAt() == null ? null : attempt.startedAt().toString()) + FIELD_SEPARATOR
                + safe(attempt.finishedAt() == null ? null : attempt.finishedAt().toString());
    }

    private static DeliveryAttempt decodeAttempt(String encoded) {
        String[] parts = split(encoded, 8);
        return new DeliveryAttempt(emptyToNull(parts[0]),
                parts[1].isEmpty() ? null : TenantId.of(parts[1]),
                parseInt(parts[2]),
                Boolean.parseBoolean(parts[3]),
                parts[4].isEmpty() ? null : DeliveryStatus.valueOf(parts[4]),
                emptyToNull(parts[5]),
                parts[6].isEmpty() ? null : Instant.parse(parts[6]),
                parts[7].isEmpty() ? null : Instant.parse(parts[7]));
    }

    private static String encodeCheckpoint(Checkpoint checkpoint) {
        return safe(checkpoint.jobName()) + FIELD_SEPARATOR
                + safe(checkpoint.lastEventId()) + FIELD_SEPARATOR
                + safe(checkpoint.observedAt() == null ? null : checkpoint.observedAt().toString()) + FIELD_SEPARATOR
                + checkpoint.processed();
    }

    private static Checkpoint decodeCheckpoint(String encoded) {
        String[] parts = split(encoded, 4);
        return new Checkpoint(emptyToNull(parts[0]), emptyToNull(parts[1]),
                parts[2].isEmpty() ? null : Instant.parse(parts[2]), parseInt(parts[3]));
    }

    private static String encodeMap(Map<String, String> values) {
        if (values == null || values.isEmpty()) {
            return "";
        }
        List<String> encoded = new ArrayList<>(values.size());
        values.forEach((key, value) -> encoded.add(safe(key) + MAP_SEPARATOR + safe(value)));
        return String.join(ENTRY_SEPARATOR, encoded);
    }

    private static Map<String, String> decodeMap(String encoded) {
        Map<String, String> values = new LinkedHashMap<>();
        if (encoded == null || encoded.isBlank()) {
            return values;
        }
        for (String entry : encoded.split(ENTRY_SEPARATOR, -1)) {
            if (entry.isEmpty()) {
                continue;
            }
            String[] parts = entry.split(MAP_SEPARATOR, -1);
            if (parts.length >= 2) {
                values.put(parts[0], parts[1]);
            }
        }
        return values;
    }

    private static String[] split(String encoded, int expected) {
        String[] parts = encoded == null ? new String[0] : encoded.split(FIELD_SEPARATOR, -1);
        String[] padded = new String[expected];
        for (int i = 0; i < expected; i++) {
            padded[i] = i < parts.length ? parts[i] : "";
        }
        return padded;
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    private static String emptyToNull(String value) {
        return value == null || value.isEmpty() ? null : value;
    }

    private static int parseInt(String value) {
        try {
            return value == null || value.isBlank() ? 0 : Integer.parseInt(value.trim());
        } catch (NumberFormatException failure) {
            return 0;
        }
    }

    // ------------------------------------------------------------------ JDBC

    private void ensureSchema(Connection connection) throws SQLException {
        if (schemaReady.get()) {
            return;
        }
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate("CREATE TABLE IF NOT EXISTS workflow_envelope ("
                    + "tenant_id VARCHAR(255) NOT NULL, event_id VARCHAR(255) NOT NULL, stage VARCHAR(64),"
                    + "next_attempt_epoch BIGINT, payload TEXT, PRIMARY KEY (tenant_id, event_id))");
            statement.executeUpdate("CREATE TABLE IF NOT EXISTS workflow_attempt ("
                    + "tenant_id VARCHAR(255) NOT NULL, event_id VARCHAR(255) NOT NULL, attempt_number INT NOT NULL,"
                    + "payload TEXT, PRIMARY KEY (tenant_id, event_id, attempt_number))");
            statement.executeUpdate("CREATE TABLE IF NOT EXISTS reconciliation_checkpoint ("
                    + "tenant_id VARCHAR(255) NOT NULL, job_name VARCHAR(255) NOT NULL, payload TEXT,"
                    + "PRIMARY KEY (tenant_id, job_name))");
        }
        schemaReady.set(true);
    }

    private Optional<EventEnvelope> findJdbc(TenantId tenantId, String eventId) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT payload FROM workflow_envelope WHERE tenant_id = ? AND event_id = ?")) {
                statement.setString(1, tenantId.value());
                statement.setString(2, eventId);
                try (ResultSet result = statement.executeQuery()) {
                    return result.next()
                            ? Optional.of(decodeEnvelope(result.getString(1)))
                            : Optional.<EventEnvelope>empty();
                }
            }
        });
    }

    private void saveJdbc(TenantId tenantId, String eventId, EventEnvelope envelope) {
        withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM workflow_envelope WHERE tenant_id = ? AND event_id = ?")) {
                delete.setString(1, tenantId.value());
                delete.setString(2, eventId);
                delete.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO workflow_envelope (tenant_id, event_id, stage, next_attempt_epoch, payload)"
                            + " VALUES (?, ?, ?, ?, ?)")) {
                insert.setString(1, tenantId.value());
                insert.setString(2, eventId);
                insert.setString(3, envelope.stage() == null ? null : envelope.stage().name());
                if (envelope.nextAttemptAt() == null) {
                    insert.setNull(4, java.sql.Types.BIGINT);
                } else {
                    insert.setLong(4, envelope.nextAttemptAt().toEpochMilli());
                }
                insert.setString(5, encodeEnvelope(envelope));
                insert.executeUpdate();
            }
            return null;
        });
    }

    private List<EventEnvelope> findDueJdbc(TenantId tenantId, Instant from, Instant to, int limit) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            StringBuilder sql = new StringBuilder(
                    "SELECT payload FROM workflow_envelope WHERE tenant_id = ? AND next_attempt_epoch IS NOT NULL"
                            + " AND stage NOT IN ('COMPLETED', 'DEAD_LETTERED')");
            if (to != null) {
                sql.append(" AND next_attempt_epoch <= ?");
            }
            if (from != null) {
                sql.append(" AND next_attempt_epoch >= ?");
            }
            sql.append(" ORDER BY next_attempt_epoch");
            try (PreparedStatement statement = connection.prepareStatement(sql.toString())) {
                int index = 1;
                statement.setString(index++, tenantId.value());
                if (to != null) {
                    statement.setLong(index++, to.toEpochMilli());
                }
                if (from != null) {
                    statement.setLong(index, from.toEpochMilli());
                }
                statement.setMaxRows(limit <= 0 ? 1 : limit);
                try (ResultSet result = statement.executeQuery()) {
                    List<EventEnvelope> due = new ArrayList<>();
                    while (result.next()) {
                        due.add(decodeEnvelope(result.getString(1)));
                    }
                    return due;
                }
            }
        });
    }

    private void appendAttemptJdbc(TenantId tenantId, String eventId, DeliveryAttempt attempt) {
        withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO workflow_attempt (tenant_id, event_id, attempt_number, payload) VALUES (?, ?, ?, ?)")) {
                insert.setString(1, tenantId.value());
                insert.setString(2, eventId);
                insert.setInt(3, attempt.attemptNumber());
                insert.setString(4, encodeAttempt(attempt));
                insert.executeUpdate();
            }
            return null;
        });
    }

    private List<DeliveryAttempt> findAttemptsJdbc(TenantId tenantId, String eventId) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT payload FROM workflow_attempt WHERE tenant_id = ? AND event_id = ?"
                            + " ORDER BY attempt_number")) {
                statement.setString(1, tenantId.value());
                statement.setString(2, eventId);
                try (ResultSet result = statement.executeQuery()) {
                    List<DeliveryAttempt> attempts = new ArrayList<>();
                    while (result.next()) {
                        attempts.add(decodeAttempt(result.getString(1)));
                    }
                    return attempts;
                }
            }
        });
    }

    private Optional<Checkpoint> getCheckpointJdbc(TenantId tenantId, String jobName) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT payload FROM reconciliation_checkpoint WHERE tenant_id = ? AND job_name = ?")) {
                statement.setString(1, tenantId.value());
                statement.setString(2, jobName);
                try (ResultSet result = statement.executeQuery()) {
                    return result.next()
                            ? Optional.of(decodeCheckpoint(result.getString(1)))
                            : Optional.<Checkpoint>empty();
                }
            }
        });
    }

    private void putCheckpointJdbc(TenantId tenantId, String jobName, Checkpoint checkpoint) {
        withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM reconciliation_checkpoint WHERE tenant_id = ? AND job_name = ?")) {
                delete.setString(1, tenantId.value());
                delete.setString(2, jobName);
                delete.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO reconciliation_checkpoint (tenant_id, job_name, payload) VALUES (?, ?, ?)")) {
                insert.setString(1, tenantId.value());
                insert.setString(2, jobName);
                insert.setString(3, encodeCheckpoint(checkpoint));
                insert.executeUpdate();
            }
            return null;
        });
    }

    private <T> T withJdbc(SqlFunction<T> action) {
        try (Connection connection = dataSource.getConnection()) {
            return action.apply(connection);
        } catch (SQLException failure) {
            throw new StorageFailureException("event envelope repository JDBC failure", failure);
        }
    }

    @FunctionalInterface
    private interface SqlFunction<T> {
        T apply(Connection connection) throws SQLException;
    }

    @Override
    public Object execute(Object input) {
        if (input instanceof EventEnvelope envelope) {
            save(envelope);
            return null;
        }
        if (input instanceof FindEnvelopeRequest request) {
            return find(request.tenantId(), request.eventId());
        }
        if (input instanceof DueRequest request) {
            return findDue(request.tenantId(), request.now(), request.limit());
        }
        if (input instanceof RetryRequest request) {
            markRetryable(request.envelope(), request.nextAttemptAt());
            return null;
        }
        if (input instanceof DeliveryAttempt attempt) {
            appendAttempt(attempt);
            return null;
        }
        if (input instanceof CheckpointRequest request) {
            put(request.tenantId(), request.checkpoint());
            return null;
        }
        throw new IllegalArgumentException("unsupported event envelope repository request: "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record FindEnvelopeRequest(TenantId tenantId, String eventId) {
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record DueRequest(TenantId tenantId, Instant now, int limit) {
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record RetryRequest(EventEnvelope envelope, Instant nextAttemptAt) {
    }

    /** Holder accepted by the compatibility {@link #execute(Object)} seam. */
    public record CheckpointRequest(TenantId tenantId, Checkpoint checkpoint) {
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
