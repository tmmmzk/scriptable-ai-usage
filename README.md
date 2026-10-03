# scriptable-ai-usage

Claude, Codex, Google Antigravity 구독 사용량과 **초기화권**을 iPhone 홈 화면·잠금 화면에 보여주는 Scriptable 위젯입니다.

두 가지 방식 중 하나를 고릅니다. 앱의 **설정 → 연결 방식**에서 언제든 바꿀 수 있고, 계정 목록은 방식마다 따로입니다.

| | 기기 모드 | 서버 모드 |
|---|---|---|
| 필요한 것 | Scriptable 만 | 리눅스 서버 + 도메인 |
| 조회 | 위젯·앱이 열릴 때 직접 (10분 지난 값만 다시 조회) | 서버가 5분마다 미리 수집, 위젯은 결과만 읽음 |
| 토큰 보관 | iOS 키체인 | 서버 파일(권한 600) |
| 위젯이 뜨는 속도 | 다시 조회할 때 몇 초 걸릴 수 있음 | 빠름 |

서버 모드 구조:

```
┌──────── 리눅스 서버 (리버스 프록시 뒤) ────────┐        ┌──────── iPhone ────────┐
│ aiusage (Python 표준 라이브러리만 사용)        │  HTTPS │ Scriptable AIUsage.js  │
│  • 계정별 OAuth 토큰 보관·자동 갱신            │ ◀───── │  • 위젯(소·중·대·잠금) │
│  • 5분마다 사용량·초기화권 수집                │        │  • 앱 안 계정 관리     │
│  • /v1/usage 로 통합 JSON 제공                 │        │    추가·재로그인·삭제  │
└────────────────────────────────────────────────┘        └────────────────────────┘
```

> ⚠️ 세 서비스 모두 **공식 사용량 API 가 없습니다.** 각 CLI·앱이 내부적으로 쓰는 비공개 엔드포인트를 호출하므로 예고 없이 깨질 수 있고, 서비스 약관상 회색지대입니다. 본인 계정에 한해 본인 책임으로 사용하세요.

## 표시 항목

| 서비스 | 사용량 | 초기화권 | 등록 방식 |
|---|---|---|---|
| Claude | 현재 세션 / 이번 주 / 모델별 이번 주, 추가 사용량, 플랜 | ✅ (sessionKey 필요) | OAuth 로그인, sessionKey |
| Codex | 5시간 / 주간 / 모델별 추가 한도, 크레딧, 플랜(Plus·Pro·Business 등) | ✅ | OAuth 로그인 |
| Antigravity | 그룹별(Gemini / Claude·GPT) 5시간·주간 | – | Google OAuth 로그인 |

## 기기 모드 (서버 없이)

1. iPhone 에 [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) 을 설치하고, 새 스크립트에 [`scriptable/AIUsage.js`](scriptable/AIUsage.js) 를 붙여넣습니다(이름 `AIUsage`).
2. 실행해서 **시작하기 → 이 iPhone에서 직접**을 고릅니다.
3. **계정 추가**로 Claude·Codex·Antigravity 계정을 로그인합니다. 로그인 방법은 아래 [계정별 로그인 방법](#계정별-로그인-방법)과 같습니다.
   - Antigravity 는 처음 한 번 Client ID/Secret 을 넣어야 합니다. **계정 추가 → Antigravity**를 누르면 입력 화면이 먼저 나오고, 나중에 **설정 → Antigravity 로그인 설정**에서 바꿀 수 있습니다. 값을 찾는 방법은 [Antigravity 를 쓰는 경우](#antigravity-를-쓰는-경우)를 보세요.
4. 홈 화면·잠금 화면에 위젯을 추가합니다.

동작 방식:
- 토큰은 계정별로 iOS 키체인에, 계정 목록과 마지막 사용량은 Scriptable 문서 폴더에 저장됩니다.
- 위젯이나 앱이 열릴 때 10분 넘게 지난 계정만 다시 조회합니다. **전체 새로고침**은 1분이 지난 계정을 다시 조회합니다.
- 여러 위젯이 동시에 토큰을 갱신하지 않도록 계정별 잠금을 겁니다. 다른 위젯이 먼저 갱신했으면 저장된 새 토큰을 그대로 씁니다.
- 폰이 오프라인이면 마지막 값을 흐리게 보여줍니다.

## 1. 서버 설치

Python 3.9 이상만 있으면 됩니다(추가 패키지 없음).

```bash
sudo useradd --system --home /opt/aiusage aiusage
sudo git clone https://github.com/tmmmzk/scriptable-ai-usage /opt/aiusage
sudo cp /opt/aiusage/server/deploy/aiusage.env.example /etc/aiusage.env
sudo chmod 600 /etc/aiusage.env
sudo sed -i "s/^AIUSAGE_API_KEY=.*/AIUSAGE_API_KEY=$(openssl rand -hex 32)/" /etc/aiusage.env
sudo cp /opt/aiusage/server/deploy/aiusage.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aiusage
curl -s http://127.0.0.1:8787/healthz
```

Docker 를 쓴다면:

```bash
cd server/deploy
cp aiusage.env.example aiusage.env   # API 키 등 입력
docker compose up -d --build
```

마지막으로 리버스 프록시에서 도메인을 `127.0.0.1:8787` 로 연결합니다. 설정 예시는 [`server/deploy/reverse-proxy.md`](server/deploy/reverse-proxy.md) 에 있습니다.

### Antigravity 를 쓰는 경우

Antigravity 의 Google OAuth 클라이언트 ID/Secret 은 앱 안에 들어 있습니다. 이 저장소에는 넣지 않았으니 직접 찾아서 `/etc/aiusage.env` 에 넣어야 합니다.

1. 아무 PC 에 Antigravity 를 설치합니다.
2. 설치 폴더의 `resources/app/out/main.js` 에서 아래 두 값을 찾습니다.
   - `….apps.googleusercontent.com` → `ANTIGRAVITY_OAUTH_CLIENT_ID`
   - `GOCSPX-…` → `ANTIGRAVITY_OAUTH_CLIENT_SECRET`
3. macOS 라면 경로는 `/Applications/Antigravity.app/Contents/Resources/app/out/main.js` 입니다.

## 2. Scriptable 설정

1. iPhone 에 [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) 을 설치합니다.
2. 새 스크립트를 만들고 [`scriptable/AIUsage.js`](scriptable/AIUsage.js) 내용을 붙여넣습니다. 이름은 `AIUsage` 로 지정합니다.
3. 스크립트를 실행하고 **시작하기 → 내 서버에 연결**에서 서버 주소(`https://ai.example.com`)와 API 키를 넣은 뒤 **연결 확인하고 저장**을 누릅니다. 값은 iOS 키체인에 저장됩니다.
4. **계정 추가**를 누르고 서비스를 고릅니다.
5. 홈 화면이나 잠금 화면에 Scriptable 위젯을 추가합니다. 위젯을 길게 눌러 **위젯 편집**에서 Script 를 `AIUsage` 로 지정합니다.
   - Parameter 에 계정 이름을 쉼표로 적으면(예: `개인,회사`) 그 계정만 표시합니다.

### 계정별 로그인 방법

| 서비스 | 로그인 후 화면 | 붙여넣을 값 |
|---|---|---|
| Claude | 코드가 표시되고 **Copy Code** 버튼이 있음 | 복사한 코드 (`code#state`) |
| Codex | `localhost` 페이지로 이동해 "연결할 수 없음"이 뜸 (**정상**) | 주소창의 **전체 URL** |
| Antigravity | `127.0.0.1` 페이지로 이동해 열리지 않음 (**정상**) | 주소창의 **전체 URL** |

- Claude 초기화권을 보려면 계정 화면의 **sessionKey**에서 값을 넣으세요. 같은 화면에서 바꾸거나 지울 수 있습니다.
  - PC 브라우저에서 claude.ai 에 로그인한 뒤 개발자 도구 → Application → Cookies → `https://claude.ai` → `sessionKey` 값입니다.
  - 서버 IP 가 Cloudflare 에 막히면 상태가 `partial` 로 표시되고, 사용량은 OAuth 로 계속 받습니다.
- 위젯에 빨간 "재로그인" 배지가 보이면 재로그인이 필요하다는 뜻입니다. 계정 화면에서 **다시 로그인**을 누르세요.

## 앱 화면

스크립트를 앱에서 실행하면 설정 앱처럼 생긴 화면이 열립니다. 설정과 입력도 팝업 대신 화면(페이지)으로 넘어가고, 글자를 직접 쳐야 할 때만 작은 입력창이 뜹니다. 결과나 오류는 각 화면 맨 위에 표시됩니다.

- **메인**: 계정마다 카드 하나. 앱은 공간이 넓어서 한도(현재 세션·이번 주·Fable 이번 주 등)를 모두 한 줄씩 가로 전체로 보여주고, 남은 시간은 퍼센트 바로 옆에 붙습니다. 카드를 누르면 계정 화면으로 갑니다.
- **계정 화면**: 한도별 남은 시간과 초기화 날짜·시각(요일 포함), 초기화권 한 장씩, 추가 사용량. 아래에서 새로고침·이름·위젯에 표시·sessionKey·다시 로그인·삭제를 합니다.
- **설정**: 연결 방식(이 iPhone / 내 서버), Antigravity 로그인 설정, 알림, 위젯 미리보기, Claude 로고.

## 위젯

| 크기 | 내용 |
|---|---|
| 소형 | 계정 1개, 두 한도를 위아래로 |
| 중형 | 계정 2개, 두 한도가 가로를 반씩 |
| 대형 | 계정 4개 + 업데이트 시각 |
| 잠금 화면 | 사각형(계정 3개 %), 원형(첫 계정), 한 줄(`CL 43% · 91%  CX 10%`) |

- 계정마다 서비스 로고, 이름, 초기화권 개수(Claude·Codex)가 표시됩니다.
- 한도마다 이름과 사용률, 막대 아래에 `2시간 12분 후 초기화` 처럼 남은 시간이 나옵니다.
- 상태 표시: 빨간 "재로그인" 배지는 재로그인 필요(막대가 회색으로 흐려짐), 주황 "일부 실패" 배지는 초기화권 등 일부 조회 실패입니다.
- 막대 색은 70% 미만 초록, 70% 이상 주황, 90% 이상 빨강입니다.
- 계정이 많으면 위젯 Parameter 로 보여줄 계정을 고르세요(예: 중형 위젯 두 개에 `개인,회사` / `구글,부계정`).
- 앱의 **설정 → Claude 로고**로 Claude 로고를 Clawd(Claude Code 마스코트)로 바꿀 수 있습니다. 위젯에도 적용됩니다.
- 로고는 [LobeHub Icons](https://github.com/lobehub/lobe-icons)(MIT)를 PNG 로 변환해 스크립트에 넣었습니다.

## 알림

위젯이나 앱이 사용량을 가져올 때마다 확인해서, 같은 내용은 한 번만 알려 줍니다. **설정 → 알림**에서 전체를 끄거나, 종류별로 켜고 끄거나, 경고 기준(80·90·95%)을 바꿀 수 있고, 테스트 알림도 보낼 수 있어요. 처음 알림을 보낼 때 iOS 가 Scriptable 알림 권한을 물어봅니다.

| 알림 | 언제 |
|---|---|
| 사용량 경고 | 대표 한도(현재 세션·이번 주 등)가 기준을 넘었을 때 — 그 한도 기간에 한 번 |
| 초기화 알림 | 기준을 넘긴 한도가 초기화되는 시각에 맞춰 예약 |
| 조기 초기화 감지 | 예정 시각 전에 한도가 초기화됐을 때(예: 서비스가 임의로 초기화, 초기화권 사용). 예약해 둔 초기화 알림은 취소 |
| 재로그인 필요 | 토큰이 만료·폐기되어 다시 로그인해야 할 때 |
| 초기화권 만료 임박 | 초기화권 만료가 24시간 안으로 다가왔을 때 |

- 조기 초기화는 직전에 본 값과 비교해 판단합니다. 예정 초기화 시각보다 1분 넘게 이른데 사용률이 10%p 넘게(직전 값이 10% 이상일 때) 떨어지면 초기화된 것으로 봅니다.
- 알림을 누르면 이 스크립트가 열립니다. iOS 가 위젯을 깨우는 간격(보통 15~30분)만큼 알림이 늦을 수 있어요.

## 동작 방식과 주의점

- **토큰 회전**: Claude 와 Codex 는 리프레시 토큰이 갱신할 때마다 바뀝니다.
  - 서버·기기 모드 모두 계정마다 잠금을 걸고 갱신하며, 새 토큰을 즉시 저장합니다.
  - 같은 계정 토큰을 다른 곳(PC 의 Claude Code, 다른 모드 등)과 **공유하지 마세요.** 이 위젯 전용으로 따로 로그인한 토큰이 필요합니다. 위젯의 로그인 흐름이 그렇게 동작합니다.
- **재로그인 주기**: Claude OAuth 는 약 한 달마다 재로그인이 필요할 수 있습니다. Codex 는 30일 동안 사용하지 않으면 만료됩니다.
- **갱신 주기**: iOS 가 위젯 갱신 시점을 정하므로 보통 15~30분 간격입니다. 서버 모드는 5분마다 미리 수집해 두기 때문에 위젯이 결과만 읽어 빠르게 뜹니다.
- **오프라인**: 서버 모드에서 서버에 연결할 수 없으면 마지막으로 받은 값을 "오프라인"으로 표시합니다.
- **Claude 표시 항목**: Claude Code 의 `/usage` 와 같은 항목만 보여줍니다. 사용량 응답에는 `iguana_necktie` 처럼 내부 코드네임이 붙은 실험용 블록이 섞여 오는데, 의미가 공개되지 않아 표시하지 않습니다. 모델별 주간 한도(예: Fable)는 응답의 `limits[]` 에서 가져옵니다.
- **플랜**: Claude 는 사용량 응답에 플랜이 없어 `/api/oauth/profile` 로 따로 확인합니다(Max 5x/20x 구분). ChatGPT 의 Team 요금제는 이름이 바뀌어 Business 로 표시합니다.

## 개발

```bash
# 서버
cd server
python3 -m unittest discover -s tests -v
AIUSAGE_API_KEY=$(openssl rand -hex 16) AIUSAGE_DATA_DIR=./data python3 -m aiusage

# 스크립트 기기 모드 (Node 18+, 가짜 업스트림과 Scriptable 스텁 위에서 실행)
node scriptable/tests/device.test.mjs
```

새 서비스를 추가하려면 서버는 `server/aiusage/providers/` 에 `Provider` 를 구현해 `providers/__init__.py` 에 등록하고, 기기 모드는 스크립트의 `DEVICE_PROVIDERS` 에 같은 형식으로 추가하세요. API 명세는 [`docs/API.md`](docs/API.md) 에 있습니다.

## 참고

엔드포인트와 응답 형식은 [steipete/CodexBar](https://github.com/steipete/CodexBar), [openai/codex](https://github.com/openai/codex) 소스와 Claude Code CLI 를 참고했습니다.
