"""在价格表本身、价格表与客户的关联或价格表与客户角色的关联发生变更时，统一清理价格表缓存前缀，防止价格列表查询返回旧结果。"""
from __future__ import annotations
from typing import Protocol
from .models import PriceListCacheInvalidationData

class PriceListCacheInvalidationContract(Protocol):
    def on_price_list_changed(self, entity: PriceListCacheInvalidationData) -> None:
        ...

    def on_customer_mapping_changed(self, entity: PriceListCacheInvalidationData) -> None:
        ...

    def on_role_mapping_changed(self, entity: PriceListCacheInvalidationData) -> None:
        ...

