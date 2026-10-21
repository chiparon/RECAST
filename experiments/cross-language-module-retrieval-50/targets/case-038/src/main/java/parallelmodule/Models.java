package parallelmodule;

import java.util.*;
import java.math.BigDecimal;

/** 定义插件描述符和生命周期契约，包括插件标识、版本、支持的系统版本、安装、卸载、升级以及配置页面地址。提供加载模式与不兼容信息的模型。 */
public final class Models {
    public static final class ExtensionPluginContractsData {
        public String system_name;
        public String friendly_name;
        public String version;
        public List<String> supported_versions;
        public boolean installed;
    }
}
