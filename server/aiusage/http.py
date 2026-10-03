from __future__ import annotations

import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from .errors import BlockedError, ProviderError, RateLimitedError


@dataclass
class Response:
    status: int
    headers: Mapping[str, str]
    body: bytes

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def text(self, limit: int = 500) -> str:
        return self.body[:limit].decode("utf-8", "replace")

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProviderError(f"JSON 파싱 실패: {self.text(200)!r}") from exc

    def header(self, name: str) -> Optional[str]:
        lname = name.lower()
        for key, value in self.headers.items():
            if key.lower() == lname:
                return value
        return None

    @property
    def cloudflare_challenge(self) -> bool:
        return (self.header("cf-mitigated") or "").lower() == "challenge"


def request(
    method: str,
    url: str,
    *,
    headers: Optional[Mapping[str, str]] = None,
    json_body: Any = None,
    form: Optional[Mapping[str, str]] = None,
    timeout: float = 20,
) -> Response:
    data: Optional[bytes] = None
    hdrs = {"Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    elif form is not None:
        data = urllib.parse.urlencode(form).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return Response(resp.status, dict(resp.headers.items()), resp.read())
    except urllib.error.HTTPError as exc:
        return Response(exc.code, dict(exc.headers.items()) if exc.headers else {}, exc.read() or b"")
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as exc:
        reason = getattr(exc, "reason", exc)
        raise ProviderError(f"네트워크 오류: {reason}") from exc


def raise_for_common(resp: Response, what: str) -> None:
    """401/403 외의 공통 오류(429, Cloudflare, 5xx)를 예외로 바꾼다."""
    if resp.status == 429:
        raise RateLimitedError(f"{what}: 요청 한도 초과(429)", resp.status)
    if resp.status == 403 and resp.cloudflare_challenge:
        raise BlockedError(f"{what}: Cloudflare 챌린지로 차단됨", resp.status)
    if not resp.ok:
        raise ProviderError(f"{what}: HTTP {resp.status} {resp.text(200)}", resp.status)
