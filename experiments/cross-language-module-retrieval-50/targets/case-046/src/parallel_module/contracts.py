"""管理下载记录，支持按数字 ID 或 GUID 查询、插入与删除记录，以及从上传文件输入中读取下载字节数据。"""
from __future__ import annotations
from typing import Protocol
from .models import DownloadRecordPersistenceData

class DownloadRecordPersistenceContract(Protocol):
    def get_by_id(self, download_id: int) -> DownloadRecordPersistenceData:
        ...

    def get_by_guid(self, download_guid: str) -> DownloadRecordPersistenceData:
        ...

    def insert_download(self, download: DownloadRecordPersistenceData) -> None:
        ...

    def delete_download(self, download: DownloadRecordPersistenceData) -> None:
        ...

    def read_upload(self, stream: object) -> bytes:
        ...

