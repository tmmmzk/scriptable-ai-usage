from __future__ import annotations

from .antigravity import AntigravityProvider
from .base import Provider
from .claude import ClaudeProvider
from .codex import CodexProvider

# 새 서비스를 추가하려면 Provider 를 구현하고 여기에 등록하면 된다.
PROVIDERS: dict[str, Provider] = {
    p.id: p for p in (ClaudeProvider(), CodexProvider(), AntigravityProvider())
}


def get(provider_id: str) -> Provider | None:
    return PROVIDERS.get(provider_id)
