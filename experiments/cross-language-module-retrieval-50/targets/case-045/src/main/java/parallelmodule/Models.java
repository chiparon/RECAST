package parallelmodule;

import java.util.*;
import java.math.BigDecimal;

/** 管理客户对缺货商品的到货订阅，按客户、商品和店铺查找与分页查询订阅，创建或删除订阅，并在商品恢复库存时向订阅者发送通知。 */
public final class Models {
    public static final class InventoryRestockSubscriptionsData {
        public int subscription_id;
        public int customer_id;
        public int product_id;
        public int store_id;
    }
}
