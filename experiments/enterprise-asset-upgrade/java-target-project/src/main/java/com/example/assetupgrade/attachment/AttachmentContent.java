package com.example.assetupgrade.attachment;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.Arrays;

/**
 * Readable attachment payload supplied to the intake boundary.
 *
 * <p>The typed contract is {@link #openStream()} and {@link #length()}. The default
 * helpers read a bounded prefix or the whole stream and are used by the signature and
 * fingerprint policies; each call opens a fresh stream so a payload may be inspected and
 * then scanned.</p>
 */
public interface AttachmentContent {

    /** Opens a fresh stream over the attachment content. */
    InputStream openStream();

    /** @return the declared content length in bytes, or a negative value when unknown. */
    long length();

    /** @return the declared content length in bytes, or {@code -1} when unknown. */
    default long contentLength() {
        return length();
    }

    /** @return {@code true} when the declared content length is exactly zero. */
    default boolean isEmpty() {
        return length() == 0L;
    }

    /** @return {@code true} when a non-negative declared content length exceeds {@code limit}. */
    default boolean exceeds(long limit) {
        long declared = length();
        return limit >= 0L && declared > limit;
    }

    /**
     * Reads at most {@code maxBytes} from the start of the content.
     *
     * @param maxBytes the maximum number of bytes to read, must not be negative
     * @return the bytes actually read, never {@code null}
     */
    default byte[] readPrefix(int maxBytes) {
        if (maxBytes <= 0) {
            return new byte[0];
        }
        try (InputStream stream = openStream()) {
            return stream.readNBytes(maxBytes);
        } catch (IOException e) {
            throw new UncheckedIOException("failed to read attachment content", e);
        }
    }

    /** Reads the entire content into memory. Intended for bounded, already-limited payloads. */
    default byte[] readAll() {
        try (InputStream stream = openStream()) {
            return stream.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException("failed to read attachment content", e);
        }
    }

    /** @return the number of bytes actually readable by opening a fresh stream. */
    default long resolveLength() {
        try (InputStream stream = openStream()) {
            byte[] buffer = new byte[8192];
            long total = 0L;
            int read;
            while ((read = stream.read(buffer)) != -1) {
                total += read;
            }
            return total;
        } catch (IOException e) {
            throw new UncheckedIOException("failed to measure attachment content", e);
        }
    }

    /** @return a content view backed by an in-memory byte array. */
    static AttachmentContent of(byte[] bytes) {
        byte[] copy = bytes == null ? new byte[0] : Arrays.copyOf(bytes, bytes.length);
        return new AttachmentContent() {
            @Override
            public InputStream openStream() {
                return new java.io.ByteArrayInputStream(copy);
            }

            @Override
            public long length() {
                return copy.length;
            }
        };
    }
}
