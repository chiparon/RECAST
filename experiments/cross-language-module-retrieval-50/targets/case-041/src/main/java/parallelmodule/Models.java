package parallelmodule;

import java.util.*;
import java.math.BigDecimal;

/** 定义后台博客文章与评论的展示、分页和搜索模型。评论携带文章、客户、店铺、审批状态、正文和创建时间，文章模型包含语言与内容信息。 */
public final class Models {
    public static final class BlogComment {
        public int comment_id;
        public int blog_post_id;
        public int customer_id;
        public String comment;
        public boolean is_approved;
        public int store_id;
        public String created_on;
    }
    public static final class BlogPost {
        public int post_id;
        public String title;
        public String body;
        public int language_id;
        public boolean allow_comments;
        public int approved_comment_count;
    }
}
