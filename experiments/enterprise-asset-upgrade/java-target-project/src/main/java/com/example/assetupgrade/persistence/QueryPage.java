package com.example.assetupgrade.persistence;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Function;

/**
 * Immutable, offset/page-result carrier for tenant-scoped queries.
 *
 * <p>The generic shape mirrors the shared paging conventions: {@code items} are defensively copied,
 * {@code offset} must be non-negative, {@code limit} must be positive and a blank {@code nextCursor}
 * normalises to {@code null}. {@link #map(Function)} preserves offset, limit and continuation
 * metadata while retyping the elements.</p>
 *
 * @param <T> element type
 * @param items      the page elements, never {@code null}
 * @param offset     the zero-based offset of the first element, at least {@code 0}
 * @param limit      the requested page size, greater than {@code 0}
 * @param hasMore    whether a further page exists
 * @param nextCursor the continuation cursor, may be {@code null}
 */
public record QueryPage<T>(List<T> items, int offset, int limit, boolean hasMore, String nextCursor) {

    public QueryPage {
        if (offset < 0) {
            throw new IllegalArgumentException("offset must be >= 0 but was " + offset);
        }
        if (limit <= 0) {
            throw new IllegalArgumentException("limit must be > 0 but was " + limit);
        }
        items = items == null ? List.of() : List.copyOf(items);
        if (nextCursor != null && nextCursor.isBlank()) {
            nextCursor = null;
        }
    }

    /** Creates an empty terminal page. */
    public static <T> QueryPage<T> empty(int limit) {
        return new QueryPage<>(List.of(), 0, limit, false, null);
    }

    /** Creates an empty terminal page with a single-element capacity. */
    public static <T> QueryPage<T> empty() {
        return new QueryPage<>(List.of(), 0, 1, false, null);
    }

    /** Creates a page, defensively copying {@code items}. */
    public static <T> QueryPage<T> of(List<T> items, int offset, int limit, boolean hasMore, String nextCursor) {
        return new QueryPage<>(items, offset, limit, hasMore, nextCursor);
    }

    /** Maps every element while preserving offset, limit, cursor and continuation metadata. */
    public <R> QueryPage<R> map(Function<? super T, ? extends R> mapper) {
        Objects.requireNonNull(mapper, "mapper");
        List<R> mapped = new ArrayList<>(items.size());
        for (T item : items) {
            mapped.add(mapper.apply(item));
        }
        return new QueryPage<>(mapped, offset, limit, hasMore, nextCursor);
    }

    /** @return the offset of the page following this one. */
    public int nextOffset() {
        return offset + limit;
    }
}
