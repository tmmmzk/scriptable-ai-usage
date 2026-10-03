import unittest

from aiusage.providers import antigravity, claude, codex
from aiusage.providers.base import parse_callback_input
from aiusage.errors import LoginError
from aiusage.util import parse_iso

NOW = parse_iso("2026-10-03T00:00:00Z")


class ClaudeParserTest(unittest.TestCase):
    def test_windows(self):
        data = {
            "five_hour": {"utilization": 42.5, "resets_at": "2026-10-03T03:00:00.123456+00:00"},
            "seven_day": {"utilization": 18, "resets_at": "2026-10-08T00:00:00Z"},
            "seven_day_opus": None,
            "seven_day_sonnet": {"utilization": 5, "resets_at": None},
            "seven_day_cowork": {"utilization": 1, "resets_at": "2026-10-08T00:00:00Z"},
            "extra_usage": {"is_enabled": True, "used_credits": 120, "monthly_limit": 5000, "utilization": 2.4},
        }
        w = {x["key"]: x for x in claude.parse_windows(data)}
        self.assertEqual(w["session"]["used_percent"], 42.5)
        self.assertEqual(w["session"]["remaining_percent"], 57.5)
        self.assertEqual(w["session"]["resets_at"], "2026-10-03T03:00:00Z")
        self.assertTrue(w["session"]["primary"] and w["weekly"]["primary"])
        self.assertNotIn("weekly_opus", w)
        self.assertIn("weekly_sonnet", w)
        self.assertIn("seven_day_cowork", w)
        self.assertEqual(claude.parse_extra_usage(data)["extra_usage"]["used_percent"], 2.4)

    def test_reset_credits(self):
        block = {
            "eligible": True,
            "grants": [
                {"id": "a", "resets_left": 2, "ends_at": "2026-10-08T00:00:00Z", "paused": False},
                {"id": "b", "resets_left": 1, "ends_at": "2026-10-04T00:00:00Z", "paused": False},
                {"id": "c", "resets_left": 1, "ends_at": None, "paused": False},
                {"id": "paused", "resets_left": 1, "ends_at": "2026-10-04T00:00:00Z", "paused": True},
                {"id": "used", "resets_left": 0, "paused": False},
                {"id": "expired", "resets_left": 1, "ends_at": "2026-10-01T00:00:00Z", "paused": False},
                {"id": "future", "resets_left": 1, "starts_at": "2026-10-05T00:00:00Z", "paused": False},
                {"id": "no_pause_field", "resets_left": 1},
            ],
        }
        rc = claude.parse_reset_credits(block, NOW)
        self.assertEqual(rc["available"], 4)
        self.assertEqual(rc["next_expires_at"], "2026-10-04T00:00:00Z")
        self.assertEqual(rc["expirations"][-1], None)
        self.assertIsNone(claude.parse_reset_credits({"eligible": False, "grants": []}, NOW))
        self.assertIsNone(claude.parse_reset_credits(None, NOW))


class CodexParserTest(unittest.TestCase):
    def test_windows_and_credits(self):
        data = {
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {"used_percent": 31, "reset_at": 1790000000, "limit_window_seconds": 18000},
                "secondary_window": {"used_percent": 64, "reset_at": 1790500000, "limit_window_seconds": 604800},
            },
            "additional_rate_limits": [
                {
                    "limit_name": "GPT-5.3-Codex-Spark",
                    "rate_limit": {
                        "primary_window": {"used_percent": 3, "reset_at": 1790000000, "limit_window_seconds": 18000}
                    },
                },
                "garbage",
            ],
            "credits": {"has_credits": True, "unlimited": False, "balance": "12.5"},
        }
        ws = codex.parse_windows(data)
        self.assertEqual([w["key"] for w in ws], ["session", "weekly", "GPT-5.3-Codex-Spark:session"])
        self.assertEqual(ws[0]["label"], "5시간")
        self.assertEqual(ws[1]["label"], "주간")
        self.assertEqual(ws[2]["group"], "GPT-5.3-Codex-Spark")
        self.assertEqual(codex.parse_extra(data)["credits"]["balance"], 12.5)

    def test_reset_credits(self):
        data = {
            "available_count": 2,
            "credits": [
                {"id": "1", "status": "available", "expires_at": "2026-10-20T00:00:00Z"},
                {"id": "2", "status": "available", "expires_at": "2026-10-10T00:00:00Z"},
                {"id": "3", "status": "redeemed", "expires_at": "2026-10-10T00:00:00Z"},
            ],
        }
        rc = codex.parse_reset_credits(data, NOW)
        self.assertEqual(rc["available"], 2)
        self.assertEqual(rc["next_expires_at"], "2026-10-10T00:00:00Z")

    def test_id_token_info(self):
        import base64
        import json

        payload = {
            "email": "me@example.com",
            "https://api.openai.com/auth": {"chatgpt_account_id": "acc-1", "chatgpt_plan_type": "pro"},
        }
        enc = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        info = codex.id_token_info(f"x.{enc}.y")
        self.assertEqual(info, {"email": "me@example.com", "account_id": "acc-1", "plan": "pro"})


class AntigravityParserTest(unittest.TestCase):
    def test_summary(self):
        data = {
            "response": {
                "groups": [
                    {
                        "displayName": "Gemini Models",
                        "buckets": [
                            {"bucketId": "g5h", "displayName": "5시간", "remainingFraction": 0.8,
                             "resetTime": "2026-10-03T05:00:00Z", "window": "FIVE_HOURS"},
                            {"bucketId": "gwk", "displayName": "주간", "remaining": {"case": "remainingFraction", "value": 0.25},
                             "window": "WEEKLY"},
                            {"bucketId": "off", "disabled": True, "remainingFraction": 1},
                        ],
                    },
                    {"displayName": "Claude and GPT models", "buckets": [{"id": "c5h", "remainingFraction": 1.0}]},
                ]
            }
        }
        ws = antigravity.parse_quota_summary(data)
        self.assertEqual(len(ws), 3)
        self.assertEqual(ws[0]["used_percent"], 20.0)
        self.assertEqual(ws[0]["window_seconds"], 5 * 3600)
        self.assertEqual(ws[1]["used_percent"], 75.0)
        self.assertEqual(ws[1]["window_seconds"], 7 * 86400)
        self.assertEqual(ws[2]["group"], "Claude and GPT models")
        antigravity.mark_primary(ws)
        self.assertEqual([w["primary"] for w in ws], [True, True, False])

    def test_models_and_buckets(self):
        models = {"models": {"gemini-3-pro": {"displayName": "Gemini 3 Pro",
                                               "quotaInfo": {"remainingFraction": 0.5, "resetTime": "2026-10-03T05:00:00Z"}},
                             "no-quota": {"displayName": "x"}}}
        ws = antigravity.parse_available_models(models)
        self.assertEqual(len(ws), 1)
        self.assertEqual(ws[0]["used_percent"], 50.0)
        buckets = {"buckets": [{"modelId": "m", "remainingFraction": 0.9}, {"modelId": "m", "remainingFraction": 0.4}]}
        self.assertEqual(antigravity.parse_quota_buckets(buckets)[0]["used_percent"], 60.0)

    def test_project_ref(self):
        self.assertEqual(antigravity.project_ref("p-1"), "p-1")
        self.assertEqual(antigravity.project_ref({"id": "p-2"}), "p-2")
        self.assertIsNone(antigravity.project_ref(None))


class CallbackInputTest(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(
            parse_callback_input("http://localhost:1455/auth/callback?code=abc&state=xyz"), ("abc", "xyz")
        )
        self.assertEqual(parse_callback_input("  abc#xyz \n"), ("abc", "xyz"))
        self.assertEqual(parse_callback_input("abc"), ("abc", None))
        with self.assertRaises(LoginError):
            parse_callback_input("http://127.0.0.1:8585/callback?error=access_denied&state=x")
        with self.assertRaises(LoginError):
            parse_callback_input("")


if __name__ == "__main__":
    unittest.main()
