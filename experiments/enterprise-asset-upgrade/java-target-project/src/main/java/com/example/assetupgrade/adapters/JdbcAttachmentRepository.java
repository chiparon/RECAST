package com.example.assetupgrade.adapters;

import com.example.assetupgrade.attachment.AttachmentMetadata;
import com.example.assetupgrade.attachment.AttachmentState;
import com.example.assetupgrade.attachment.QuarantineReason;
import com.example.assetupgrade.attachment.port.AttachmentMetadataStore;
import com.example.assetupgrade.attachment.port.AttachmentRepository;
import com.example.assetupgrade.attachment.port.QuarantinePort;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.StorageFailureException;
import com.example.assetupgrade.persistence.TransactionPort;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Attachment metadata repository implementing {@link AttachmentRepository},
 * {@link AttachmentMetadataStore} and {@link QuarantinePort}.
 *
 * <p>Every key is {@code (tenantId, attachmentId)}; {@link #find(TenantId, String)} returns only the
 * owning tenant's metadata and never another tenant's record. {@link #save(AttachmentMetadata)} and
 * {@link #record(AttachmentMetadata)} persist the metadata unchanged, preserving its lifecycle
 * state, scan flag and content hash. {@link #quarantine(AttachmentMetadata, QuarantineReason)}
 * records the hold and moves the attachment into {@link AttachmentState#QUARANTINED}, while
 * {@link #release(TenantId, String)} drops the hold for the owning tenant only.</p>
 *
 * <p>When a {@link DataSource} is configured the adapter persists through JDBC; otherwise it keeps a
 * coherent, tenant-isolated in-memory store. Failures surface as {@link StorageFailureException}
 * rather than a silently successful write.</p>
 */
public final class JdbcAttachmentRepository
        implements AttachmentRepository, AttachmentMetadataStore, QuarantinePort {

    private final Map<String, Map<String, AttachmentMetadata>> metadataByTenant = new ConcurrentHashMap<>();
    private final Map<String, Map<String, QuarantineReason>> quarantineByTenant = new ConcurrentHashMap<>();
    private final DataSource dataSource;
    private final TransactionPort transactions;
    private final AtomicBoolean schemaReady = new AtomicBoolean(false);

    /** Creates a coherent in-memory repository. */
    public JdbcAttachmentRepository() {
        this(null, null);
    }

    /** Creates an in-memory repository that runs every mutation inside {@code transactions}. */
    public JdbcAttachmentRepository(TransactionPort transactions) {
        this(null, transactions);
    }

    /** Creates a JDBC-backed repository. */
    public JdbcAttachmentRepository(DataSource dataSource) {
        this(dataSource, null);
    }

    /** Creates a JDBC-backed repository that runs every mutation inside {@code transactions}. */
    public JdbcAttachmentRepository(DataSource dataSource, TransactionPort transactions) {
        this.dataSource = dataSource;
        this.transactions = transactions;
    }

    /** @return a coherent in-memory attachment repository. */
    public static JdbcAttachmentRepository local() {
        return new JdbcAttachmentRepository();
    }

    /** @return {@code true} when an external {@link DataSource} is configured. */
    public boolean isConfigured() {
        return dataSource != null;
    }

    @Override
    public Optional<AttachmentMetadata> find(TenantId tenantId, String attachmentId) {
        if (tenantId == null || attachmentId == null || attachmentId.isBlank()) {
            return Optional.empty();
        }
        if (dataSource != null) {
            return findJdbc(tenantId, attachmentId.trim());
        }
        Map<String, AttachmentMetadata> tenantMetadata = metadataByTenant.get(tenantId.value());
        if (tenantMetadata == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(tenantMetadata.get(attachmentId.trim()));
    }

    @Override
    public void save(AttachmentMetadata metadata) {
        write(metadata);
    }

    @Override
    public void record(AttachmentMetadata metadata) {
        write(metadata);
    }

    @Override
    public void quarantine(AttachmentMetadata metadata, QuarantineReason reason) {
        Objects.requireNonNull(metadata, "metadata");
        Objects.requireNonNull(reason, "reason");
        TenantId tenantId = requireTenant(metadata.tenantId());
        String attachmentId = requireAttachmentId(metadata.attachmentId());
        AttachmentMetadata held = metadata.withState(AttachmentState.QUARANTINED);
        if (dataSource != null) {
            inTransaction(() -> {
                saveJdbc(held);
                quarantineJdbc(tenantId, attachmentId, reason);
                return null;
            });
            return;
        }
        inTransaction(() -> {
            tenantMetadata(tenantId).put(attachmentId, held);
            tenantQuarantine(tenantId).put(attachmentId, reason);
            return null;
        });
    }

    @Override
    public void release(TenantId tenantId, String attachmentId) {
        Objects.requireNonNull(tenantId, "tenantId");
        if (attachmentId == null || attachmentId.isBlank()) {
            return;
        }
        String id = attachmentId.trim();
        if (dataSource != null) {
            inTransaction(() -> {
                releaseJdbc(tenantId, id);
                return null;
            });
            return;
        }
        Map<String, QuarantineReason> tenantQuarantine = quarantineByTenant.get(tenantId.value());
        if (tenantQuarantine != null) {
            tenantQuarantine.remove(id);
        }
    }

    /** @return the quarantine reason currently held for the attachment, or empty when none. */
    public Optional<QuarantineReason> quarantineReason(TenantId tenantId, String attachmentId) {
        if (tenantId == null || attachmentId == null || attachmentId.isBlank()) {
            return Optional.empty();
        }
        if (dataSource != null) {
            return quarantineReasonJdbc(tenantId, attachmentId.trim());
        }
        Map<String, QuarantineReason> tenantQuarantine = quarantineByTenant.get(tenantId.value());
        if (tenantQuarantine == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(tenantQuarantine.get(attachmentId.trim()));
    }

    /** @return {@code true} when {@code tenantId}/{@code attachmentId} is currently quarantined. */
    public boolean isQuarantined(TenantId tenantId, String attachmentId) {
        return quarantineReason(tenantId, attachmentId).isPresent();
    }

    private void write(AttachmentMetadata metadata) {
        Objects.requireNonNull(metadata, "metadata");
        TenantId tenantId = requireTenant(metadata.tenantId());
        String attachmentId = requireAttachmentId(metadata.attachmentId());
        if (dataSource != null) {
            inTransaction(() -> {
                saveJdbc(metadata);
                return null;
            });
            return;
        }
        inTransaction(() -> {
            tenantMetadata(tenantId).put(attachmentId, metadata);
            return null;
        });
    }

    private <T> T inTransaction(java.util.function.Supplier<T> operation) {
        if (transactions == null) {
            return operation.get();
        }
        return transactions.inTransaction(operation);
    }

    private Map<String, AttachmentMetadata> tenantMetadata(TenantId tenantId) {
        return metadataByTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>());
    }

    private Map<String, QuarantineReason> tenantQuarantine(TenantId tenantId) {
        return quarantineByTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>());
    }

    private static TenantId requireTenant(TenantId tenantId) {
        return Objects.requireNonNull(tenantId, "tenantId");
    }

    private static String requireAttachmentId(String attachmentId) {
        Objects.requireNonNull(attachmentId, "attachmentId");
        String trimmed = attachmentId.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("attachmentId must not be blank");
        }
        return trimmed;
    }

    // ---------------------------------------------------------------------------------------------
    // JDBC path
    // ---------------------------------------------------------------------------------------------

    private void ensureSchema(Connection connection) throws SQLException {
        if (schemaReady.get()) {
            return;
        }
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate("CREATE TABLE IF NOT EXISTS attachment_metadata ("
                    + "tenant_id VARCHAR(255) NOT NULL,"
                    + "attachment_id VARCHAR(255) NOT NULL,"
                    + "file_name VARCHAR(1024),"
                    + "declared_type VARCHAR(255),"
                    + "content_length BIGINT,"
                    + "content_hash VARCHAR(255),"
                    + "state VARCHAR(64),"
                    + "scanned BOOLEAN,"
                    + "received_at VARCHAR(64),"
                    + "PRIMARY KEY (tenant_id, attachment_id))");
            statement.executeUpdate("CREATE TABLE IF NOT EXISTS attachment_quarantine ("
                    + "tenant_id VARCHAR(255) NOT NULL,"
                    + "attachment_id VARCHAR(255) NOT NULL,"
                    + "reason VARCHAR(64),"
                    + "PRIMARY KEY (tenant_id, attachment_id))");
        }
        schemaReady.set(true);
    }

    private Optional<AttachmentMetadata> findJdbc(TenantId tenantId, String attachmentId) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT file_name, declared_type, content_length, content_hash, state, scanned, received_at "
                            + "FROM attachment_metadata WHERE tenant_id = ? AND attachment_id = ?")) {
                statement.setString(1, tenantId.value());
                statement.setString(2, attachmentId);
                try (ResultSet result = statement.executeQuery()) {
                    if (!result.next()) {
                        return Optional.<AttachmentMetadata>empty();
                    }
                    return Optional.of(mapMetadata(tenantId, attachmentId, result));
                }
            }
        });
    }

    private void saveJdbc(AttachmentMetadata metadata) {
        withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM attachment_metadata WHERE tenant_id = ? AND attachment_id = ?")) {
                delete.setString(1, metadata.tenantId().value());
                delete.setString(2, metadata.attachmentId());
                delete.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO attachment_metadata (tenant_id, attachment_id, file_name, declared_type, "
                            + "content_length, content_hash, state, scanned, received_at) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, metadata.tenantId().value());
                insert.setString(2, metadata.attachmentId());
                insert.setString(3, metadata.fileName());
                insert.setString(4, metadata.declaredContentType().value());
                insert.setLong(5, metadata.contentLength());
                insert.setString(6, metadata.contentHash());
                insert.setString(7, metadata.state().name());
                insert.setBoolean(8, metadata.scanned());
                insert.setString(9, metadata.receivedAt() == null ? null : metadata.receivedAt().toString());
                insert.executeUpdate();
            }
            return null;
        });
    }

    private void quarantineJdbc(TenantId tenantId, String attachmentId, QuarantineReason reason) {
        withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM attachment_quarantine WHERE tenant_id = ? AND attachment_id = ?")) {
                delete.setString(1, tenantId.value());
                delete.setString(2, attachmentId);
                delete.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO attachment_quarantine (tenant_id, attachment_id, reason) VALUES (?, ?, ?)")) {
                insert.setString(1, tenantId.value());
                insert.setString(2, attachmentId);
                insert.setString(3, reason.name());
                insert.executeUpdate();
            }
            return null;
        });
    }

    private void releaseJdbc(TenantId tenantId, String attachmentId) {
        withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM attachment_quarantine WHERE tenant_id = ? AND attachment_id = ?")) {
                delete.setString(1, tenantId.value());
                delete.setString(2, attachmentId);
                delete.executeUpdate();
            }
            return null;
        });
    }

    private Optional<QuarantineReason> quarantineReasonJdbc(TenantId tenantId, String attachmentId) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT reason FROM attachment_quarantine WHERE tenant_id = ? AND attachment_id = ?")) {
                statement.setString(1, tenantId.value());
                statement.setString(2, attachmentId);
                try (ResultSet result = statement.executeQuery()) {
                    if (!result.next()) {
                        return Optional.<QuarantineReason>empty();
                    }
                    return Optional.of(QuarantineReason.valueOf(result.getString(1)));
                }
            }
        });
    }

    private AttachmentMetadata mapMetadata(TenantId tenantId, String attachmentId, ResultSet result)
            throws SQLException {
        String receivedAt = result.getString("received_at");
        return new AttachmentMetadata(
                attachmentId,
                tenantId,
                result.getString("file_name"),
                new com.example.assetupgrade.attachment.AttachmentContentType(result.getString("declared_type")),
                result.getLong("content_length"),
                result.getString("content_hash"),
                AttachmentState.valueOf(result.getString("state")),
                result.getBoolean("scanned"),
                receivedAt == null ? Instant.now() : Instant.parse(receivedAt));
    }

    private <T> T withJdbc(SqlFunction<T> action) {
        try (Connection connection = dataSource.getConnection()) {
            return action.apply(connection);
        } catch (SQLException failure) {
            throw new StorageFailureException("attachment repository JDBC failure", failure);
        }
    }

    @FunctionalInterface
    private interface SqlFunction<T> {
        T apply(Connection connection) throws SQLException;
    }

    @Override
    public Object execute(Object input) {
        if (input instanceof AttachmentMetadata metadata) {
            save(metadata);
            return null;
        }
        if (input instanceof AttachmentRepository.FindRequest request) {
            return find(request.tenantId(), request.attachmentId());
        }
        if (input instanceof AttachmentMetadataStore.FindRequest request) {
            return find(request.tenantId(), request.attachmentId());
        }
        if (input instanceof QuarantinePort.QuarantineRequest request) {
            quarantine(request.metadata(), request.reason());
            return null;
        }
        if (input instanceof QuarantinePort.ReleaseRequest request) {
            release(request.tenantId(), request.attachmentId());
            return null;
        }
        throw new IllegalArgumentException("unsupported attachment repository request: "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
