package parallelmodule;

import java.util.*;
import java.math.BigDecimal;
import parallelmodule.Models.*;

/** 管理客户对缺货商品的到货订阅，按客户、商品和店铺查找与分页查询订阅，创建或删除订阅，并在商品恢复库存时向订阅者发送通知。 */
public interface InventoryRestockSubscriptionsContract {
    InventoryRestockSubscriptionsData find_subscription(int customer_id, int product_id, int store_id);
    void insert_subscription(InventoryRestockSubscriptionsData subscription);
    void delete_subscription(InventoryRestockSubscriptionsData subscription);
    int notify_subscribers(InventoryRestockSubscriptionsData product);
}
