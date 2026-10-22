"""为身份管理模型提供关系数据库持久化，使用实体和适配器管理用户、凭据、realm、角色及认证会话，处理实体键与过期会话。"""
from __future__ import annotations
from typing import Protocol
from .models import RelationalIdentityPersistenceData

class RelationalIdentityPersistenceContract(Protocol):
    def add_user(self, realm_id: str, username: str) -> RelationalIdentityPersistenceData:
        ...

    def find_user(self, realm_id: str, user_id: str) -> RelationalIdentityPersistenceData:
        ...

    def remove_user(self, realm_id: str, user_id: str) -> bool:
        ...

    def remove_expired_sessions(self, now: int) -> None:
        ...

