package com.example.assetupgrade.adapters;

import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.StorageFailureException;
import com.example.assetupgrade.order.OrderLine;
import com.example.assetupgrade.order.OrderRequest;
import com.example.assetupgrade.order.OrderSnapshot;
import com.example.assetupgrade.order.OrderStatus;
import com.example.assetupgrade.order.PluginDescriptor;
import com.example.assetupgrade.order.Reservation;
import com.example.assetupgrade.order.port.OrderCommitPort;
import com.example.assetupgrade.order.port.PluginRegistryPort;
import com.example.assetupgrade.order.port.ReservationLedgerPort;
import com.example.assetupgrade.persistence.TransactionPort;
import com.example.assetupgrade.retry.IdempotencyKey;
import com.example.assetupgrade.retry.IdempotencyPort;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/**
 * Tenant-scoped order persistence adapter implementing {@link OrderCommitPort},
 * {@link ReservationLedgerPort}, {@link PluginRegistryPort} and {@link IdempotencyPort}.
 *
 * <p>{@link #commit(OrderRequest, Reservation)} performs the durable order write inside the
 * caller's transaction boundary; {@link #save(Reservation)}/{@link #release(TenantId, String)} are
 * tenant-scoped and release is idempotent. {@link #find(TenantId, String)} (plugin lookup) returns
 * only the tenant-registered descriptor and never another tenant's registration. Idempotency keys
 * are tenant-qualified by {@link IdempotencyKey#asString()} so a duplicate command can return the
 * existing outcome without re-reserving or committing again.</p>
 *
 * <p>When a {@link DataSource} is configured the adapter persists through JDBC; otherwise it keeps a
 * coherent, tenant-isolated in-memory store. Failures surface as {@link StorageFailureException}.</p>
 */
@SuppressWarnings({"rawtypes", "unchecked"})
public final class JdbcOrderRepository
        implements OrderCommitPort, ReservationLedgerPort, PluginRegistryPort, IdempotencyPort {

    private static final String LIST_SEPARATOR = "\u001f";
    private static final String ENTRY_SEPARATOR = "\u001e";
    private static final String FIELD_SEPARATOR = "\u001d";

    private final Map<String, Map<String, OrderSnapshot>> ordersByTenant = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Reservation>> reservationsByTenant = new ConcurrentHashMap<>();
    private final Map<String, Map<String, PluginDescriptor>> pluginsByTenant = new ConcurrentHashMap<>();
    private final Set<String> completedKeys = ConcurrentHashMap.newKeySet();
    private final DataSource dataSource;
    private final TransactionPort transactions;
    private final AtomicBoolean schemaReady = new AtomicBoolean(false);

    /** Creates a coherent in-memory order repository. */
    public JdbcOrderRepository() {
        this(null, null);
    }

    /** Creates an in-memory repository that runs every mutation inside {@code transactions}. */
    public JdbcOrderRepository(TransactionPort transactions) {
        this(null, transactions);
    }

    /** Creates a JDBC-backed repository. */
    public JdbcOrderRepository(DataSource dataSource) {
        this(dataSource, null);
    }

    /** Creates a JDBC-backed repository that runs every mutation inside {@code transactions}. */
    public JdbcOrderRepository(DataSource dataSource, TransactionPort transactions) {
        this.dataSource = dataSource;
        this.transactions = transactions;
    }

    /** @return a coherent in-memory order repository. */
    public static JdbcOrderRepository local() {
        return new JdbcOrderRepository();
    }

    /** @return {@code true} when an external {@link DataSource} is configured. */
    public boolean isConfigured() {
        return dataSource != null;
    }

    // ------------------------------------------------------------------ OrderCommitPort

    @Override
    public void commit(OrderRequest order, Reservation reservation) {
        Objects.requireNonNull(order, "order");
        TenantId tenantId = Objects.requireNonNull(order.tenantId(), "order.tenantId");
        String orderId = requireOrderId(order.orderId());
        OrderStatus status = reservation == null
                ? OrderStatus.COMMITTING
                : (reservation.released() ? OrderStatus.ROLLED_BACK : OrderStatus.ACCEPTED);
        long totalMinor = order.lineTotalMinor();
        Instant now = Instant.now();
        OrderSnapshot snapshot = new OrderSnapshot(order, status, reservation, totalMinor, now,
                currentVersion(tenantId, orderId) + 1);
        inTransaction(() -> {
            saveSnapshot(tenantId, snapshot);
            if (reservation != null) {
                saveReservation(reservation);
            }
            return null;
        });
    }

    // ------------------------------------------------------------------ OrderRepository-ish reads

    /** @return the persisted order snapshot for {@code tenantId}/{@code orderId}, if present. */
    public Optional<OrderSnapshot> findOrder(TenantId tenantId, String orderId) {
        if (tenantId == null || orderId == null || orderId.isBlank()) {
            return Optional.empty();
        }
        if (dataSource != null) {
            return findOrderJdbc(tenantId, orderId.trim());
        }
        Map<String, OrderSnapshot> tenantOrders = ordersByTenant.get(tenantId.value());
        if (tenantOrders == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(tenantOrders.get(orderId.trim()));
    }

    /** @return the current optimistic-lock version of {@code tenantId}/{@code orderId}. */
    public int currentVersion(TenantId tenantId, String orderId) {
        return findOrder(tenantId, orderId).map(OrderSnapshot::version).orElse(0);
    }

    // ------------------------------------------------------------------ ReservationLedgerPort

    /** @return the reservation for {@code tenantId}/{@code reservationId}, if present. */
    public Optional<Reservation> findReservation(TenantId tenantId, String reservationId) {
        if (tenantId == null || reservationId == null || reservationId.isBlank()) {
            return Optional.empty();
        }
        if (dataSource != null) {
            return findReservationJdbc(tenantId, reservationId.trim());
        }
        Map<String, Reservation> tenantReservations = reservationsByTenant.get(tenantId.value());
        if (tenantReservations == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(tenantReservations.get(reservationId.trim()));
    }

    @Override
    public void save(Reservation reservation) {
        Objects.requireNonNull(reservation, "reservation");
        TenantId tenantId = requireTenant(reservation.tenantId());
        String reservationId = requireReservationId(reservation.reservationId());
        Reservation normalized = reservation.reservationId().equals(reservationId)
                ? reservation
                : new Reservation(reservationId, tenantId, reservation.orderId(), reservation.quantities(),
                        reservation.expiresAt(), reservation.released());
        inTransaction(() -> {
            saveReservation(normalized);
            return null;
        });
    }

    @Override
    public void release(TenantId tenantId, String reservationId) {
        Objects.requireNonNull(tenantId, "tenantId");
        if (reservationId == null || reservationId.isBlank()) {
            return;
        }
        String id = reservationId.trim();
        inTransaction(() -> {
            Optional<Reservation> existing = findReservation(tenantId, id);
            existing.ifPresent(reservation -> saveReservation(reservation.withReleased(true)));
            return null;
        });
    }

    // ------------------------------------------------------------------ PluginRegistryPort

    /** @return the plugin descriptor for {@code tenantId}/{@code pluginId}, if registered. */
    public Optional<PluginDescriptor> findPlugin(TenantId tenantId, String pluginId) {
        if (tenantId == null || pluginId == null || pluginId.isBlank()) {
            return Optional.empty();
        }
        if (dataSource != null) {
            return findPluginJdbc(tenantId, pluginId.trim());
        }
        Map<String, PluginDescriptor> tenantPlugins = pluginsByTenant.get(tenantId.value());
        if (tenantPlugins == null) {
            return Optional.empty();
        }
        PluginDescriptor descriptor = tenantPlugins.get(pluginId.trim());
        return descriptor != null && descriptor.belongsTo(tenantId) ? Optional.of(descriptor) : Optional.empty();
    }

    /**
     * Raw-typed {@code find} satisfying both {@link ReservationLedgerPort#find} and
     * {@link PluginRegistryPort#find}. A reservation with the requested identity takes precedence;
     * otherwise a registered plugin descriptor is returned, and an unknown id yields empty.
     */
    @Override
    @SuppressWarnings({"rawtypes", "unchecked"})
    public Optional find(TenantId tenantId, String id) {
        Optional<Reservation> reservation = findReservation(tenantId, id);
        if (reservation.isPresent()) {
            return reservation;
        }
        return findPlugin(tenantId, id);
    }

    /** Registers or replaces {@code descriptor} for its owning tenant. */
    public void register(PluginDescriptor descriptor) {
        Objects.requireNonNull(descriptor, "descriptor");
        TenantId tenantId = requireTenant(descriptor.tenantId());
        String pluginId = requirePluginId(descriptor.pluginId());
        inTransaction(() -> {
            if (dataSource != null) {
                savePluginJdbc(tenantId, pluginId, descriptor);
            } else {
                tenantPlugins(tenantId).put(pluginId, descriptor);
            }
            return null;
        });
    }

    // ------------------------------------------------------------------ IdempotencyPort

    @Override
    public boolean isCompleted(IdempotencyKey key) {
        Objects.requireNonNull(key, "key");
        if (dataSource != null) {
            return isCompletedJdbc(key);
        }
        return completedKeys.contains(key.asString());
    }

    @Override
    public boolean tryMarkCompleted(IdempotencyKey key) {
        Objects.requireNonNull(key, "key");
        if (dataSource != null) {
            return tryMarkCompletedJdbc(key);
        }
        return completedKeys.add(key.asString());
    }

    @Override
    public void remove(IdempotencyKey key) {
        Objects.requireNonNull(key, "key");
        if (dataSource != null) {
            removeJdbc(key);
            return;
        }
        completedKeys.remove(key.asString());
    }

    // ------------------------------------------------------------------ helpers

    private void saveSnapshot(TenantId tenantId, OrderSnapshot snapshot) {
        if (dataSource != null) {
            saveOrderJdbc(tenantId, snapshot);
        } else {
            tenantOrders(tenantId).put(requireOrderId(snapshot.orderId()), snapshot);
        }
    }

    private void saveReservation(Reservation reservation) {
        TenantId tenantId = requireTenant(reservation.tenantId());
        String reservationId = requireReservationId(reservation.reservationId());
        if (dataSource != null) {
            saveReservationJdbc(tenantId, reservation);
        } else {
            tenantReservations(tenantId).put(reservationId, reservation);
        }
    }

    private <T> T inTransaction(Supplier<T> operation) {
        if (transactions == null) {
            return operation.get();
        }
        return transactions.inTransaction(operation);
    }

    private Map<String, OrderSnapshot> tenantOrders(TenantId tenantId) {
        return ordersByTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>());
    }

    private Map<String, Reservation> tenantReservations(TenantId tenantId) {
        return reservationsByTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>());
    }

    private Map<String, PluginDescriptor> tenantPlugins(TenantId tenantId) {
        return pluginsByTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>());
    }

    private static TenantId requireTenant(TenantId tenantId) {
        return Objects.requireNonNull(tenantId, "tenantId");
    }

    private static String requireOrderId(String orderId) {
        Objects.requireNonNull(orderId, "orderId");
        String trimmed = orderId.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("orderId must not be blank");
        }
        return trimmed;
    }

    private static String requireReservationId(String reservationId) {
        Objects.requireNonNull(reservationId, "reservationId");
        String trimmed = reservationId.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("reservationId must not be blank");
        }
        return trimmed;
    }

    private static String requirePluginId(String pluginId) {
        Objects.requireNonNull(pluginId, "pluginId");
        String trimmed = pluginId.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("pluginId must not be blank");
        }
        return trimmed;
    }

    // ------------------------------------------------------------------ encoding helpers

    private static String encodeLines(List<OrderLine> lines) {
        if (lines == null || lines.isEmpty()) {
            return "";
        }
        List<String> encoded = new ArrayList<>(lines.size());
        for (OrderLine line : lines) {
            if (line == null) {
                continue;
            }
            encoded.add(safe(line.sku()) + FIELD_SEPARATOR + line.quantity() + FIELD_SEPARATOR
                    + line.unitPriceMinor());
        }
        return String.join(ENTRY_SEPARATOR, encoded);
    }

    private static List<OrderLine> decodeLines(String encoded) {
        List<OrderLine> lines = new ArrayList<>();
        if (encoded == null || encoded.isBlank()) {
            return lines;
        }
        for (String entry : encoded.split(ENTRY_SEPARATOR, -1)) {
            if (entry.isEmpty()) {
                continue;
            }
            String[] parts = entry.split(FIELD_SEPARATOR, -1);
            if (parts.length < 3) {
                continue;
            }
            lines.add(new OrderLine(parts[0], Integer.parseInt(parts[1]), Long.parseLong(parts[2])));
        }
        return lines;
    }

    private static String encodeQuantities(Map<String, Integer> quantities) {
        if (quantities == null || quantities.isEmpty()) {
            return "";
        }
        List<String> encoded = new ArrayList<>(quantities.size());
        quantities.forEach((sku, quantity) -> encoded.add(safe(sku) + FIELD_SEPARATOR + quantity));
        return String.join(ENTRY_SEPARATOR, encoded);
    }

    private static Map<String, Integer> decodeQuantities(String encoded) {
        Map<String, Integer> quantities = new LinkedHashMap<>();
        if (encoded == null || encoded.isBlank()) {
            return quantities;
        }
        for (String entry : encoded.split(ENTRY_SEPARATOR, -1)) {
            if (entry.isEmpty()) {
                continue;
            }
            String[] parts = entry.split(FIELD_SEPARATOR, -1);
            if (parts.length >= 2) {
                quantities.put(parts[0], Integer.parseInt(parts[1]));
            }
        }
        return quantities;
    }

    private static String encodeStrings(Set<String> values) {
        return values == null || values.isEmpty() ? "" : String.join(ENTRY_SEPARATOR, values);
    }

    private static Set<String> decodeStrings(String encoded) {
        Set<String> values = new LinkedHashSet<>();
        if (encoded == null || encoded.isBlank()) {
            return values;
        }
        for (String entry : encoded.split(ENTRY_SEPARATOR, -1)) {
            if (!entry.isEmpty()) {
                values.add(entry);
            }
        }
        return values;
    }

    private static String encodeMap(Map<String, String> values) {
        if (values == null || values.isEmpty()) {
            return "";
        }
        List<String> encoded = new ArrayList<>(values.size());
        values.forEach((key, value) -> encoded.add(safe(key) + FIELD_SEPARATOR + safe(value)));
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
            String[] parts = entry.split(FIELD_SEPARATOR, -1);
            if (parts.length >= 2) {
                values.put(parts[0], parts[1]);
            }
        }
        return values;
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    private static String safeName(Enum<?> value) {
        return value == null ? null : value.name();
    }

    // ------------------------------------------------------------------ JDBC path

    private void ensureSchema(Connection connection) throws SQLException {
        if (schemaReady.get()) {
            return;
        }
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate("CREATE TABLE IF NOT EXISTS asset_order ("
                    + "tenant_id VARCHAR(255) NOT NULL, order_id VARCHAR(255) NOT NULL,"
                    + "status VARCHAR(64), total_minor BIGINT, updated_at VARCHAR(64), version INT,"
                    + "actor_id VARCHAR(255), currency VARCHAR(32), lines TEXT,"
                    + "reservation_id VARCHAR(255), PRIMARY KEY (tenant_id, order_id))");
            statement.executeUpdate("CREATE TABLE IF NOT EXISTS asset_reservation ("
                    + "tenant_id VARCHAR(255) NOT NULL, reservation_id VARCHAR(255) NOT NULL,"
                    + "order_id VARCHAR(255), quantities TEXT, expires_at VARCHAR(64), released BOOLEAN,"
                    + "PRIMARY KEY (tenant_id, reservation_id))");
            statement.executeUpdate("CREATE TABLE IF NOT EXISTS asset_plugin ("
                    + "tenant_id VARCHAR(255) NOT NULL, plugin_id VARCHAR(255) NOT NULL,"
                    + "version VARCHAR(64), capabilities TEXT, enabled BOOLEAN, configuration TEXT,"
                    + "PRIMARY KEY (tenant_id, plugin_id))");
            statement.executeUpdate("CREATE TABLE IF NOT EXISTS asset_idempotency ("
                    + "key_value VARCHAR(512) NOT NULL, PRIMARY KEY (key_value))");
        }
        schemaReady.set(true);
    }

    private void saveOrderJdbc(TenantId tenantId, OrderSnapshot snapshot) {
        withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM asset_order WHERE tenant_id = ? AND order_id = ?")) {
                delete.setString(1, tenantId.value());
                delete.setString(2, snapshot.orderId());
                delete.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO asset_order (tenant_id, order_id, status, total_minor, updated_at, version,"
                            + " actor_id, currency, lines, reservation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")) {
                OrderRequest request = snapshot.request();
                insert.setString(1, tenantId.value());
                insert.setString(2, snapshot.orderId());
                insert.setString(3, safeName(snapshot.status()));
                insert.setLong(4, snapshot.totalMinor());
                insert.setString(5, snapshot.updatedAt() == null ? null : snapshot.updatedAt().toString());
                insert.setInt(6, snapshot.version());
                insert.setString(7, request == null || request.actorId() == null ? null : request.actorId().value());
                insert.setString(8, request == null ? null : request.currency());
                insert.setString(9, request == null ? null : encodeLines(request.lines()));
                insert.setString(10, snapshot.reservationId());
                insert.executeUpdate();
            }
            return null;
        });
    }

    private Optional<OrderSnapshot> findOrderJdbc(TenantId tenantId, String orderId) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT status, total_minor, updated_at, version, actor_id, currency, lines, reservation_id"
                            + " FROM asset_order WHERE tenant_id = ? AND order_id = ?")) {
                statement.setString(1, tenantId.value());
                statement.setString(2, orderId);
                try (ResultSet result = statement.executeQuery()) {
                    if (!result.next()) {
                        return Optional.<OrderSnapshot>empty();
                    }
                    OrderRequest request = new OrderRequest(orderId, tenantId,
                            result.getString("actor_id") == null ? null
                                    : com.example.assetupgrade.common.ActorId.of(result.getString("actor_id")),
                            decodeLines(result.getString("lines")), result.getString("currency"));
                    Reservation reservation = result.getString("reservation_id") == null ? null
                            : findReservationJdbc(tenantId, result.getString("reservation_id")).orElse(null);
                    String updatedAt = result.getString("updated_at");
                    return Optional.of(new OrderSnapshot(request,
                            OrderStatus.valueOf(result.getString("status")),
                            reservation,
                            result.getLong("total_minor"),
                            updatedAt == null ? Instant.EPOCH : Instant.parse(updatedAt),
                            result.getInt("version")));
                }
            }
        });
    }

    private void saveReservationJdbc(TenantId tenantId, Reservation reservation) {
        withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM asset_reservation WHERE tenant_id = ? AND reservation_id = ?")) {
                delete.setString(1, tenantId.value());
                delete.setString(2, reservation.reservationId());
                delete.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO asset_reservation (tenant_id, reservation_id, order_id, quantities, expires_at,"
                            + " released) VALUES (?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, tenantId.value());
                insert.setString(2, reservation.reservationId());
                insert.setString(3, reservation.orderId());
                insert.setString(4, encodeQuantities(reservation.quantities()));
                insert.setString(5, reservation.expiresAt() == null ? null : reservation.expiresAt().toString());
                insert.setBoolean(6, reservation.released());
                insert.executeUpdate();
            }
            return null;
        });
    }

    private Optional<Reservation> findReservationJdbc(TenantId tenantId, String reservationId) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT order_id, quantities, expires_at, released FROM asset_reservation"
                            + " WHERE tenant_id = ? AND reservation_id = ?")) {
                statement.setString(1, tenantId.value());
                statement.setString(2, reservationId);
                try (ResultSet result = statement.executeQuery()) {
                    if (!result.next()) {
                        return Optional.<Reservation>empty();
                    }
                    String expiresAt = result.getString("expires_at");
                    return Optional.of(new Reservation(reservationId, tenantId, result.getString("order_id"),
                            decodeQuantities(result.getString("quantities")),
                            expiresAt == null ? null : Instant.parse(expiresAt),
                            result.getBoolean("released")));
                }
            }
        });
    }

    private void savePluginJdbc(TenantId tenantId, String pluginId, PluginDescriptor descriptor) {
        withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM asset_plugin WHERE tenant_id = ? AND plugin_id = ?")) {
                delete.setString(1, tenantId.value());
                delete.setString(2, pluginId);
                delete.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO asset_plugin (tenant_id, plugin_id, version, capabilities, enabled, configuration)"
                            + " VALUES (?, ?, ?, ?, ?, ?)")) {
                insert.setString(1, tenantId.value());
                insert.setString(2, pluginId);
                insert.setString(3, descriptor.version());
                insert.setString(4, encodeStrings(descriptor.capabilities()));
                insert.setBoolean(5, descriptor.enabled());
                insert.setString(6, encodeMap(descriptor.configuration()));
                insert.executeUpdate();
            }
            return null;
        });
    }

    private Optional<PluginDescriptor> findPluginJdbc(TenantId tenantId, String pluginId) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT version, capabilities, enabled, configuration FROM asset_plugin"
                            + " WHERE tenant_id = ? AND plugin_id = ?")) {
                statement.setString(1, tenantId.value());
                statement.setString(2, pluginId);
                try (ResultSet result = statement.executeQuery()) {
                    if (!result.next()) {
                        return Optional.<PluginDescriptor>empty();
                    }
                    return Optional.of(new PluginDescriptor(pluginId, tenantId, result.getString("version"),
                            decodeStrings(result.getString("capabilities")), result.getBoolean("enabled"),
                            decodeMap(result.getString("configuration"))));
                }
            }
        });
    }

    private boolean isCompletedJdbc(IdempotencyKey key) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT key_value FROM asset_idempotency WHERE key_value = ?")) {
                statement.setString(1, key.asString());
                try (ResultSet result = statement.executeQuery()) {
                    return result.next();
                }
            }
        });
    }

    private boolean tryMarkCompletedJdbc(IdempotencyKey key) {
        return withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO asset_idempotency (key_value) VALUES (?)")) {
                insert.setString(1, key.asString());
                insert.executeUpdate();
                return true;
            } catch (SQLException duplicate) {
                return false;
            }
        });
    }

    private void removeJdbc(IdempotencyKey key) {
        withJdbc(connection -> {
            ensureSchema(connection);
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM asset_idempotency WHERE key_value = ?")) {
                delete.setString(1, key.asString());
                delete.executeUpdate();
            }
            return null;
        });
    }

    private <T> T withJdbc(SqlFunction<T> action) {
        try (Connection connection = dataSource.getConnection()) {
            return action.apply(connection);
        } catch (SQLException failure) {
            throw new StorageFailureException("order repository JDBC failure", failure);
        }
    }

    @FunctionalInterface
    private interface SqlFunction<T> {
        T apply(Connection connection) throws SQLException;
    }

    @Override
    public Object execute(Object input) {
        if (input instanceof OrderCommitPort.CommitRequest request) {
            commit(request.order(), request.reservation());
            return null;
        }
        if (input instanceof ReservationLedgerPort.FindRequest request) {
            return find(request.tenantId(), request.reservationId());
        }
        if (input instanceof Reservation reservation) {
            save(reservation);
            return null;
        }
        if (input instanceof ReservationLedgerPort.ReleaseRequest request) {
            release(request.tenantId(), request.reservationId());
            return null;
        }
        if (input instanceof PluginRegistryPort.FindRequest request) {
            return find(request.tenantId(), request.pluginId());
        }
        if (input instanceof IdempotencyKey key) {
            return tryMarkCompleted(key);
        }
        throw new IllegalArgumentException("unsupported order repository request: "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
