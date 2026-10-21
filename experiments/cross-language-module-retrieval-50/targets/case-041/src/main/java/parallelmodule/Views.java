package parallelmodule;

import java.util.*;
import java.math.BigDecimal;
import parallelmodule.Models.BlogComment;

public final class Views {
    public static final class SearchView { public String search_text; public int page_index; public int page_size; }
    public static final class ListView { public List<BlogComment> items; public int total_count; }
}
