"""ChatGPT / Codex 사용량.

- 사용량: `GET https://chatgpt.com/backend-api/wham/usage`
- 초기화권: `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
- 로그인: Codex CLI 와 같은 OAuth(PKCE). 리다이렉트는 localhost 라서 폰에서는 페이지가 열리지 않지만
  주소창의 URL 에 code 가 들어 있으므로 그대로 복사해 붙여넣으면 된다.
"""

from __future__ import annotations

import secrets
import urllib.parse
from typing import Any, Optional

from .. import http
from ..config import Config
from ..errors import AuthError, LoginError, ProviderError
from ..util import clamp_pct, iso, jwt_claims, now, parse_iso, pkce_pair, to_float, window_label
from .base import (
    LoginResult,
    LoginStart,
    Provider,
    SaveCreds,
    Usage,
    check_state,
    make_window,
    parse_callback_input,
    reset_credit,
    reset_credits_summary,
)

ISSUER = "https://auth.openai.com"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
SCOPE = "openid profile email offline_access"
API_BASE = "https://chatgpt.com/backend-api"
USER_AGENT = "codex_cli_rs/0.50.0 (Linux; x86_64)"
REFRESH_MARGIN = 300


class CodexProvider(Provider):
    id = "codex"
    name = "Codex"

    # ---------- 로그인 ----------
    def start_login(self, cfg: Config) -> LoginStart:
        verifier, challenge = pkce_pair()
        state = secrets.token_urlsafe(24)
        params = {
            "response_type": "code",
            "client_id": CLIENT_ID,
            "redirect_uri": cfg.codex_redirect_uri,
            "scope": SCOPE,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
            "originator": "codex_cli_rs",
            "state": state,
        }
        return LoginStart(
            authorize_url=f"{ISSUER}/oauth/authorize?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}",
            instructions=(
                "ChatGPT 계정으로 로그인하면 '연결할 수 없음' 페이지가 떠요. "
                "정상이에요. 주소창의 주소를 통째로 복사한 뒤 돌아오세요."
            ),
            input_hint="localhost:1455 로 시작하는 주소 전체",
            pending={"verifier": verifier, "state": state, "redirect_uri": cfg.codex_redirect_uri},
        )

    def finish_login(self, cfg: Config, pending: dict, user_input: str) -> LoginResult:
        code, state = parse_callback_input(user_input)
        check_state(pending["state"], state)
        resp = http.request(
            "POST",
            f"{ISSUER}/oauth/token",
            form={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": pending["redirect_uri"],
                "client_id": CLIENT_ID,
                "code_verifier": pending["verifier"],
            },
        )
        if not resp.ok:
            raise LoginError(f"토큰 교환 실패: HTTP {resp.status} {resp.text(200)}")
        data = resp.json()
        creds = self._creds_from_token_response(data, previous=None)
        info = id_token_info(creds.get("id_token"))
        return LoginResult(creds=creds, email=info["email"], plan=info["plan"])

    def describe_creds(self, creds: dict) -> dict[str, Any]:
        return {
            "oauth": bool(creds.get("refresh_token")),
            "account_id": bool(creds.get("account_id")),
            "last_refresh": iso(creds.get("last_refresh")),
            "reset_credits_supported": True,
        }

    # ---------- 토큰 ----------
    @staticmethod
    def _creds_from_token_response(data: dict, previous: Optional[dict]) -> dict:
        prev = previous or {}
        access = data.get("access_token")
        if not access:
            raise ProviderError("토큰 응답에 access_token 이 없습니다.")
        id_token = data.get("id_token") or prev.get("id_token")
        info = id_token_info(id_token)
        return {
            "access_token": access,
            "refresh_token": data.get("refresh_token") or prev.get("refresh_token"),
            "id_token": id_token,
            "account_id": info["account_id"] or prev.get("account_id"),
            "last_refresh": now(),
        }

    def _refresh(self, creds: dict, save_creds: SaveCreds) -> dict:
        if not creds.get("refresh_token"):
            raise AuthError("리프레시 토큰이 없습니다. 다시 로그인하세요.")
        resp = http.request(
            "POST",
            f"{ISSUER}/oauth/token",
            json_body={
                "client_id": CLIENT_ID,
                "grant_type": "refresh_token",
                "refresh_token": creds["refresh_token"],
                "scope": "openid profile email",
            },
        )
        if resp.status in (400, 401):
            raise AuthError(f"토큰 갱신 거부(HTTP {resp.status}) {resp.text(120)}", resp.status)
        http.raise_for_common(resp, "Codex 토큰 갱신")
        creds = self._creds_from_token_response(resp.json(), previous=creds)
        save_creds(creds)  # 회전된 리프레시 토큰을 즉시 저장
        return creds

    @staticmethod
    def _needs_refresh(creds: dict) -> bool:
        exp = jwt_claims(creds.get("access_token")).get("exp")
        if isinstance(exp, (int, float)):
            return exp - REFRESH_MARGIN < now()
        # exp 를 못 읽으면 마지막 갱신 후 50분이 지나면 갱신
        return (creds.get("last_refresh") or 0) + 3000 < now()

    def _get(self, path: str, creds: dict, extra_headers: Optional[dict] = None) -> http.Response:
        headers = {
            "Authorization": f"Bearer {creds['access_token']}",
            "User-Agent": USER_AGENT,
            "originator": "codex_cli_rs",
        }
        if creds.get("account_id"):
            headers["ChatGPT-Account-Id"] = creds["account_id"]
        if extra_headers:
            headers.update(extra_headers)
        return http.request("GET", f"{API_BASE}{path}", headers=headers)

    # ---------- 조회 ----------
    def fetch(self, cfg: Config, account: dict, save_creds: SaveCreds) -> Usage:
        creds = account["creds"]
        if self._needs_refresh(creds):
            creds = self._refresh(creds, save_creds)

        resp = self._get("/wham/usage", creds)
        if resp.status == 401:
            creds = self._refresh(creds, save_creds)
            resp = self._get("/wham/usage", creds)
        if resp.status in (401, 403) and not resp.cloudflare_challenge:
            raise AuthError(f"Codex 인증 실패(HTTP {resp.status})", resp.status)
        http.raise_for_common(resp, "Codex 사용량")
        data = resp.json()

        usage = Usage()
        usage.windows = parse_windows(data)
        usage.plan = data.get("plan_type") if isinstance(data.get("plan_type"), str) else None
        usage.email = id_token_info(creds.get("id_token"))["email"]
        usage.extra = parse_extra(data)

        try:
            rc = self._get("/wham/rate-limit-reset-credits", creds, {"OpenAI-Beta": "codex-1"})
            http.raise_for_common(rc, "Codex 초기화권")
            usage.reset_credits = parse_reset_credits(rc.json(), now())
        except ProviderError as exc:
            usage.warnings.append(f"초기화권 조회 실패: {exc}")
        return usage


# ---------- 정규화(순수 함수, 테스트 대상) ----------
def id_token_info(id_token: Optional[str]) -> dict:
    claims = jwt_claims(id_token)
    auth = claims.get("https://api.openai.com/auth") or {}
    return {
        "email": claims.get("email"),
        "account_id": auth.get("chatgpt_account_id"),
        "plan": auth.get("chatgpt_plan_type"),
    }


def _window(raw: Any, key_hint: str, group: Optional[str], primary: bool) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    seconds = raw.get("limit_window_seconds")
    seconds = int(seconds) if isinstance(seconds, (int, float)) else None
    reset_at = raw.get("reset_at")
    reset_iso = iso(float(reset_at)) if isinstance(reset_at, (int, float)) else iso(parse_iso(reset_at))
    if seconds and seconds <= 86400:
        key = "session"
    elif seconds:
        key = "weekly"
    else:
        key = key_hint
    return make_window(
        key,
        window_label(seconds),
        clamp_pct(to_float(raw.get("used_percent"))),
        reset_iso,
        window_seconds=seconds,
        group=group,
        primary=primary,
    )


def parse_windows(data: dict) -> list[dict]:
    windows: list[dict] = []
    rate = data.get("rate_limit") or {}
    for name in ("primary_window", "secondary_window"):
        w = _window(rate.get(name), name, None, True)
        if w:
            windows.append(w)
    for extra in data.get("additional_rate_limits") or []:
        if not isinstance(extra, dict):
            continue
        name = extra.get("limit_name") or extra.get("metered_feature") or "추가 한도"
        rl = extra.get("rate_limit") or {}
        for wname in ("primary_window", "secondary_window"):
            w = _window(rl.get(wname), wname, name, False)
            if w:
                w["key"] = f"{name}:{w['key']}"
                windows.append(w)
    return windows


def parse_extra(data: dict) -> dict:
    credits = data.get("credits")
    if not isinstance(credits, dict) or not (credits.get("has_credits") or credits.get("unlimited")):
        return {}
    return {
        "credits": {
            "unlimited": bool(credits.get("unlimited")),
            "balance": to_float(credits.get("balance")),
        }
    }


def parse_reset_credits(data: Any, at: float) -> Optional[dict]:
    if not isinstance(data, dict):
        return None
    credits = []
    for credit in data.get("credits") or []:
        if not isinstance(credit, dict) or credit.get("status") != "available":
            continue
        exp = parse_iso(credit.get("expires_at"))
        if exp is not None and exp <= at:
            continue
        credits.append(reset_credit(exp, parse_iso(credit.get("granted_at")), title=credit.get("title"),
                                    description=credit.get("description"), reset_type=credit.get("reset_type")))
    count = data.get("available_count")
    return reset_credits_summary(credits, count if isinstance(count, int) and count >= 0 else None)
