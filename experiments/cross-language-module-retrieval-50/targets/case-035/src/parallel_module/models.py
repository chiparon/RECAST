"""Domain data for this module."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass
class RelationalIdentityPersistenceData:
    """为身份管理模型提供关系数据库持久化，使用实体和适配器管理用户、凭据、realm、角色及认证会话，处理实体键与过期会话。"""
    realm_id: str
    user_id: str
    username: str
    session_expires_at: int
