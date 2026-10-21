"""提供可由身份认证流程调用的脚本步骤入口，根据用户与认证上下文检查结果，向宿主报告成功或无效用户失败，并记录认证跟踪信息。"""
from __future__ import annotations
from typing import Protocol
from .models import ScriptedAuthenticationStepData

class ScriptedAuthenticationStepContract(Protocol):
    def authenticate(self, context: ScriptedAuthenticationStepData) -> None:
        ...

