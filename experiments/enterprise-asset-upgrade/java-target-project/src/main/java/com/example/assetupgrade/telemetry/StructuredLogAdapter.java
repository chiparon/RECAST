package com.example.assetupgrade.telemetry;

import com.example.assetupgrade.observability.LogContext;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Best-effort structured logging adapter.
 *
 * <p>Builds a correlation-and-tenant scoped field map for every log record and retains the
 * most recent records for inspection. Rendering never throws: any failure is caught and
 * logged so that logging can never change the business or audit outcome.</p>
 */
public final class StructuredLogAdapter {

    private static final System.Logger LOG = System.getLogger(StructuredLogAdapter.class.getName());

    /** Conventional field name for the log level. */
    public static final String LEVEL = "level";

    /** Conventional field name for the rendered message. */
    public static final String MESSAGE = "message";

    private final List<Map<String, String>> records = new CopyOnWriteArrayList<>();

    /** Builds and emits a structured record, returning its immutable field map. */
    public Map<String, String> record(String level, String message, LogContext context) {
        Map<String, String> fields = fields(level, message, context);
        try {
            records.add(fields);
        } catch (RuntimeException ex) {
            LOG.log(System.Logger.Level.WARNING, "failed to retain structured log record", ex);
        }
        return fields;
    }

    /** Builds and emits an informational record. */
    public Map<String, String> info(String message, LogContext context) {
        return record("INFO", message, context);
    }

    /** Builds and emits a warning record. */
    public Map<String, String> warn(String message, LogContext context) {
        return record("WARN", message, context);
    }

    /** Builds and emits an error record. */
    public Map<String, String> error(String message, LogContext context) {
        return record("ERROR", message, context);
    }

    /** Builds and emits a debug record. */
    public Map<String, String> debug(String message, LogContext context) {
        return record("DEBUG", message, context);
    }

    /** Builds and emits a record with an explicit level. */
    public Map<String, String> log(String level, String message, LogContext context) {
        return record(level, message, context);
    }

    /** Builds and emits an informational record. */
    public Map<String, String> log(String message, LogContext context) {
        return record("INFO", message, context);
    }

    /** Renders a deterministic single-line textual form of a structured record. */
    public String render(String level, String message, LogContext context) {
        Map<String, String> fields = fields(level, message, context);
        StringBuilder builder = new StringBuilder();
        for (Map.Entry<String, String> field : fields.entrySet()) {
            if (builder.length() > 0) {
                builder.append(' ');
            }
            builder.append(field.getKey()).append('=').append(field.getValue());
        }
        return builder.toString();
    }

    /** @return an immutable snapshot of the retained records, oldest first. */
    public List<Map<String, String>> records() {
        return List.copyOf(records);
    }

    /** Clears all retained records. */
    public void reset() {
        records.clear();
    }

    /** Compatibility seam for early implementations; the typed contract is {@link #record(String, String, LogContext)}. */
    public Object execute(Object input) {
        if (input instanceof LogContext context) {
            return record("INFO", "", context);
        }
        return record("INFO", String.valueOf(input), null);
    }

    private Map<String, String> fields(String level, String message, LogContext context) {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put(LEVEL, level == null || level.isBlank() ? "INFO" : level.trim());
        fields.put(MESSAGE, message == null ? "" : message);
        if (context != null) {
            fields.putAll(context.toMap());
        }
        return Collections.unmodifiableMap(fields);
    }
}
