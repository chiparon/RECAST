"""构建结束后修正 vendor 输出文件中的模块导入路径。按明确的文件、查找文本和替换文本改写内容，并将结果写回相应构建产物。"""
from __future__ import annotations
from typing import Protocol
from .models import VendorBundleImportRewritingData

class VendorBundleImportRewritingContract(Protocol):
    def replace_contents(self, file_path: str, search: str, replacement: str) -> None:
        ...

