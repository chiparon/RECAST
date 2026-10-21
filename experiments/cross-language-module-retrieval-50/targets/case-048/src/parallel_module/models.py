"""Domain data for this module."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass
class PriceListCacheInvalidationData:
    """在价格表本身、价格表与客户的关联或价格表与客户角色的关联发生变更时，统一清理价格表缓存前缀，防止价格列表查询返回旧结果。"""
    price_list_id: int
    customer_id: int
    customer_role_id: int
    event_type: str
