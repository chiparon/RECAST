"""通过可插拔用户存储管理用户及其凭据，兼容本地与联邦用户。验证和更新凭据、管理缓存用户模型，并提供存储提供者配置与查找能力。"""
from __future__ import annotations
from typing import Protocol
from .models import FederatedIdentityStorageData

class FederatedIdentityStorageContract(Protocol):
    def validate_credentials(self, user: FederatedIdentityStorageData, inputs: list[FederatedIdentityStorageData]) -> bool:
        ...

    def update_credential(self, user: FederatedIdentityStorageData, credential: FederatedIdentityStorageData) -> bool:
        ...

    def resolve_provider(self, provider_id: str) -> object:
        ...

