"""업스트림 HTTP 를 가짜로 바꿔서 로그인 → 조회 → 토큰 회전 → 계정 관리 흐름을 검증한다."""

import base64
import json
import os
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from unittest import mock

from aiusage import api, http
from aiusage.config import Config
from aiusage.service import UsageService
from aiusage.store import Store

API_KEY = "test-key-0123456789abcdef"


def fake_jwt(payload: dict) -> str:
    enc = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return f"h.{enc}.s"


class FakeUpstream:
    def __init__(self):
        self.calls = []
        self.codex_refresh_count = 0
        self.claude_usage_status = 200
        self.oauth_cedar = None  # dict 면 OAuth 응답에 초기화권, "reject" 면 cedar_ember=1 을 거부

    def __call__(self, method, url, headers=None, json_body=None, form=None, timeout=20):
        self.calls.append((method, url, headers or {}, json_body, form))
        u = urllib.parse.urlparse(url)
        hdrs = headers or {}

        def resp(obj, status=200, extra=None):
            return http.Response(status, extra or {}, json.dumps(obj).encode())

        # ---- Claude ----
        if url == "https://platform.claude.com/v1/oauth/token":
            if json_body["grant_type"] == "authorization_code":
                assert json_body["code"] == "claudecode" and json_body["code_verifier"]
                return resp({"access_token": "c-at-1", "refresh_token": "c-rt-1", "expires_in": 28800,
                             "scope": "user:profile user:inference",
                             "account": {"email_address": "me@example.com"}, "organization": {"uuid": "org-1"}})
            assert json_body["refresh_token"] == "c-rt-1"
            return resp({"access_token": "c-at-2", "refresh_token": "c-rt-2", "expires_in": 28800})
        if url == "https://api.anthropic.com/api/oauth/profile":
            return resp({"organization": {"uuid": "org-1", "organization_type": "claude_max", "rate_limit_tier": "default_claude_max_5x"}})
        if url == "https://api.anthropic.com/api/oauth/organizations/org-1/prepaid/credits":
            assert hdrs["x-organization-uuid"] == "org-1"
            return resp({"amount": 2300, "currency": "USD"})  # 센트
        if f"{u.scheme}://{u.netloc}{u.path}" == "https://api.anthropic.com/api/oauth/usage":
            assert hdrs["anthropic-beta"] == "oauth-2025-04-20"
            if self.claude_usage_status != 200:
                return resp({"error": "x"}, self.claude_usage_status)
            cedar = urllib.parse.parse_qs(u.query).get("cedar_ember") == ["1"]
            if cedar and self.oauth_cedar == "reject":
                return resp({"error": "unknown parameter"}, 400)
            body = {"five_hour": {"utilization": 10, "resets_at": "2026-10-03T05:00:00Z"},
                    "seven_day": {"utilization": 20, "resets_at": "2026-10-09T00:00:00Z"},
                    "extra_usage": {"is_enabled": True, "used_credits": 1240, "monthly_limit": 5000, "utilization": 24.8, "currency": "USD"},
                    "cinder_cove": {"utilization": 40, "resets_at": "2099-02-01T00:00:00Z"}}
            if cedar and isinstance(self.oauth_cedar, dict):
                body["cedar_ember"] = self.oauth_cedar
            return resp(body)
        if url == "https://claude.ai/api/organizations":
            return resp([{"uuid": "org-api", "capabilities": ["api"]}, {"uuid": "org-1", "capabilities": ["chat"]}])
        if u.netloc == "claude.ai" and u.path == "/api/organizations/org-1/usage":
            assert hdrs["Cookie"] == "sessionKey=sk-ant-sid-test"
            return resp({"five_hour": {"utilization": 11, "resets_at": None},
                         "cedar_ember": {"eligible": True, "grants": [
                             {"resets_left": 1, "ends_at": "2099-01-01T00:00:00Z", "paused": False}]}})

        # ---- Codex ----
        if url == "https://auth.openai.com/oauth/token":
            if form:  # authorization_code
                assert form["code"] == "codexcode"
                return resp({"access_token": fake_jwt({"exp": 1}), "refresh_token": "x-rt-1",
                             "id_token": fake_jwt({"email": "me@example.com", "https://api.openai.com/auth": {
                                 "chatgpt_account_id": "acct-9", "chatgpt_plan_type": "plus"}})})
            self.codex_refresh_count += 1
            n = self.codex_refresh_count
            return resp({"access_token": fake_jwt({"exp": 4102444800}), "refresh_token": f"x-rt-{n + 1}"})
        if url == "https://chatgpt.com/backend-api/wham/usage":
            assert hdrs["ChatGPT-Account-Id"] == "acct-9"
            return resp({"plan_type": "plus", "rate_limit": {
                "primary_window": {"used_percent": 50, "reset_at": 4102444800, "limit_window_seconds": 18000},
                "secondary_window": {"used_percent": 70, "reset_at": 4102444800, "limit_window_seconds": 604800}}})
        if url == "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits":
            return resp({"available_count": 1, "credits": [{"id": "r", "status": "available",
                                                           "expires_at": "2099-01-01T00:00:00Z"}]})
        raise AssertionError(f"unexpected call {method} {url}")


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Config(api_key=API_KEY, data_dir=self.tmp.name, host="127.0.0.1", port=0, poll_interval=300,
                          min_refresh_interval=60, antigravity_client_id=None, antigravity_client_secret=None,
                          antigravity_redirect_uri="http://127.0.0.1:8585/callback",
                          codex_redirect_uri="http://localhost:1455/auth/callback")
        self.fake = FakeUpstream()
        self.patch = mock.patch.object(http, "request", self.fake)
        self.patch.start()
        self.svc = UsageService(self.cfg, Store(self.tmp.name))
        self.server = api.serve(self.svc, "127.0.0.1", 0)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.svc.stop()
        self.patch.stop()
        self.tmp.cleanup()

    def stored(self):
        with open(os.path.join(self.tmp.name, "accounts.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def call(self, method, path, body=None, key=API_KEY):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {key}")
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_auth_required(self):
        self.assertEqual(self.call("GET", "/v1/usage", key="wrong")[0], 401)
        with urllib.request.urlopen(self.base + "/healthz") as r:
            self.assertEqual(r.status, 200)

    def test_login_not_found_is_404(self):
        # 클라이언트는 언어와 상관없이 404 로 '로그인을 처음부터 다시'를 알아본다
        self.assertEqual(self.call("POST", "/v1/logins/nope/complete", {"input": "x#y"})[0], 404)
        self.assertEqual(self.call("POST", "/v1/logins", {"provider": "codex", "account_id": "claude_none"})[0], 404)

    def test_providers(self):
        status, body = self.call("GET", "/v1/providers")
        info = {p["id"]: p for p in body["providers"]}
        self.assertTrue(info["claude"]["configured"])
        self.assertFalse(info["antigravity"]["configured"])
        status, body = self.call("POST", "/v1/logins", {"provider": "antigravity"})
        self.assertEqual(status, 400)

    def test_claude_oauth_then_session_key(self):
        status, start = self.call("POST", "/v1/logins", {"provider": "claude", "label": "개인"})
        self.assertEqual(status, 200)
        q = urllib.parse.parse_qs(urllib.parse.urlparse(start["authorize_url"]).query)
        self.assertEqual(q["redirect_uri"], ["https://platform.claude.com/oauth/code/callback"])
        self.assertEqual(q["code_challenge_method"], ["S256"])
        state = q["state"][0]

        status, err = self.call("POST", f"/v1/logins/{start['login_id']}/complete", {"input": "claudecode#WRONG"})
        self.assertEqual(status, 400)
        status, acc = self.call("POST", f"/v1/logins/{start['login_id']}/complete", {"input": f"claudecode#{state}"})
        self.assertEqual(status, 200, acc)
        self.assertEqual(acc["label"], "개인")
        self.assertEqual(acc["email"], "me@example.com")
        self.assertEqual(acc["plan"], "default_claude_max_5x")
        self.assertEqual(acc["status"], "ok")
        self.assertTrue(acc["auth"]["reset_credits_supported"])  # OAuth 로도 초기화권을 받을 수 있다

        status, usage = self.call("GET", "/v1/usage")
        entry = usage["accounts"][0]
        self.assertEqual([w["key"] for w in entry["windows"]], ["session", "weekly", "cowork_credit"])
        self.assertEqual(entry["windows"][2]["kind"], "credit")
        self.assertIsNone(entry["reset_credits"])
        # 금액은 센트로 오므로 달러로 바꾼다
        self.assertEqual(entry["extra"]["extra_usage"], {"used": 12.4, "limit": 50.0, "used_percent": 24.8, "currency": "USD"})
        self.assertEqual(entry["extra"]["prepaid"], {"balance": 23.0, "currency": "USD"})

        # OAuth 만으로 초기화권(cedar_ember=1). 거부되면 옵션 없이 다시 조회한다.
        self.fake.oauth_cedar = {"eligible": True, "grants": [{"resets_left": 2, "ends_at": "2099-03-01T00:00:00Z", "paused": False}]}
        entry = self.call("POST", f"/v1/accounts/{acc['id']}/refresh")[1]
        self.assertEqual(entry["reset_credits"]["available"], 2)
        self.fake.oauth_cedar = "reject"
        entry = self.call("POST", f"/v1/accounts/{acc['id']}/refresh")[1]
        self.assertEqual(entry["status"], "ok")
        self.assertIsNone(entry["reset_credits"])
        self.fake.oauth_cedar = None

        status, acc2 = self.call("PATCH", f"/v1/accounts/{acc['id']}", {"session_key": "sk-ant-sid-test"})
        self.assertEqual(status, 200, acc2)
        self.assertTrue(acc2["auth"]["session_key"])
        status, usage = self.call("GET", "/v1/usage")
        entry = usage["accounts"][0]
        self.assertEqual(entry["windows"][0]["used_percent"], 10)  # OAuth 값 우선
        self.assertEqual(entry["reset_credits"]["available"], 1)

        # 401 → 리프레시 → 회전된 토큰이 파일에 저장되는지
        self.fake.claude_usage_status = 401
        self.call("POST", f"/v1/accounts/{acc['id']}/refresh")
        stored = self.stored()
        self.assertEqual(stored[acc["id"]]["creds"]["oauth"]["refresh_token"], "c-rt-2")
        status, usage = self.call("GET", "/v1/usage")
        self.assertEqual(usage["accounts"][0]["status"], "needs_login")
        self.assertTrue(usage["accounts"][0]["stale"])

        # 비밀값이 계정 목록에 노출되지 않는지
        status, listing = self.call("GET", "/v1/accounts")
        raw = json.dumps(listing)
        for secret in ("c-rt-2", "c-at-2", "sk-ant-sid-test"):
            self.assertNotIn(secret, raw)

        # 예전 버전이 저장한 코드네임 창은 응답에서 빠진다(조회가 계속 실패해 스냅숏이 그대로여도)
        snap = self.svc.store.get_snapshot(acc["id"])
        snap["windows"] = snap["windows"] + [{"key": "iguana_necktie", "label": "iguana necktie", "used_percent": 1}]
        self.svc.store.put_snapshot(acc["id"], snap)
        status, usage = self.call("GET", "/v1/usage")
        self.assertNotIn("iguana_necktie", [w["key"] for w in usage["accounts"][0]["windows"]])

    def test_codex_flow_and_rotation(self):
        status, start = self.call("POST", "/v1/logins", {"provider": "codex"})
        state = urllib.parse.parse_qs(urllib.parse.urlparse(start["authorize_url"]).query)["state"][0]
        cb = f"http://localhost:1455/auth/callback?code=codexcode&scope=openid&state={state}"
        status, acc = self.call("POST", f"/v1/logins/{start['login_id']}/complete", {"input": cb})
        self.assertEqual(status, 200, acc)
        self.assertEqual(acc["label"], "me")
        self.assertEqual(acc["plan"], "plus")
        self.assertEqual(self.fake.codex_refresh_count, 1)  # exp=1 이라 즉시 갱신

        status, usage = self.call("GET", "/v1/usage")
        entry = usage["accounts"][0]
        self.assertEqual(entry["status"], "ok")
        self.assertEqual([w["label"] for w in entry["windows"]], ["5시간", "주간"])
        self.assertEqual(entry["reset_credits"]["available"], 1)
        stored = self.stored()
        self.assertEqual(stored[acc["id"]]["creds"]["refresh_token"], "x-rt-2")

        # 같은 이메일로 다시 로그인하면 새 계정이 아니라 기존 계정을 갱신
        status, start = self.call("POST", "/v1/logins", {"provider": "codex"})
        state = urllib.parse.parse_qs(urllib.parse.urlparse(start["authorize_url"]).query)["state"][0]
        self.call("POST", f"/v1/logins/{start['login_id']}/complete",
                  {"input": f"http://localhost:1455/auth/callback?code=codexcode&state={state}"})
        status, listing = self.call("GET", "/v1/accounts")
        self.assertEqual(len(listing["accounts"]), 1)

        status, _ = self.call("PATCH", f"/v1/accounts/{acc['id']}", {"label": "회사", "enabled": False})
        status, usage = self.call("GET", "/v1/usage")
        self.assertEqual(usage["accounts"], [])
        status, _ = self.call("DELETE", f"/v1/accounts/{acc['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(self.call("GET", "/v1/accounts")[1]["accounts"], [])

    def test_claude_session_key_only(self):
        status, acc = self.call("POST", "/v1/accounts",
                                {"provider": "claude", "session_key": "sk-ant-sid-test", "label": "웹"})
        self.assertEqual(status, 200, acc)
        status, usage = self.call("GET", "/v1/usage?accounts=웹".replace("웹", urllib.parse.quote("웹")))
        entry = usage["accounts"][0]
        self.assertEqual(entry["windows"][0]["used_percent"], 11)
        self.assertEqual(entry["reset_credits"]["available"], 1)
        self.assertEqual(self.call("POST", "/v1/accounts", {"provider": "claude", "session_key": "bad"})[0], 400)

        # 위젯에서 숨기면 기본 응답에서는 빠지고, 앱이 쓰는 ?all=1 에는 enabled=false 로 남는다
        self.call("PATCH", f"/v1/accounts/{acc['id']}", {"enabled": False})
        self.assertEqual(self.call("GET", "/v1/usage")[1]["accounts"], [])
        hidden = self.call("GET", "/v1/usage?all=1")[1]["accounts"]
        self.assertEqual([(a["id"], a["enabled"]) for a in hidden], [(acc["id"], False)])
        self.assertEqual(hidden[0]["windows"][0]["used_percent"], 11)


if __name__ == "__main__":
    unittest.main()
