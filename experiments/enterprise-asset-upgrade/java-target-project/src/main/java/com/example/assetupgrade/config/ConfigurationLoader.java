package com.example.assetupgrade.config;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Provider-neutral, ordered configuration loader.
 *
 * <p>Translated from nopCommerce {@code AppSettings} (typed {@code Get<TConfig>()} lookup
 * over {@code IConfig} sections ordered by {@code GetOrder()}) and
 * {@code AppSettingsHelper} (merge raw values over defaults and publish a running
 * settings singleton). Sections are named by their {@code IConfig.Name} marker, ordered by
 * the declared section order, and resolved to the typed property records. Absent keys fall
 * back to the records' explicit public defaults; an optional {@code ASSETUPGRADE_}-prefixed
 * environment map overrides raw values using the documented
 * {@code ASSETUPGRADE_<SECTION>_<KEY>} convention. No file system, JSON or provider code
 * appears here.</p>
 */
public final class ConfigurationLoader {

    /** Prefix applied to environment-style override keys. */
    public static final String ENV_PREFIX = "ASSETUPGRADE_";

    /** Order returned by {@link #order(String)} for an unknown section. */
    public static final int UNKNOWN_ORDER = -1;

    /** Declared section order, mirroring {@code IConfig.GetOrder()} ascending. */
    public static final List<String> SECTION_ORDER = List.of(
            AttachmentPolicyProperties.MARKER,
            DatabaseProperties.MARKER,
            EnvironmentProperties.MARKER,
            MessagingProperties.MARKER,
            RetryProperties.MARKER,
            SchedulerProperties.MARKER,
            StorageProperties.MARKER,
            TenantProperties.MARKER,
            WorkflowProperties.MARKER);

    private static final Map<String, Set<String>> KNOWN_KEYS = knownKeys();

    private final Map<String, Map<String, String>> source;
    private final Map<String, String> environment;
    private volatile Settings settings;

    /** Creates a loader with no overrides; every section resolves to its defaults. */
    public ConfigurationLoader() {
        this(Map.of(), Map.of());
    }

    /** Creates a loader over named sections. */
    public ConfigurationLoader(Map<String, Map<String, String>> source) {
        this(source, Map.of());
    }

    /** Creates a loader over named sections plus an environment-style override map. */
    public ConfigurationLoader(Map<String, Map<String, String>> source, Map<String, String> environment) {
        this.source = copySections(source);
        this.environment = environment == null ? Map.of() : Map.copyOf(environment);
    }

    /** @return a loader with no overrides. */
    public static ConfigurationLoader defaults() {
        return new ConfigurationLoader();
    }

    /** @return a loader over {@code source}. */
    public static ConfigurationLoader of(Map<String, Map<String, String>> source) {
        return new ConfigurationLoader(source);
    }

    /** @return a loader over {@code source} and {@code environment}. */
    public static ConfigurationLoader of(Map<String, Map<String, String>> source, Map<String, String> environment) {
        return new ConfigurationLoader(source, environment);
    }

    /** @return the ordered, resolved settings; deterministic and cached after first call. */
    public Settings load() {
        Settings current = settings;
        if (current == null) {
            current = build();
            settings = current;
        }
        return current;
    }

    /** @return the declared section names in order. */
    public List<String> sectionNames() {
        return SECTION_ORDER;
    }

    /** @return the declared order of {@code section}, or {@link #UNKNOWN_ORDER} when unknown. */
    public int order(String section) {
        if (section == null) {
            return UNKNOWN_ORDER;
        }
        int index = SECTION_ORDER.indexOf(section.trim());
        return index < 0 ? UNKNOWN_ORDER : index;
    }

    /** @return the typed section for {@code type}; never throws for an optional section. */
    public <T> T get(Class<T> type) {
        return load().get(type);
    }

    /** @return the raw, unmodifiable named-section source. */
    public Map<String, Map<String, String>> source() {
        return source;
    }

    /** @return the raw, unmodifiable environment override map. */
    public Map<String, String> environment() {
        return environment;
    }

    /**
     * Compatibility seam. A {@link Class} argument resolves the typed section; any other
     * argument returns the fully loaded settings.
     */
    public Object execute(Object input) {
        if (input instanceof Class<?> type) {
            return get(type);
        }
        if (input instanceof Settings loaded) {
            return loaded;
        }
        return load();
    }

    private Settings build() {
        Map<String, Map<String, String>> sections = new LinkedHashMap<>();
        for (String name : SECTION_ORDER) {
            sections.put(name, merged(name));
        }
        for (Map.Entry<String, Map<String, String>> entry : source.entrySet()) {
            sections.computeIfAbsent(entry.getKey(), key -> Map.copyOf(entry.getValue()));
        }
        return new Settings(sections);
    }

    private Map<String, String> merged(String section) {
        Map<String, String> merged = new LinkedHashMap<>();
        Map<String, String> provided = source.get(section);
        if (provided != null) {
            merged.putAll(provided);
        }
        for (Map.Entry<String, String> entry : environment.entrySet()) {
            String canonical = canonicalKey(section, entry.getKey());
            if (canonical != null) {
                merged.put(canonical, entry.getValue());
            }
        }
        return Map.copyOf(merged);
    }

    /** Resolves an {@code ASSETUPGRADE_<SECTION>_<KEY>} environment key to a section key. */
    static String canonicalKey(String section, String envKey) {
        if (envKey == null || !envKey.startsWith(ENV_PREFIX)) {
            return null;
        }
        String body = envKey.substring(ENV_PREFIX.length());
        int separator = body.indexOf('_');
        if (separator <= 0 || separator == body.length() - 1) {
            return null;
        }
        String resolvedSection = body.substring(0, separator).trim().toLowerCase(java.util.Locale.ROOT);
        if (!resolvedSection.equals(section)) {
            return null;
        }
        String rawKey = body.substring(separator + 1);
        String normalized = rawKey.replace("_", "").toUpperCase(java.util.Locale.ROOT);
        for (String known : KNOWN_KEYS.getOrDefault(section, Set.of())) {
            if (known.replace("_", "").toUpperCase(java.util.Locale.ROOT).equals(normalized)) {
                return known;
            }
        }
        return rawKey.trim().toLowerCase(java.util.Locale.ROOT);
    }

    private static Map<String, Map<String, String>> copySections(Map<String, Map<String, String>> raw) {
        if (raw == null || raw.isEmpty()) {
            return Map.of();
        }
        Map<String, Map<String, String>> copy = new LinkedHashMap<>();
        for (Map.Entry<String, Map<String, String>> entry : raw.entrySet()) {
            if (entry.getKey() == null) {
                continue;
            }
            Map<String, String> section = entry.getValue() == null ? Map.of() : Map.copyOf(entry.getValue());
            copy.put(entry.getKey().trim(), section);
        }
        return Collections.unmodifiableMap(copy);
    }

    private static Map<String, Set<String>> knownKeys() {
        Map<String, Set<String>> keys = new LinkedHashMap<>();
        keys.put(AttachmentPolicyProperties.MARKER, Set.of(
                AttachmentPolicyProperties.KEY_MAX_BYTES,
                AttachmentPolicyProperties.KEY_ALLOWED_MIME_TYPES,
                AttachmentPolicyProperties.KEY_REQUIRE_SIGNATURE,
                AttachmentPolicyProperties.KEY_QUARANTINE_BUCKET));
        keys.put(DatabaseProperties.MARKER, Set.of(
                DatabaseProperties.KEY_JDBC_URL,
                DatabaseProperties.KEY_POOL_SIZE,
                DatabaseProperties.KEY_CONNECTION_TIMEOUT_SECONDS));
        keys.put(EnvironmentProperties.MARKER, Set.of(
                EnvironmentProperties.KEY_NAME,
                EnvironmentProperties.KEY_DISPLAY_FULL_ERROR_STACK));
        keys.put(MessagingProperties.MARKER, Set.of(
                MessagingProperties.KEY_BOOTSTRAP_SERVERS,
                MessagingProperties.KEY_WORKFLOW_TOPIC,
                MessagingProperties.KEY_DEAD_LETTER_TOPIC,
                MessagingProperties.KEY_ENABLED));
        keys.put(RetryProperties.MARKER, Set.of(
                RetryProperties.KEY_MAX_ATTEMPTS,
                RetryProperties.KEY_INITIAL_BACKOFF_MILLIS,
                RetryProperties.KEY_MULTIPLIER,
                RetryProperties.KEY_MAX_BACKOFF_MILLIS,
                RetryProperties.KEY_JITTER));
        keys.put(SchedulerProperties.MARKER, Set.of(
                SchedulerProperties.KEY_ENABLED,
                SchedulerProperties.KEY_INTERVAL_SECONDS,
                SchedulerProperties.KEY_LEASE_TTL_SECONDS));
        keys.put(StorageProperties.MARKER, Set.of(
                StorageProperties.KEY_ENDPOINT,
                StorageProperties.KEY_BUCKET,
                StorageProperties.KEY_MAX_OBJECT_BYTES));
        keys.put(TenantProperties.MARKER, Set.of(
                TenantProperties.KEY_DEFAULT_TENANT,
                TenantProperties.KEY_ENFORCE_ISOLATION));
        keys.put(WorkflowProperties.MARKER, Set.of(
                WorkflowProperties.KEY_APPROVED_STATE,
                WorkflowProperties.KEY_DISPATCH_ROUTE,
                WorkflowProperties.KEY_MAX_ATTEMPTS,
                WorkflowProperties.KEY_ENGINE));
        return Map.copyOf(keys);
    }

    /**
     * Immutable, ordered resolved configuration.
     *
     * <p>Mirrors the running {@code AppSettings} singleton: named raw sections plus typed
     * section instances resolved by {@link #get(Class)}. Optional sections always resolve
     * to their declared defaults rather than throwing.</p>
     */
    public static final class Settings {

        private final List<String> sectionNames;
        private final Map<String, Map<String, String>> sections;
        private final Map<Class<?>, Object> typed;

        private Settings(Map<String, Map<String, String>> sections) {
            Map<String, Map<String, String>> ordered = new LinkedHashMap<>();
            for (Map.Entry<String, Map<String, String>> entry : sections.entrySet()) {
                ordered.put(entry.getKey(), entry.getValue());
            }
            this.sections = Collections.unmodifiableMap(ordered);
            this.sectionNames = List.copyOf(ordered.keySet());
            this.typed = resolve(sections);
        }

        private static Map<Class<?>, Object> resolve(Map<String, Map<String, String>> sections) {
            Map<Class<?>, Object> resolved = new LinkedHashMap<>();
            resolved.put(AttachmentPolicyProperties.class,
                    AttachmentPolicyProperties.of(AttachmentPolicyProperties.MARKER,
                            sections.getOrDefault(AttachmentPolicyProperties.MARKER, Map.of())));
            resolved.put(DatabaseProperties.class,
                    DatabaseProperties.of(DatabaseProperties.MARKER,
                            sections.getOrDefault(DatabaseProperties.MARKER, Map.of())));
            resolved.put(EnvironmentProperties.class,
                    EnvironmentProperties.of(EnvironmentProperties.MARKER,
                            sections.getOrDefault(EnvironmentProperties.MARKER, Map.of())));
            resolved.put(MessagingProperties.class,
                    MessagingProperties.of(MessagingProperties.MARKER,
                            sections.getOrDefault(MessagingProperties.MARKER, Map.of())));
            resolved.put(RetryProperties.class,
                    RetryProperties.of(RetryProperties.MARKER,
                            sections.getOrDefault(RetryProperties.MARKER, Map.of())));
            resolved.put(SchedulerProperties.class,
                    SchedulerProperties.of(SchedulerProperties.MARKER,
                            sections.getOrDefault(SchedulerProperties.MARKER, Map.of())));
            resolved.put(StorageProperties.class,
                    StorageProperties.of(StorageProperties.MARKER,
                            sections.getOrDefault(StorageProperties.MARKER, Map.of())));
            resolved.put(TenantProperties.class,
                    TenantProperties.of(TenantProperties.MARKER,
                            sections.getOrDefault(TenantProperties.MARKER, Map.of())));
            resolved.put(WorkflowProperties.class,
                    WorkflowProperties.of(WorkflowProperties.MARKER,
                            sections.getOrDefault(WorkflowProperties.MARKER, Map.of())));
            return Map.copyOf(resolved);
        }

        /** @return the declared section names in order. */
        public List<String> sectionNames() {
            return sectionNames;
        }

        /** @return the declared order of {@code section}, or {@link #UNKNOWN_ORDER} when unknown. */
        public int order(String section) {
            if (section == null) {
                return UNKNOWN_ORDER;
            }
            int index = SECTION_ORDER.indexOf(section.trim());
            return index < 0 ? UNKNOWN_ORDER : index;
        }

        /** @return the raw named sections in order. */
        public Map<String, Map<String, String>> sections() {
            return sections;
        }

        /** @return the raw attributes of {@code section}, empty when absent. */
        public Map<String, String> section(String section) {
            if (section == null) {
                return Map.of();
            }
            return sections.getOrDefault(section.trim(), Map.of());
        }

        /** @return whether {@code section} was provided by the source. */
        public boolean hasSection(String section) {
            return section != null && sections.containsKey(section.trim());
        }

        /** @return the attachment-policy section. */
        public AttachmentPolicyProperties attachmentPolicy() {
            return get(AttachmentPolicyProperties.class);
        }

        /** @return the database section. */
        public DatabaseProperties database() {
            return get(DatabaseProperties.class);
        }

        /** @return the environment section. */
        public EnvironmentProperties environment() {
            return get(EnvironmentProperties.class);
        }

        /** @return the messaging section. */
        public MessagingProperties messaging() {
            return get(MessagingProperties.class);
        }

        /** @return the retry section. */
        public RetryProperties retry() {
            return get(RetryProperties.class);
        }

        /** @return the scheduler section. */
        public SchedulerProperties scheduler() {
            return get(SchedulerProperties.class);
        }

        /** @return the storage section. */
        public StorageProperties storage() {
            return get(StorageProperties.class);
        }

        /** @return the tenant section. */
        public TenantProperties tenant() {
            return get(TenantProperties.class);
        }

        /** @return the workflow section. */
        public WorkflowProperties workflow() {
            return get(WorkflowProperties.class);
        }

        /**
         * Resolves the typed section for {@code type}.
         *
         * @throws IllegalArgumentException when {@code type} is not one of the declared sections
         */
        @SuppressWarnings("unchecked")
        public <T> T get(Class<T> type) {
            Objects.requireNonNull(type, "type");
            Object value = typed.get(type);
            if (value == null) {
                throw new IllegalArgumentException("unknown configuration type '" + type.getName() + "'");
            }
            return (T) value;
        }

        /** Compatibility seam: a {@link Class} resolves a typed section, a {@link String} a raw section. */
        public Object execute(Object input) {
            if (input instanceof Class<?> type) {
                return get(type);
            }
            if (input instanceof String name) {
                return section(name);
            }
            return this;
        }

        /** @return the declared section names as an ordered list. */
        public List<String> orderedNames() {
            List<String> ordered = new ArrayList<>(SECTION_ORDER);
            for (String name : sectionNames) {
                if (!ordered.contains(name)) {
                    ordered.add(name);
                }
            }
            return List.copyOf(ordered);
        }
    }
}
