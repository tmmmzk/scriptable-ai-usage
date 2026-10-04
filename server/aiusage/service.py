from __future__ import annotations

import logging
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Iterable, Optional

from . import providers
from .config import Config
from .errors import LoginError, LoginNotFound, ProviderError
from .store import Store
from .util import iso, now, parse_iso

log = logging.getLogger("aiusage")

LOGIN_TTL = 15 * 60


class UsageService:
    def __init__(self, cfg: Config, store: Store):
        self.cfg = cfg
        self.store = store
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._logins: dict[str, dict] = {}
        self._logins_guard = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="fetch")
        self._stop = threading.Event()

    # ---------- 공개 표현 ----------
    def _common(self, acc: dict, snap: dict) -> dict:
        """계정 목록과 사용량 응답에 공통으로 들어가는 필드."""
        provider = providers.get(acc["provider"])
        return {
            "id": acc["id"],
            "code": acc.get("code"),
            "provider": acc["provider"],
            "provider_name": provider.name if provider else acc["provider"],
            "label": acc.get("label"),
            "email": acc.get("email"),
            "status": snap.get("status", "pending"),
            "error": snap.get("error"),
            "fetched_at": snap.get("fetched_at"),
            "last_success_at": snap.get("last_success_at"),
        }

    def public_account(self, acc: dict) -> dict:
        provider = providers.get(acc["provider"])
        snap = self.store.get_snapshot(acc["id"]) or {}
        return {
            **self._common(acc, snap),
            "plan": acc.get("plan"),
            "enabled": acc.get("enabled", True),
            "order": acc.get("order", 0),
            "created_at": acc.get("created_at"),
            "auth": provider.describe_creds(acc.get("creds") or {}) if provider else {},
        }

    def usage_entry(self, acc: dict) -> dict:
        snap = self.store.get_snapshot(acc["id"]) or {}
        provider = providers.get(acc["provider"])
        windows = snap.get("windows", [])
        return {
            **self._common(acc, snap),
            "plan": snap.get("plan") or acc.get("plan"),
            "enabled": acc.get("enabled", True),
            "warnings": snap.get("warnings", []),
            "stale": snap.get("stale", False),
            "windows": provider.visible_windows(windows) if provider else windows,
            "reset_credits": snap.get("reset_credits"),
            "extra": snap.get("extra", {}),
        }

    # ---------- 조회 ----------
    def _lock_for(self, account_id: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(account_id, threading.Lock())

    def refresh_account(self, account_id: str, force: bool = False) -> Optional[dict]:
        # 리프레시 토큰 회전 때문에 같은 계정을 동시에 갱신하면 안 된다.
        with self._lock_for(account_id):
            acc = self.store.get(account_id)
            if acc is None:
                return None
            prev = self.store.get_snapshot(account_id) or {}
            last = parse_iso(prev.get("fetched_at")) or 0
            if not force and now() - last < self.cfg.min_refresh_interval:
                return prev
            provider = providers.get(acc["provider"])
            if provider is None:
                return prev
            snap = dict(prev)
            snap["fetched_at"] = iso(now())
            try:
                usage = provider.fetch(self.cfg, acc, lambda creds: self.store.save_creds(account_id, creds))
                snap.update(
                    status="partial" if usage.warnings else "ok",
                    error=None,
                    warnings=usage.warnings,
                    stale=False,
                    windows=usage.windows,
                    reset_credits=usage.reset_credits,
                    extra=usage.extra,
                    plan=usage.plan or prev.get("plan"),
                    last_success_at=snap["fetched_at"],
                )
                if usage.email and not acc.get("email"):
                    self.store.update(account_id, lambda a: a.__setitem__("email", usage.email))
                if usage.plan and usage.plan != acc.get("plan"):
                    self.store.update(account_id, lambda a: a.__setitem__("plan", usage.plan))
            except ProviderError as exc:
                log.warning("fetch %s failed: %s", account_id, exc)
                snap.update(status=exc.kind, error=str(exc), stale=bool(prev.get("windows")))
            except Exception as exc:  # noqa: BLE001 - 위젯이 죽지 않도록 모든 오류를 상태로 변환
                log.exception("fetch %s crashed", account_id)
                snap.update(status="error", error=f"내부 오류: {exc}", stale=bool(prev.get("windows")))
            self.store.put_snapshot(account_id, snap)
            return snap

    def refresh_many(self, account_ids: Iterable[str], timeout: float = 25) -> None:
        futures = [self._pool.submit(self.refresh_account, aid) for aid in account_ids]
        wait(futures, timeout=timeout)

    def usage_payload(self, ids: Optional[list[str]] = None, refresh: bool = False, include_hidden: bool = False) -> dict:
        """위젯에서 숨긴 계정(enabled=False)은 빼고 준다. 앱은 include_hidden 으로 모두 받는다."""
        accounts = [a for a in self.store.list_accounts() if include_hidden or a.get("enabled", True)]
        if ids:
            wanted = set(ids)
            accounts = [a for a in accounts if wanted & {a["id"], a.get("code"), a.get("label") or ""}]
        if refresh:
            self.refresh_many([a["id"] for a in accounts])
        return {
            "generated_at": iso(now()),
            "poll_interval": self.cfg.poll_interval,
            "accounts": [self.usage_entry(a) for a in accounts],
        }

    # ---------- 백그라운드 폴링 ----------
    def start_poller(self) -> None:
        def loop() -> None:
            while not self._stop.is_set():
                # 위젯에서 숨긴 계정도 앱에서는 보이므로 같이 조회한다
                ids = [a["id"] for a in self.store.list_accounts()]
                self.refresh_many(ids, timeout=120)
                self._expire_logins()
                self._stop.wait(self.cfg.poll_interval)

        threading.Thread(target=loop, name="poller", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        self._pool.shutdown(wait=False)

    # ---------- 로그인 ----------
    def _expire_logins(self) -> None:
        cutoff = now() - LOGIN_TTL
        with self._logins_guard:
            for key in [k for k, v in self._logins.items() if v["created"] < cutoff]:
                del self._logins[key]

    def start_login(self, provider_id: str, label: Optional[str], account_id: Optional[str]) -> dict:
        provider = providers.get(provider_id)
        if provider is None:
            raise LoginError(f"알 수 없는 서비스: {provider_id}")
        if account_id:
            acc = self.store.get(account_id)
            if acc is None or acc["provider"] != provider_id:
                raise LoginNotFound("재로그인할 계정을 찾을 수 없습니다.")
        start = provider.start_login(self.cfg)
        login_id = secrets.token_urlsafe(16)
        self._expire_logins()
        with self._logins_guard:
            self._logins[login_id] = {
                "provider": provider_id,
                "label": label,
                "account_id": account_id,
                "pending": start.pending,
                "created": now(),
            }
        return {
            "login_id": login_id,
            "provider": provider_id,
            "authorize_url": start.authorize_url,
            "instructions": start.instructions,
            "input_hint": start.input_hint,
            "expires_at": iso(now() + LOGIN_TTL),
        }

    def complete_login(self, login_id: str, user_input: str) -> dict:
        with self._logins_guard:
            entry = self._logins.get(login_id)
        if entry is None:
            raise LoginNotFound("로그인 세션이 없거나 만료되었습니다. 처음부터 다시 시작하세요.")
        provider = providers.get(entry["provider"])
        result = provider.finish_login(self.cfg, entry["pending"], user_input)
        with self._logins_guard:
            self._logins.pop(login_id, None)
        acc = self._upsert(entry["provider"], entry.get("account_id"), entry.get("label"), result)
        self.refresh_account(acc["id"], force=True)
        return self.public_account(self.store.get(acc["id"]))

    def create_manual(self, provider_id: str, payload: dict) -> dict:
        provider = providers.get(provider_id)
        if provider is None:
            raise LoginError(f"알 수 없는 서비스: {provider_id}")
        result = provider.create_manual(self.cfg, payload)
        acc = self._upsert(provider_id, None, payload.get("label"), result)
        self.refresh_account(acc["id"], force=True)
        return self.public_account(self.store.get(acc["id"]))

    def _upsert(self, provider_id: str, account_id: Optional[str], label: Optional[str], result) -> dict:
        existing = self.store.get(account_id) if account_id else self.store.find(provider_id, result.email)
        if existing:
            def apply(a: dict) -> None:
                merged = dict(a.get("creds") or {})
                merged.update(result.creds)  # Claude 는 sessionKey 를 유지한 채 OAuth 만 교체
                a["creds"] = merged
                if result.email:
                    a["email"] = result.email
                if result.plan:
                    a["plan"] = result.plan
                if label:
                    a["label"] = label

            return self.store.update(existing["id"], apply)
        provider = providers.get(provider_id)
        default_label = result.email.split("@")[0] if result.email else provider.name
        return self.store.create(provider_id, label or default_label, result.creds, result.email, result.plan)

    # ---------- 계정 수정 ----------
    def patch_account(self, account_id: str, body: dict) -> Optional[dict]:
        acc = self.store.get(account_id)
        if acc is None:
            return None
        session_key = body.get("session_key")
        if session_key is not None and acc["provider"] != "claude":
            raise LoginError("session_key 는 Claude 계정에만 설정할 수 있습니다.")
        if session_key and not str(session_key).startswith("sk-ant-"):
            raise LoginError("sessionKey 는 'sk-ant-' 로 시작해야 합니다.")
        if session_key == "" and not (acc.get("creds") or {}).get("oauth"):
            raise LoginError("OAuth 로그인이 없는 계정에서는 sessionKey 를 지울 수 없습니다.")

        def apply(a: dict) -> None:
            if "label" in body and str(body["label"]).strip():
                a["label"] = str(body["label"]).strip()
            if "enabled" in body:
                a["enabled"] = bool(body["enabled"])
            if "order" in body and isinstance(body["order"], (int, float)):
                a["order"] = body["order"]
            if session_key is not None:
                creds = dict(a.get("creds") or {})
                if session_key:
                    creds["session_key"] = session_key
                else:
                    creds.pop("session_key", None)
                a["creds"] = creds

        updated = self.store.update(account_id, apply)
        if session_key is not None:
            self.refresh_account(account_id, force=True)
        return self.public_account(updated)

    def providers_info(self) -> list[dict]:
        out = []
        for p in providers.PROVIDERS.values():
            ok, reason = p.is_configured(self.cfg)
            out.append({"id": p.id, "name": p.name, "methods": list(p.methods), "configured": ok, "reason": reason})
        return out
