package parallelmodule;

import java.util.*;
import java.math.BigDecimal;

/** 定义后台结账属性的编辑、列表和搜索模型。包含名称、提示文本、必填、税务、控件类型和显示顺序，支持长度与上传文件限制、条件属性及多语言值。 */
public final class Models {
    public static final class CheckoutAttribute {
        public int attribute_id;
        public String name;
        public String text_prompt;
        public boolean is_required;
        public int tax_category_id;
        public int control_type;
        public int display_order;
        public int minimum_length;
        public int maximum_length;
        public List<String> allowed_extensions;
        public Map<String, String> localized_values;
    }
    public static final class CheckoutAttributeValue {
        public int value_id;
        public int attribute_id;
        public String name;
        public BigDecimal price_adjustment;
        public int display_order;
        public Map<String, String> localized_values;
    }
}
