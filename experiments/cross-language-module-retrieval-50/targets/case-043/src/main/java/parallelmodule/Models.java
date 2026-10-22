package parallelmodule;

import java.util.*;
import java.math.BigDecimal;

/** 定义运费报价的请求与响应模型。请求包含客户、包裹商品、数量覆盖、目的地址和发货仓库地址及店铺；响应包含运输选项与错误信息。 */
public final class Models {
    public static final class PackageItem {
        public int product_id;
        public int shopping_cart_item_id;
        public int quantity;
        public Integer overridden_quantity;
    }
    public static final class ShippingQuoteRequest {
        public int customer_id;
        public int store_id;
        public Map<String, String> shipping_address;
        public int warehouse_id;
        public List<PackageItem> items;
    }
    public static final class ShippingOption {
        public String name;
        public String description;
        public BigDecimal rate;
    }
    public static final class ShippingQuoteResponse {
        public List<ShippingOption> shipping_options;
        public List<String> errors;
    }
}
