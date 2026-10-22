package parallelmodule;

import java.util.*;
import java.math.BigDecimal;
import parallelmodule.Models.*;

/** 提供电商实体的角色访问控制、权限配置、加密解密和密码哈希服务。访问控制可用于实体授权及查询过滤，相关实体或权限变更应清理安全缓存。 */
public interface CommerceSecurityServicesContract {
    boolean authorize(CommerceSecurityServicesData entity, CommerceSecurityServicesData customer);
    List<CommerceSecurityServicesData> apply_acl(List<CommerceSecurityServicesData> entities, List<Integer> role_ids);
    String encrypt_text(String plaintext, String key);
    String decrypt_text(String ciphertext, String key);
    String hash_password(String password, String salt);
}
