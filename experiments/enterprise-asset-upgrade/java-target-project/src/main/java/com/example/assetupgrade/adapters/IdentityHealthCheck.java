package com.example.assetupgrade.adapters;

import com.example.assetupgrade.observability.HealthCheck;
import com.example.assetupgrade.observability.HealthStatus;

import java.util.Map;

/**
 * Health probe for the identity provider boundary.
 *
 * <p>Reports {@link HealthStatus#up()} only when an identity provider is actually reachable. An
 * unconfigured or unreachable Keycloak adapter - the local fallback - yields
 * {@link HealthStatus#down(String)} with a reason, and {@link #status()} never throws.</p>
 */
public final class IdentityHealthCheck implements HealthCheck {

    private final KeycloakIdentityAdapter identity;

    /** Creates a probe with no identity provider; it reports down. */
    public IdentityHealthCheck() {
        this(null);
    }

    /** Creates a probe over {@code identity}. */
    public IdentityHealthCheck(KeycloakIdentityAdapter identity) {
        this.identity = identity;
    }

    @Override
    public String id() {
        return "identity";
    }

    @Override
    public Map<String, String> metadata() {
        return Map.of("component", "identity", "provider", "keycloak");
    }

    @Override
    public HealthStatus status() {
        try {
            if (identity == null) {
                return HealthStatus.down("identity provider is not configured");
            }
            if (!identity.probe()) {
                return HealthStatus.down("identity provider is not reachable");
            }
            return HealthStatus.up(Map.of("provider", "keycloak"));
        } catch (RuntimeException failure) {
            return HealthStatus.down("identity probe failed: " + failure.getMessage());
        }
    }

    /** Compatibility seam preserving the skeleton's generic entry point. */
    public Object invoke(Object input) {
        return execute(input);
    }
}
