package parallelmodule;

import java.util.*;
import java.math.BigDecimal;

/** 为后台分类、制造商和主题模板提供列表、新增、编辑及删除入口。检查输入模型和管理权限，并防止删除某一模板类别中最后一个可用模板。 */
public final class Models {
    public static final class DisplayTemplateAdministrationData {
        public int template_id;
        public String template_type;
        public String name;
        public String view_path;
        public int display_order;
    }
}
