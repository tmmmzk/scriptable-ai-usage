# API

모든 `/v1/*` 요청은 `Authorization: Bearer <AIUSAGE_API_KEY>` 헤더(또는 `X-API-Key`)가 필요합니다.
응답은 모두 JSON 이고, 오류는 `{"error": "메시지"}` 형식입니다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/healthz` | 헬스 체크 (인증 없음) |
| GET | `/v1/usage` | 위젯용 사용량. `?refresh=1` 이면 오래된 값을 즉시 다시 조회, `?accounts=개인,codex_ab12` 로 필터, `?all=1` 이면 위젯에서 숨긴 계정(`enabled: false`)도 포함 |
| GET | `/v1/providers` | 지원 서비스, 등록 방식, 서버 설정 여부 |
| GET | `/v1/accounts` | 계정 목록 (비밀값 제외) |
| POST | `/v1/accounts` | 수동 등록. 현재는 Claude sessionKey 만: `{"provider":"claude","session_key":"sk-ant-…","label":"개인"}` |
| GET | `/v1/accounts/{id}` | 계정 정보 + 사용량 |
| PATCH | `/v1/accounts/{id}` | `label`, `enabled`, `order`, `session_key`(Claude, `""` 이면 제거) |
| DELETE | `/v1/accounts/{id}` | 계정과 저장된 토큰 삭제 |
| POST | `/v1/accounts/{id}/refresh` | 즉시 다시 조회 |
| POST | `/v1/logins` | OAuth 로그인 시작: `{"provider":"codex","label":"회사"}`, 재로그인은 `account_id` 추가(다른 서비스 계정이면 404) |
| POST | `/v1/logins/{login_id}/complete` | `{"input":"<리다이렉트 URL 또는 code#state>"}`. 로그인 세션이 없거나 만료됐으면 404 |

## `GET /v1/usage`

```json
{
  "generated_at": "2026-10-03T09:00:00Z",
  "poll_interval": 300,
  "accounts": [
    {
      "id": "claude_1a2b3c4d",
      "provider": "claude",
      "provider_name": "Claude",
      "label": "개인",
      "email": "me@example.com",
      "plan": "default_claude_max_20x",
      "enabled": true,
      "status": "ok",
      "error": null,
      "warnings": [],
      "stale": false,
      "fetched_at": "2026-10-03T08:58:12Z",
      "last_success_at": "2026-10-03T08:58:12Z",
      "windows": [
        {
          "key": "session",
          "label": "현재 세션",
          "group": null,
          "used_percent": 42.0,
          "remaining_percent": 58.0,
          "resets_at": "2026-10-03T11:00:00Z",
          "window_seconds": 18000,
          "primary": true
        },
        {
          "key": "weekly",
          "label": "이번 주",
          "group": null,
          "used_percent": 18.0,
          "remaining_percent": 82.0,
          "resets_at": "2026-10-08T00:00:00Z",
          "window_seconds": 604800,
          "primary": true
        }
      ],
      "reset_credits": {
        "available": 2,
        "next_expires_at": "2026-10-20T00:00:00Z",
        "expirations": ["2026-10-20T00:00:00Z", "2026-10-27T00:00:00Z"],
        "items": [
          {"title": null, "description": null, "reset_type": null,
           "granted_at": "2026-09-20T00:00:00Z", "expires_at": "2026-10-20T00:00:00Z"},
          {"title": null, "description": null, "reset_type": null,
           "granted_at": "2026-09-27T00:00:00Z", "expires_at": "2026-10-27T00:00:00Z"}
        ]
      },
      "extra": {}
    }
  ]
}
```

### 필드 설명

- `status`
  - `ok`: 정상
  - `partial`: 사용량은 받았지만 초기화권 등 일부 조회가 실패함 (`warnings` 참고)
  - `needs_login`: 토큰이 만료·폐기되어 재로그인 필요
  - `error`: 업스트림 오류
  - `blocked`: Cloudflare 챌린지로 서버 IP 가 막힘
  - `rate_limited`: 업스트림 요청 한도 초과(429)
  - `pending`: 아직 한 번도 조회하지 않음
- `stale`: 마지막 조회는 실패했고 `windows` 는 이전에 성공한 값입니다.
- `enabled`: `false` 면 위젯에서 숨긴 계정입니다(`?all=1` 일 때만 응답에 들어옵니다).
- `windows[].primary`: 작은 위젯에 우선 표시할 창입니다(계정당 최대 2개). Antigravity 는 첫 그룹(보통 Gemini)의 5시간·주간입니다.
- `windows[].group`: Antigravity 그룹 이름(예: `Gemini Models`)이나 Codex 추가 한도 이름입니다.
- `windows[].label`: 화면에 그대로 쓰는 이름입니다. Claude 는 `현재 세션`·`이번 주`·`<모델> 이번 주`, Codex·Antigravity 는 `5시간`·`주간` 처럼 기간으로 표시합니다.
- `windows[].kind`: `"credit"` 이면 한도가 아니라 일회성 크레딧입니다(Claude `Claude Code·Cowork 크레딧`). `resets_at` 은 만료 시각입니다.
- `plan`: 서비스가 주는 값 그대로입니다(예: Claude `default_claude_max_20x`·`pro`, Codex `plus`·`team`, Antigravity `g1-pro-tier`(AI Pro)·`Free`). 보기 좋은 이름으로 바꾸는 건 위젯이 합니다.
- `reset_credits`
  - `null`: 조회하지 않았거나 대상이 아닙니다. Claude 는 sessionKey 가 없으면 `null`, Antigravity 는 항상 `null` 입니다.
  - `available` 이 0 이면 현재 쓸 수 있는 초기화권이 없습니다.
  - `items` 는 초기화권 한 장당 하나씩, 만료가 빠른 순서입니다. Codex 는 `title`·`reset_type` 이 채워질 수 있습니다.
  - 초기화권을 사용할 때 쓰는 ID 는 응답에 넣지 않습니다.
- `extra`
  - Claude: `extra_usage` (추가 사용량. `used`·`limit` 은 통화 단위 금액, 한도가 없으면 `limit` 이 `null`), `prepaid` (선불 크레딧 잔액 `balance`)
  - Codex: `credits` (크레딧 잔액)
