package com.example.assetupgrade.persistence;

import com.example.assetupgrade.common.TenantId;

import java.time.Instant;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Immutable, tenant-scoped storage record.
 *
 * <p>The record binds an owning {@link TenantId} to a key, an opaque payload, a monotonically
 * increasing 1-based version and an updated-at instant. The payload is defensively copied and the
 * attributes are exposed as an unmodifiable map, so a persisted record can never be mutated through
 * its accessors. No provider type appears in this contract.</p>
 *
 * @param tenantId   the owning tenant, never {@code null}
 * @param key        the record key, never blank
 * @param payload    the opaque payload bytes, never {@code null} (may be empty)
 * @param version    the 1-based optimistic-lock version, at least {@code 1}
 * @param updatedAt  the last update instant, never {@code null}
 * @param attributes immutable free-form metadata, never {@code null}
 */
public record StorageRecord(
        TenantId tenantId,
        String key,
        byte[] payload,
        long version,
        Instant updatedAt,
        Map<String, String> attributes) {

    private static final byte[] EMPTY_PAYLOAD = new byte[0];

    public StorageRecord {
        tenantId = Objects.requireNonNull(tenantId, "tenantId");
        key = requireKey(key);
        if (version < 1) {
            throw new IllegalArgumentException("version must be >= 1 but was " + version);
        }
        payload = payload == null ? EMPTY_PAYLOAD : payload.clone();
        updatedAt = updatedAt == null ? Instant.now() : updatedAt;
        attributes = immutableCopy(attributes);
    }

    private static String requireKey(String raw) {
        if (raw == null) {
            throw new IllegalArgumentException("key is required");
        }
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("key must not be blank");
        }
        return trimmed;
    }

    private static Map<String, String> immutableCopy(Map<String, String> source) {
        if (source == null || source.isEmpty()) {
            return Map.of();
        }
        Map<String, String> copy = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : source.entrySet()) {
            if (entry.getKey() != null && entry.getValue() != null) {
                copy.put(entry.getKey(), entry.getValue());
            }
        }
        return Collections.unmodifiableMap(copy);
    }

    /** Creates a first-version record. */
    public static StorageRecord of(TenantId tenantId, String key, byte[] payload, Instant updatedAt,
                                   Map<String, String> attributes) {
        return new StorageRecord(tenantId, key, payload, 1L, updatedAt, attributes);
    }

    /** Creates a first-version record stamped with the current instant. */
    public static StorageRecord of(TenantId tenantId, String key, byte[] payload, Map<String, String> attributes) {
        return new StorageRecord(tenantId, key, payload, 1L, null, attributes);
    }

    /** Creates a first-version record with no attributes. */
    public static StorageRecord of(TenantId tenantId, String key, byte[] payload) {
        return new StorageRecord(tenantId, key, payload, 1L, null, Map.of());
    }

    /** Creates a full record. */
    public static StorageRecord of(TenantId tenantId, String key, byte[] payload, long version, Instant updatedAt,
                                   Map<String, String> attributes) {
        return new StorageRecord(tenantId, key, payload, version, updatedAt, attributes);
    }

    /** @return the owning tenant; alias of {@link #tenantId()}. */
    public TenantId tenant() {
        return tenantId;
    }

    /** @return a defensive copy of the payload bytes. */
    public byte[] payloadCopy() {
        return payload.clone();
    }

    /** @return a copy carrying {@code newVersion}. */
    public StorageRecord withVersion(long newVersion) {
        return new StorageRecord(tenantId, key, payload, newVersion, updatedAt, attributes);
    }

    /** @return a copy stamped with {@code newUpdatedAt}. */
    public StorageRecord withUpdatedAt(Instant newUpdatedAt) {
        return new StorageRecord(tenantId, key, payload, version, newUpdatedAt, attributes);
    }

    /** @return a copy carrying {@code newPayload}. */
    public StorageRecord withPayload(byte[] newPayload) {
        return new StorageRecord(tenantId, key, newPayload, version, updatedAt, attributes);
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof StorageRecord that)) {
            return false;
        }
        return tenantId.equals(that.tenantId)
                && key.equals(that.key)
                && Arrays.equals(payload, that.payload)
                && version == that.version
                && updatedAt.equals(that.updatedAt)
                && attributes.equals(that.attributes);
    }

    @Override
    public int hashCode() {
        int result = Objects.hash(tenantId, key, version, updatedAt, attributes);
        return 31 * result + Arrays.hashCode(payload);
    }

    @Override
    public String toString() {
        return "StorageRecord[tenantId=" + tenantId + ", key=" + key + ", payload=" + payload.length
                + " bytes, version=" + version + ", updatedAt=" + updatedAt + ']';
    }
}
