"""Claude (claude.ai 구독) 사용량.

- 사용량: OAuth `GET https://api.anthropic.com/api/oauth/usage` (Claude Code 와 같은 client_id)
- 초기화권: 웹 API `GET https://claude.ai/api/organizations/{org}/usage?cedar_ember=1` 의
  `cedar_ember` 블록. OAuth 응답에는 없어서 `sessionKey` 쿠키가 필요하다.
"""

from __future__ import annotations

import re
import secrets
import urllib.parse
from typing import Any, Optional

from .. import http
from ..config import Config
from ..errors import AuthError, LoginError, ProviderError
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
API_BASE = "https://api.anthropic.com/api/oauth"
WEB_BASE = "https://claude.ai/api"
OAUTH_BETA = "oauth-2025-04-20"
USER_AGENT = "claude-code/2.1.0"
WEB_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.0 Safari/605.1.15"
)
REFRESH_MARGIN = 300

# 표시할 사용량 창(Claude Code 의 /usage 와 같은 것만). 응답에는 내부 코드네임 블록
# (예: iguana_necktie)도 섞여 오므로, 모르는 키는 보여주지 않는다.
KNOWN_WINDOWS = [
    ("five_hour", "session", "현재 세션", 5 * 3600, True),
    ("seven_day", "weekly", "이번 주", 7 * 86400, True),
    ("seven_day_opus", "weekly_opus", "Opus 이번 주", 7 * 86400, False),
    ("seven_day_sonnet", "weekly_sonnet", "Sonnet 이번 주", 7 * 86400, False),
]
# limits[] 의 모델별 주간 한도도 알려진 모델만 보여준다. Claude Code 는 허용 목록(기본 Fable)으로
# 거르고, 목록에 없는 행에는 코드네임 모델이 섞여 온다. 새 버전(예: Fable 6)은 계열 이름으로 통과시킨다.
MODEL_FAMILIES = re.compile(r"^(fable|opus|sonnet|haiku)\b", re.I)
KNOWN_KEYS = {key for _, key, _, _, _ in KNOWN_WINDOWS} | {"cowork_credit"}


def model_shown(name: Any) -> bool:
    return isinstance(name, str) and bool(MODEL_FAMILIES.match(name.strip()))


def window_shown(window: dict) -> bool:
    key = str(window.get("key") or "")
    return key in KNOWN_KEYS or (key.startswith("model:") and model_shown(key[len("model:"):]))


# /api/oauth/profile 의 organization_type → 플랜
ORG_PLANS = {"claude_max": "max", "claude_pro": "pro", "claude_team": "team", "claude_enterprise": "enterprise"}
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
            instructions="Claude 계정으로 로그인해 승인하면 코드가 나와요. 'Copy Code'를 눌러 복사한 뒤 돌아오세요.",
            input_hint="복사한 코드 (code#state 형식)",
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
        return LoginResult(creds=creds, email=email, plan=parse_plan(self._fetch_profile(oauth["access_token"])))

    def create_manual(self, cfg: Config, payload: dict) -> LoginResult:
        session_key = (payload.get("session_key") or "").strip()
        if not session_key.startswith("sk-ant-"):
            raise LoginError("sessionKey 는 'sk-ant-' 로 시작해야 합니다.")
        org = self._web_org(session_key)
        creds = {"session_key": session_key, "org_id": org["uuid"]}
        return LoginResult(creds=creds, email=None, plan=None)

    def describe_creds(self, creds: dict) -> dict[str, Any]:
        oauth = creds.get("oauth") or {}
        return {
            "oauth": bool(oauth.get("refresh_token")),
            "oauth_expires_at": iso(oauth.get("expires_at")) if oauth else None,
            "session_key": bool(creds.get("session_key")),
            "reset_credits_supported": bool(creds.get("session_key") or oauth),
        }

    def visible_windows(self, windows: list[dict]) -> list[dict]:
        return [w for w in windows if isinstance(w, dict) and window_shown(w)]

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
            if data.get("cedar_ember"):
                usage.reset_credits = parse_reset_credits(data["cedar_ember"], now())
            token = creds["oauth"]["access_token"]
            # 사용량 응답에는 플랜·조직이 없어 프로필로 따로 조회(바뀔 일이 드물어 모를 때만)
            if not account.get("plan") or not creds.get("org_id"):
                profile = self._fetch_profile(token)
                if not account.get("plan"):
                    usage.plan = parse_plan(profile)
                org = ((profile or {}).get("organization") or {}).get("uuid") if isinstance(profile, dict) else None
                if org and not creds.get("org_id"):
                    creds = dict(creds, org_id=org)
                    save_creds(creds)
            if creds.get("org_id"):
                prepaid = self._fetch_prepaid(token, creds["org_id"])
                if prepaid:
                    usage.extra = dict(usage.extra, prepaid=prepaid)

        # OAuth 로 초기화권을 못 받았을 때만 claude.ai 웹(sessionKey)으로
        if creds.get("session_key") and usage.reset_credits is None:
            try:
                web_data, creds = self._fetch_web_usage(creds, save_creds)
            except ProviderError as exc:
                if not creds.get("oauth"):
                    raise  # sessionKey 만 있는 계정이면 이게 전부라 실패로 본다
                label = "sessionKey 만료" if isinstance(exc, AuthError) else "초기화권 조회 실패"
                usage.warnings.append(f"{label}: {exc}")

        if web_data is not None:
            if not usage.windows:
                usage.windows = parse_windows(web_data)
                usage.extra = parse_extra_usage(web_data)
            usage.reset_credits = parse_reset_credits(web_data.get("cedar_ember"), now())
        return usage

    @staticmethod
    def _oauth_headers(token: str) -> dict:
        return {"Authorization": f"Bearer {token}", "anthropic-beta": OAUTH_BETA, "User-Agent": USER_AGENT}

    @classmethod
    def _fetch_profile(cls, token: str) -> Optional[dict]:
        """프로필(플랜·조직)은 부가 정보라 실패해도 사용량 조회를 막지 않는다."""
        try:
            resp = http.request("GET", f"{API_BASE}/profile", headers=cls._oauth_headers(token))
            return resp.json() if resp.ok else None
        except ProviderError:
            return None

    @classmethod
    def _fetch_prepaid(cls, token: str, org: str) -> Optional[dict]:
        """선불 크레딧 잔액(Claude Code 의 /usage-credits 와 같은 곳). 없거나 실패하면 None."""
        try:
            resp = http.request("GET", f"{API_BASE}/organizations/{org}/prepaid/credits",
                                headers={**cls._oauth_headers(token), "x-organization-uuid": org})
            data = resp.json() if resp.ok else None
        except ProviderError:
            return None
        if not isinstance(data, dict) or not isinstance(data.get("amount"), (int, float)):
            return None
        return {"balance": from_minor(data["amount"], data.get("currency")), "currency": data.get("currency") or "USD"}

    def _fetch_oauth_usage(self, creds: dict, save_creds: SaveCreds) -> tuple[dict, dict]:
        # cedar_ember=1 이면 초기화권도 같이 온다(Claude Code 와 같은 요청)
        def get(c: dict, query: str = "?cedar_ember=1") -> http.Response:
            return http.request("GET", f"{API_BASE}/usage{query}", headers=self._oauth_headers(c["oauth"]["access_token"]))

        if (creds["oauth"].get("expires_at") or 0) - REFRESH_MARGIN < now():
            creds = self._refresh(creds, save_creds)
        resp = get(creds)
        if resp.status == 401:  # 만료 전에 폐기됐을 수 있어 한 번만 갱신해 다시
            creds = self._refresh(creds, save_creds)
            resp = get(creds)
        if not resp.ok and resp.status not in (401, 403, 429) and not resp.cloudflare_challenge:
            resp = get(creds, "")  # 옵션이 거부되면 옵션 없이 한 번 더
        http.raise_for_auth(resp, "Claude OAuth")
        http.raise_for_common(resp, "Claude 사용량")
        return resp.json(), creds

    def _web_headers(self, session_key: str) -> dict:
        return {
            "Cookie": f"sessionKey={session_key}",
            "User-Agent": WEB_USER_AGENT,
            "Accept": "application/json",
        }

    def _web_org(self, session_key: str) -> dict:
        resp = http.request("GET", f"{WEB_BASE}/organizations", headers=self._web_headers(session_key))
        http.raise_for_auth(resp, "sessionKey")
        http.raise_for_common(resp, "claude.ai 조직 조회")
        orgs = resp.json()
        if not isinstance(orgs, list) or not orgs:
            raise ProviderError("claude.ai 조직 목록이 비어 있습니다.")

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
            org_id = self._web_org(session_key)["uuid"]
            creds = dict(creds, org_id=org_id)
            save_creds(creds)
        base = f"{WEB_BASE}/organizations/{org_id}/usage"
        resp = http.request("GET", f"{base}?cedar_ember=1", headers=self._web_headers(session_key))
        http.raise_for_auth(resp, "sessionKey")
        if not resp.ok and resp.status != 429 and not resp.cloudflare_challenge:
            # 초기화권 옵트인이 거부되면 옵션 없이 한 번 더(사용량은 받을 수 있음)
            resp = http.request("GET", base, headers=self._web_headers(session_key))
        http.raise_for_common(resp, "claude.ai 사용량")
        return resp.json(), creds


# ---------- 정규화(순수 함수, 테스트 대상) ----------
def parse_windows(data: dict) -> list[dict]:
    windows: list[dict] = []
    for src, key, label, seconds, primary in KNOWN_WINDOWS:
        block = data.get(src)
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
    # 모델별 주간 한도(예: Fable). limits[] 중 kind 가 weekly_scoped 인 것.
    for item in data.get("limits") or []:
        if not isinstance(item, dict) or item.get("kind") != "weekly_scoped":
            continue
        model = ((item.get("scope") or {}).get("model") or {}).get("display_name")
        if not model_shown(model):
            continue
        model = model.strip()
        if any(w["label"] == f"{model} 이번 주" for w in windows):
            continue  # seven_day_opus 등과 겹치면 하나만
        resets = item.get("resets_at")
        windows.append(
            make_window(
                f"model:{model}",
                f"{model} 이번 주",
                clamp_pct(to_float(item.get("percent"))),
                iso(float(resets)) if isinstance(resets, (int, float)) else iso(parse_iso(resets)),
                window_seconds=7 * 86400,
            )
        )
    # Claude Code·Cowork 일회성 크레딧(cinder_cove). resets_at 은 만료 시각이다.
    cc = data.get("cinder_cove")
    if isinstance(cc, dict) and cc.get("utilization") is not None:
        w = make_window("cowork_credit", "Claude Code·Cowork 크레딧", clamp_pct(to_float(cc.get("utilization"))), iso(parse_iso(cc.get("resets_at"))))
        windows.append({**w, "kind": "credit"})
    return windows


def from_minor(value: Any, currency: Any) -> Optional[float]:
    """금액은 최소 단위(센트)로 온다. 원·엔처럼 소수점이 없는 통화는 그대로."""
    v = to_float(value)
    if v is None:
        return None
    return v if str(currency or "USD").upper() in ("JPY", "KRW") else v / 100


def parse_plan(profile: Any) -> Optional[str]:
    """프로필 → 플랜. Max 는 rate_limit_tier 로 5x/20x 를 구분한다(예: default_claude_max_20x)."""
    org = (profile or {}).get("organization") if isinstance(profile, dict) else None
    if not isinstance(org, dict):
        return None
    tier = org.get("rate_limit_tier")
    if isinstance(tier, str) and re.search(r"max_\d+x", tier):
        return tier
    return ORG_PLANS.get(org.get("organization_type"))


def parse_extra_usage(data: dict) -> dict:
    extra = data.get("extra_usage")
    if not isinstance(extra, dict) or not extra.get("is_enabled"):
        return {}
    # used_credits·monthly_limit 은 센트 단위다(한도가 없으면 monthly_limit 이 null)
    currency = extra.get("currency") or "USD"
    limit = extra.get("monthly_limit") if extra.get("monthly_limit") is not None else extra.get("monthly_credit_limit")
    return {
        "extra_usage": {
            "used": from_minor(extra.get("used_credits"), currency),
            "limit": from_minor(limit, currency),
            "used_percent": clamp_pct(to_float(extra.get("utilization"))),
            "currency": currency,
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
