package parallelmodule;

import java.util.*;
import java.math.BigDecimal;

/** 定义后台订单项与向订单添加商品的搜索、列表和编辑模型，表达商品与 SKU、数量、含税及未税单价、折扣、小计、商品属性和礼品卡关联。 */
public final class Models {
    public static final class OrderLine {
        public int order_item_id;
        public int product_id;
        public String sku;
        public int quantity;
        public BigDecimal unit_price_incl_tax;
        public BigDecimal unit_price_excl_tax;
        public BigDecimal discount;
        public BigDecimal subtotal;
        public Map<String, String> attributes;
        public List<Integer> gift_card_ids;
    }
    public static final class ProductAddition {
        public int product_id;
        public int order_id;
        public int quantity;
        public BigDecimal unit_price_incl_tax;
        public BigDecimal unit_price_excl_tax;
        public Map<String, String> attributes;
    }
}
