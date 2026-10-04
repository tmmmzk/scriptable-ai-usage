from __future__ import annotations

import copy
import json
import os
import secrets
import threading
from typing import Any, Callable, Optional

from .util import iso, now


def assign_codes(accounts: list[dict]) -> bool:
    """위젯 Parameter 에 쓰는 계정 번호(4자리). id 로 정하고 겹치면 다음 번호.
    한 번 정하면 저장해 두어 바뀌지 않는다. 번호를 새로 붙였으면 True."""
    used = {a["code"] for a in accounts if a.get("code")}
    changed = False
    for acc in accounts:
        if acc.get("code"):
            continue
        h = 0
        for ch in acc["id"]:
            h = (h * 31 + ord(ch)) & 0xFFFFFFFF
        n = 1000 + h % 9000
        while str(n) in used:
            n = 1000 if n == 9999 else n + 1
        acc["code"] = str(n)
        used.add(acc["code"])
        changed = True
    return changed


class Store:
    """계정(자격증명 포함)과 마지막 스냅샷을 JSON 파일로 저장한다.

    리프레시 토큰이 매번 회전하는 서비스가 있으므로, 자격증명이 바뀌면 즉시 원자적으로 기록한다.
    """

    def __init__(self, data_dir: str):
        os.makedirs(data_dir, mode=0o700, exist_ok=True)
        self._accounts_path = os.path.join(data_dir, "accounts.json")
        self._snapshots_path = os.path.join(data_dir, "snapshots.json")
        self._lock = threading.RLock()
        self._accounts: dict[str, dict] = self._read(self._accounts_path, {})
        self._snapshots: dict[str, dict] = self._read(self._snapshots_path, {})
        if assign_codes(self._ordered()):  # 번호가 없던 예전 계정
            self._write(self._accounts_path, self._accounts)

    # ---- 파일 I/O ----
    @staticmethod
    def _read(path: str, default: Any) -> Any:
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except FileNotFoundError:
            return default

    @staticmethod
    def _write(path: str, data: Any) -> None:
        tmp = f"{path}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    # ---- 계정 ----
    def _ordered(self) -> list[dict]:
        return sorted(self._accounts.values(), key=lambda a: (a.get("order", 0), a.get("created_at", "")))

    def list_accounts(self) -> list[dict]:
        with self._lock:
            accounts = [copy.deepcopy(a) for a in self._accounts.values()]
        return sorted(accounts, key=lambda a: (a.get("order", 0), a.get("created_at", "")))

    def get(self, account_id: str) -> Optional[dict]:
        with self._lock:
            acc = self._accounts.get(account_id)
            return copy.deepcopy(acc) if acc else None

    def find(self, provider: str, email: Optional[str]) -> Optional[dict]:
        if not email:
            return None
        with self._lock:
            for acc in self._accounts.values():
                if acc["provider"] == provider and (acc.get("email") or "").lower() == email.lower():
                    return copy.deepcopy(acc)
        return None

    def create(self, provider: str, label: str, creds: dict, email: Optional[str], plan: Optional[str]) -> dict:
        with self._lock:
            account_id = f"{provider}_{secrets.token_hex(4)}"
            order = max([a.get("order", 0) for a in self._accounts.values()] + [0]) + 1
            acc = {
                "id": account_id,
                "provider": provider,
                "label": label,
                "email": email,
                "plan": plan,
                "enabled": True,
                "order": order,
                "created_at": iso(now()),
                "creds": creds,
            }
            self._accounts[account_id] = acc
            assign_codes(self._ordered())
            self._write(self._accounts_path, self._accounts)
            return copy.deepcopy(acc)

    def update(self, account_id: str, fn: Callable[[dict], None]) -> Optional[dict]:
        with self._lock:
            acc = self._accounts.get(account_id)
            if acc is None:
                return None
            fn(acc)
            self._write(self._accounts_path, self._accounts)
            return copy.deepcopy(acc)

    def save_creds(self, account_id: str, creds: dict) -> None:
        def apply(acc: dict) -> None:
            acc["creds"] = creds

        self.update(account_id, apply)

    def delete(self, account_id: str) -> bool:
        with self._lock:
            if self._accounts.pop(account_id, None) is None:
                return False
            self._snapshots.pop(account_id, None)
            self._write(self._accounts_path, self._accounts)
            self._write(self._snapshots_path, self._snapshots)
            return True

    # ---- 스냅샷 ----
    def get_snapshot(self, account_id: str) -> Optional[dict]:
        with self._lock:
            snap = self._snapshots.get(account_id)
            return copy.deepcopy(snap) if snap else None

    def put_snapshot(self, account_id: str, snapshot: dict) -> None:
        with self._lock:
            if account_id not in self._accounts:
                return
            self._snapshots[account_id] = snapshot
            self._write(self._snapshots_path, self._snapshots)
