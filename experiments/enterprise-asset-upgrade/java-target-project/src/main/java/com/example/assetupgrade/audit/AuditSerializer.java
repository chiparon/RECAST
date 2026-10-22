package com.example.assetupgrade.audit;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.ValidationException;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Deterministic, round-trippable textual rendering of an {@link AuditEntry}.
 *
 * <p>The serialized form is a single line of {@code key=value} fields separated by
 * {@code |}, with the fixed field order {@code tenantId, subjectId, action, status,
 * correlationId, occurredAt, details}. Detail pairs are sorted by key and separated by
 * {@code ,}. Delimiters inside values are backslash-escaped. Every field required to
 * preserve event identity and the final state - tenant, subject, action, status,
 * correlation and occurrence time - is retained so {@link #deserialize(String)} reproduces
 * an equal entry.</p>
 */
public final class AuditSerializer {

    private static final char FIELD_SEPARATOR = '|';
    private static final char PAIR_SEPARATOR = ',';
    private static final char KEY_VALUE_SEPARATOR = '=';
    private static final String NULL_SENTINEL = "";

    /** Renders {@code entry} to its stable textual form. */
    public String serialize(AuditEntry entry) {
        if (entry == null) {
            throw new ValidationException("audit entry is required for serialization");
        }
        StringBuilder builder = new StringBuilder();
        appendField(builder, "tenantId", entry.tenantId().value());
        appendField(builder, "subjectId", entry.subjectId());
        appendField(builder, "action", entry.action().name());
        appendField(builder, "status", entry.status().name());
        appendField(builder, "correlationId", entry.correlationId() == null ? null : entry.correlationId().value());
        appendField(builder, "occurredAt", entry.occurredAt().toString());
        appendField(builder, "details", renderDetails(entry.details()));
        return builder.toString();
    }

    /** Parses an entry previously produced by {@link #serialize(AuditEntry)}. */
    public AuditEntry deserialize(String text) {
        if (text == null || text.isBlank()) {
            throw new ValidationException("audit serialization text is required");
        }
        List<String> fields = splitUnescaped(text, FIELD_SEPARATOR);
        Map<String, String> values = new LinkedHashMap<>();
        for (String field : fields) {
            int separator = indexOfUnescaped(field, KEY_VALUE_SEPARATOR);
            if (separator < 0) {
                throw new ValidationException("malformed audit field: " + field);
            }
            String key = field.substring(0, separator);
            String value = unescape(field.substring(separator + 1));
            values.put(key, value);
        }
        try {
            TenantId tenantId = TenantId.of(require(values, "tenantId"));
            String subjectId = nullable(values.get("subjectId"));
            AuditAction action = AuditAction.valueOf(require(values, "action"));
            AuditStatus status = AuditStatus.valueOf(require(values, "status"));
            CorrelationId correlationId = nullable(values.get("correlationId")) == null
                    ? null
                    : CorrelationId.of(values.get("correlationId"));
            Instant occurredAt = Instant.parse(require(values, "occurredAt"));
            Map<String, String> details = parseDetails(values.get("details"));
            return new AuditEntry(tenantId, subjectId, action, status, correlationId, occurredAt, details);
        } catch (IllegalArgumentException | DateTimeParseException ex) {
            throw new ValidationException("malformed audit serialization text", ex);
        }
    }

    /** Alias of {@link #serialize(AuditEntry)}. */
    public String toText(AuditEntry entry) {
        return serialize(entry);
    }

    /** Alias of {@link #deserialize(String)}. */
    public AuditEntry fromText(String text) {
        return deserialize(text);
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #serialize(AuditEntry)}. */
    public Object execute(Object input) {
        if (input instanceof AuditEntry entry) {
            return serialize(entry);
        }
        if (input instanceof String text) {
            return deserialize(text);
        }
        throw new IllegalArgumentException("expected an AuditEntry or String but got "
                + (input == null ? "null" : input.getClass().getName()));
    }

    private static String require(Map<String, String> values, String key) {
        String value = values.get(key);
        if (value == null || value.isEmpty()) {
            throw new ValidationException("missing audit field: " + key);
        }
        return value;
    }

    private static String nullable(String value) {
        return value == null || value.isEmpty() ? null : value;
    }

    private static void appendField(StringBuilder builder, String key, String value) {
        if (builder.length() > 0) {
            builder.append(FIELD_SEPARATOR);
        }
        builder.append(key).append(KEY_VALUE_SEPARATOR).append(escape(value));
    }

    private static String renderDetails(Map<String, String> details) {
        if (details == null || details.isEmpty()) {
            return NULL_SENTINEL;
        }
        StringBuilder builder = new StringBuilder();
        for (Map.Entry<String, String> detail : new TreeMap<>(details).entrySet()) {
            if (builder.length() > 0) {
                builder.append(PAIR_SEPARATOR);
            }
            builder.append(escape(detail.getKey())).append(KEY_VALUE_SEPARATOR).append(escape(detail.getValue()));
        }
        return builder.toString();
    }

    private static Map<String, String> parseDetails(String rendered) {
        if (rendered == null || rendered.isEmpty()) {
            return Map.of();
        }
        Map<String, String> details = new LinkedHashMap<>();
        for (String pair : splitUnescaped(rendered, PAIR_SEPARATOR)) {
            int separator = indexOfUnescaped(pair, KEY_VALUE_SEPARATOR);
            if (separator < 0) {
                throw new ValidationException("malformed audit detail: " + pair);
            }
            details.put(unescape(pair.substring(0, separator)), unescape(pair.substring(separator + 1)));
        }
        return details;
    }

    private static String escape(String value) {
        if (value == null || value.isEmpty()) {
            return NULL_SENTINEL;
        }
        StringBuilder builder = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\\' || c == FIELD_SEPARATOR || c == PAIR_SEPARATOR || c == KEY_VALUE_SEPARATOR) {
                builder.append('\\');
            }
            builder.append(c);
        }
        return builder.toString();
    }

    private static String unescape(String value) {
        StringBuilder builder = new StringBuilder(value.length());
        boolean escaped = false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (escaped) {
                builder.append(c);
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else {
                builder.append(c);
            }
        }
        if (escaped) {
            builder.append('\\');
        }
        return builder.toString();
    }

    private static List<String> splitUnescaped(String value, char separator) {
        List<String> parts = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean escaped = false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (escaped) {
                current.append(c);
                escaped = false;
            } else if (c == '\\') {
                current.append(c);
                escaped = true;
            } else if (c == separator) {
                parts.add(current.toString());
                current.setLength(0);
            } else {
                current.append(c);
            }
        }
        parts.add(current.toString());
        return parts;
    }

    private static int indexOfUnescaped(String value, char target) {
        boolean escaped = false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == target) {
                return i;
            }
        }
        return -1;
    }
}
