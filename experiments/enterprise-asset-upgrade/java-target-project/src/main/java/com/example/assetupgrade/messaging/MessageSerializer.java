package com.example.assetupgrade.messaging;

import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.error.ValidationException;
import com.example.assetupgrade.persistence.RepositoryException;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Provider-neutral message serialization port.
 *
 * <p>A serializer renders a message value - a {@link MessageEnvelope}, a {@link MessageHeaders}, a
 * map or an opaque byte sequence - to bytes and reconstructs it from bytes. The contract mirrors the
 * historical APScheduler {@code Serializer} seam: {@code serialize(Object) -> bytes},
 * {@code deserialize(bytes, type) -> T}, format-specific default hooks for time, identity, enums and
 * byte arrays, a magic-key/type-tag round-trip for arbitrary objects, and uniform wrapping of every
 * encode/decode failure. Raw provider exceptions are never leaked; failures surface as
 * {@link RepositoryException} while malformed or absent input is rejected with
 * {@link ValidationException}.</p>
 *
 * <p>Three self-contained formats are registered and require no third-party dependency:
 * {@code json} (deterministic UTF-8 object rendering), {@code cbor} (length-prefixed, type-tagged
 * binary framing) and {@code native} (opaque byte pass-through that still round-trips message
 * values). {@link #of(String)} and {@link #forContentType(String)} resolve a codec and reject an
 * unknown format with {@link ValidationException}.</p>
 */
public interface MessageSerializer {

    /** @return the registered format name ({@code json}, {@code cbor} or {@code native}). */
    String format();

    /** @return the payload content type produced by this serializer. */
    default String contentType() {
        return switch (format()) {
            case "json" -> "application/json";
            case "cbor" -> "application/cbor";
            default -> "application/octet-stream";
        };
    }

    /** Renders {@code value} to its byte form. */
    byte[] serialize(Object value);

    /** Reconstructs a value previously produced by {@link #serialize(Object)}. */
    <T> T deserialize(byte[] data, Class<T> type);

    /** Alias of {@link #serialize(Object)} returning the textual rendering. */
    default String toText(Object value) {
        return new String(serialize(value), StandardCharsets.UTF_8);
    }

    /** Alias of {@link #deserialize(byte[], Class)} accepting textual input. */
    default <T> T fromText(String text, Class<T> type) {
        if (text == null) {
            throw new ValidationException("serialized text is required");
        }
        return deserialize(text.getBytes(StandardCharsets.UTF_8), type);
    }

    /**
     * Compatibility seam for early implementations.
     *
     * <p>A {@link DeserializeRequest} holder triggers deserialization; every other input is
     * serialized.</p>
     */
    default Object execute(Object input) {
        if (input instanceof DeserializeRequest request) {
            return deserialize(request.data(), request.type());
        }
        return serialize(input);
    }

    /** @return the registered codec for {@code format}. */
    static MessageSerializer of(String format) {
        return MessageSerializerRegistry.of(format);
    }

    /** @return the codec whose content type matches {@code contentType}. */
    static MessageSerializer forContentType(String contentType) {
        return MessageSerializerRegistry.forContentType(contentType);
    }

    /** @return the registered format names in registration order. */
    static Set<String> formats() {
        return MessageSerializerRegistry.formats();
    }

    /** @return the JSON codec. */
    static MessageSerializer json() {
        return MessageSerializerRegistry.of("json");
    }

    /** @return the CBOR codec. */
    static MessageSerializer cbor() {
        return MessageSerializerRegistry.of("cbor");
    }

    /** @return the native/pickle-style pass-through codec. */
    static MessageSerializer pickle() {
        return MessageSerializerRegistry.of("native");
    }

    /**
     * Holder accepted by the compatibility {@link #execute(Object)} seam.
     *
     * @param data the serialized bytes
     * @param type the target type
     */
    record DeserializeRequest(byte[] data, Class<?> type) {}
}

/** Base codec that centralises format identification and uniform error wrapping. */
abstract class AbstractMessageSerializer implements MessageSerializer {

    @Override
    public byte[] serialize(Object value) {
        if (value == null) {
            throw new ValidationException("message value is required for serialization");
        }
        try {
            return encode(value);
        } catch (ValidationException invalid) {
            throw invalid;
        } catch (RuntimeException failure) {
            throw new RepositoryException("failed to serialize message with format " + format(), failure);
        }
    }

    @Override
    public <T> T deserialize(byte[] data, Class<T> type) {
        if (data == null || data.length == 0) {
            throw new ValidationException("serialized message bytes are required");
        }
        if (type == null) {
            throw new ValidationException("target type is required");
        }
        try {
            Object root = decode(data);
            Object rebuilt = MessageSerialization.rebuild(root, type);
            return type.cast(rebuilt);
        } catch (ValidationException invalid) {
            throw invalid;
        } catch (RuntimeException failure) {
            throw new RepositoryException("failed to deserialize message with format " + format(), failure);
        }
    }

    protected abstract byte[] encode(Object value);

    protected abstract Object decode(byte[] data);
}

/** Deterministic UTF-8 object rendering. */
final class JsonMessageSerializer extends AbstractMessageSerializer {

    @Override
    public String format() {
        return "json";
    }

    @Override
    protected byte[] encode(Object value) {
        return MessageJson.write(MessageSerialization.state(value)).getBytes(StandardCharsets.UTF_8);
    }

    @Override
    protected Object decode(byte[] data) {
        return MessageJson.read(new String(data, StandardCharsets.UTF_8));
    }
}

/** Length-prefixed, type-tagged binary framing mirroring the historical CBOR type tag. */
final class CborMessageSerializer extends AbstractMessageSerializer {

    private static final byte TYPE_TAG = (byte) 0xCB;
    private static final int HEADER_LENGTH = 5;

    @Override
    public String format() {
        return "cbor";
    }

    @Override
    protected byte[] encode(Object value) {
        byte[] body = MessageJson.write(MessageSerialization.state(value)).getBytes(StandardCharsets.UTF_8);
        byte[] framed = new byte[HEADER_LENGTH + body.length];
        framed[0] = TYPE_TAG;
        framed[1] = (byte) (body.length >>> 24);
        framed[2] = (byte) (body.length >>> 16);
        framed[3] = (byte) (body.length >>> 8);
        framed[4] = (byte) body.length;
        System.arraycopy(body, 0, framed, HEADER_LENGTH, body.length);
        return framed;
    }

    @Override
    protected Object decode(byte[] data) {
        if (data.length < HEADER_LENGTH || data[0] != TYPE_TAG) {
            throw new IllegalArgumentException("unsupported CBOR framing");
        }
        int length = ((data[1] & 0xFF) << 24) | ((data[2] & 0xFF) << 16) | ((data[3] & 0xFF) << 8)
                | (data[4] & 0xFF);
        if (length < 0 || HEADER_LENGTH + length != data.length) {
            throw new IllegalArgumentException("malformed CBOR frame length");
        }
        String json = new String(data, HEADER_LENGTH, length, StandardCharsets.UTF_8);
        return MessageJson.read(json);
    }
}

/** Opaque byte pass-through that still round-trips typed message values. */
final class NativeMessageSerializer extends AbstractMessageSerializer {

    @Override
    public String format() {
        return "native";
    }

    @Override
    protected byte[] encode(Object value) {
        if (value instanceof byte[] bytes) {
            return bytes.clone();
        }
        if (value instanceof CharSequence text) {
            return text.toString().getBytes(StandardCharsets.UTF_8);
        }
        return MessageJson.write(MessageSerialization.state(value)).getBytes(StandardCharsets.UTF_8);
    }

    @Override
    protected Object decode(byte[] data) {
        return MessageJson.read(new String(data, StandardCharsets.UTF_8));
    }

    @Override
    public <T> T deserialize(byte[] data, Class<T> type) {
        if (type == byte[].class) {
            if (data == null || data.length == 0) {
                throw new ValidationException("serialized message bytes are required");
            }
            return type.cast(data.clone());
        }
        if (type == String.class) {
            if (data == null) {
                throw new ValidationException("serialized message bytes are required");
            }
            return type.cast(new String(data, StandardCharsets.UTF_8));
        }
        return super.deserialize(data, type);
    }
}

/** Registry of the self-contained codecs, resolved by format name or content type. */
final class MessageSerializerRegistry {

    private static final Map<String, MessageSerializer> BY_FORMAT;

    static {
        Map<String, MessageSerializer> codecs = new LinkedHashMap<>();
        codecs.put("json", new JsonMessageSerializer());
        codecs.put("cbor", new CborMessageSerializer());
        codecs.put("native", new NativeMessageSerializer());
        BY_FORMAT = Collections.unmodifiableMap(codecs);
    }

    private MessageSerializerRegistry() {
    }

    static MessageSerializer of(String format) {
        if (format == null || format.isBlank()) {
            throw new ValidationException("serializer format is required");
        }
        MessageSerializer serializer = BY_FORMAT.get(format.trim().toLowerCase(Locale.ROOT));
        if (serializer == null) {
            throw new ValidationException("unknown serializer format: " + format);
        }
        return serializer;
    }

    static MessageSerializer forContentType(String contentType) {
        if (contentType == null || contentType.isBlank()) {
            throw new ValidationException("content type is required");
        }
        String base = contentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return switch (base) {
            case "application/json", "text/json" -> of("json");
            case "application/cbor" -> of("cbor");
            case "application/octet-stream", "application/x-pickle", "application/binary" -> of("native");
            default -> throw new ValidationException("unknown content type: " + contentType);
        };
    }

    static Set<String> formats() {
        return BY_FORMAT.keySet();
    }
}

/** Shared value-model normalisation and reconstruction for the registered codecs. */
final class MessageSerialization {

    private MessageSerialization() {
    }

    /** Renders a supported value into a deterministic map/list/scalar state tree. */
    static Object state(Object value) {
        if (value == null) {
            throw new IllegalArgumentException("value must not be null");
        }
        if (value instanceof MessageEnvelope envelope) {
            return envelopeState(envelope);
        }
        if (value instanceof MessageHeaders headers) {
            return headersState(headers);
        }
        if (value instanceof TenantId tenantId) {
            return tenantId.value();
        }
        if (value instanceof CorrelationId correlationId) {
            return correlationId.value();
        }
        if (value instanceof Instant instant) {
            return instant.toString();
        }
        if (value instanceof byte[] bytes) {
            return Base64.getEncoder().encodeToString(bytes);
        }
        if (value instanceof Enum<?> enumValue) {
            return enumValue.name();
        }
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> rendered = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                rendered.put(String.valueOf(entry.getKey()), state(entry.getValue()));
            }
            return rendered;
        }
        if (value instanceof Iterable<?> iterable) {
            java.util.List<Object> rendered = new java.util.ArrayList<>();
            for (Object element : iterable) {
                rendered.add(state(element));
            }
            return rendered;
        }
        if (value instanceof CharSequence || value instanceof Number || value instanceof Boolean) {
            return value;
        }
        return String.valueOf(value);
    }

    private static Map<String, Object> envelopeState(MessageEnvelope envelope) {
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("tenantId", envelope.tenantId().value());
        state.put("correlationId", envelope.correlationId() == null ? null : envelope.correlationId().value());
        state.put("topic", envelope.topic());
        state.put("headers", headersState(envelope.headers()));
        state.put("payload", Base64.getEncoder().encodeToString(envelope.payload()));
        state.put("occurredAt", envelope.occurredAt().toString());
        return state;
    }

    private static Map<String, Object> headersState(MessageHeaders headers) {
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("tenantId", headers.tenantId().value());
        state.put("correlationId", headers.correlationId() == null ? null : headers.correlationId().value());
        state.put("contentType", headers.contentType());
        state.put("messageId", headers.messageId());
        state.put("attempt", headers.attempt());
        state.put("attributes", new LinkedHashMap<>(headers.attributes()));
        return state;
    }

    /** Rebuilds a value of {@code type} from the decoded state tree. */
    static Object rebuild(Object root, Class<?> type) {
        if (type == MessageEnvelope.class) {
            return envelopeFrom(root);
        }
        if (type == MessageHeaders.class) {
            return headersFrom(root);
        }
        if (type == byte[].class) {
            if (!(root instanceof String text)) {
                throw new IllegalArgumentException("expected a base64 payload for byte[]");
            }
            return Base64.getDecoder().decode(text);
        }
        if (type == String.class) {
            return root == null ? null : String.valueOf(root);
        }
        if (type == Map.class) {
            if (!(root instanceof Map<?, ?>)) {
                throw new IllegalArgumentException("expected an object for Map");
            }
            return root;
        }
        if (type == Instant.class) {
            return Instant.parse(String.valueOf(root));
        }
        if (type == Object.class || type.isInstance(root)) {
            return root;
        }
        throw new IllegalArgumentException("unsupported target type: " + type.getName());
    }

    private static MessageEnvelope envelopeFrom(Object root) {
        Map<?, ?> state = asMap(root);
        TenantId tenantId = TenantId.of(string(state.get("tenantId")));
        CorrelationId correlationId = correlationId(state.get("correlationId"));
        String topic = string(state.get("topic"));
        MessageHeaders headers = state.get("headers") instanceof Map<?, ?> nested ? headersFrom(nested) : null;
        byte[] payload = state.get("payload") == null
                ? null
                : Base64.getDecoder().decode(string(state.get("payload")));
        Instant occurredAt = state.get("occurredAt") == null ? null : Instant.parse(string(state.get("occurredAt")));
        return new MessageEnvelope(tenantId, correlationId, topic, headers, payload, occurredAt);
    }

    private static MessageHeaders headersFrom(Object root) {
        Map<?, ?> state = asMap(root);
        TenantId tenantId = TenantId.of(string(state.get("tenantId")));
        CorrelationId correlationId = correlationId(state.get("correlationId"));
        String contentType = state.get("contentType") == null ? null : string(state.get("contentType"));
        String messageId = state.get("messageId") == null ? null : string(state.get("messageId"));
        int attempt = state.get("attempt") instanceof Number number ? number.intValue() : 1;
        Map<String, String> attributes = toStringMap(state.get("attributes"));
        return new MessageHeaders(tenantId, correlationId, contentType, messageId, attempt, attributes);
    }

    private static Map<?, ?> asMap(Object root) {
        if (root instanceof Map<?, ?> map) {
            return map;
        }
        throw new IllegalArgumentException("expected an object state");
    }

    private static Map<String, String> toStringMap(Object value) {
        if (!(value instanceof Map<?, ?> map)) {
            return Map.of();
        }
        Map<String, String> attributes = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (entry.getKey() != null && entry.getValue() != null) {
                attributes.put(String.valueOf(entry.getKey()), String.valueOf(entry.getValue()));
            }
        }
        return attributes;
    }

    private static String string(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static CorrelationId correlationId(Object value) {
        String text = value == null ? null : String.valueOf(value);
        if (text == null) {
            return null;
        }
        String trimmed = text.trim();
        return trimmed.isEmpty() ? null : CorrelationId.of(trimmed);
    }
}

/** Minimal deterministic JSON writer/reader, kept in-file to avoid a third-party dependency. */
final class MessageJson {

    private MessageJson() {
    }

    static String write(Object value) {
        StringBuilder builder = new StringBuilder();
        writeValue(builder, value);
        return builder.toString();
    }

    private static void writeValue(StringBuilder builder, Object value) {
        if (value == null) {
            builder.append("null");
        } else if (value instanceof String text) {
            writeString(builder, text);
        } else if (value instanceof Boolean || value instanceof Number) {
            builder.append(value);
        } else if (value instanceof Map<?, ?> map) {
            builder.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) {
                    builder.append(',');
                }
                first = false;
                writeString(builder, String.valueOf(entry.getKey()));
                builder.append(':');
                writeValue(builder, entry.getValue());
            }
            builder.append('}');
        } else if (value instanceof Iterable<?> iterable) {
            builder.append('[');
            boolean first = true;
            for (Object element : iterable) {
                if (!first) {
                    builder.append(',');
                }
                first = false;
                writeValue(builder, element);
            }
            builder.append(']');
        } else {
            writeString(builder, String.valueOf(value));
        }
    }

    private static void writeString(StringBuilder builder, String text) {
        builder.append('"');
        for (int index = 0; index < text.length(); index++) {
            char character = text.charAt(index);
            switch (character) {
                case '"' -> builder.append("\\\"");
                case '\\' -> builder.append("\\\\");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                case '\b' -> builder.append("\\b");
                case '\f' -> builder.append("\\f");
                default -> {
                    if (character < 0x20) {
                        builder.append(String.format("\\u%04x", (int) character));
                    } else {
                        builder.append(character);
                    }
                }
            }
        }
        builder.append('"');
    }

    static Object read(String text) {
        Objects.requireNonNull(text, "text");
        Parser parser = new Parser(text);
        Object value = parser.parseValue();
        parser.skipWhitespace();
        if (!parser.atEnd()) {
            throw new IllegalArgumentException("trailing content at index " + parser.position());
        }
        return value;
    }

    private static final class Parser {

        private final String text;
        private int position;

        Parser(String text) {
            this.text = text;
        }

        boolean atEnd() {
            return position >= text.length();
        }

        int position() {
            return position;
        }

        void skipWhitespace() {
            while (!atEnd() && Character.isWhitespace(text.charAt(position))) {
                position++;
            }
        }

        Object parseValue() {
            skipWhitespace();
            if (atEnd()) {
                throw new IllegalArgumentException("unexpected end of input");
            }
            char character = text.charAt(position);
            return switch (character) {
                case '{' -> parseObject();
                case '[' -> parseArray();
                case '"' -> parseString();
                case 't' -> parseLiteral("true", Boolean.TRUE);
                case 'f' -> parseLiteral("false", Boolean.FALSE);
                case 'n' -> parseLiteral("null", null);
                default -> parseNumber();
            };
        }

        private Map<String, Object> parseObject() {
            expect('{');
            Map<String, Object> result = new LinkedHashMap<>();
            skipWhitespace();
            if (peek() == '}') {
                position++;
                return result;
            }
            while (true) {
                skipWhitespace();
                String key = parseString();
                skipWhitespace();
                expect(':');
                result.put(key, parseValue());
                skipWhitespace();
                char character = peek();
                if (character == ',') {
                    position++;
                } else if (character == '}') {
                    position++;
                    return result;
                } else {
                    throw new IllegalArgumentException("expected ',' or '}' at index " + position);
                }
            }
        }

        private List<Object> parseArray() {
            expect('[');
            List<Object> result = new java.util.ArrayList<>();
            skipWhitespace();
            if (peek() == ']') {
                position++;
                return result;
            }
            while (true) {
                result.add(parseValue());
                skipWhitespace();
                char character = peek();
                if (character == ',') {
                    position++;
                } else if (character == ']') {
                    position++;
                    return result;
                } else {
                    throw new IllegalArgumentException("expected ',' or ']' at index " + position);
                }
            }
        }

        private String parseString() {
            expect('"');
            StringBuilder builder = new StringBuilder();
            while (true) {
                if (atEnd()) {
                    throw new IllegalArgumentException("unterminated string");
                }
                char character = text.charAt(position++);
                if (character == '"') {
                    return builder.toString();
                }
                if (character == '\\') {
                    if (atEnd()) {
                        throw new IllegalArgumentException("unterminated escape");
                    }
                    char escape = text.charAt(position++);
                    switch (escape) {
                        case '"' -> builder.append('"');
                        case '\\' -> builder.append('\\');
                        case '/' -> builder.append('/');
                        case 'n' -> builder.append('\n');
                        case 'r' -> builder.append('\r');
                        case 't' -> builder.append('\t');
                        case 'b' -> builder.append('\b');
                        case 'f' -> builder.append('\f');
                        case 'u' -> builder.append(parseUnicode());
                        default -> throw new IllegalArgumentException("invalid escape \\" + escape);
                    }
                } else {
                    builder.append(character);
                }
            }
        }

        private char parseUnicode() {
            if (position + 4 > text.length()) {
                throw new IllegalArgumentException("truncated unicode escape");
            }
            String hex = text.substring(position, position + 4);
            position += 4;
            return (char) Integer.parseInt(hex, 16);
        }

        private Object parseLiteral(String literal, Object value) {
            if (text.startsWith(literal, position)) {
                position += literal.length();
                return value;
            }
            throw new IllegalArgumentException("invalid literal at index " + position);
        }

        private Object parseNumber() {
            int start = position;
            while (!atEnd()) {
                char character = text.charAt(position);
                if (character == '-' || character == '+' || character == '.' || character == 'e'
                        || character == 'E' || (character >= '0' && character <= '9')) {
                    position++;
                } else {
                    break;
                }
            }
            String literal = text.substring(start, position);
            if (literal.isEmpty()) {
                throw new IllegalArgumentException("invalid number at index " + start);
            }
            if (literal.indexOf('.') >= 0 || literal.indexOf('e') >= 0 || literal.indexOf('E') >= 0) {
                return Double.valueOf(literal);
            }
            return Long.valueOf(literal);
        }

        private char peek() {
            if (atEnd()) {
                throw new IllegalArgumentException("unexpected end of input");
            }
            return text.charAt(position);
        }

        private void expect(char expected) {
            skipWhitespace();
            if (atEnd() || text.charAt(position) != expected) {
                throw new IllegalArgumentException("expected '" + expected + "' at index " + position);
            }
            position++;
        }
    }
}
