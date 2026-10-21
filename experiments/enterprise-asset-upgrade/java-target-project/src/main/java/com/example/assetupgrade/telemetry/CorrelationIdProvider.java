package com.example.assetupgrade.telemetry;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.observability.CorrelationPort;
import com.example.assetupgrade.observability.LogContext;
import com.example.assetupgrade.observability.TelemetryContext;

import java.util.Map;

/**
 * Best-effort {@link CorrelationPort} adapter.
 *
 * <p>Returns an inbound {@link CorrelationId} unchanged when one is supplied and otherwise
 * generates a fresh identity, propagating the result into {@link TelemetryContext} and
 * {@link LogContext}. Resolution never throws: a failure while generating falls back to a
 * freshly generated identity and, in the extreme case, a fixed placeholder.</p>
 */
public final class CorrelationIdProvider implements CorrelationPort {

    private static final System.Logger LOG = System.getLogger(CorrelationIdProvider.class.getName());

    @Override
    public CorrelationId resolve(CorrelationId inbound) {
        if (inbound != null) {
            return inbound;
        }
        try {
            return CorrelationId.generate();
        } catch (RuntimeException ex) {
            LOG.log(System.Logger.Level.WARNING, "failed to generate correlation id", ex);
            return CorrelationId.of("correlation-unavailable");
        }
    }

    /** Generates a fresh correlation identity. */
    public CorrelationId generate() {
        return resolve(null);
    }

    /** @return the correlation identity to use for the current operation. */
    @Override
    public CorrelationId correlationId() {
        return resolve(null);
    }

    /** Resolves a correlation identity from an optional textual header value. */
    public CorrelationId resolveHeader(String header) {
        if (header == null || header.isBlank()) {
            return resolve(null);
        }
        try {
            return resolve(CorrelationId.of(header));
        } catch (RuntimeException ex) {
            LOG.log(System.Logger.Level.WARNING, "invalid correlation header, generating a fresh id", ex);
            return resolve(null);
        }
    }

    /** Builds a correlation-tagged telemetry context. */
    public TelemetryContext telemetryContext(String marker, CorrelationId correlationId, Map<String, String> attributes) {
        CorrelationId resolved = resolve(correlationId);
        TelemetryContext base = TelemetryContext.of(marker, attributes);
        return base.withAttribute("correlationId", resolved.value());
    }

    /** Builds a correlation-and-tenant-tagged log context. */
    public LogContext logContext(CorrelationId correlationId, TenantId tenantId, Map<String, String> attributes) {
        return LogContext.of(resolve(correlationId), tenantId, attributes);
    }

    /** Builds a correlation-and-tenant-tagged log context. */
    public LogContext logContext(CorrelationId correlationId, TenantId tenantId) {
        return LogContext.of(resolve(correlationId), tenantId);
    }
}
