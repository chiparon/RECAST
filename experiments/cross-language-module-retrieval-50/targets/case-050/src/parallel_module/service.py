"""管理仓库主数据，按标识或名称查询、创建、更新和删除仓库，并利用仓库地址与目的地址查找最近的仓库。"""
from __future__ import annotations
from .contracts import FulfillmentWarehouseDirectoryContract
from .models import FulfillmentWarehouseDirectoryData

class FulfillmentWarehouseDirectory(FulfillmentWarehouseDirectoryContract):
    def get_warehouse(self, warehouse_id: int) -> FulfillmentWarehouseDirectoryData:
        raise NotImplementedError("Business implementation pending")

    def list_warehouses(self, name: str) -> list[FulfillmentWarehouseDirectoryData]:
        raise NotImplementedError("Business implementation pending")

    def insert_warehouse(self, warehouse: FulfillmentWarehouseDirectoryData) -> None:
        raise NotImplementedError("Business implementation pending")

    def update_warehouse(self, warehouse: FulfillmentWarehouseDirectoryData) -> None:
        raise NotImplementedError("Business implementation pending")

    def delete_warehouse(self, warehouse: FulfillmentWarehouseDirectoryData) -> None:
        raise NotImplementedError("Business implementation pending")

    def nearest_warehouse(self, address: FulfillmentWarehouseDirectoryData, warehouses: list[FulfillmentWarehouseDirectoryData]) -> FulfillmentWarehouseDirectoryData:
        raise NotImplementedError("Business implementation pending")

