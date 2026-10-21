package parallelmodule;

import java.util.*;
import java.math.BigDecimal;
import parallelmodule.Models.*;

/** 从远程 XML feed 获取扩展市场的类别、版本和插件数据。插件列表支持类别、版本、价格和搜索文本筛选，并按页返回结果。 */
public interface ExtensionMarketplaceFeedContract {
    List<ExtensionMarketplaceFeedData> get_categories();
    List<ExtensionMarketplaceFeedData> get_versions();
    List<ExtensionMarketplaceFeedData> get_plugins(ExtensionMarketplaceFeedData filter);
}
