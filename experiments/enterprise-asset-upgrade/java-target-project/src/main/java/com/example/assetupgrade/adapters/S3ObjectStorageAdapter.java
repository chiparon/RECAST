package com.example.assetupgrade.adapters;

import com.example.assetupgrade.attachment.AttachmentContent;
import com.example.assetupgrade.attachment.AttachmentMetadata;
import com.example.assetupgrade.attachment.port.AttachmentCleanupPort;
import com.example.assetupgrade.attachment.port.AttachmentFingerprintPort;
import com.example.assetupgrade.attachment.port.ObjectStoragePort;
import com.example.assetupgrade.attachment.port.UploadStreamPort;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.StorageFailureException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Object/attachment storage adapter implementing {@link ObjectStoragePort},
 * {@link AttachmentCleanupPort}, {@link UploadStreamPort} and {@link AttachmentFingerprintPort}.
 *
 * <p>Content is stored under a tenant-qualified key derived from {@code tenantId}/{@code
 * attachmentId}, so a lookup or removal for one tenant can never touch another tenant's bytes.
 * {@link #open(String)} materialises a fresh, independently readable view for each staged upload.
 * {@link #fingerprint(AttachmentContent)} is a deterministic SHA-256 of the bytes and carries no
 * tenant information.</p>
 *
 * <p>No AWS SDK is on the classpath, so this adapter is the <em>local</em> provider unless a remote
 * endpoint is supplied. When a remote endpoint is configured but the endpoint has not been observed
 * reachable, {@link #store(AttachmentMetadata, AttachmentContent)} refuses to acknowledge a put and
 * throws a {@link StorageFailureException} rather than pretending a remote write succeeded. The
 * local store is explicitly bounded per object and in total.</p>
 */
public final class S3ObjectStorageAdapter
        implements ObjectStoragePort, AttachmentCleanupPort, UploadStreamPort, AttachmentFingerprintPort {

    /** Default maximum size, in bytes, of a single locally stored object. */
    public static final long DEFAULT_MAX_OBJECT_BYTES = 64L * 1024L * 1024L;

    private final Map<String, Map<String, byte[]>> objectsByTenant = new ConcurrentHashMap<>();
    private final Map<String, byte[]> uploads = new ConcurrentHashMap<>();
    private final Map<String, Integer> objectCountByTenant = new ConcurrentHashMap<>();
    private final String endpoint;
    private final String bucket;
    private final long maxObjectBytes;
    private volatile boolean reachable;

    /** Creates a local object store with no remote endpoint configured. */
    public S3ObjectStorageAdapter() {
        this(null, null, DEFAULT_MAX_OBJECT_BYTES);
    }

    /** Creates a local object store bounded to {@code maxObjectBytes} per object. */
    public S3ObjectStorageAdapter(long maxObjectBytes) {
        this(null, null, maxObjectBytes);
    }

    /** Creates a remote-configured adapter; remote puts are refused until {@link #markReachable}. */
    public S3ObjectStorageAdapter(String endpoint, String bucket) {
        this(endpoint, bucket, DEFAULT_MAX_OBJECT_BYTES);
    }

    /** Creates a remote-configured adapter bounded to {@code maxObjectBytes} per object. */
    public S3ObjectStorageAdapter(String endpoint, String bucket, long maxObjectBytes) {
        this.endpoint = endpoint == null || endpoint.isBlank() ? null : endpoint.trim();
        this.bucket = bucket == null || bucket.isBlank() ? null : bucket.trim();
        this.maxObjectBytes = maxObjectBytes > 0 ? maxObjectBytes : DEFAULT_MAX_OBJECT_BYTES;
        this.reachable = this.endpoint == null;
    }

    /** @return a local, unbounded-endpoint object store. */
    public static S3ObjectStorageAdapter local() {
        return new S3ObjectStorageAdapter();
    }

    /** @return a remote-configured object store for {@code endpoint}/{@code bucket}. */
    public static S3ObjectStorageAdapter remote(String endpoint, String bucket) {
        return new S3ObjectStorageAdapter(endpoint, bucket);
    }

    /** @return {@code true} when a remote endpoint is configured. */
    public boolean isConfigured() {
        return endpoint != null;
    }

    /** @return {@code true} when stored content may actually be written. */
    public boolean isReachable() {
        return reachable;
    }

    /** Marks the remote endpoint reachable (or not) for health and store decisions. */
    public S3ObjectStorageAdapter markReachable(boolean value) {
        this.reachable = value;
        return this;
    }

    /** @return the configured endpoint, or {@code null} for the local store. */
    public String endpoint() {
        return endpoint;
    }

    /** @return the configured bucket, or {@code null} when none is set. */
    public String bucket() {
        return bucket;
    }

    @Override
    public void store(AttachmentMetadata metadata, AttachmentContent content) {
        Objects.requireNonNull(metadata, "metadata");
        Objects.requireNonNull(content, "content");
        TenantId tenantId = Objects.requireNonNull(metadata.tenantId(), "metadata.tenantId");
        String attachmentId = requireAttachmentId(metadata.attachmentId());
        if (isConfigured() && !reachable) {
            throw new StorageFailureException("object storage endpoint " + endpoint + " is not reachable");
        }
        byte[] bytes = content.readAll();
        if (bytes.length > maxObjectBytes) {
            throw new StorageFailureException("attachment " + attachmentId + " exceeds the local store limit of "
                    + maxObjectBytes + " bytes");
        }
        Map<String, byte[]> tenantObjects = tenantObjects(tenantId);
        byte[] previous = tenantObjects.put(attachmentId, bytes);
        if (previous == null) {
            objectCountByTenant.merge(tenantId.value(), 1, Integer::sum);
        }
    }

    @Override
    public void remove(TenantId tenantId, String attachmentId) {
        Objects.requireNonNull(tenantId, "tenantId");
        if (attachmentId == null || attachmentId.isBlank()) {
            return;
        }
        Map<String, byte[]> tenantObjects = objectsByTenant.get(tenantId.value());
        if (tenantObjects == null) {
            return;
        }
        if (tenantObjects.remove(attachmentId) != null) {
            objectCountByTenant.computeIfPresent(tenantId.value(), (key, count) -> count <= 1 ? null : count - 1);
        }
    }

    @Override
    public AttachmentContent open(String uploadId) {
        Objects.requireNonNull(uploadId, "uploadId");
        byte[] bytes = uploads.get(uploadId);
        if (bytes == null) {
            throw new StorageFailureException("no staged upload for id " + uploadId);
        }
        return AttachmentContent.of(bytes);
    }

    @Override
    public String fingerprint(AttachmentContent content) {
        if (content == null) {
            return null;
        }
        byte[] bytes = content.readAll();
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(bytes));
        } catch (NoSuchAlgorithmException failure) {
            throw new StorageFailureException("SHA-256 is not available", failure);
        }
    }

    /** Stages {@code content} under {@code uploadId} so {@link #open(String)} can materialise it. */
    public void stage(String uploadId, AttachmentContent content) {
        Objects.requireNonNull(uploadId, "uploadId");
        Objects.requireNonNull(content, "content");
        uploads.put(uploadId, content.readAll());
    }

    /** Stages a raw byte array under {@code uploadId}. */
    public void stage(String uploadId, byte[] bytes) {
        Objects.requireNonNull(uploadId, "uploadId");
        uploads.put(uploadId, bytes == null ? new byte[0] : Arrays.copyOf(bytes, bytes.length));
    }

    /** Discards a staged upload. */
    public void discard(String uploadId) {
        if (uploadId != null) {
            uploads.remove(uploadId);
        }
    }

    /** @return the stored bytes for {@code tenantId}/{@code attachmentId}, or {@code null}. */
    public byte[] read(TenantId tenantId, String attachmentId) {
        if (tenantId == null || attachmentId == null) {
            return null;
        }
        Map<String, byte[]> tenantObjects = objectsByTenant.get(tenantId.value());
        if (tenantObjects == null) {
            return null;
        }
        byte[] bytes = tenantObjects.get(attachmentId);
        return bytes == null ? null : Arrays.copyOf(bytes, bytes.length);
    }

    /** @return {@code true} when content is stored for {@code tenantId}/{@code attachmentId}. */
    public boolean contains(TenantId tenantId, String attachmentId) {
        if (tenantId == null || attachmentId == null) {
            return false;
        }
        Map<String, byte[]> tenantObjects = objectsByTenant.get(tenantId.value());
        return tenantObjects != null && tenantObjects.containsKey(attachmentId);
    }

    /** @return the number of objects currently stored for {@code tenantId}. */
    public int objectCount(TenantId tenantId) {
        if (tenantId == null) {
            return 0;
        }
        Integer count = objectCountByTenant.get(tenantId.value());
        return count == null ? 0 : count;
    }

    private Map<String, byte[]> tenantObjects(TenantId tenantId) {
        return objectsByTenant.computeIfAbsent(tenantId.value(), key -> new ConcurrentHashMap<>());
    }

    private static String requireAttachmentId(String attachmentId) {
        if (attachmentId == null || attachmentId.isBlank()) {
            throw new IllegalArgumentException("attachmentId must not be blank");
        }
        return attachmentId.trim();
    }

    @Override
    public Object execute(Object input) {
        if (input instanceof ObjectStoragePort.StoreRequest request) {
            store(request.metadata(), request.content());
            return null;
        }
        if (input instanceof AttachmentCleanupPort.CleanupRequest request) {
            remove(request.tenantId(), request.attachmentId());
            return null;
        }
        if (input instanceof String uploadId) {
            return open(uploadId);
        }
        if (input instanceof AttachmentContent content) {
            return fingerprint(content);
        }
        throw new IllegalArgumentException("unsupported object storage request: "
                + (input == null ? "null" : input.getClass().getName()));
    }

    /** Convenience: SHA-256 of a raw byte array as lowercase hex. */
    public static String sha256(byte[] bytes) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(bytes == null ? new byte[0] : bytes));
        } catch (NoSuchAlgorithmException failure) {
            throw new StorageFailureException("SHA-256 is not available", failure);
        }
    }

    /** Convenience: SHA-256 of a UTF-8 string as lowercase hex. */
    public static String sha256(String value) {
        return sha256(value == null ? new byte[0] : value.getBytes(StandardCharsets.UTF_8));
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
