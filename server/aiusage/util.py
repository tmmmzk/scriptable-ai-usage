from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Optional


def now() -> float:
    return time.time()


def iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: Any) -> Optional[float]:
    """ISO-8601 문자열을 epoch 초로. 소수점 자릿수가 긴 값(나노초)도 처리한다."""
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip().replace("Z", "+00:00")
    raw = re.sub(r"(\.\d{6})\d+", r"\1", raw)
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def pkce_pair() -> tuple[str, str]:
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def jwt_claims(token: Optional[str]) -> dict:
    """서명 검증 없이 JWT payload 만 읽는다(표시·만료 계산용)."""
    if not token or token.count(".") < 2:
        return {}
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
    except (ValueError, json.JSONDecodeError):
        return {}


def to_float(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def clamp_pct(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return round(max(0.0, min(100.0, value)), 1)


def window_label(seconds: Optional[int]) -> str:
    if not seconds:
        return "?"
    if seconds % 86400 == 0:
        days = seconds // 86400
        return "주간" if days == 7 else f"{days}일"
    hours = round(seconds / 3600)
    return f"{hours}시간"
