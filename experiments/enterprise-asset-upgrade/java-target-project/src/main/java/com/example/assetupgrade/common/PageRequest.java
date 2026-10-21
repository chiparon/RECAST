package com.example.assetupgrade.common;

import java.util.Objects;

/**
 * Vendor-neutral offset/cursor paging request.
 *
 * <p>The record components are part of the public contract; validation and derived
 * factory helpers are added here.</p>
 */
public record PageRequest(int offset, int limit, String cursor) {

    public PageRequest {
        if (offset < 0) {
            throw new IllegalArgumentException("offset must be >= 0 but was " + offset);
        }
        if (limit <= 0) {
            throw new IllegalArgumentException("limit must be > 0 but was " + limit);
        }
        if (cursor != null && cursor.isBlank()) {
            cursor = null;
        }
    }

    /** Creates the first page request with no cursor. */
    public static PageRequest firstPage(int limit) {
        return new PageRequest(0, limit, null);
    }

    /** Creates the page following {@code previous}, advancing the offset and cursor. */
    public static PageRequest nextPage(PageRequest previous, String nextCursor) {
        Objects.requireNonNull(previous, "previous");
        long nextOffset = (long) previous.offset() + previous.limit();
        if (nextOffset > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("next page offset overflows int: " + nextOffset);
        }
        return new PageRequest((int) nextOffset, previous.limit(), nextCursor);
    }

    /** @return {@code true} when a continuation cursor is present. */
    public boolean hasCursor() {
        return cursor != null;
    }
}
