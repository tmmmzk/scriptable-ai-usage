"""Claude (claude.ai 구독) 사용량.

- 사용량: OAuth `GET https://api.anthropic.com/api/oauth/usage` (Claude Code 와 같은 client_id)
- 초기화권: 웹 API `GET https://claude.ai/api/organizations/{org}/usage?cedar_ember=1` 의
  `cedar_ember` 블록. OAuth 응답에는 없어서 `sessionKey` 쿠키가 필요하다.
"""

from __future__ import annotations

import secrets
import urllib.parse
from typing import Any, Optional

from .. import http
from ..config import Config
from ..errors import AuthError, BlockedError, LoginError, ProviderError
from ..util import clamp_pct, iso, now, parse_iso, pkce_pair, to_float
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

CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
SCOPES = [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
]
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
WEB_BASE = "https://claude.ai/api"
OAUTH_BETA = "oauth-2025-04-20"
USER_AGENT = "claude-code/2.1.0"
WEB_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.0 Safari/605.1.15"
)
REFRESH_MARGIN = 300

# 알려진 사용량 창. 그 외 `utilization` 을 가진 블록도 자동으로 추가한다.
KNOWN_WINDOWS = [
    ("five_hour", "session", "5시간", 5 * 3600, True),
    ("seven_day", "weekly", "주간", 7 * 86400, True),
    ("seven_day_opus", "weekly_opus", "Opus 주간", 7 * 86400, False),
    ("seven_day_sonnet", "weekly_sonnet", "Sonnet 주간", 7 * 86400, False),
]
MAX_RESET_CREDITS = 50


class ClaudeProvider(Provider):
    id = "claude"
    name = "Claude"
    methods = ("oauth", "session_key")

    # ---------- 로그인 ----------
    def start_login(self, cfg: Config) -> LoginStart:
        verifier, challenge = pkce_pair()
        state = secrets.token_urlsafe(24)
        params = {
            "code": "true",
            "client_id": CLIENT_ID,
            "response_type": "code",
            "redirect_uri": REDIRECT_URI,
            "scope": " ".join(SCOPES),
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
        return LoginStart(
            authorize_url=f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}",
            instructions="Claude 계정으로 로그인해 승인하면 코드가 표시됩니다. 'Copy Code'로 복사해 붙여넣으세요.",
            input_hint="code#state 형식의 코드",
            pending={"verifier": verifier, "state": state},
        )

    def finish_login(self, cfg: Config, pending: dict, user_input: str) -> LoginResult:
        code, state = parse_callback_input(user_input)
        check_state(pending["state"], state)
        resp = http.request(
            "POST",
            TOKEN_URL,
            json_body={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT_URI,
                "client_id": CLIENT_ID,
                "code_verifier": pending["verifier"],
                "state": pending["state"],
            },
        )
        if not resp.ok:
            raise LoginError(f"토큰 교환 실패: HTTP {resp.status} {resp.text(200)}")
        data = resp.json()
        oauth = self._oauth_from_token_response(data, previous=None)
        account = data.get("account") or {}
        org = data.get("organization") or {}
        email = account.get("email_address") or account.get("email")
        creds = {"oauth": oauth}
        if org.get("uuid"):
            creds["org_id"] = org["uuid"]
        return LoginResult(creds=creds, email=email)

    def create_manual(self, cfg: Config, payload: dict) -> LoginResult:
        session_key = (payload.get("session_key") or "").strip()
        if not session_key.startswith("sk-ant-"):
            raise LoginError("sessionKey 는 'sk-ant-' 로 시작해야 합니다.")
        org = self._web_org(session_key, None)
        creds = {"session_key": session_key, "org_id": org["uuid"]}
        return LoginResult(creds=creds, email=None, plan=None)

    def describe_creds(self, creds: dict) -> dict[str, Any]:
        oauth = creds.get("oauth") or {}
        return {
            "oauth": bool(oauth.get("refresh_token")),
            "oauth_expires_at": iso(oauth.get("expires_at")) if oauth else None,
            "session_key": bool(creds.get("session_key")),
            "reset_credits_supported": bool(creds.get("session_key")),
        }

    # ---------- 토큰 ----------
    @staticmethod
    def _oauth_from_token_response(data: dict, previous: Optional[dict]) -> dict:
        access = data.get("access_token")
        if not access:
            raise ProviderError("토큰 응답에 access_token 이 없습니다.")
        expires_in = to_float(data.get("expires_in")) or 3600
        scopes = data.get("scope")
        if isinstance(scopes, str):
            scopes = scopes.split()
        prev = previous or {}
        return {
            "access_token": access,
            # 리프레시 토큰은 사용할 때마다 회전한다. 응답에 없으면 이전 값을 유지.
            "refresh_token": data.get("refresh_token") or prev.get("refresh_token"),
            "expires_at": now() + expires_in,
            "scopes": scopes or prev.get("scopes") or SCOPES,
        }

    def _refresh(self, creds: dict, save_creds: SaveCreds) -> dict:
        oauth = creds["oauth"]
        if not oauth.get("refresh_token"):
            raise AuthError("리프레시 토큰이 없습니다. 다시 로그인하세요.")
        resp = http.request(
            "POST",
            TOKEN_URL,
            json_body={
                "grant_type": "refresh_token",
                "refresh_token": oauth["refresh_token"],
                "client_id": CLIENT_ID,
                "scope": " ".join(oauth.get("scopes") or SCOPES),
            },
        )
        if resp.status in (400, 401, 403):
            raise AuthError(f"토큰 갱신 거부(HTTP {resp.status}). 다시 로그인하세요.", resp.status)
        http.raise_for_common(resp, "Claude 토큰 갱신")
        creds = dict(creds)
        creds["oauth"] = self._oauth_from_token_response(resp.json(), previous=oauth)
        save_creds(creds)  # 회전된 리프레시 토큰을 즉시 저장
        return creds

    # ---------- 조회 ----------
    def fetch(self, cfg: Config, account: dict, save_creds: SaveCreds) -> Usage:
        creds = account["creds"]
        usage = Usage()
        web_data: Optional[dict] = None

        if creds.get("oauth"):
            data, creds = self._fetch_oauth_usage(creds, save_creds)
            usage.windows = parse_windows(data)
            usage.extra = parse_extra_usage(data)

        if creds.get("session_key"):
            try:
                web_data, creds = self._fetch_web_usage(creds, save_creds)
            except AuthError as exc:
                if not creds.get("oauth"):
                    raise
                usage.warnings.append(f"sessionKey 만료: {exc}")
            except ProviderError as exc:
                if not creds.get("oauth"):
                    raise
                usage.warnings.append(f"초기화권 조회 실패: {exc}")

        if web_data is not None:
            if not usage.windows:
                usage.windows = parse_windows(web_data)
                usage.extra = parse_extra_usage(web_data)
            usage.reset_credits = parse_reset_credits(web_data.get("cedar_ember"), now())
        return usage

    def _fetch_oauth_usage(self, creds: dict, save_creds: SaveCreds) -> tuple[dict, dict]:
        if (creds["oauth"].get("expires_at") or 0) - REFRESH_MARGIN < now():
            creds = self._refresh(creds, save_creds)
        for attempt in range(2):
            resp = http.request(
                "GET",
                USAGE_URL,
                headers={
                    "Authorization": f"Bearer {creds['oauth']['access_token']}",
                    "anthropic-beta": OAUTH_BETA,
                    "User-Agent": USER_AGENT,
                },
            )
            if resp.status == 401 and attempt == 0:
                creds = self._refresh(creds, save_creds)
                continue
            if resp.status in (401, 403) and not resp.cloudflare_challenge:
                raise AuthError(f"Claude OAuth 인증 실패(HTTP {resp.status})", resp.status)
            http.raise_for_common(resp, "Claude 사용량")
            return resp.json(), creds
        raise AuthError("Claude OAuth 인증 실패")

    def _web_headers(self, session_key: str) -> dict:
        return {
            "Cookie": f"sessionKey={session_key}",
            "User-Agent": WEB_USER_AGENT,
            "Accept": "application/json",
        }

    def _web_org(self, session_key: str, wanted: Optional[str]) -> dict:
        resp = http.request("GET", f"{WEB_BASE}/organizations", headers=self._web_headers(session_key))
        if resp.status in (401, 403) and not resp.cloudflare_challenge:
            raise AuthError(f"sessionKey 인증 실패(HTTP {resp.status})", resp.status)
        http.raise_for_common(resp, "claude.ai 조직 조회")
        orgs = resp.json()
        if not isinstance(orgs, list) or not orgs:
            raise ProviderError("claude.ai 조직 목록이 비어 있습니다.")
        if wanted:
            for org in orgs:
                if org.get("uuid") == wanted:
                    return org

        def caps(org: dict) -> set:
            return {str(c).lower() for c in (org.get("capabilities") or [])}

        for org in orgs:
            if "chat" in caps(org):
                return org
        for org in orgs:
            if caps(org) != {"api"}:
                return org
        return orgs[0]

    def _fetch_web_usage(self, creds: dict, save_creds: SaveCreds) -> tuple[dict, dict]:
        session_key = creds["session_key"]
        org_id = creds.get("org_id")
        if not org_id:
            org_id = self._web_org(session_key, None)["uuid"]
            creds = dict(creds, org_id=org_id)
            save_creds(creds)
        base = f"{WEB_BASE}/organizations/{org_id}/usage"
        resp = http.request("GET", f"{base}?cedar_ember=1", headers=self._web_headers(session_key))
        if resp.status in (401, 403) and not resp.cloudflare_challenge:
            raise AuthError(f"sessionKey 인증 실패(HTTP {resp.status})", resp.status)
        if resp.status == 403 and resp.cloudflare_challenge:
            raise BlockedError("claude.ai 가 서버 IP 를 Cloudflare 챌린지로 막았습니다.", 403)
        if not resp.ok and resp.status != 429:
            # 초기화권 옵트인이 거부되면 옵션 없이 한 번 더(사용량은 받을 수 있음)
            resp = http.request("GET", base, headers=self._web_headers(session_key))
        http.raise_for_common(resp, "claude.ai 사용량")
        return resp.json(), creds


# ---------- 정규화(순수 함수, 테스트 대상) ----------
def parse_windows(data: dict) -> list[dict]:
    windows: list[dict] = []
    seen = set()
    for src, key, label, seconds, primary in KNOWN_WINDOWS:
        block = data.get(src)
        seen.add(src)
        if isinstance(block, dict) and block.get("utilization") is not None:
            windows.append(
                make_window(
                    key,
                    label,
                    clamp_pct(to_float(block.get("utilization"))),
                    iso(parse_iso(block.get("resets_at"))),
                    window_seconds=seconds,
                    primary=primary,
                )
            )
    for src, block in data.items():
        if src in seen or src in ("extra_usage", "cedar_ember"):
            continue
        if isinstance(block, dict) and block.get("utilization") is not None and "resets_at" in block:
            windows.append(
                make_window(
                    src,
                    src.replace("seven_day_", "주간 ").replace("_", " "),
                    clamp_pct(to_float(block.get("utilization"))),
                    iso(parse_iso(block.get("resets_at"))),
                    window_seconds=7 * 86400 if src.startswith("seven_day") else None,
                )
            )
    return windows


def parse_extra_usage(data: dict) -> dict:
    extra = data.get("extra_usage")
    if not isinstance(extra, dict) or not extra.get("is_enabled"):
        return {}
    return {
        "extra_usage": {
            "used": to_float(extra.get("used_credits")),
            "limit": to_float(extra.get("monthly_limit") or extra.get("monthly_credit_limit")),
            "used_percent": clamp_pct(to_float(extra.get("utilization"))),
            "currency": extra.get("currency"),
        }
    }


def parse_reset_credits(block: Any, at: float) -> Optional[dict]:
    """`cedar_ember` 블록 → 사용 가능한 초기화권 목록.

    eligible 이 아니면 None. 일시정지·소진·미시작·만료된 grant 는 제외하고,
    resets_left 가 2 이상이면 그 수만큼 펼친다.
    """
    if not isinstance(block, dict) or block.get("eligible") is not True:
        return None
    credits = []
    for grant in block.get("grants") or []:
        if not isinstance(grant, dict):
            continue
        left = grant.get("resets_left")
        if not isinstance(left, int) or left <= 0 or grant.get("paused") is not False:
            continue
        starts = parse_iso(grant.get("starts_at"))
        ends = parse_iso(grant.get("ends_at"))
        if starts is not None and starts > at:
            continue
        if ends is not None and ends <= at:
            continue
        if len(credits) + left > MAX_RESET_CREDITS:
            return None
        credits.extend(reset_credit(ends, starts) for _ in range(left))
    return reset_credits_summary(credits)
