package com.example.assetupgrade.security;

import com.example.assetupgrade.common.ActorId;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;

/**
 * Outbound seam for publishing security decisions as events.
 *
 * <p>Adapted from the nopCommerce permission-record cache event consumer; provider
 * transport details belong to adapters behind this port.</p>
 */
public interface SecurityEventPublisher {

    /** Publishes a single authorization decision for auditing and downstream consumers. */
    void publish(TenantId tenantId, ActorId actorId, CorrelationId correlationId, Permission permission, AuthorizationDecision decision);
}
