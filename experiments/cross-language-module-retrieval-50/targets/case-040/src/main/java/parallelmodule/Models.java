package parallelmodule;

import java.util.*;
import java.math.BigDecimal;

/** 提供电商实体的角色访问控制、权限配置、加密解密和密码哈希服务。访问控制可用于实体授权及查询过滤，相关实体或权限变更应清理安全缓存。 */
public final class Models {
    public static final class CommerceSecurityServicesData {
        public int entity_id;
        public String entity_name;
        public int customer_id;
        public List<Integer> allowed_role_ids;
        public String encryption_key;
    }
}
