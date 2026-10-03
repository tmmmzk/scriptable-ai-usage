"""Google Antigravity 사용량.

Cloud Code 내부 API(`cloudcode-pa.googleapis.com/v1internal:*`)를 Google OAuth 토큰으로 호출한다.
OAuth 클라이언트 ID/Secret 은 Antigravity 앱에 들어 있는 값을 환경변수로 넣어야 한다.
"""

from __future__ import annotations

import re
import secrets
import time
import urllib.parse
from typing import Any, Optional

from .. import http
from ..config import Config
from ..errors import AuthError, LoginError, ProviderError
from ..util import clamp_pct, iso, jwt_claims, now, parse_iso, to_float
from .base import LoginResult, LoginStart, Provider, SaveCreds, Usage, check_state, make_window, parse_callback_input

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
]
API_BASE = "https://cloudcode-pa.googleapis.com/v1internal"
USER_AGENT = "antigravity/hub/2.9.1 linux/amd64"
CLIENT_METADATA = {"ideType": "ANTIGRAVITY", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}
REFRESH_MARGIN = 120


class AntigravityProvider(Provider):
    id = "antigravity"
    name = "Antigravity"

    def is_configured(self, cfg: Config) -> tuple[bool, Optional[str]]:
        if cfg.antigravity_client_id and cfg.antigravity_client_secret:
            return True, None
        return False, "서버에 ANTIGRAVITY_OAUTH_CLIENT_ID / ANTIGRAVITY_OAUTH_CLIENT_SECRET 이 설정되지 않았습니다."

    def _client(self, cfg: Config) -> tuple[str, str]:
        ok, reason = self.is_configured(cfg)
        if not ok:
            raise LoginError(reason)
        return cfg.antigravity_client_id, cfg.antigravity_client_secret  # type: ignore[return-value]

    # ---------- 로그인 ----------
    def start_login(self, cfg: Config) -> LoginStart:
        client_id, _ = self._client(cfg)
        state = secrets.token_urlsafe(24)
        params = {
            "client_id": client_id,
            "redirect_uri": cfg.antigravity_redirect_uri,
            "response_type": "code",
            "scope": " ".join(SCOPES),
            "access_type": "offline",
            "prompt": "select_account consent",
            "state": state,
        }
        return LoginStart(
            authorize_url=f"{AUTH_URL}?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}",
            instructions=(
                "Antigravity 에서 쓰는 Google 계정으로 로그인하면 127.0.0.1 페이지로 이동하며 열리지 않습니다. "
                "정상입니다. 주소창의 전체 URL을 복사해 붙여넣으세요."
            ),
            input_hint="http://127.0.0.1:8585/callback?code=... 전체 URL",
            pending={"state": state, "redirect_uri": cfg.antigravity_redirect_uri},
        )

    def finish_login(self, cfg: Config, pending: dict, user_input: str) -> LoginResult:
        client_id, client_secret = self._client(cfg)
        code, state = parse_callback_input(user_input)
        check_state(pending["state"], state)
        resp = http.request(
            "POST",
            TOKEN_URL,
            form={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": pending["redirect_uri"],
                "grant_type": "authorization_code",
            },
        )
        if not resp.ok:
            raise LoginError(f"토큰 교환 실패: HTTP {resp.status} {resp.text(200)}")
        data = resp.json()
        if not data.get("refresh_token"):
            raise LoginError("refresh_token 을 받지 못했습니다. Google 계정 권한에서 앱 연결을 해제한 뒤 다시 시도하세요.")
        creds = {
            "access_token": data["access_token"],
            "refresh_token": data["refresh_token"],
            "expires_at": now() + (to_float(data.get("expires_in")) or 3600),
            "id_token": data.get("id_token"),
        }
        email = jwt_claims(creds.get("id_token")).get("email")
        if not email:
            info = http.request("GET", USERINFO_URL, headers={"Authorization": f"Bearer {creds['access_token']}"})
            if info.ok:
                email = info.json().get("email")
        return LoginResult(creds=creds, email=email)

    def describe_creds(self, creds: dict) -> dict[str, Any]:
        return {
            "oauth": bool(creds.get("refresh_token")),
            "project_id": bool(creds.get("project_id")),
            "reset_credits_supported": False,
        }

    # ---------- 토큰 ----------
    def _refresh(self, cfg: Config, creds: dict, save_creds: SaveCreds) -> dict:
        client_id, client_secret = self._client(cfg)
        resp = http.request(
            "POST",
            TOKEN_URL,
            form={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": creds["refresh_token"],
                "grant_type": "refresh_token",
            },
        )
        if resp.status in (400, 401):
            raise AuthError(f"Google 토큰 갱신 거부(HTTP {resp.status}). 다시 로그인하세요.", resp.status)
        http.raise_for_common(resp, "Google 토큰 갱신")
        data = resp.json()
        creds = dict(creds)
        creds["access_token"] = data["access_token"]
        creds["expires_at"] = now() + (to_float(data.get("expires_in")) or 3600)
        if data.get("refresh_token"):
            creds["refresh_token"] = data["refresh_token"]
        if data.get("id_token"):
            creds["id_token"] = data["id_token"]
        save_creds(creds)
        return creds

    def _post(self, method: str, token: str, body: dict) -> Any:
        resp = http.request(
            "POST",
            f"{API_BASE}:{method}",
            headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
            json_body=body,
        )
        if resp.status == 401:
            raise AuthError("Antigravity 인증 실패(401)", 401)
        if resp.status == 403:
            raise ProviderError(f"{method}: 권한 없음(403) {resp.text(200)}", 403)
        http.raise_for_common(resp, f"Antigravity {method}")
        return resp.json()

    def _code_assist(self, token: str, creds: dict, save_creds: SaveCreds) -> tuple[Optional[str], Optional[str], dict]:
        """프로젝트 ID 와 플랜을 알아낸다. 프로젝트가 없으면 온보딩을 시도한다. (project, plan, creds)"""
        info = self._post("loadCodeAssist", token, {"metadata": CLIENT_METADATA})
        project = creds.get("project_id") or project_ref(info.get("cloudaicompanionProject"))
        if not project:
            tier = pick_tier(info)
            if tier:
                try:
                    onboard = self._post("onboardUser", token, {"tierId": tier, "metadata": CLIENT_METADATA})
                    project = project_ref((onboard.get("response") or {}).get("cloudaicompanionProject"))
                except ProviderError:
                    project = None
                for _ in range(3):
                    if project:
                        break
                    time.sleep(2)
                    info = self._post("loadCodeAssist", token, {"metadata": CLIENT_METADATA})
                    project = project_ref(info.get("cloudaicompanionProject"))
        if project and creds.get("project_id") != project:
            creds = dict(creds, project_id=project)
            save_creds(creds)
        return project, resolve_plan(info, creds), creds

    # ---------- 조회 ----------
    def fetch(self, cfg: Config, account: dict, save_creds: SaveCreds) -> Usage:
        creds = account["creds"]
        if (creds.get("expires_at") or 0) - REFRESH_MARGIN < now():
            creds = self._refresh(cfg, creds, save_creds)
        token = creds["access_token"]
        try:
            project, plan, creds = self._code_assist(token, creds, save_creds)
        except AuthError:
            creds = self._refresh(cfg, creds, save_creds)
            token = creds["access_token"]
            project, plan, creds = self._code_assist(token, creds, save_creds)

        body = {"project": project} if project else {}
        usage = Usage(plan=plan, email=jwt_claims(creds.get("id_token")).get("email"))
        try:
            usage.windows = parse_quota_summary(self._post("retrieveUserQuotaSummary", token, body))
        except ProviderError as exc:
            usage.warnings.append(f"요약 조회 실패, 모델별 조회로 대체: {exc}")
        if not usage.windows:
            try:
                usage.windows = parse_available_models(self._post("fetchAvailableModels", token, body))
            except ProviderError:
                usage.windows = parse_quota_buckets(self._post("retrieveUserQuota", token, body))
        mark_primary(usage.windows)
        return usage


# ---------- 정규화(순수 함수, 테스트 대상) ----------
def project_ref(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, dict):
        return project_ref(value.get("id") or value.get("projectId"))
    return None


def pick_tier(info: dict) -> Optional[str]:
    tiers = info.get("allowedTiers") or []
    for tier in tiers:
        if tier.get("isDefault") and tier.get("id"):
            return tier["id"]
    for tier in tiers:
        if tier.get("id"):
            return tier["id"]
    for key in ("paidTier", "currentTier"):
        if (info.get(key) or {}).get("id"):
            return info[key]["id"]
    return None


def resolve_plan(info: dict, creds: dict) -> Optional[str]:
    plan = (info.get("planInfo") or {}).get("planType")
    if plan:
        return plan
    tier = (info.get("currentTier") or {}).get("id")
    hosted = jwt_claims(creds.get("id_token")).get("hd")
    return {
        "standard-tier": "Paid",
        "free-tier": "Workspace" if hosted else "Free",
        "legacy-tier": "Legacy",
    }.get(tier, (info.get("currentTier") or {}).get("name"))


def _used_from_remaining(fraction: Any) -> Optional[float]:
    f = to_float(fraction)
    return None if f is None else clamp_pct((1 - f) * 100)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_") or "q"


def _window_seconds(window: Any) -> Optional[int]:
    w = str(window or "").upper()
    if "HOUR" in w:
        m = re.search(r"(\d+)", w)
        return int(m.group(1)) * 3600 if m else 5 * 3600
    if "WEEK" in w:
        return 7 * 86400
    if "DAY" in w:
        return 86400
    return None


def parse_quota_summary(data: Any) -> list[dict]:
    if not isinstance(data, dict):
        return []
    payload = data.get("response") or data.get("summary") or data
    windows: list[dict] = []
    for group in payload.get("groups") or []:
        gname = group.get("displayName") or group.get("name") or "Quota"
        for bucket in group.get("buckets") or []:
            if bucket.get("disabled"):
                continue
            bid = bucket.get("bucketId") or bucket.get("id")
            if not bid:
                continue
            remaining = bucket.get("remainingFraction")
            if remaining is None and isinstance(bucket.get("remaining"), dict):
                rem = bucket["remaining"]
                remaining = rem.get("remainingFraction")
                if remaining is None and rem.get("case") == "remainingFraction":
                    remaining = rem.get("value")
            windows.append(
                make_window(
                    f"{_slug(gname)}:{bid}",
                    bucket.get("displayName") or bucket.get("name") or bid,
                    _used_from_remaining(remaining),
                    iso(parse_iso(bucket.get("resetTime"))),
                    window_seconds=_window_seconds(bucket.get("window")),
                    group=gname,
                )
            )
    return windows


def parse_available_models(data: Any) -> list[dict]:
    windows = []
    models = (data or {}).get("models") or {}
    for model_id, model in sorted(models.items()):
        quota = (model or {}).get("quotaInfo")
        if not isinstance(quota, dict) or quota.get("remainingFraction") is None:
            continue
        windows.append(
            make_window(
                f"model:{model_id}",
                model.get("displayName") or model.get("label") or model_id,
                _used_from_remaining(quota.get("remainingFraction")),
                iso(parse_iso(quota.get("resetTime"))),
                group="모델별",
            )
        )
    return windows


def parse_quota_buckets(data: Any) -> list[dict]:
    best: dict[str, dict] = {}
    for bucket in (data or {}).get("buckets") or []:
        model_id = (bucket.get("modelId") or "").strip()
        if not model_id or bucket.get("remainingFraction") is None:
            continue
        cur = best.get(model_id)
        if cur is None or bucket["remainingFraction"] < cur["remainingFraction"]:
            best[model_id] = bucket
    return [
        make_window(
            f"model:{mid}",
            mid,
            _used_from_remaining(b["remainingFraction"]),
            iso(parse_iso(b.get("resetTime"))),
            group="모델별",
        )
        for mid, b in sorted(best.items())
    ]


def mark_primary(windows: list[dict], limit: int = 2) -> None:
    """작은 위젯에 보여줄 대표 창: 사용률이 가장 높은 것부터 limit 개."""
    ranked = sorted(
        (w for w in windows if w["used_percent"] is not None),
        key=lambda w: w["used_percent"],
        reverse=True,
    )
    for w in ranked[:limit]:
        w["primary"] = True
