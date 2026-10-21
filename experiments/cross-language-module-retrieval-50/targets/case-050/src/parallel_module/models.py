"""Domain data for this module."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass
class FulfillmentWarehouseDirectoryData:
    """管理仓库主数据，按标识或名称查询、创建、更新和删除仓库，并利用仓库地址与目的地址查找最近的仓库。"""
    warehouse_id: int
    name: str
    address_id: int
    latitude: float
    longitude: float
