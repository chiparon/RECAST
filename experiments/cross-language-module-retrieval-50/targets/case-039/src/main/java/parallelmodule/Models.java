package parallelmodule;

import java.util.*;
import java.math.BigDecimal;

/** 从远程 XML feed 获取扩展市场的类别、版本和插件数据。插件列表支持类别、版本、价格和搜索文本筛选，并按页返回结果。 */
public final class Models {
    public static final class ExtensionMarketplaceFeedData {
        public int category_id;
        public int version_id;
        public int price;
        public String search_term;
        public int page_index;
        public int page_size;
    }
}
