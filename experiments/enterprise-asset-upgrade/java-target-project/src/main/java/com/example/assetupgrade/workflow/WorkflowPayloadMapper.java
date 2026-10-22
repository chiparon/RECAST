package com.example.assetupgrade.workflow;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Application-layer projection of a workflow event onto a provider-neutral payload map.
 *
 * <p>Delegates to the declared {@link com.example.assetupgrade.workflow.port.WorkflowPayloadMapper}
 * port and returns an immutable copy so callers can never mutate the mapped payload or observe a
 * provider-specific value type. When no port is configured the event's own immutable attributes are
 * exposed as the payload.</p>
 */
public final class WorkflowPayloadMapper {

    private final com.example.assetupgrade.workflow.port.WorkflowPayloadMapper port;

    /** Creates a mapper that projects the event attributes directly. */
    public WorkflowPayloadMapper() {
        this(null);
    }

    /** Creates a mapper delegating to {@code port}. */
    public WorkflowPayloadMapper(com.example.assetupgrade.workflow.port.WorkflowPayloadMapper port) {
        this.port = port;
    }

    /** @return an immutable payload map for {@code event}, never {@code null}. */
    public Map<String, Object> map(WorkflowEvent event) {
        Objects.requireNonNull(event, "event");
        Map<String, Object> mapped = null;
        if (port != null) {
            mapped = port.map(event);
        }
        if (mapped == null) {
            mapped = new LinkedHashMap<>(event.attributes() == null ? Map.of() : event.attributes());
        }
        return Collections.unmodifiableMap(new LinkedHashMap<>(mapped));
    }

    /** @return the backing payload port, or {@code null} when none is configured. */
    public com.example.assetupgrade.workflow.port.WorkflowPayloadMapper port() {
        return port;
    }

    /** Compatibility seam; accepts a {@link WorkflowEvent} and maps it. */
    public Object execute(Object input) {
        if (input instanceof WorkflowEvent event) {
            return map(event);
        }
        throw new IllegalArgumentException("Expected WorkflowEvent");
    }
}
