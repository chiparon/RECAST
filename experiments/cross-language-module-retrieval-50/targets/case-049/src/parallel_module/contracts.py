"""在安装阶段装载示例客户、目录分类、属性和商品数据，关联默认语言和店铺，导入示例图片并创建搜索引擎友好名称。"""
from __future__ import annotations
from typing import Protocol
from .models import InstallationDemoDataLoadingData

class InstallationDemoDataLoadingContract(Protocol):
    def install_sample_customers(self, customers: list[InstallationDemoDataLoadingData]) -> None:
        ...

    def install_categories(self, categories: list[InstallationDemoDataLoadingData]) -> None:
        ...

    def install_products(self, products: list[InstallationDemoDataLoadingData]) -> None:
        ...

    def insert_sample_picture(self, filename: str, name: str) -> int:
        ...

