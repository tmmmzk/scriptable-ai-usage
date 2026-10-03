from __future__ import annotations

import hmac
import json
import logging
import re
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional

from . import __version__
from .errors import LoginError, ProviderError
from .service import UsageService

log = logging.getLogger("aiusage.api")

MAX_BODY = 64 * 1024


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


Route = tuple[str, "re.Pattern[str]", Callable[..., Any]]


def build_routes(svc: UsageService) -> list[Route]:
    def usage(q: dict, body: dict) -> Any:
        ids = [s for s in (q.get("accounts", [""])[0]).split(",") if s.strip()]
        refresh = q.get("refresh", ["0"])[0] in ("1", "true", "yes")
        return svc.usage_payload(ids or None, refresh=refresh)

    def list_accounts(q: dict, body: dict) -> Any:
        return {"accounts": [svc.public_account(a) for a in svc.store.list_accounts()]}

    def create_account(q: dict, body: dict) -> Any:
        provider = body.get("provider")
        if not provider:
            raise ApiError(400, "provider 가 필요합니다.")
        return svc.create_manual(provider, body)

    def get_account(q: dict, body: dict, account_id: str) -> Any:
        acc = svc.store.get(account_id)
        if acc is None:
            raise ApiError(404, "계정이 없습니다.")
        return {"account": svc.public_account(acc), "usage": svc.usage_entry(acc)}

    def patch_account(q: dict, body: dict, account_id: str) -> Any:
        acc = svc.patch_account(account_id, body)
        if acc is None:
            raise ApiError(404, "계정이 없습니다.")
        return acc

    def delete_account(q: dict, body: dict, account_id: str) -> Any:
        if not svc.store.delete(account_id):
            raise ApiError(404, "계정이 없습니다.")
        return {"deleted": account_id}

    def refresh_account(q: dict, body: dict, account_id: str) -> Any:
        if svc.refresh_account(account_id, force=True) is None:
            raise ApiError(404, "계정이 없습니다.")
        return svc.usage_entry(svc.store.get(account_id))

    def start_login(q: dict, body: dict) -> Any:
        if not body.get("provider"):
            raise ApiError(400, "provider 가 필요합니다.")
        return svc.start_login(body["provider"], body.get("label"), body.get("account_id"))

    def complete_login(q: dict, body: dict, login_id: str) -> Any:
        if not body.get("input"):
            raise ApiError(400, "input(리다이렉트 URL 또는 코드)이 필요합니다.")
        return svc.complete_login(login_id, body["input"])

    def provider_list(q: dict, body: dict) -> Any:
        return {"providers": svc.providers_info()}

    acc = r"(?P<account_id>[A-Za-z0-9_-]+)"
    return [
        ("GET", re.compile(r"^/v1/usage$"), usage),
        ("GET", re.compile(r"^/v1/providers$"), provider_list),
        ("GET", re.compile(r"^/v1/accounts$"), list_accounts),
        ("POST", re.compile(r"^/v1/accounts$"), create_account),
        ("GET", re.compile(rf"^/v1/accounts/{acc}$"), get_account),
        ("PATCH", re.compile(rf"^/v1/accounts/{acc}$"), patch_account),
        ("DELETE", re.compile(rf"^/v1/accounts/{acc}$"), delete_account),
        ("POST", re.compile(rf"^/v1/accounts/{acc}/refresh$"), refresh_account),
        ("POST", re.compile(r"^/v1/logins$"), start_login),
        ("POST", re.compile(r"^/v1/logins/(?P<login_id>[A-Za-z0-9_-]+)/complete$"), complete_login),
    ]


def make_handler(svc: UsageService) -> type[BaseHTTPRequestHandler]:
    routes = build_routes(svc)
    api_key = svc.cfg.api_key.encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        server_version = f"aiusage/{__version__}"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # 토큰이 로그에 남지 않도록 경로만
            log.info("%s %s", self.command, self.path.split("?")[0])

        def _send(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            token = header[7:].strip() if header.lower().startswith("bearer ") else self.headers.get("X-API-Key", "")
            return hmac.compare_digest(token.encode("utf-8"), api_key)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise ApiError(413, "요청 본문이 너무 큽니다.")
            if not length:
                return {}
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise ApiError(400, "JSON 본문을 읽을 수 없습니다.")
            if not isinstance(data, dict):
                raise ApiError(400, "JSON 객체가 필요합니다.")
            return data

        def _dispatch(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            try:
                if path == "/healthz" and self.command == "GET":
                    return self._send(200, {"ok": True, "version": __version__})
                if not self._authorized():
                    raise ApiError(401, "API 키가 올바르지 않습니다.")
                matched_path = False
                for method, pattern, fn in routes:
                    m = pattern.match(path)
                    if not m:
                        continue
                    matched_path = True
                    if method != self.command:
                        continue
                    body = self._body() if self.command in ("POST", "PATCH") else {}
                    query = urllib.parse.parse_qs(parsed.query)
                    return self._send(200, fn(query, body, **m.groupdict()))
                raise ApiError(405 if matched_path else 404, "지원하지 않는 경로입니다.")
            except ApiError as exc:
                self._send(exc.status, {"error": str(exc)})
            except LoginError as exc:
                self._send(400, {"error": str(exc)})
            except ProviderError as exc:
                self._send(502, {"error": str(exc), "kind": exc.kind})
            except Exception:  # noqa: BLE001
                log.exception("unhandled error")
                self._send(500, {"error": "서버 내부 오류"})

        do_GET = do_POST = do_PATCH = do_DELETE = _dispatch

    return Handler


def serve(svc: UsageService, host: str, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(svc))
    server.daemon_threads = True
    return server


def run(svc: UsageService, host: str, port: int, ready: Optional[Callable[[], None]] = None) -> None:
    server = serve(svc, host, port)
    log.info("listening on http://%s:%d", host, port)
    if ready:
        ready()
    try:
        server.serve_forever()
    finally:
        server.server_close()
