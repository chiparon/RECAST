package parallelmodule;

import java.util.*;
import java.math.BigDecimal;
import parallelmodule.Models.*;

/** 定义插件描述符和生命周期契约，包括插件标识、版本、支持的系统版本、安装、卸载、升级以及配置页面地址。提供加载模式与不兼容信息的模型。 */
public final class ExtensionPluginContracts implements ExtensionPluginContractsContract {
    @Override public void install() { throw new UnsupportedOperationException("Business implementation pending"); }
    @Override public void uninstall() { throw new UnsupportedOperationException("Business implementation pending"); }
    @Override public void update(String current_version, String target_version) { throw new UnsupportedOperationException("Business implementation pending"); }
    @Override public String configuration_url() { throw new UnsupportedOperationException("Business implementation pending"); }
}
