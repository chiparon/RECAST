package com.example.assetupgrade.common;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Function;

/**
 * Vendor-neutral page of results.
 *
 * <p>The generic record shape is part of the public contract; defensive copying and
 * mapping helpers are added here.</p>
 *
 * @param <T> element type
 */
public record PageResult<T>(List<T> items, String nextCursor, boolean hasMore) {

    public PageResult {
        items = items == null ? List.of() : List.copyOf(items);
        if (nextCursor != null && nextCursor.isBlank()) {
            nextCursor = null;
        }
    }

    /** Creates an empty terminal page. */
    public static <T> PageResult<T> empty() {
        return new PageResult<>(List.of(), null, false);
    }

    /** Creates a page result, defensively copying {@code items}. */
    public static <T> PageResult<T> of(List<T> items, String nextCursor, boolean hasMore) {
        return new PageResult<>(items, nextCursor, hasMore);
    }

    /** Maps every element while preserving cursor and continuation metadata. */
    public <R> PageResult<R> map(Function<? super T, ? extends R> mapper) {
        Objects.requireNonNull(mapper, "mapper");
        List<R> mapped = new ArrayList<>(items.size());
        for (T item : items) {
            mapped.add(mapper.apply(item));
        }
        return new PageResult<>(mapped, nextCursor, hasMore);
    }
}
