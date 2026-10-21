package com.example.assetupgrade.adapters;

import com.example.assetupgrade.error.StorageFailureException;
import com.example.assetupgrade.persistence.ConnectionPort;
import com.example.assetupgrade.persistence.TransactionPort;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/**
 * Provider adapter implementing both the atomic {@link TransactionPort} and the
 * {@link ConnectionPort} handle-lending boundary.
 *
 * <p>When a {@link DataSource} is configured, {@link #inTransaction(Supplier)} opens a connection,
 * disables auto-commit, runs the supplier exactly once and commits; a {@link RuntimeException}
 * rolls the boundary back and rethrows, so no partial write is visible. Nested calls on the same
 * thread reuse the outer boundary. When no infrastructure is configured the adapter degrades to an
 * honest <em>local</em> boundary: the supplier still runs exactly once, the open/in-transaction
 * state is tracked, rollbacks are counted, and no remote commit is ever claimed.</p>
 *
 * <p>{@link #withConnection(Supplier)} lends the caller the transaction's connection while one is
 * active, or a fresh handle otherwise, and never leaks a closed handle. A closed adapter refuses to
 * lend a handle with a {@link StorageFailureException}. When the provider genuinely fails, the
 * failure is surfaced as a {@link StorageFailureException} rather than being swallowed.</p>
 */
public final class PostgresTransactionAdapter implements TransactionPort, ConnectionPort {

    private final DataSource dataSource;
    private final AtomicBoolean open = new AtomicBoolean(true);
    private final ThreadLocal<Integer> depth = ThreadLocal.withInitial(() -> 0);
    private final ThreadLocal<Connection> bound = new ThreadLocal<>();
    private final AtomicLong commits = new AtomicLong();
    private final AtomicLong rollbacks = new AtomicLong();

    /** Creates a local transaction boundary with no external infrastructure. */
    public PostgresTransactionAdapter() {
        this(null);
    }

    /** Creates a transaction boundary over {@code dataSource}, or a local boundary when it is {@code null}. */
    public PostgresTransactionAdapter(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    /** @return a local transaction boundary. */
    public static PostgresTransactionAdapter local() {
        return new PostgresTransactionAdapter();
    }

    /** @return a transaction boundary over {@code dataSource}. */
    public static PostgresTransactionAdapter over(DataSource dataSource) {
        return new PostgresTransactionAdapter(dataSource);
    }

    /** @return {@code true} when an external {@link DataSource} is configured. */
    public boolean isConfigured() {
        return dataSource != null;
    }

    @Override
    public <T> T inTransaction(Supplier<T> operation) {
        Objects.requireNonNull(operation, "operation");
        if (!open.get()) {
            throw new StorageFailureException("transaction boundary is closed");
        }
        int current = depth.get();
        if (current > 0) {
            // Nested call on the same thread participates in the outer boundary.
            return operation.get();
        }
        depth.set(1);
        try {
            if (dataSource == null) {
                return runLocal(operation);
            }
            return runTransactional(operation);
        } finally {
            depth.remove();
        }
    }

    private <T> T runLocal(Supplier<T> operation) {
        try {
            T result = operation.get();
            commits.incrementAndGet();
            return result;
        } catch (RuntimeException failure) {
            rollbacks.incrementAndGet();
            throw failure;
        }
    }

    private <T> T runTransactional(Supplier<T> operation) {
        Connection connection = openConnection();
        boolean previousAutoCommit;
        try {
            previousAutoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
        } catch (SQLException failure) {
            closeQuietly(connection);
            throw new StorageFailureException("failed to begin transaction", failure);
        }
        bound.set(connection);
        try {
            T result = operation.get();
            connection.commit();
            commits.incrementAndGet();
            return result;
        } catch (RuntimeException failure) {
            rollback(connection);
            throw failure;
        } catch (SQLException failure) {
            rollback(connection);
            throw new StorageFailureException("transaction commit failed", failure);
        } finally {
            bound.remove();
            try {
                connection.setAutoCommit(previousAutoCommit);
            } catch (SQLException ignored) {
                // restoring auto-commit is best effort; the handle is closed next
            }
            closeQuietly(connection);
        }
    }

    private void rollback(Connection connection) {
        rollbacks.incrementAndGet();
        try {
            connection.rollback();
        } catch (SQLException ignored) {
            // A rollback failure must not mask the original business failure.
        }
    }

    @Override
    public boolean isOpen() {
        return open.get();
    }

    @Override
    public <T> T withConnection(Supplier<T> operation) {
        Objects.requireNonNull(operation, "operation");
        if (!open.get()) {
            throw new StorageFailureException("connection is closed");
        }
        Connection active = bound.get();
        if (active != null) {
            return operation.get();
        }
        if (dataSource == null) {
            // Local boundary: no JDBC handle exists, so the supplier runs against local state.
            return operation.get();
        }
        Connection connection = openConnection();
        try {
            return operation.get();
        } finally {
            closeQuietly(connection);
        }
    }

    @Override
    public void close() {
        open.set(false);
    }

    /** @return the number of committed boundaries observed by this adapter. */
    public long commitCount() {
        return commits.get();
    }

    /** @return the number of rolled-back boundaries observed by this adapter. */
    public long rollbackCount() {
        return rollbacks.get();
    }

    private Connection openConnection() {
        try {
            Connection connection = dataSource.getConnection();
            if (connection == null) {
                throw new StorageFailureException("data source returned no connection");
            }
            return connection;
        } catch (SQLException failure) {
            throw new StorageFailureException("failed to obtain a database connection", failure);
        }
    }

    private static void closeQuietly(Connection connection) {
        try {
            connection.close();
        } catch (SQLException ignored) {
            // Closing a handle that already failed is best effort.
        }
    }

    /**
     * Compatibility seam. Both {@link TransactionPort} and {@link ConnectionPort} declare
     * {@code execute(Object)}, so the adapter resolves the inherited defaults explicitly and runs
     * the input through the transaction boundary.
     */
    @Override
    public Object execute(Object input) {
        if (input instanceof Supplier<?> supplier) {
            return inTransaction(supplier::get);
        }
        if (input instanceof Runnable action) {
            Objects.requireNonNull(action, "action");
            inTransaction(() -> {
                action.run();
                return null;
            });
            return null;
        }
        throw new IllegalArgumentException("expected a Supplier or Runnable but got "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
