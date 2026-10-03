# scriptable-ai-usage

Claude, ChatGPT·Codex, Google Antigravity 구독 사용량과 **초기화권**을 iPhone 홈 화면·잠금 화면에 보여주는 Scriptable 위젯입니다.
리눅스 서버가 사용량을 모아 정리된 API 로 내려줍니다.

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
| Claude | 5시간 / 주간 / 모델별 주간, 추가 사용량 | ✅ (sessionKey 필요) | OAuth 로그인, sessionKey |
| ChatGPT · Codex | 5시간 / 주간 / 모델별 추가 한도, 크레딧 | ✅ | OAuth 로그인 |
| Antigravity | 그룹별(Gemini / Claude·GPT) 5시간·주간 | – | Google OAuth 로그인 |

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
3. 스크립트를 실행하고 서버 주소(`https://ai.example.com`)와 API 키를 입력합니다. 값은 iOS 키체인에 저장됩니다.
4. **＋ 계정 추가**를 누르고 서비스를 고릅니다.
5. 홈 화면이나 잠금 화면에 Scriptable 위젯을 추가합니다. 위젯을 길게 눌러 **위젯 편집**에서 Script 를 `AIUsage` 로 지정합니다.
   - Parameter 에 계정 이름을 쉼표로 적으면(예: `개인,회사`) 그 계정만 표시합니다.

### 계정별 로그인 방법

| 서비스 | 로그인 후 화면 | 붙여넣을 값 |
|---|---|---|
| Claude | 코드가 표시되고 **Copy Code** 버튼이 있음 | 복사한 코드 (`code#state`) |
| Codex | `localhost` 페이지로 이동해 "연결할 수 없음"이 뜸 (**정상**) | 주소창의 **전체 URL** |
| Antigravity | `127.0.0.1` 페이지로 이동해 열리지 않음 (**정상**) | 주소창의 **전체 URL** |

- Claude 초기화권을 보려면 계정 화면에서 **sessionKey 설정**을 눌러 `sessionKey` 를 넣으세요.
  - PC 브라우저에서 claude.ai 에 로그인한 뒤 개발자 도구 → Application → Cookies → `https://claude.ai` → `sessionKey` 값입니다.
  - 서버 IP 가 Cloudflare 에 막히면 상태가 `partial` 로 표시되고, 사용량은 OAuth 로 계속 받습니다.
- 위젯에 🔑 가 보이면 재로그인이 필요하다는 뜻입니다. 계정 화면에서 **다시 로그인**을 누르세요.

### 서버 없이 미리 보기 (데모 모드)

서버를 아직 세팅하지 않았어도 UI 와 위젯 디자인을 확인할 수 있습니다.

- **앱**: 스크립트를 처음 실행할 때 **데모 모드로 둘러보기**를 고릅니다. 이미 서버를 설정했다면 메인 화면의 **🧪 데모 모드로 보기**를 누르세요.
  - Claude, Codex, Antigravity 계정이 정상·일부 실패·재로그인 필요 상태로 하나씩 들어 있습니다.
  - 계정 추가·이름 변경·삭제 같은 관리 동작도 그대로 눌러볼 수 있습니다. 변경 내용은 기기 로컬 파일에만 저장되고, **🧪 데모 데이터 초기화**로 되돌릴 수 있습니다.
- **위젯**: 위젯 Parameter 에 `demo` 를 적으면 그 위젯만 데모 데이터로 그립니다. 필터와 같이 쓰려면 `demo,회사` 처럼 적으세요.
- 데모를 끝내려면 **⚙︎ 서버 연결 (데모 종료)**에서 서버를 설정합니다.

## 위젯

| 크기 | 내용 |
|---|---|
| 소형 | 계정 1개, 두 한도를 위아래로 |
| 중형 | 계정 2개, 두 한도가 가로를 반씩 |
| 대형 | 계정 4개 + 업데이트 시각 |
| 잠금 화면 | 사각형(계정 3개 %), 원형(첫 계정), 한 줄(`CL 43% · 91%  CX 10%`) |

- 계정마다 서비스 로고, 이름, 초기화권 개수(Claude·Codex)가 표시됩니다.
- 한도마다 `5시간 · 2h 12m` 처럼 초기화까지 남은 시간과 사용률이 나옵니다.
- 상태 표시: "🔑 재로그인" 배지는 재로그인 필요(막대가 회색으로 흐려짐), ⚠︎ 는 일부 조회 실패입니다.
- 막대 색은 70% 미만 초록, 70% 이상 주황, 90% 이상 빨강입니다.
- 계정이 많으면 위젯 Parameter 로 보여줄 계정을 고르세요(예: 중형 위젯 두 개에 `개인,회사` / `구글,부계정`).
- 로고는 [LobeHub Icons](https://github.com/lobehub/lobe-icons)(MIT)를 PNG 로 변환해 스크립트에 넣었습니다.

## 동작 방식과 주의점

- **토큰 회전**: Claude 와 Codex 는 리프레시 토큰이 갱신할 때마다 바뀝니다.
  - 서버는 계정마다 잠금을 걸고 갱신하며, 새 토큰을 즉시 디스크에 저장합니다(`accounts.json`, 권한 600).
  - 같은 계정 토큰을 다른 곳(PC 의 Claude Code 등)과 **공유하지 마세요.** 서버 전용으로 따로 로그인한 토큰이 필요합니다. 위젯의 로그인 흐름이 그렇게 동작합니다.
- **재로그인 주기**: Claude OAuth 는 약 한 달마다 재로그인이 필요할 수 있습니다. Codex 는 30일 동안 사용하지 않으면 만료됩니다.
- **갱신 주기**: iOS 가 위젯 갱신 시점을 정하므로 보통 15~30분 간격입니다. 서버는 5분마다 미리 수집해 두기 때문에 위젯은 캐시만 읽어 빠르게 뜹니다.
- **오프라인**: 서버에 연결할 수 없으면 마지막으로 받은 값을 "오프라인"으로 표시합니다.

## 개발

```bash
cd server
python3 -m unittest discover -s tests -v
AIUSAGE_API_KEY=$(openssl rand -hex 16) AIUSAGE_DATA_DIR=./data python3 -m aiusage
```

새 서비스를 추가하려면 `server/aiusage/providers/` 에 `Provider` 를 구현하고 `providers/__init__.py` 에 등록하세요. API 명세는 [`docs/API.md`](docs/API.md) 에 있습니다.

## 참고

엔드포인트와 응답 형식은 [steipete/CodexBar](https://github.com/steipete/CodexBar), [openai/codex](https://github.com/openai/codex) 소스와 Claude Code CLI 를 참고했습니다.
