package parallelmodule;

import java.util.*;
import java.math.BigDecimal;

/** 后台短信功能先跳转到提供商列表，再展示和搜索已安装提供商，并按提供商系统标识选择主短信提供商。 */
public final class Models {
    public static final class MessagingProviderAdministrationData {
        public String system_name;
        public String friendly_name;
        public boolean primary;
        public boolean installed;
    }
}
