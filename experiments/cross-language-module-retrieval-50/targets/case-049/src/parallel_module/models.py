"""Domain data for this module."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass
class InstallationDemoDataLoadingData:
    """在安装阶段装载示例客户、目录分类、属性和商品数据，关联默认语言和店铺，导入示例图片并创建搜索引擎友好名称。"""
    language_id: int
    store_id: int
    sample_file: str
    image_directory: str
