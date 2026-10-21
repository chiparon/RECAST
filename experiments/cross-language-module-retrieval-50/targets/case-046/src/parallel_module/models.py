"""Domain data for this module."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass
class DownloadRecordPersistenceData:
    """管理下载记录，支持按数字 ID 或 GUID 查询、插入与删除记录，以及从上传文件输入中读取下载字节数据。"""
    download_id: int
    download_guid: str
    filename: str
    content_type: str
    content: bytes
