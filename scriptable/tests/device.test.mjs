// 기기 모드 테스트: 가짜 업스트림 + Scriptable API 스텁 위에서 AIUsage.js 내부 함수를 직접 호출한다.
import fs from "fs"
import crypto from "crypto"
import assert from "assert/strict"

// 사용법: node scriptable/tests/device.test.mjs [AIUsage.js 경로]
const SRC = fs.readFileSync(process.argv[2] || new URL("../AIUsage.js", import.meta.url), "utf8")
const body = SRC.slice(0, SRC.indexOf("// ───────────────────────── 진입점"))

// ── Scriptable 스텁 ──
const kc = {}
const files = {}
const Keychain = { contains: (k) => k in kc, get: (k) => kc[k], set: (k, v) => (kc[k] = v), remove: (k) => delete kc[k] }
const FileManager = { local: () => ({ joinPath: (a, b) => `${a}/${b}`, documentsDirectory: () => "/d",
  fileExists: (p) => p in files, readString: (p) => files[p], writeString: (p, s) => (files[p] = s), remove: (p) => delete files[p] }) }
const UUID = { string: () => crypto.randomUUID().toUpperCase() }
class Color { constructor(h, a) { this.hex = h; this.a = a } static dynamic(l) { return l } static white() { return new Color("#fff") } static red() { return new Color("#f00") } static gray() { return new Color("#888") } }
const Font = new Proxy({}, { get: () => () => ({}) })
const notifications = []
const removed = []
class Notification {
  setTriggerDate(d) { this.at = d }
  async schedule() { notifications.push({ id: this.identifier, title: this.title, body: this.body, at: this.at }) }
  static async removePending(ids) { removed.push(...ids) }
}
const URLScheme = { forRunningScript: () => "scriptable:///run/AIUsage" }

// ── 가짜 업스트림 ──
const calls = []
const up = { claudeUsageStatus: 200, codexRefreshes: 0, claudeRefreshes: 0, claudeChallenge: null, codexChallenge: null }
const jwt = (o) => `h.${Buffer.from(JSON.stringify(o)).toString("base64url")}.s`
const parseBody = (b, headers) => (!b ? {} : (headers["Content-Type"] || "").includes("json") ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b)))
const s256 = (v) => crypto.createHash("sha256").update(v).digest("base64url")

function upstream(method, url, headers, raw) {
  const b = parseBody(raw, headers)
  calls.push({ method, url, headers, body: b })
  const ok = (o, status = 200, h = {}) => ({ status, body: JSON.stringify(o), headers: h })
  const u = new URL(url)
  // Claude
  if (url === "https://platform.claude.com/v1/oauth/token") {
    if (b.grant_type === "authorization_code") {
      assert.equal(b.code, "claudecode")
      assert.equal(s256(b.code_verifier), up.claudeChallenge, "PKCE: verifier 해시가 challenge 와 같아야 함")
      return ok({ access_token: "c-at-1", refresh_token: "c-rt-1", expires_in: 28800, scope: "user:profile user:inference",
        account: { email_address: "me@example.com" }, organization: { uuid: "org-1" } })
    }
    if (b.refresh_token === "revoked") return ok({ error: "invalid_grant" }, 400)
    up.claudeRefreshes++
    assert.equal(b.refresh_token, `c-rt-${up.claudeRefreshes}`)
    return ok({ access_token: `c-at-${up.claudeRefreshes + 1}`, refresh_token: `c-rt-${up.claudeRefreshes + 1}`, expires_in: 28800 })
  }
  if (url === "https://api.anthropic.com/api/oauth/profile")
    return ok({ organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } })
  if (url === "https://api.anthropic.com/api/oauth/usage") {
    assert.equal(headers["anthropic-beta"], "oauth-2025-04-20")
    if (up.claudeUsageStatus !== 200) { const s = up.claudeUsageStatus; up.claudeUsageStatus = 200; return ok({}, s) }
    return ok({ five_hour: { utilization: 10, resets_at: "2099-01-01T05:00:00.123456+00:00" },
      seven_day: { utilization: 20, resets_at: "2099-01-07T00:00:00Z" }, extra_usage: { is_enabled: true, used_credits: 5, monthly_limit: 50, utilization: 10 },
      iguana_necktie: { utilization: 3, resets_at: "2099-01-07T00:00:00Z" }, // 내부 코드네임 블록
      limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 33, resets_at: 4070908800 },
        { kind: "something_else", percent: 1 }] })
  }
  if (url === "https://claude.ai/api/organizations") return ok([{ uuid: "org-api", capabilities: ["api"] }, { uuid: "org-1", capabilities: ["chat"] }])
  if (u.host === "claude.ai" && u.pathname === "/api/organizations/org-1/usage") {
    assert.equal(headers.Cookie, "sessionKey=sk-ant-sid")
    return ok({ five_hour: { utilization: 11, resets_at: null }, cedar_ember: { eligible: true, grants: [
      { resets_left: 2, ends_at: "2099-01-01T00:00:00Z", starts_at: "2020-01-01T00:00:00Z", paused: false },
      { resets_left: 1, ends_at: "2000-01-01T00:00:00Z", paused: false }] } })
  }
  // Codex
  if (url === "https://auth.openai.com/oauth/token") {
    if (b.grant_type === "authorization_code") {
      assert.equal(s256(b.code_verifier), up.codexChallenge)
      return ok({ access_token: jwt({ exp: 1 }), refresh_token: "x-rt-1",
        id_token: jwt({ email: "work@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-9", chatgpt_plan_type: "plus" } }) })
    }
    up.codexRefreshes++
    assert.equal(b.refresh_token, `x-rt-${up.codexRefreshes}`)
    return ok({ access_token: jwt({ exp: 4102444800 }), refresh_token: `x-rt-${up.codexRefreshes + 1}` })
  }
  if (url === "https://chatgpt.com/backend-api/wham/usage") {
    assert.equal(headers["ChatGPT-Account-Id"], "acct-9")
    return ok({ plan_type: "plus", rate_limit: {
      primary_window: { used_percent: 50, reset_at: 4102444800, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 70, reset_at: 4102444800, limit_window_seconds: 604800 } } })
  }
  if (url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits")
    return ok({ available_count: 1, credits: [{ id: "secret-id", status: "available", title: "Rate limit reset",
      expires_at: "2099-02-01T00:00:00Z", granted_at: "2099-01-01T00:00:00Z" }] })
  // Antigravity
  if (url === "https://oauth2.googleapis.com/token") {
    assert.equal(b.client_secret, "GOCSPX-test")
    return ok({ access_token: "g-at", refresh_token: "g-rt", expires_in: 3600, id_token: jwt({ email: "me@gmail.com" }) })
  }
  if (url === "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
    return ok({ cloudaicompanionProject: { id: "proj-1" }, currentTier: { id: "free-tier" }, paidTier: { id: "g1-pro-tier", name: "Gemini Code Assist in Google One AI Pro" } })
  if (url === "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary") {
    assert.equal(b.project, "proj-1")
    return ok({ response: { groups: [
      // 실제 응답처럼 이름은 영어로 길게, 주간이 먼저
      { displayName: "Gemini Models", buckets: [{ bucketId: "gw", displayName: "Weekly Limit Remaining", remaining: { case: "remainingFraction", value: 0.9 } },
        { bucketId: "g5", displayName: "Five Hour Limit Remaining", remainingFraction: 0.4, window: "FIVE_HOUR", resetTime: "2099-01-01T00:00:00Z" }] },
      { displayName: "Claude and GPT models", buckets: [{ id: "cw", displayName: "Weekly Limit Remaining", remainingFraction: 0.05 },
        { id: "c5", displayName: "Five Hour Limit Remaining", remainingFraction: 0.7 }] }] } })
  }
  throw new Error(`unexpected ${method} ${url}`)
}

class Request {
  constructor(url) { this.url = url; this.method = "GET"; this.headers = {}; this.body = null }
  async loadString() {
    const r = upstream(this.method, this.url, this.headers, this.body)
    this.response = { statusCode: r.status, headers: r.headers }
    return r.body
  }
}

const env = { Keychain, FileManager, UUID, Color, Font, Request, Notification, URLScheme, Device: { screenSize: () => ({ width: 393, height: 852 }) } }
const api = new Function(...Object.keys(env), body + `
  return { sha256, b64url, b64decode, utf8Bytes, utf8Decode, jwtClaims, pkcePair, parseCallbackInput, deviceApi,
    devGetCreds, devCredKey, getConfig, setMode, KC_AG_CLIENT, msOf, devRefreshCreds, claudeProvider,
    checkAlerts, saveNotifySettings, planLabel, resetText, claudeWindows, cleanUsage,
    setLang, t, fmtDuration, windowTitle, statusText, serverApi, STRINGS, LANG_CODES, primaryWindows, setWidgetGroup }`)(...Object.values(env))

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log("ok -", name) }

// ── 1. 인코딩·해시 ──
await test("sha256 / base64url / utf8 은 Node crypto 와 같다", () => {
  for (let i = 0; i < 300; i++) {
    const buf = crypto.randomBytes(i)
    assert.deepEqual(api.sha256([...buf]), [...crypto.createHash("sha256").update(buf).digest()])
    assert.equal(api.b64url([...buf]), buf.toString("base64url"))
    assert.deepEqual(api.b64decode(buf.toString("base64")), [...buf])
    assert.deepEqual(api.b64decode(buf.toString("base64url")), [...buf])
  }
  const text = "한글 ✓ emoji 🎟 ascii"
  assert.deepEqual(api.utf8Bytes(text), [...Buffer.from(text)])
  assert.equal(api.utf8Decode([...Buffer.from(text)]), text)
  assert.equal(api.jwtClaims(jwt({ email: "가@b.c", n: 1 })).email, "가@b.c")
  const { verifier, challenge } = api.pkcePair()
  assert.ok(verifier.length >= 43)
  assert.equal(challenge, s256(verifier))
  assert.equal(api.msOf("2026-10-03T03:00:00.123456+00:00"), Date.parse("2026-10-03T03:00:00.123Z"))
})

await test("붙여넣기 입력 파싱", () => {
  assert.deepEqual(api.parseCallbackInput("http://localhost:1455/auth/callback?code=abc&state=xyz"), { code: "abc", state: "xyz" })
  assert.deepEqual(api.parseCallbackInput(" abc#xyz "), { code: "abc", state: "xyz" })
  assert.throws(() => api.parseCallbackInput("http://127.0.0.1:8585/callback?error=access_denied"))
})

// ── 2. 기기 모드 흐름 ──
api.setMode("device")
assert.ok(api.getConfig().device)
const call = (m, p, b) => api.deviceApi(m, p, b || {})
const q = (url) => Object.fromEntries(new URL(url).searchParams)

await test("Antigravity 는 Client ID/Secret 이 없으면 미설정", async () => {
  const { providers } = await call("GET", "/v1/providers")
  assert.equal(providers.find((p) => p.id === "antigravity").configured, false)
  await assert.rejects(call("POST", "/v1/logins", { provider: "antigravity" }))
})

let claudeId
await test("Claude OAuth 로그인(PKCE 검증) → 사용량", async () => {
  const start = await call("POST", "/v1/logins", { provider: "claude", label: "개인" })
  const params = q(start.authorize_url)
  assert.equal(params.redirect_uri, "https://platform.claude.com/oauth/code/callback")
  assert.equal(params.code_challenge_method, "S256")
  up.claudeChallenge = params.code_challenge
  await assert.rejects(call("POST", `/v1/logins/${start.login_id}/complete`, { input: "claudecode#WRONG" }))
  const acc = await call("POST", `/v1/logins/${start.login_id}/complete`, { input: `claudecode#${params.state}` })
  claudeId = acc.id
  assert.equal(acc.label, "개인")
  assert.equal(acc.email, "me@example.com")
  assert.equal(acc.plan, "default_claude_max_20x") // 프로필로 조회한 플랜
  assert.equal(acc.status, "ok")
  const { accounts } = await call("GET", "/v1/usage")
  const e = accounts[0]
  // 알려진 키 + limits[] 의 모델별 주간 한도만. iguana_necktie 같은 코드네임은 숨김.
  assert.deepEqual(e.windows.map((w) => [w.key, w.label, w.used_percent]),
    [["session", "현재 세션", 10], ["weekly", "이번 주", 20], ["model:Fable", "Fable 이번 주", 33]])
  assert.equal(e.windows[2].resets_at, "2099-01-01T00:00:00Z")
  assert.equal(e.windows[0].resets_at, "2099-01-01T05:00:00Z")
  assert.equal(e.extra.extra_usage.used_percent, 10)
  assert.equal(e.reset_credits, null)
  // 비밀값이 목록에 섞이지 않는다
  const listing = JSON.stringify(await call("GET", "/v1/accounts"))
  for (const secret of ["c-at-1", "c-rt-1"]) assert.ok(!listing.includes(secret))
})

await test("로그인: 없는·만료된 로그인은 404(언어와 상관없이 알아본다), 다른 서비스 계정으로는 재로그인 불가", async () => {
  await assert.rejects(call("POST", "/v1/logins/nope/complete", { input: "x#y" }), (e) => e.status === 404)
  await assert.rejects(call("POST", "/v1/logins", { provider: "codex", account_id: claudeId }), (e) => e.status === 404)
})

await test("사용량: ?accounts= 로 이름·id 거르기", async () => {
  assert.deepEqual((await call("GET", "/v1/usage?accounts=" + encodeURIComponent("개인"))).accounts.map((a) => a.id), [claudeId])
  assert.deepEqual((await call("GET", "/v1/usage?accounts=nobody")).accounts, [])
})

await test("10분 안에는 다시 조회하지 않음, refresh=1 은 1분 지나야", async () => {
  const before = calls.length
  await call("GET", "/v1/usage")
  await call("GET", "/v1/usage?refresh=1")
  assert.equal(calls.length, before)
})

await test("sessionKey 추가 → 초기화권(만료된 grant 제외, 한 장씩)", async () => {
  await call("PATCH", `/v1/accounts/${claudeId}`, { session_key: "sk-ant-sid" })
  const { usage } = await call("GET", `/v1/accounts/${claudeId}`)
  assert.equal(usage.windows[0].used_percent, 10) // OAuth 값이 우선
  assert.equal(usage.reset_credits.available, 2)
  assert.equal(usage.reset_credits.items.length, 2)
  assert.equal(usage.reset_credits.items[0].granted_at, "2020-01-01T00:00:00Z")
  await assert.rejects(call("PATCH", `/v1/accounts/${claudeId}`, { session_key: "bad" }))
})

await test("401 → 토큰 갱신, 회전된 리프레시 토큰을 키체인에 저장", async () => {
  up.claudeUsageStatus = 401
  await call("POST", `/v1/accounts/${claudeId}/refresh`)
  assert.equal(api.devGetCreds(claudeId).oauth.refresh_token, "c-rt-2")
  assert.equal(api.devGetCreds(claudeId).session_key, "sk-ant-sid")
})

await test("다른 위젯이 먼저 갱신했으면 저장된 새 토큰을 쓴다(토큰 서버 호출 없음)", async () => {
  // 이 프로세스는 옛 토큰(c)을 들고 있고, 그 사이 다른 위젯이 갱신해 키체인에 새 토큰을 저장한 상황
  const c = api.devGetCreds(claudeId)
  const newer = { ...c, oauth: { ...c.oauth, access_token: "from-other-widget", refresh_token: "c-rt-OTHER", expires_at: Date.now() + 3600e3 } }
  kc[api.devCredKey(claudeId)] = JSON.stringify(newer)
  const before = up.claudeRefreshes
  const got = await api.devRefreshCreds({ id: claudeId }, api.claudeProvider, c)
  assert.equal(got.oauth.access_token, "from-other-widget")
  assert.equal(up.claudeRefreshes, before)
  kc[api.devCredKey(claudeId)] = JSON.stringify(c)
})

await test("갱신 잠금 중이면 이번 조회는 건너뛰고 이전 값을 유지", async () => {
  const c = api.devGetCreds(claudeId)
  kc[api.devCredKey(claudeId)] = JSON.stringify({ ...c, oauth: { ...c.oauth, expires_at: 0 } })
  files[`/d/aiusage-device-lock-${claudeId}`] = String(Date.now())
  const before = up.claudeRefreshes
  const e = await call("POST", `/v1/accounts/${claudeId}/refresh`)
  assert.equal(up.claudeRefreshes, before)
  assert.equal(e.status, "ok")
  delete files[`/d/aiusage-device-lock-${claudeId}`]
  await call("POST", `/v1/accounts/${claudeId}/refresh`)
  assert.equal(up.claudeRefreshes, before + 1)
  assert.ok(!(`/d/aiusage-device-lock-${claudeId}` in files), "잠금 파일은 갱신 후 지워짐")
})

await test("갱신 거부(400) → needs_login, 이전 값은 stale 로 유지", async () => {
  const c = api.devGetCreds(claudeId)
  kc[api.devCredKey(claudeId)] = JSON.stringify({ ...c, oauth: { ...c.oauth, expires_at: 0, refresh_token: "revoked" } })
  const e = await call("POST", `/v1/accounts/${claudeId}/refresh`)
  assert.equal(e.status, "needs_login")
  assert.equal(e.stale, true)
  assert.ok(e.windows.length)
  kc[api.devCredKey(claudeId)] = JSON.stringify(c)
  assert.equal((await call("POST", `/v1/accounts/${claudeId}/refresh`)).status, "ok")
})

let codexId
await test("Codex 로그인(URL 붙여넣기) → 즉시 토큰 갱신·회전, 초기화권 id 비노출", async () => {
  const start = await call("POST", "/v1/logins", { provider: "codex" })
  const params = q(start.authorize_url)
  up.codexChallenge = params.code_challenge
  const acc = await call("POST", `/v1/logins/${start.login_id}/complete`,
    { input: `http://localhost:1455/auth/callback?code=x&scope=openid&state=${params.state}` })
  codexId = acc.id
  assert.equal(acc.label, "work")
  assert.equal(acc.plan, "plus")
  assert.equal(up.codexRefreshes, 1)
  assert.equal(api.devGetCreds(codexId).refresh_token, "x-rt-2")
  const { usage } = await call("GET", `/v1/accounts/${codexId}`)
  assert.deepEqual(usage.windows.map((w) => w.label), ["5시간", "주간"])
  assert.equal(usage.reset_credits.items[0].title, "Rate limit reset")
  assert.ok(!JSON.stringify(usage).includes("secret-id"))
  // 같은 이메일로 다시 로그인하면 기존 계정을 갱신
  const s2 = await call("POST", "/v1/logins", { provider: "codex" })
  const p2 = q(s2.authorize_url)
  up.codexChallenge = p2.code_challenge
  await call("POST", `/v1/logins/${s2.login_id}/complete`, { input: `http://localhost:1455/auth/callback?code=x&state=${p2.state}` })
  assert.equal((await call("GET", "/v1/accounts")).accounts.filter((a) => a.provider === "codex").length, 1)
})

await test("Antigravity: Client 설정 → 로그인 → 프로젝트·그룹별 사용량", async () => {
  kc[api.KC_AG_CLIENT] = JSON.stringify({ id: "123-abc.apps.googleusercontent.com", secret: "GOCSPX-test" })
  const start = await call("POST", "/v1/logins", { provider: "antigravity", label: "구글" })
  const params = q(start.authorize_url)
  assert.equal(params.access_type, "offline")
  const acc = await call("POST", `/v1/logins/${start.login_id}/complete`, { input: `http://127.0.0.1:8585/callback?code=g&state=${params.state}` })
  assert.equal(acc.email, "me@gmail.com")
  assert.equal(acc.plan, "g1-pro-tier") // AI Pro 는 paidTier 로 온다
  assert.equal(api.planLabel(acc.plan, "antigravity"), "AI Pro")
  assert.equal(api.devGetCreds(acc.id).project_id, "proj-1")
  const { usage } = await call("GET", `/v1/accounts/${acc.id}`)
  // 이름은 기간으로, 그룹 안에서는 5시간 → 주간. 대표 창은 사용률과 상관없이 첫 그룹(Gemini).
  assert.deepEqual(usage.windows.map((w) => [api.windowTitle(w), w.used_percent, w.primary]),
    [["Gemini 5시간", 60, true], ["Gemini 주간", 10, true], ["Claude/GPT 5시간", 30, false], ["Claude/GPT 주간", 95, false]])
  // 위젯에 보일 그룹을 고르면 그 그룹의 5시간·주간
  const entry = { ...usage, id: acc.id }
  assert.deepEqual(api.primaryWindows(entry).map(api.windowTitle), ["Gemini 5시간", "Gemini 주간"])
  api.setWidgetGroup(acc.id, "Claude and GPT models")
  assert.deepEqual(api.primaryWindows(entry).map(api.windowTitle), ["Claude/GPT 5시간", "Claude/GPT 주간"])
})

await test("숨김·이름 변경·삭제(키체인·파일 정리)", async () => {
  await call("PATCH", `/v1/accounts/${codexId}`, { label: "회사", enabled: false })
  assert.ok(!(await call("GET", "/v1/usage")).accounts.some((a) => a.id === codexId))
  // 앱은 ?all=1 로 숨긴 계정도 사용량과 함께 받는다(위젯에서만 숨김)
  const hidden = (await call("GET", "/v1/usage?all=1")).accounts.find((a) => a.id === codexId)
  assert.equal(hidden.enabled, false)
  assert.ok(hidden.windows.length > 0)
  await call("DELETE", `/v1/accounts/${codexId}`)
  assert.ok(!(api.devCredKey(codexId) in kc))
  assert.ok(!Object.keys(files).some((f) => f.includes(codexId)))
  await assert.rejects(call("GET", `/v1/accounts/${codexId}`))
})

await test("플랜 표시: Codex Team 은 Business, Claude Max 는 5x/20x", () => {
  assert.equal(api.planLabel("team", "codex"), "Business")
  assert.equal(api.planLabel("team", "claude"), "Team")
  assert.equal(api.planLabel("default_claude_max_20x", "claude"), "Max 20x")
  assert.equal(api.planLabel("plus", "codex"), "Plus")
  assert.equal(api.resetText(new Date(Date.now() - 60e3).toISOString()), "곧 초기화")
})

await test("Claude: 코드네임 블록·모델 행은 숨기고, 예전에 저장된 창도 거른다", () => {
  const ws = api.claudeWindows({
    five_hour: { utilization: 42, resets_at: "2026-10-03T03:00:00Z" },
    seven_day_sonnet: { utilization: 5, resets_at: null },
    iguana_necktie: { utilization: 1, resets_at: "2026-10-08T00:00:00Z" },
    limits: [
      { kind: "weekly_scoped", scope: { model: { display_name: "Fable 5.1" } }, percent: 33, resets_at: 1790000000 },
      { kind: "weekly_scoped", scope: { model: { display_name: "Iguana Necktie" } }, percent: 7 },
      { kind: "weekly_scoped", scope: { model: { display_name: "Sonnet" } }, percent: 5 },
    ],
  })
  assert.deepEqual(ws.map((w) => w.label), ["현재 세션", "Sonnet 이번 주", "Fable 5.1 이번 주"])
  const data = api.cleanUsage({ accounts: [
    { provider: "claude", windows: [{ key: "session" }, { key: "iguana_necktie" }, { key: "model:Iguana Necktie" }, { key: "model:Fable" }] },
    { provider: "codex", windows: [{ key: "session" }, { key: "additional:gpt_5_codex_spark:5h" }] },
  ] })
  assert.deepEqual(data.accounts.map((a) => a.windows.map((w) => w.key)),
    [["session", "model:Fable"], ["session", "additional:gpt_5_codex_spark:5h"]])
})

await test("알림: 기준 초과·초기화 예약·재로그인·초기화권 만료 임박, 같은 알림은 한 번만", async () => {
  const soon = new Date(Date.now() + 3 * 3600e3).toISOString()
  const accounts = [
    { id: "a1", provider: "codex", label: "회사", status: "ok", windows: [
      { key: "session", label: "5시간", used_percent: 93, resets_at: soon, primary: true },
      { key: "weekly", label: "주간", used_percent: 40, resets_at: soon, primary: true }],
      reset_credits: { items: [{ expires_at: new Date(Date.now() + 5 * 3600e3).toISOString() }, { expires_at: "2099-01-01T00:00:00Z" }] } },
    { id: "a2", provider: "claude", label: "부계정", status: "needs_login", last_success_at: "2026-01-01T00:00:00Z", windows: [] },
    { id: "a3", provider: "claude", label: "오래된값", status: "error", stale: true,
      windows: [{ key: "session", label: "현재 세션", used_percent: 99, resets_at: soon, primary: true }] },
  ]
  notifications.length = 0
  await api.checkAlerts(accounts)
  const ids = notifications.map((n) => n.id).sort()
  assert.deepEqual(ids, ["aiusage-credit-a1-" + Date.parse(accounts[0].reset_credits.items[0].expires_at), "aiusage-high-a1-session",
    "aiusage-login-a2", "aiusage-reset-a1-session"].sort())
  const high = notifications.find((n) => n.id === "aiusage-high-a1-session")
  assert.equal(high.title, "Codex (회사)")
  assert.match(high.body, /^5시간 사용량이 93%예요\. (2시간 5\d분|3시간) 후 초기화돼요\.$/)
  assert.equal(notifications.find((n) => n.id === "aiusage-reset-a1-session").at.toISOString(), new Date(soon).toISOString())
  // 다시 확인해도 같은 알림은 보내지 않는다
  notifications.length = 0
  await api.checkAlerts(accounts)
  assert.equal(notifications.length, 0)
  // 기준을 낮추면 주간(40%)도 알림. 끄면 아무것도 보내지 않는다.
  api.saveNotifySettings({ enabled: true, threshold: 40 })
  await api.checkAlerts(accounts)
  assert.deepEqual(notifications.map((n) => n.id).sort(), ["aiusage-high-a1-weekly", "aiusage-reset-a1-weekly"])
  notifications.length = 0
  api.saveNotifySettings({ enabled: false, threshold: 40 })
  await api.checkAlerts([{ ...accounts[0], id: "a9" }])
  assert.equal(notifications.length, 0)
  api.saveNotifySettings({ enabled: true, threshold: 90 })
})

await test("알림: 종류별로 끄기, 예정보다 이른 초기화 감지", async () => {
  const H = 3600e3
  const at = (ms) => new Date(Date.now() + ms).toISOString()
  const acc = (id, used, resetsAt) => ({ id, provider: "claude", label: "개인", status: "ok",
    windows: [{ key: "weekly", label: "이번 주", used_percent: used, resets_at: resetsAt, primary: true }] })
  // 사용량 경고만 끄면 초기화 예약만 남는다
  api.saveNotifySettings({ enabled: true, threshold: 90, types: { high: false } })
  notifications.length = 0
  await api.checkAlerts([acc("e1", 95, at(48 * H))])
  assert.deepEqual(notifications.map((n) => n.id), ["aiusage-reset-e1-weekly"])
  // 예정(48시간 뒤)보다 일찍 95% → 3% 로 떨어지면 조기 초기화 알림, 예약해 둔 초기화 알림은 취소
  notifications.length = 0
  removed.length = 0
  await api.checkAlerts([acc("e1", 3, at(7 * 24 * H))])
  assert.deepEqual(notifications.map((n) => n.id), ["aiusage-early-e1-weekly"])
  assert.equal(notifications[0].body, "이번 주 한도가 예정보다 일찍 초기화됐어요. (95% → 3%)")
  assert.deepEqual(removed, ["aiusage-reset-e1-weekly"])
  // 같은 초기화는 한 번만
  notifications.length = 0
  await api.checkAlerts([acc("e1", 3, at(7 * 24 * H))])
  assert.equal(notifications.length, 0)
  // 예정 시각이 지난 뒤의 정상 초기화, 조금 줄어든 값은 조기 초기화가 아니다
  await api.checkAlerts([acc("e2", 60, at(-60e3))])
  await api.checkAlerts([acc("e2", 1, at(7 * 24 * H))])
  await api.checkAlerts([acc("e3", 60, at(48 * H))])
  await api.checkAlerts([acc("e3", 55, at(48 * H))])
  assert.equal(notifications.length, 0)
  // 조기 초기화 알림을 끄면 보내지 않는다
  api.saveNotifySettings({ enabled: true, threshold: 90, types: { early: false } })
  await api.checkAlerts([acc("e4", 70, at(48 * H))])
  await api.checkAlerts([acc("e4", 0, at(7 * 24 * H))])
  assert.equal(notifications.filter((n) => n.id.startsWith("aiusage-early")).length, 0)
  api.saveNotifySettings({ enabled: true, threshold: 90 })
})

await test("언어: 모든 문구가 4개 언어로 있고, 시간·한도 이름·상태가 바뀐다", () => {
  for (const [key, row] of Object.entries(api.STRINGS)) assert.equal(row.length, api.LANG_CODES.length, key)
  const at = new Date(Date.now() + (2 * 60 + 12) * 60e3 + 30e3).toISOString()
  const w = { label: "Fable 이번 주" }
  const seen = {}
  for (const lang of api.LANG_CODES) {
    api.setLang(lang)
    seen[lang] = [api.fmtDuration(at), api.resetText(at), api.windowTitle({ label: "현재 세션" }), api.windowTitle(w),
      api.windowTitle({ label: "5시간", group: "Gemini Models" }), api.statusText("needs_login"), api.t("pill.credits", { n: 1 }),
      api.windowTitle({ label: "주간", group: "추가 한도" })]
  }
  assert.deepEqual(seen.ko, ["2시간 12분", "2시간 12분 후 초기화", "현재 세션", "Fable 이번 주", "Gemini 5시간", "재로그인 필요", "초기화권 1", "추가 한도 주간"])
  assert.deepEqual(seen.en, ["2h 12m", "Resets in 2h 12m", "Current session", "Fable this week", "Gemini 5h", "Sign-in needed", "1 reset", "Extra limit Weekly"])
  assert.deepEqual(seen.ja.slice(0, 3), ["2時間12分", "2時間12分後にリセット", "現在のセッション"])
  assert.deepEqual(seen.zh.slice(0, 3), ["2小时12分钟", "2小时12分钟后重置", "当前会话"])
  assert.equal(api.t("pill.credits", { n: 3 }), "重置券 3")
  api.setLang("en")
  assert.equal(api.t("pill.credits", { n: 3 }), "3 resets")
  assert.equal(api.t("no.such.key"), "no.such.key")
  api.setLang("ko")
})

await test("서버 모드: 프록시가 HTML 오류 페이지를 줘도 상태 코드를 잃지 않는다", async () => {
  const realLoad = Request.prototype.loadString
  const reply = (status, body) => { Request.prototype.loadString = async function () { this.response = { statusCode: status, headers: {} }; return body } }
  const cfg = { server: "https://ai.example.com/", apiKey: "k" }
  try {
    reply(502, "<html>Bad Gateway</html>")
    await assert.rejects(api.serverApi(cfg, "GET", "/v1/usage"), (e) => e.status === 502 && e.message === "HTTP 502")
    reply(401, JSON.stringify({ error: "API 키가 올바르지 않습니다." }))
    await assert.rejects(api.serverApi(cfg, "GET", "/v1/usage"), (e) => e.status === 401 && /API 키/.test(e.message))
    reply(200, JSON.stringify({ accounts: [] }))
    assert.deepEqual(await api.serverApi(cfg, "GET", "/v1/accounts"), { accounts: [] })
  } finally {
    Request.prototype.loadString = realLoad
  }
})

// ── 3. 위젯이 기기 모드에서 그려지는지 (전체 스크립트 실행) ──
await test("기기 모드 위젯 렌더링", async () => {
  const log = []
  class Stack { addStack() { return new Stack() } addText(t) { log.push(t); return {} } addImage() { return {} } addSpacer() {}
    layoutHorizontally() {} layoutVertically() {} centerAlignContent() {} bottomAlignContent() {} setPadding() {} }
  class ListWidget extends Stack {}
  class DrawContext { addPath() {} setFillColor() {} fillPath() {} getImage() { return {} } }
  class Path { addRoundedRect() {} }
  let widget
  const wenv = { ...env, ListWidget, DrawContext, Path, Rect: class {}, Size: class {}, Image: { fromData: () => ({}) },
    Data: { fromBase64String: () => ({}) }, Script: { setWidget: (w) => (widget = w), complete() {} },
    config: { runsInWidget: true, widgetFamily: "medium" }, args: { widgetParameter: "" }, DateFormatter: class { string() { return "" } } }
  await new Function(...Object.keys(wenv), `return (async () => {${SRC}})()`)(...Object.values(wenv))
  assert.ok(widget, "위젯이 만들어져야 함")
  assert.ok(log.includes("개인") && log.includes("구글"), log.join(" | "))
  assert.ok(log.some((t) => /후 초기화/.test(t)))
})

console.log(`\n${passed} tests passed`)
