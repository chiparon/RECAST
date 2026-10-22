package com.example.assetupgrade.attachment;

import java.util.Locale;
import java.util.Objects;

/**
 * Normalised, vendor-neutral description of an attachment's declared media type.
 *
 * <p>The single record component {@code value} is the public contract consumed by the
 * intake boundary. The canonical constructor trims surrounding whitespace, lower-cases the
 * type (media types are case-insensitive), drops any parameters such as
 * {@code ; charset=...}, and defaults a missing declaration to
 * {@link #OCTET_STREAM}. Behavioural helpers added here let policy code compare type
 * families without re-parsing the value.</p>
 */
public record AttachmentContentType(String value) {

    /** Fallback media type used when a caller declares nothing. */
    public static final String OCTET_STREAM = "application/octet-stream";

    public AttachmentContentType {
        value = normalize(value);
    }

    private static String normalize(String candidate) {
        if (candidate == null) {
            return OCTET_STREAM;
        }
        String trimmed = candidate.trim();
        int separator = trimmed.indexOf(';');
        if (separator >= 0) {
            trimmed = trimmed.substring(0, separator).trim();
        }
        if (trimmed.isEmpty()) {
            return OCTET_STREAM;
        }
        return trimmed.toLowerCase(Locale.ROOT);
    }

    /** Creates a content type from its textual representation. */
    public static AttachmentContentType of(String value) {
        return new AttachmentContentType(value);
    }

    /** @return the primary type, for example {@code application} in {@code application/pdf}. */
    public String type() {
        int slash = value.indexOf('/');
        return slash < 0 ? value : value.substring(0, slash);
    }

    /** @return the subtype, for example {@code pdf} in {@code application/pdf}. */
    public String subtype() {
        int slash = value.indexOf('/');
        return slash < 0 ? "" : value.substring(slash + 1);
    }

    /** @return {@code true} when the declaration contains a wildcard, for example {@code image/*}. */
    public boolean isWildcard() {
        return value.indexOf('*') >= 0;
    }

    /** @return {@code true} when the declaration carries no specific type information. */
    public boolean isOctetStream() {
        return OCTET_STREAM.equals(value);
    }

    /** @return {@code true} when both declarations share the same primary type. */
    public boolean sameFamilyAs(AttachmentContentType other) {
        return other != null && Objects.equals(type(), other.type());
    }

    /**
     * @return {@code true} when this declaration accepts content declaring {@code other}. A
     *         wildcard or octet-stream declaration accepts anything; otherwise the two must
     *         share a family with a matching or wildcard subtype.
     */
    public boolean accepts(AttachmentContentType other) {
        if (other == null || isWildcard() || isOctetStream()) {
            return true;
        }
        if (!sameFamilyAs(other)) {
            return false;
        }
        String subtype = subtype();
        return "*".equals(subtype) || subtype.equals(other.subtype());
    }
}
