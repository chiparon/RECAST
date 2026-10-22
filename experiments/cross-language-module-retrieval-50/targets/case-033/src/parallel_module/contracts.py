"""将单个 realm 或全部 realm 身份配置导出为一个 JSON 文件，并从单文件恢复模型。提供文件路径、realm 筛选和导入策略配置，以及导入导出提供者工厂生命周期。"""
from __future__ import annotations
from typing import Protocol
from .models import RealmSingleDocumentTransferData

class RealmSingleDocumentTransferContract(Protocol):
    def export_model(self, file_path: str, realm_name: str) -> None:
        ...

    def import_model(self, file_path: str, strategy: str) -> None:
        ...

    def close(self) -> None:
        ...

