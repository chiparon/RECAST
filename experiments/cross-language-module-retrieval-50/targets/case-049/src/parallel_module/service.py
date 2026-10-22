"""在安装阶段装载示例客户、目录分类、属性和商品数据，关联默认语言和店铺，导入示例图片并创建搜索引擎友好名称。"""
from __future__ import annotations
from .contracts import InstallationDemoDataLoadingContract
from .models import InstallationDemoDataLoadingData

class InstallationDemoDataLoading(InstallationDemoDataLoadingContract):
    def install_sample_customers(self, customers: list[InstallationDemoDataLoadingData]) -> None:
        raise NotImplementedError("Business implementation pending")

    def install_categories(self, categories: list[InstallationDemoDataLoadingData]) -> None:
        raise NotImplementedError("Business implementation pending")

    def install_products(self, products: list[InstallationDemoDataLoadingData]) -> None:
        raise NotImplementedError("Business implementation pending")

    def insert_sample_picture(self, filename: str, name: str) -> int:
        raise NotImplementedError("Business implementation pending")

