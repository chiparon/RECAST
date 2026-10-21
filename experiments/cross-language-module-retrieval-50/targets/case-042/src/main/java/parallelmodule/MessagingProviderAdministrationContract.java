package parallelmodule;

import java.util.*;
import java.math.BigDecimal;
import parallelmodule.Models.*;

/** 后台短信功能先跳转到提供商列表，再展示和搜索已安装提供商，并按提供商系统标识选择主短信提供商。 */
public interface MessagingProviderAdministrationContract {
    String list_entry();
    List<MessagingProviderAdministrationData> get_providers(MessagingProviderAdministrationData search);
    void mark_primary(String system_name);
}
