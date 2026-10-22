package parallelmodule;

import java.util.*;
import java.math.BigDecimal;
import parallelmodule.Models.*;

/** 为后台分类、制造商和主题模板提供列表、新增、编辑及删除入口。检查输入模型和管理权限，并防止删除某一模板类别中最后一个可用模板。 */
public final class DisplayTemplateAdministration implements DisplayTemplateAdministrationContract {
    @Override public List<DisplayTemplateAdministrationData> list_templates(String template_type, DisplayTemplateAdministrationData search) { throw new UnsupportedOperationException("Business implementation pending"); }
    @Override public DisplayTemplateAdministrationData add_template(DisplayTemplateAdministrationData model) { throw new UnsupportedOperationException("Business implementation pending"); }
    @Override public void update_template(DisplayTemplateAdministrationData model) { throw new UnsupportedOperationException("Business implementation pending"); }
    @Override public void delete_template(String template_type, int template_id) { throw new UnsupportedOperationException("Business implementation pending"); }
}
