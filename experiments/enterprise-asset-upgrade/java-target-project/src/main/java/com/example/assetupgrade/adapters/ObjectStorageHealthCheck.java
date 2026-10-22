package com.example.assetupgrade.adapters;

import com.example.assetupgrade.observability.HealthCheck;
import com.example.assetupgrade.observability.HealthStatus;

import java.util.Map;

/**
 * Health probe for the object storage boundary.
 *
 * <p>Reports {@link HealthStatus#up()} only when a remote object store is configured and reachable.
 * The local byte store, an unconfigured endpoint and a failing endpoint all yield
 * {@link HealthStatus#down(String)} with a reason, and {@link #status()} never throws.</p>
 */
public final class ObjectStorageHealthCheck implements HealthCheck {

    private final S3ObjectStorageAdapter storage;

    /** Creates a probe with no storage adapter; it reports down. */
    public ObjectStorageHealthCheck() {
        this(null);
    }

    /** Creates a probe over {@code storage}. */
    public ObjectStorageHealthCheck(S3ObjectStorageAdapter storage) {
        this.storage = storage;
    }

    @Override
    public String id() {
        return "object-storage";
    }

    @Override
    public Map<String, String> metadata() {
        return Map.of("component", "object-storage", "provider", "s3");
    }

    @Override
    public HealthStatus status() {
        try {
            if (storage == null) {
                return HealthStatus.down("object storage is not configured");
            }
            if (!storage.isConfigured()) {
                return HealthStatus.down("object storage endpoint is not configured (local store in use)");
            }
            if (!storage.isReachable()) {
                return HealthStatus.down("object storage endpoint is not reachable");
            }
            return HealthStatus.up(Map.of("provider", "s3",
                    "bucket", storage.bucket() == null ? "" : storage.bucket()));
        } catch (RuntimeException failure) {
            return HealthStatus.down("object storage probe failed: " + failure.getMessage());
        }
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
