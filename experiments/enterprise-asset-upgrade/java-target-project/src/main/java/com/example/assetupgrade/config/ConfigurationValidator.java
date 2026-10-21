package com.example.assetupgrade.config;

import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.error.ValidationException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Pure validation policy over a loaded {@link ConfigurationLoader.Settings}.
 *
 * <p>Translated from the nopCommerce app-settings save/validation path: every offending
 * section is collected before failing so a caller receives the complete list of problems
 * rather than one at a time. The validator is provider-neutral: it inspects only the typed
 * property records and never touches a file system, broker or database.</p>
 */
public final class ConfigurationValidator {

    /** Creates a validator. */
    public ConfigurationValidator() {
    }

    /** @return a validator. */
    public static ConfigurationValidator defaults() {
        return new ConfigurationValidator();
    }

    /** @return every blocking problem found in {@code settings}; empty when the settings are valid. */
    public List<ServiceProblem> problems(ConfigurationLoader.Settings settings) {
        Objects.requireNonNull(settings, "settings");
        List<ServiceProblem> problems = new ArrayList<>();

        TenantProperties tenant = settings.get(TenantProperties.class);
        if (isBlank(tenant.defaultTenant())) {
            problems.add(problem("tenant.defaultTenant must not be blank"));
        }

        StorageProperties storage = settings.get(StorageProperties.class);
        if (isBlank(storage.bucket())) {
            problems.add(problem("storage.bucket must not be blank"));
        }
        if (storage.maxObjectBytes() <= 0) {
            problems.add(problem("storage.maxObjectBytes must be positive"));
        }

        AttachmentPolicyProperties attachment = settings.get(AttachmentPolicyProperties.class);
        if (attachment.maxBytes() <= 0) {
            problems.add(problem("attachment.maxBytes must be positive"));
        }
        if (storage.maxObjectBytes() > 0 && attachment.maxBytes() > storage.maxObjectBytes()) {
            problems.add(problem("attachment.maxBytes must not exceed storage.maxObjectBytes"));
        }

        DatabaseProperties database = settings.get(DatabaseProperties.class);
        if (isBlank(database.jdbcUrl())) {
            problems.add(problem("database.jdbcUrl must not be blank"));
        }
        if (database.poolSize() <= 0) {
            problems.add(problem("database.poolSize must be positive"));
        }

        RetryProperties retry = settings.get(RetryProperties.class);
        if (retry.maxAttempts() < 1) {
            problems.add(problem("retry.maxAttempts must be at least 1"));
        }
        if (retry.initialBackoffMillis() < 0) {
            problems.add(problem("retry.initialBackoffMillis must not be negative"));
        }
        if (retry.maxBackoffMillis() < 0) {
            problems.add(problem("retry.maxBackoffMillis must not be negative"));
        }
        if (!(retry.multiplier() >= 1.0d)) {
            problems.add(problem("retry.multiplier must be at least 1.0"));
        }
        if (retry.initialBackoffMillis() >= 0 && retry.maxBackoffMillis() > 0
                && retry.initialBackoffMillis() > retry.maxBackoffMillis()) {
            problems.add(problem("retry.initialBackoffMillis must not exceed retry.maxBackoffMillis"));
        }

        SchedulerProperties scheduler = settings.get(SchedulerProperties.class);
        if (scheduler.enabled()) {
            if (scheduler.intervalSeconds() <= 0) {
                problems.add(problem("scheduler.intervalSeconds must be positive when enabled"));
            }
            if (scheduler.leaseTtlSeconds() <= 0) {
                problems.add(problem("scheduler.leaseTtlSeconds must be positive when enabled"));
            }
            if (scheduler.intervalSeconds() > 0 && scheduler.leaseTtlSeconds() >= scheduler.intervalSeconds()) {
                problems.add(problem("scheduler.leaseTtlSeconds must be less than scheduler.intervalSeconds"));
            }
        }

        MessagingProperties messaging = settings.get(MessagingProperties.class);
        if (messaging.enabled() && isBlank(messaging.bootstrapServers())) {
            problems.add(problem("messaging.bootstrapServers must not be blank when messaging is enabled"));
        }

        WorkflowProperties workflow = settings.get(WorkflowProperties.class);
        if (!WorkflowProperties.DEFAULT_APPROVED_STATE.equals(workflow.approvedState())) {
            problems.add(problem("workflow.approvedState must be exactly '"
                    + WorkflowProperties.DEFAULT_APPROVED_STATE + "'"));
        }

        return List.copyOf(problems);
    }

    /**
     * Validates {@code settings}, throwing a single aggregated
     * {@link ValidationException} listing every problem when any is found.
     */
    public void validate(ConfigurationLoader.Settings settings) {
        List<ServiceProblem> problems = problems(settings);
        if (problems.isEmpty()) {
            return;
        }
        Map<String, String> attributes = new LinkedHashMap<>();
        StringBuilder builder = new StringBuilder("invalid configuration:");
        for (ServiceProblem problem : problems) {
            builder.append("\n- ").append(problem.message());
        }
        attributes.put("problemCount", Integer.toString(problems.size()));
        throw new ValidationException(builder.toString());
    }

    /** Validates {@code settings} and returns it unchanged, for fluent composition. */
    public ConfigurationLoader.Settings validateAndReturn(ConfigurationLoader.Settings settings) {
        validate(settings);
        return settings;
    }

    /** Compatibility seam; the typed contract is {@link #validate(ConfigurationLoader.Settings)}. */
    public Object execute(Object input) {
        if (input instanceof ConfigurationLoader.Settings settings) {
            return validateAndReturn(settings);
        }
        if (input instanceof ConfigurationLoader loader) {
            return validateAndReturn(loader.load());
        }
        throw new IllegalArgumentException("expected configuration settings but got "
                + (input == null ? "null" : input.getClass().getName()));
    }

    private static ServiceProblem problem(String message) {
        return ServiceProblem.of(ProblemCode.INVALID_INPUT, message);
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
