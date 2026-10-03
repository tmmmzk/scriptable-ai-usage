from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Config:
    api_key: str
    data_dir: str
    host: str
    port: int
    poll_interval: int
    min_refresh_interval: int
    antigravity_client_id: Optional[str]
    antigravity_client_secret: Optional[str]
    antigravity_redirect_uri: str
    codex_redirect_uri: str


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value or default


def load() -> Config:
    api_key = _env("AIUSAGE_API_KEY")
    if not api_key or len(api_key) < 16:
        raise SystemExit("AIUSAGE_API_KEY 환경변수를 16자 이상으로 설정하세요. (예: openssl rand -hex 32)")
    return Config(
        api_key=api_key,
        data_dir=_env("AIUSAGE_DATA_DIR", "./data"),
        host=_env("AIUSAGE_HOST", "127.0.0.1"),
        port=int(_env("AIUSAGE_PORT", "8787")),
        poll_interval=max(60, int(_env("AIUSAGE_POLL_INTERVAL", "300"))),
        min_refresh_interval=max(10, int(_env("AIUSAGE_MIN_REFRESH_INTERVAL", "60"))),
        antigravity_client_id=_env("ANTIGRAVITY_OAUTH_CLIENT_ID"),
        antigravity_client_secret=_env("ANTIGRAVITY_OAUTH_CLIENT_SECRET"),
        antigravity_redirect_uri=_env("ANTIGRAVITY_REDIRECT_URI", "http://127.0.0.1:8585/callback"),
        codex_redirect_uri=_env("CODEX_REDIRECT_URI", "http://localhost:1455/auth/callback"),
    )
