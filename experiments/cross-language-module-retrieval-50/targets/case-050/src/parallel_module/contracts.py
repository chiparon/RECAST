"""管理仓库主数据，按标识或名称查询、创建、更新和删除仓库，并利用仓库地址与目的地址查找最近的仓库。"""
from __future__ import annotations
from typing import Protocol
from .models import FulfillmentWarehouseDirectoryData

class FulfillmentWarehouseDirectoryContract(Protocol):
    def get_warehouse(self, warehouse_id: int) -> FulfillmentWarehouseDirectoryData:
        ...

    def list_warehouses(self, name: str) -> list[FulfillmentWarehouseDirectoryData]:
        ...

    def insert_warehouse(self, warehouse: FulfillmentWarehouseDirectoryData) -> None:
        ...

    def update_warehouse(self, warehouse: FulfillmentWarehouseDirectoryData) -> None:
        ...

    def delete_warehouse(self, warehouse: FulfillmentWarehouseDirectoryData) -> None:
        ...

    def nearest_warehouse(self, address: FulfillmentWarehouseDirectoryData, warehouses: list[FulfillmentWarehouseDirectoryData]) -> FulfillmentWarehouseDirectoryData:
        ...

