from __future__ import annotations

import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from ..config import Config
from ..errors import LoginError
from ..util import iso

SaveCreds = Callable[[dict], None]


@dataclass
class LoginStart:
    authorize_url: str
    instructions: str
    input_hint: str
    pending: dict  # 서버 메모리에만 보관(verifier, state 등)


@dataclass
class LoginResult:
    creds: dict
    email: Optional[str] = None
    plan: Optional[str] = None


@dataclass
class Usage:
    """서비스별 응답을 공통 형식으로 정규화한 결과."""

    windows: list[dict] = field(default_factory=list)
    reset_credits: Optional[dict] = None
    plan: Optional[str] = None
    email: Optional[str] = None
    extra: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def make_window(
    key: str,
    label: str,
    used_percent: Optional[float],
    resets_at: Optional[str],
    *,
    window_seconds: Optional[int] = None,
    group: Optional[str] = None,
    primary: bool = False,
) -> dict:
    return {
        "key": key,
        "label": label,
        "group": group,
        "used_percent": used_percent,
        "remaining_percent": None if used_percent is None else round(100 - used_percent, 1),
        "resets_at": resets_at,
        "window_seconds": window_seconds,
        "primary": primary,
    }


def reset_credit(expires: Optional[float], granted: Optional[float] = None, *, title: Any = None,
                 description: Any = None, reset_type: Any = None) -> tuple[Optional[float], dict]:
    """초기화권 한 장. (정렬용 만료 epoch, 응답용 dict). 사용(redeem)용 id 는 넣지 않는다."""
    text = lambda v: v if isinstance(v, str) else None  # noqa: E731
    return expires, {
        "title": text(title),
        "description": text(description),
        "reset_type": text(reset_type),
        "granted_at": iso(granted),
        "expires_at": iso(expires),
    }


def reset_credits_summary(credits: list[tuple[Optional[float], dict]], available: Optional[int] = None) -> dict:
    """초기화권 목록을 만료가 빠른 순(만료 없음은 마지막)으로 정리한 응답 형식."""
    credits = sorted(credits, key=lambda c: (c[0] is None, c[0] or 0))
    expirations = [exp for exp, _ in credits]
    return {
        "available": available if available is not None else len(credits),
        "next_expires_at": iso(expirations[0]) if expirations and expirations[0] else None,
        "expirations": [iso(e) for e in expirations],
        "items": [item for _, item in credits],
    }


def parse_callback_input(raw: str) -> tuple[str, Optional[str]]:
    """사용자가 붙여넣은 값에서 (code, state)를 꺼낸다.

    허용 형식: 리다이렉트된 전체 URL, `code#state`, 또는 code 만.
    """
    text = (raw or "").strip()
    if not text:
        raise LoginError("입력이 비어 있습니다.")
    if "://" in text or text.startswith("/") or "code=" in text:
        parsed = urllib.parse.urlparse(text)
        query = urllib.parse.parse_qs(parsed.query or text.split("?", 1)[-1])
        if "error" in query:
            raise LoginError(f"로그인 거부/실패: {query['error'][0]}")
        code = (query.get("code") or [None])[0]
        state = (query.get("state") or [None])[0]
        if not code:
            raise LoginError("URL에 code 파라미터가 없습니다. 주소창의 전체 URL을 복사했는지 확인하세요.")
        return code, state
    if "#" in text:
        code, state = text.split("#", 1)
        return code.strip(), state.strip() or None
    return text, None


def check_state(expected: str, got: Optional[str]) -> None:
    if got is not None and got != expected:
        raise LoginError("state 값이 일치하지 않습니다. 로그인을 처음부터 다시 시작하세요.")


class Provider:
    id: str = ""
    name: str = ""
    # 지원하는 등록 방식: "oauth", "session_key" 등
    methods: tuple[str, ...] = ("oauth",)

    def is_configured(self, cfg: Config) -> tuple[bool, Optional[str]]:
        return True, None

    def start_login(self, cfg: Config) -> LoginStart:
        raise NotImplementedError

    def finish_login(self, cfg: Config, pending: dict, user_input: str) -> LoginResult:
        raise NotImplementedError

    def create_manual(self, cfg: Config, payload: dict) -> LoginResult:
        raise LoginError(f"{self.name}은(는) 수동 등록을 지원하지 않습니다.")

    def fetch(self, cfg: Config, account: dict, save_creds: SaveCreds) -> Usage:
        raise NotImplementedError

    def describe_creds(self, creds: dict) -> dict[str, Any]:
        """계정 목록 API에 노출해도 되는 자격증명 요약(비밀값 제외)."""
        return {}

    def visible_windows(self, windows: list[dict]) -> list[dict]:
        """저장된 사용량 창 중 보여줄 것. 예전 버전이 저장한 값을 거를 때 쓴다."""
        return windows
