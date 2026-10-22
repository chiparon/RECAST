package com.example.assetupgrade.persistence;

/**
 * Provider-neutral schema migration port.
 *
 * <p>Migrations are version-scoped and idempotent: applying an already-applied
 * {@code migrationId} leaves the schema unchanged. A provider failure surfaces as
 * {@link com.example.assetupgrade.error.StorageFailureException}. JDBC details stay out of the port
 * and belong to a provider adapter.</p>
 */
public interface MigrationPort {

    /** @return the highest migration version currently applied. */
    int currentVersion();

    /** Applies {@code migrationId} if it has not already been applied. */
    void apply(String migrationId);

    /** @return {@code true} when {@link #currentVersion()} has reached {@code targetVersion}. */
    default boolean isUpToDate(int targetVersion) {
        return currentVersion() >= targetVersion;
    }

    /** Compatibility seam for early implementations; the typed methods define the contract. */
    default Object execute(Object input) {
        if (input instanceof String migrationId) {
            apply(migrationId);
            return currentVersion();
        }
        if (input instanceof Number targetVersion) {
            return isUpToDate(targetVersion.intValue());
        }
        throw new IllegalArgumentException("expected a migration id or target version but got "
                + (input == null ? "null" : input.getClass().getName()));
    }
}
