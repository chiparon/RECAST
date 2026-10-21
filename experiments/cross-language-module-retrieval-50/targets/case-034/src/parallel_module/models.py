"""Domain data for this module."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass
class FederatedIdentityStorageData:
    """通过可插拔用户存储管理用户及其凭据，兼容本地与联邦用户。验证和更新凭据、管理缓存用户模型，并提供存储提供者配置与查找能力。"""
    realm_id: str
    user_id: str
    federation_link: str
    credential_type: str
