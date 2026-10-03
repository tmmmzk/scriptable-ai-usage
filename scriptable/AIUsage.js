// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-purple; icon-glyph: tachometer-alt;

// AI 사용량 위젯 — Claude / Codex / Antigravity
// https://github.com/tmmmzk/scriptable-ai-usage
//
// • 두 가지 방식: 서버 모드(직접 띄운 서버가 수집) / 기기 모드(서버 없이 이 스크립트가 직접 조회)
// • 앱에서 실행하면 설정·계정 관리 화면이 열립니다.
// • 위젯 Parameter 에 계정 이름(또는 id)을 쉼표로 적으면 그 계정만 표시합니다. 예) 개인,회사

const VERSION = "0.3.0"
const KC_SERVER = "aiusage.server"
const KC_KEY = "aiusage.apikey"
const CACHE_FILE = "aiusage-cache.json"
const WIDGET_REFRESH_MIN = 15

const PROVIDER_STYLE = {
  claude: { color: "#D97757", name: "Claude", abbr: "CL" },
  codex: { color: "#10A37F", name: "Codex", abbr: "CX" },
  antigravity: { color: "#4285F4", name: "Antigravity", abbr: "AG" },
}

function providerName(provider) {
  return (PROVIDER_STYLE[provider] || {}).name || provider
}

const C = {
  bg: Color.dynamic(new Color("#FFFFFF"), new Color("#1C1C1E")),
  text: Color.dynamic(new Color("#1C1C1E"), new Color("#F2F2F7")),
  sub: Color.dynamic(new Color("#6E6E73"), new Color("#98989F")),
  // DrawContext 이미지에는 dynamic 색이 적용되지 않으므로 양쪽 모드에서 보이는 반투명 단색
  track: new Color("#8E8E93", 0.25),
  pill: Color.dynamic(new Color("#787880", 0.14), new Color("#787880", 0.28)),
  ok: new Color("#34C759"),
  warn: new Color("#FF9F0A"),
  bad: new Color("#FF453A"),
}

// ───────────────────────── 설정 / API ─────────────────────────
function getConfig() {
  if (getMode() === "device") return { device: true }
  const server = Keychain.contains(KC_SERVER) ? Keychain.get(KC_SERVER) : null
  const apiKey = Keychain.contains(KC_KEY) ? Keychain.get(KC_KEY) : null
  return server && apiKey ? { server, apiKey } : null
}

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

const DAY_MS = 86400 * 1000

// ───────────────────────── 기기 모드 (서버 없이) ─────────────────────────
// 서버가 하던 일(로그인·토큰 갱신·조회)을 이 스크립트가 직접 한다. 화면 쪽은 서버와 같은 API 형식을 그대로 쓴다.
// 토큰은 키체인(계정별), 계정 목록·사용량은 기기 파일에 둔다. 위젯과 앱이 같은 저장소를 같이 쓴다.
const KC_MODE = "aiusage.mode" // "server" | "device"
const KC_AG_CLIENT = "aiusage.dev.antigravityClient"
const DEV_ACCOUNTS_FILE = "aiusage-device-accounts.json"
const DEV_LOGINS_FILE = "aiusage-device-logins.json"
const DEV_AUTO_REFRESH_MS = 10 * 60 * 1000 // 이보다 오래된 값은 위젯·앱을 열 때 다시 조회
const DEV_MIN_REFRESH_MS = 60 * 1000 // '새로고침'을 눌러도 이 간격 안에서는 다시 조회하지 않음
const DEV_LOCK_MS = 30 * 1000
const DEV_LOGIN_TTL_MS = 15 * 60 * 1000

function getMode() {
  if (Keychain.contains(KC_MODE)) return Keychain.get(KC_MODE)
  return Keychain.contains(KC_SERVER) ? "server" : null // 기기 모드가 생기기 전 설정
}

function setMode(mode) {
  Keychain.set(KC_MODE, mode)
}

// ── 바이트·인코딩 (Scriptable 에는 crypto 가 없어 PKCE 용 SHA-256 등을 직접 구현) ──
function utf8Bytes(str) {
  const out = []
  for (const ch of str) {
    const c = ch.codePointAt(0)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

function utf8Decode(bytes) {
  let s = ""
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]
    let c = b
    if (b >= 0xf0) c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63)
    else if (b >= 0xe0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63)
    else if (b >= 0xc0) c = ((b & 31) << 6) | (bytes[i++] & 63)
    s += String.fromCodePoint(c)
  }
  return s
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

function b64url(bytes) {
  let s = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    s += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63]
    if (i + 1 < bytes.length) s += B64_CHARS[(n >> 6) & 63]
    if (i + 2 < bytes.length) s += B64_CHARS[n & 63]
  }
  return s
}

// 일반·URL-safe base64 모두, 패딩이 없어도 읽는다
function b64decode(str) {
  const out = []
  let buf = 0
  let bits = 0
  for (const ch of str.replace(/\+/g, "-").replace(/\//g, "_")) {
    const v = B64_CHARS.indexOf(ch)
    if (v < 0) continue
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buf >> bits) & 255)
      buf &= (1 << bits) - 1
    }
  }
  return out
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]

function sha256(bytes) {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const bitLen = bytes.length * 8
  const msg = bytes.concat([0x80])
  while (msg.length % 64 !== 56) msg.push(0)
  msg.push(0, 0, 0, 0, (bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  const w = new Array(64)
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      w[i] = ((msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, k] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      k = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, k].forEach((v, i) => (h[i] = (h[i] + v) >>> 0))
  }
  return h.flatMap((v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255])
}

// iOS 가 만드는 UUID(v4) 의 난수로 바이트를 채운다
function randomBytes(n) {
  let hex = ""
  while (hex.length < n * 2) hex += UUID.string().replace(/-/g, "")
  return Array.from({ length: n }, (_, i) => parseInt(hex.substr(i * 2, 2), 16))
}

const randomToken = (n = 32) => b64url(randomBytes(n))

function pkcePair() {
  const verifier = randomToken(32)
  return { verifier, challenge: b64url(sha256(utf8Bytes(verifier))) }
}

// 서명 검증 없이 JWT payload 만 읽는다(표시·만료 계산용)
function jwtClaims(token) {
  try {
    return JSON.parse(utf8Decode(b64decode(String(token).split(".")[1])))
  } catch (e) {
    return {}
  }
}

const formEncode = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")

// ── HTTP ──
class ProviderError extends Error {
  // kind: 위젯 상태로 그대로 쓰인다 (needs_login / rate_limited / blocked / error)
  constructor(message, kind = "error") {
    super(message)
    this.kind = kind
  }
}

class RefreshBusy extends Error {}

const authError = (message) => new ProviderError(message, "needs_login")

async function devHttp(method, url, { headers = {}, json, form, timeout = 15 } = {}) {
  const req = new Request(url)
  req.method = method
  req.timeoutInterval = timeout
  const h = { Accept: "application/json", ...headers }
  if (json !== undefined) {
    h["Content-Type"] = "application/json"
    req.body = JSON.stringify(json)
  } else if (form) {
    h["Content-Type"] = "application/x-www-form-urlencoded"
    req.body = formEncode(form)
  }
  req.headers = h
  let text
  try {
    text = await req.loadString()
  } catch (e) {
    throw new ProviderError(`네트워크 오류: ${e.message || e}`)
  }
  const res = req.response || {}
  const status = res.statusCode || 0
  const hdrs = res.headers || {}
  const cf = Object.keys(hdrs).find((k) => k.toLowerCase() === "cf-mitigated")
  return {
    status,
    ok: status >= 200 && status < 300,
    text: text || "",
    challenge: !!cf && String(hdrs[cf]).toLowerCase() === "challenge",
    json() {
      try {
        return JSON.parse(this.text)
      } catch (e) {
        throw new ProviderError(`JSON 파싱 실패: ${this.text.slice(0, 120)}`)
      }
    },
  }
}

// 401/403(챌린지 제외) → 재로그인 필요
function checkAuth(res, what) {
  if ((res.status === 401 || res.status === 403) && !res.challenge) throw authError(`${what}: 인증 실패(HTTP ${res.status})`)
}

// 429, Cloudflare, 그 밖의 오류
function checkCommon(res, what) {
  if (res.status === 429) throw new ProviderError(`${what}: 요청 한도 초과(429)`, "rate_limited")
  if (res.status === 403 && res.challenge) throw new ProviderError(`${what}: Cloudflare 챌린지로 차단됨`, "blocked")
  if (!res.ok) throw new ProviderError(`${what}: HTTP ${res.status} ${res.text.slice(0, 160)}`)
}

// ── 정규화 공통 (서버의 providers/base.py 와 같은 형식) ──
const isoOf = (ms) => (ms == null || isNaN(ms) ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"))

// ISO-8601 → epoch ms. 소수점 자릿수가 긴 값(나노초)도 처리.
function msOf(v) {
  if (typeof v !== "string" || !v.trim()) return null
  const t = Date.parse(v.trim().replace(/(\.\d{3})\d+/, "$1"))
  return isNaN(t) ? null : t
}

function num(v) {
  if (typeof v === "number" && isFinite(v)) return v
  if (typeof v === "string" && v.trim() && isFinite(Number(v))) return Number(v)
  return null
}

const clampPct = (v) => (v == null ? null : Math.round(Math.max(0, Math.min(100, v)) * 10) / 10)

function makeWindow(key, label, used, resetsAt, { seconds = null, group = null, primary = false } = {}) {
  return {
    key, label, group, used_percent: used,
    remaining_percent: used == null ? null : Math.round((100 - used) * 10) / 10,
    resets_at: resetsAt, window_seconds: seconds, primary,
  }
}

function windowLabel(seconds) {
  if (!seconds) return "?"
  if (seconds % 86400 === 0) return seconds === 7 * 86400 ? "주간" : `${seconds / 86400}일`
  return `${Math.round(seconds / 3600)}시간`
}

// 초기화권 한 장 → [정렬용 만료 ms, 응답용 항목]. 사용(redeem)용 id 는 넣지 않는다.
function resetCredit(expires, granted = null, { title, description, reset_type } = {}) {
  const text = (v) => (typeof v === "string" ? v : null)
  return [expires, {
    title: text(title), description: text(description), reset_type: text(reset_type),
    granted_at: isoOf(granted), expires_at: isoOf(expires),
  }]
}

function resetCreditsSummary(credits, available = null) {
  const sorted = [...credits].sort((x, y) => (x[0] == null) - (y[0] == null) || (x[0] || 0) - (y[0] || 0))
  const exps = sorted.map((c) => c[0])
  return {
    available: available != null ? available : sorted.length,
    next_expires_at: exps.length && exps[0] ? isoOf(exps[0]) : null,
    expirations: exps.map(isoOf),
    items: sorted.map((c) => c[1]),
  }
}

// 사용자가 붙여넣은 값 → { code, state }. 리다이렉트 전체 URL, code#state, code 만 모두 허용.
function parseCallbackInput(raw) {
  const text = String(raw || "").trim()
  if (!text) throw new ProviderError("입력이 비어 있습니다.")
  if (text.includes("://") || text.includes("code=")) {
    const query = text.includes("?") ? text.split("?").slice(1).join("?").split("#")[0] : text
    const params = {}
    for (const part of query.split("&")) {
      const [k, v = ""] = part.split("=")
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "))
    }
    if (params.error) throw new ProviderError(`로그인 거부/실패: ${params.error}`)
    if (!params.code) throw new ProviderError("URL에 code 파라미터가 없습니다. 주소창의 전체 URL을 복사했는지 확인하세요.")
    return { code: params.code, state: params.state || null }
  }
  if (text.includes("#")) {
    const [code, state] = text.split("#")
    return { code: code.trim(), state: state.trim() || null }
  }
  return { code: text, state: null }
}

function checkState(expected, got) {
  if (got != null && got !== expected) throw new ProviderError("state 값이 일치하지 않습니다. 로그인을 처음부터 다시 시작하세요.")
}

const authorizeUrl = (base, params) =>
  `${base}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`

// ── Claude ──
const CLAUDE = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  scopes: ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"],
  usageUrl: "https://api.anthropic.com/api/oauth/usage",
  profileUrl: "https://api.anthropic.com/api/oauth/profile",
  webBase: "https://claude.ai/api",
  userAgent: "claude-code/2.1.0",
  webUserAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
}

// 표시할 사용량 창(Claude Code 의 /usage 와 같은 것만). 응답에는 내부 코드네임 블록
// (예: iguana_necktie)도 섞여 오므로, 모르는 키는 보여주지 않는다.
const CLAUDE_WINDOWS = [
  ["five_hour", "session", "현재 세션", 5 * 3600, true],
  ["seven_day", "weekly", "이번 주", 7 * 86400, true],
  ["seven_day_opus", "weekly_opus", "Opus 이번 주", 7 * 86400, false],
  ["seven_day_sonnet", "weekly_sonnet", "Sonnet 이번 주", 7 * 86400, false],
]

// limits[] 의 모델별 주간 한도도 알려진 모델만 보여준다. Claude Code 는 허용 목록(기본 Fable)으로
// 거르고, 목록에 없는 행에는 코드네임 모델이 섞여 온다. 새 버전(예: Fable 6)은 계열 이름으로 통과시킨다.
const CLAUDE_MODEL_FAMILIES = /^(fable|opus|sonnet|haiku)\b/i
const claudeModelShown = (name) => typeof name === "string" && CLAUDE_MODEL_FAMILIES.test(name.trim())

// 저장된 창 중 보여줄 것. 예전 버전이 저장한 코드네임 창(iguana_necktie 등)도 여기서 걸러진다.
function claudeWindowShown(w) {
  const key = String((w && w.key) || "")
  return CLAUDE_WINDOWS.some(([, k]) => k === key) || (key.startsWith("model:") && claudeModelShown(key.slice(6)))
}

// /api/oauth/profile 의 organization_type → 플랜. Max 는 rate_limit_tier 로 5x/20x 를 구분한다.
const CLAUDE_ORG_PLANS = { claude_max: "max", claude_pro: "pro", claude_team: "team", claude_enterprise: "enterprise" }

function claudePlan(profile) {
  const org = profile && profile.organization
  if (!org || typeof org !== "object") return null
  if (typeof org.rate_limit_tier === "string" && /max_\d+x/.test(org.rate_limit_tier)) return org.rate_limit_tier
  return CLAUDE_ORG_PLANS[org.organization_type] || null
}

// 플랜은 부가 정보라 실패해도 사용량 조회를 막지 않는다
async function claudeFetchPlan(accessToken) {
  try {
    const res = await devHttp("GET", CLAUDE.profileUrl, { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": CLAUDE.userAgent } })
    return res.ok ? claudePlan(res.json()) : null
  } catch (e) {
    return null
  }
}

function claudeWindows(data) {
  const out = []
  for (const [src, key, label, seconds, primary] of CLAUDE_WINDOWS) {
    const b = data[src]
    if (b && typeof b === "object" && b.utilization != null)
      out.push(makeWindow(key, label, clampPct(num(b.utilization)), isoOf(msOf(b.resets_at)), { seconds, primary }))
  }
  // 모델별 주간 한도(예: Fable). limits[] 중 kind 가 weekly_scoped 인 것.
  for (const item of Array.isArray(data.limits) ? data.limits : []) {
    const name = item && item.kind === "weekly_scoped" && ((item.scope || {}).model || {}).display_name
    if (!claudeModelShown(name)) continue
    const model = name.trim()
    if (out.some((w) => w.label === `${model} 이번 주`)) continue // seven_day_opus 등과 겹치면 하나만
    const resets = typeof item.resets_at === "number" ? isoOf(item.resets_at * 1000) : isoOf(msOf(item.resets_at))
    out.push(makeWindow(`model:${model}`, `${model} 이번 주`, clampPct(num(item.percent)), resets, { seconds: 7 * 86400 }))
  }
  return out
}

function claudeExtra(data) {
  const e = data.extra_usage
  if (!e || typeof e !== "object" || !e.is_enabled) return {}
  return { extra_usage: { used: num(e.used_credits), limit: num(e.monthly_limit || e.monthly_credit_limit),
    used_percent: clampPct(num(e.utilization)), currency: e.currency || null } }
}

// cedar_ember → 초기화권. 일시정지·소진·미시작·만료된 grant 는 빼고 resets_left 만큼 펼친다.
function claudeResetCredits(block, at) {
  if (!block || typeof block !== "object" || block.eligible !== true) return null
  const credits = []
  for (const g of block.grants || []) {
    if (!g || typeof g !== "object") continue
    const left = g.resets_left
    if (!Number.isInteger(left) || left <= 0 || g.paused !== false) continue
    const starts = msOf(g.starts_at)
    const ends = msOf(g.ends_at)
    if ((starts != null && starts > at) || (ends != null && ends <= at)) continue
    if (credits.length + left > 50) return null
    for (let i = 0; i < left; i++) credits.push(resetCredit(ends, starts))
  }
  return resetCreditsSummary(credits)
}

function claudeOAuth(data, prev = {}) {
  if (!data.access_token) throw new ProviderError("토큰 응답에 access_token 이 없습니다.")
  const scopes = typeof data.scope === "string" ? data.scope.split(" ") : data.scope
  return {
    access_token: data.access_token,
    // 리프레시 토큰은 쓸 때마다 바뀐다. 응답에 없으면 이전 값을 유지.
    refresh_token: data.refresh_token || prev.refresh_token,
    expires_at: Date.now() + (num(data.expires_in) || 3600) * 1000,
    scopes: scopes || prev.scopes || CLAUDE.scopes,
  }
}

const claudeWebHeaders = (key) => ({ Cookie: `sessionKey=${key}`, "User-Agent": CLAUDE.webUserAgent })

async function claudeWebOrg(sessionKey) {
  const res = await devHttp("GET", `${CLAUDE.webBase}/organizations`, { headers: claudeWebHeaders(sessionKey) })
  checkAuth(res, "sessionKey")
  checkCommon(res, "claude.ai 조직 조회")
  const orgs = res.json()
  if (!Array.isArray(orgs) || !orgs.length) throw new ProviderError("claude.ai 조직 목록이 비어 있습니다.")
  const caps = (o) => (o.capabilities || []).map((c) => String(c).toLowerCase())
  return orgs.find((o) => caps(o).includes("chat")) || orgs.find((o) => caps(o).join() !== "api") || orgs[0]
}

async function claudeWebUsage(creds, ctx) {
  if (!creds.org_id) {
    creds = { ...creds, org_id: (await claudeWebOrg(creds.session_key)).uuid }
    ctx.save(creds)
  }
  const base = `${CLAUDE.webBase}/organizations/${creds.org_id}/usage`
  const headers = claudeWebHeaders(creds.session_key)
  let res = await devHttp("GET", `${base}?cedar_ember=1`, { headers })
  checkAuth(res, "sessionKey")
  // 초기화권 옵트인이 거부되면 옵션 없이 한 번 더(사용량은 받을 수 있음)
  if (!res.ok && res.status !== 429 && !res.challenge) res = await devHttp("GET", base, { headers })
  checkCommon(res, "claude.ai 사용량")
  return res.json()
}

const claudeProvider = {
  methods: ["oauth", "session_key"],
  configured: () => [true, null],
  refreshToken: (c) => c.oauth && c.oauth.refresh_token,
  needsRefresh: (c) => !!c.oauth && (c.oauth.expires_at || 0) - 5 * 60 * 1000 < Date.now(),

  startLogin() {
    const { verifier, challenge } = pkcePair()
    const state = randomToken(24)
    return {
      authorize_url: authorizeUrl(CLAUDE.authorizeUrl, {
        code: "true", client_id: CLAUDE.clientId, response_type: "code", redirect_uri: CLAUDE.redirectUri,
        scope: CLAUDE.scopes.join(" "), code_challenge: challenge, code_challenge_method: "S256", state,
      }),
      instructions: "Claude 계정으로 로그인해 승인하면 코드가 나와요. 'Copy Code'를 눌러 복사한 뒤 돌아오세요.",
      input_hint: "복사한 코드 (code#state 형식)",
      pending: { verifier, state },
    }
  },

  async finishLogin(pending, input) {
    const { code, state } = parseCallbackInput(input)
    checkState(pending.state, state)
    const res = await devHttp("POST", CLAUDE.tokenUrl, { json: {
      grant_type: "authorization_code", code, redirect_uri: CLAUDE.redirectUri, client_id: CLAUDE.clientId,
      code_verifier: pending.verifier, state: pending.state,
    } })
    if (!res.ok) throw new ProviderError(`토큰 교환 실패: HTTP ${res.status} ${res.text.slice(0, 160)}`)
    const data = res.json()
    const creds = { oauth: claudeOAuth(data) }
    if (data.organization && data.organization.uuid) creds.org_id = data.organization.uuid
    const account = data.account || {}
    return { creds, email: account.email_address || account.email || null, plan: await claudeFetchPlan(creds.oauth.access_token) }
  },

  async createManual({ session_key }) {
    const key = String(session_key || "").trim()
    if (!key.startsWith("sk-ant-")) throw new ProviderError("sessionKey 는 'sk-ant-' 로 시작해야 합니다.")
    const org = await claudeWebOrg(key)
    return { creds: { session_key: key, org_id: org.uuid }, email: null }
  },

  describe: (c) => ({ oauth: !!(c.oauth && c.oauth.refresh_token), session_key: !!c.session_key,
    reset_credits_supported: !!c.session_key }),

  async refresh(c) {
    if (!c.oauth || !c.oauth.refresh_token) throw authError("리프레시 토큰이 없습니다. 다시 로그인하세요.")
    const res = await devHttp("POST", CLAUDE.tokenUrl, { json: {
      grant_type: "refresh_token", refresh_token: c.oauth.refresh_token, client_id: CLAUDE.clientId,
      scope: (c.oauth.scopes || CLAUDE.scopes).join(" "),
    } })
    if ([400, 401, 403].includes(res.status)) throw authError(`토큰 갱신 거부(HTTP ${res.status}). 다시 로그인하세요.`)
    checkCommon(res, "Claude 토큰 갱신")
    return { ...c, oauth: claudeOAuth(res.json(), c.oauth) }
  },

  async fetch(creds, ctx) {
    const usage = { windows: [], reset_credits: null, plan: null, email: null, extra: {}, warnings: [] }
    if (creds.oauth) {
      if (this.needsRefresh(creds)) creds = await ctx.refresh(creds)
      const get = () => devHttp("GET", CLAUDE.usageUrl, { headers: {
        Authorization: `Bearer ${creds.oauth.access_token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": CLAUDE.userAgent,
      } })
      let res = await get()
      if (res.status === 401) {
        creds = await ctx.refresh(creds)
        res = await get()
      }
      checkAuth(res, "Claude OAuth")
      checkCommon(res, "Claude 사용량")
      const data = res.json()
      usage.windows = claudeWindows(data)
      usage.extra = claudeExtra(data)
      // 사용량 응답에는 플랜이 없어 프로필로 따로 조회(바뀔 일이 드물어 모를 때만)
      if (!ctx.knownPlan) usage.plan = await claudeFetchPlan(creds.oauth.access_token)
    }
    if (creds.session_key) {
      let web = null
      try {
        web = await claudeWebUsage(creds, ctx)
      } catch (e) {
        if (!creds.oauth) throw e
        usage.warnings.push(e.kind === "needs_login" ? `sessionKey 만료: ${e.message}` : `초기화권 조회 실패: ${e.message}`)
      }
      if (web) {
        if (!usage.windows.length) {
          usage.windows = claudeWindows(web)
          usage.extra = claudeExtra(web)
        }
        usage.reset_credits = claudeResetCredits(web.cedar_ember, Date.now())
      }
    }
    return usage
  },
}

// ── Codex ──
const CODEX = {
  issuer: "https://auth.openai.com",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  apiBase: "https://chatgpt.com/backend-api",
  userAgent: "codex_cli_rs/0.50.0 (iOS; arm64)",
}

function codexIdInfo(idToken) {
  const claims = jwtClaims(idToken)
  const auth = claims["https://api.openai.com/auth"] || {}
  return { email: claims.email || null, account_id: auth.chatgpt_account_id || null, plan: auth.chatgpt_plan_type || null }
}

function codexCreds(data, prev = {}) {
  if (!data.access_token) throw new ProviderError("토큰 응답에 access_token 이 없습니다.")
  const id_token = data.id_token || prev.id_token
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || prev.refresh_token,
    id_token,
    account_id: codexIdInfo(id_token).account_id || prev.account_id,
    last_refresh: Date.now(),
  }
}

function codexWindow(raw, keyHint, group, primary) {
  if (!raw || typeof raw !== "object") return null
  const seconds = typeof raw.limit_window_seconds === "number" ? Math.round(raw.limit_window_seconds) : null
  const reset = typeof raw.reset_at === "number" ? isoOf(raw.reset_at * 1000) : isoOf(msOf(raw.reset_at))
  const key = seconds ? (seconds <= 86400 ? "session" : "weekly") : keyHint
  return makeWindow(key, windowLabel(seconds), clampPct(num(raw.used_percent)), reset, { seconds, group, primary })
}

function codexWindows(data) {
  const out = []
  const rate = data.rate_limit || {}
  for (const name of ["primary_window", "secondary_window"]) {
    const w = codexWindow(rate[name], name, null, true)
    if (w) out.push(w)
  }
  for (const extra of data.additional_rate_limits || []) {
    if (!extra || typeof extra !== "object") continue
    const name = extra.limit_name || extra.metered_feature || "추가 한도"
    for (const wname of ["primary_window", "secondary_window"]) {
      const w = codexWindow((extra.rate_limit || {})[wname], wname, name, false)
      if (w) out.push({ ...w, key: `${name}:${w.key}` })
    }
  }
  return out
}

function codexExtra(data) {
  const c = data.credits
  if (!c || typeof c !== "object" || !(c.has_credits || c.unlimited)) return {}
  return { credits: { unlimited: !!c.unlimited, balance: num(c.balance) } }
}

function codexResetCredits(data, at) {
  if (!data || typeof data !== "object") return null
  const credits = []
  for (const c of data.credits || []) {
    if (!c || typeof c !== "object" || c.status !== "available") continue
    const exp = msOf(c.expires_at)
    if (exp != null && exp <= at) continue
    credits.push(resetCredit(exp, msOf(c.granted_at), c))
  }
  const count = data.available_count
  return resetCreditsSummary(credits, Number.isInteger(count) && count >= 0 ? count : null)
}

const codexProvider = {
  methods: ["oauth"],
  configured: () => [true, null],
  refreshToken: (c) => c.refresh_token,
  needsRefresh(c) {
    const exp = jwtClaims(c.access_token).exp
    if (typeof exp === "number") return exp * 1000 - 5 * 60 * 1000 < Date.now()
    return (c.last_refresh || 0) + 50 * 60 * 1000 < Date.now()
  },

  startLogin() {
    const { verifier, challenge } = pkcePair()
    const state = randomToken(24)
    return {
      authorize_url: authorizeUrl(`${CODEX.issuer}/oauth/authorize`, {
        response_type: "code", client_id: CODEX.clientId, redirect_uri: CODEX.redirectUri,
        scope: "openid profile email offline_access", code_challenge: challenge, code_challenge_method: "S256",
        id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs", state,
      }),
      instructions: "ChatGPT 계정으로 로그인하면 '연결할 수 없음' 페이지가 떠요. 정상이에요. 주소창의 주소를 통째로 복사한 뒤 돌아오세요.",
      input_hint: "localhost:1455 로 시작하는 주소 전체",
      pending: { verifier, state },
    }
  },

  async finishLogin(pending, input) {
    const { code, state } = parseCallbackInput(input)
    checkState(pending.state, state)
    const res = await devHttp("POST", `${CODEX.issuer}/oauth/token`, { form: {
      grant_type: "authorization_code", code, redirect_uri: CODEX.redirectUri, client_id: CODEX.clientId,
      code_verifier: pending.verifier,
    } })
    if (!res.ok) throw new ProviderError(`토큰 교환 실패: HTTP ${res.status} ${res.text.slice(0, 160)}`)
    const creds = codexCreds(res.json())
    const info = codexIdInfo(creds.id_token)
    return { creds, email: info.email, plan: info.plan }
  },

  describe: (c) => ({ oauth: !!c.refresh_token, reset_credits_supported: true }),

  async refresh(c) {
    if (!c.refresh_token) throw authError("리프레시 토큰이 없습니다. 다시 로그인하세요.")
    const res = await devHttp("POST", `${CODEX.issuer}/oauth/token`, { json: {
      client_id: CODEX.clientId, grant_type: "refresh_token", refresh_token: c.refresh_token, scope: "openid profile email",
    } })
    if (res.status === 400 || res.status === 401) throw authError(`토큰 갱신 거부(HTTP ${res.status}) ${res.text.slice(0, 120)}`)
    checkCommon(res, "Codex 토큰 갱신")
    return codexCreds(res.json(), c)
  },

  async fetch(creds, ctx) {
    if (this.needsRefresh(creds)) creds = await ctx.refresh(creds)
    const get = (path, extra = {}) => devHttp("GET", `${CODEX.apiBase}${path}`, { headers: {
      Authorization: `Bearer ${creds.access_token}`, "User-Agent": CODEX.userAgent, originator: "codex_cli_rs",
      ...(creds.account_id ? { "ChatGPT-Account-Id": creds.account_id } : {}), ...extra,
    } })
    let res = await get("/wham/usage")
    if (res.status === 401) {
      creds = await ctx.refresh(creds)
      res = await get("/wham/usage")
    }
    checkAuth(res, "Codex")
    checkCommon(res, "Codex 사용량")
    const data = res.json()
    const usage = {
      windows: codexWindows(data), reset_credits: null, extra: codexExtra(data), warnings: [],
      plan: typeof data.plan_type === "string" ? data.plan_type : null, email: codexIdInfo(creds.id_token).email,
    }
    try {
      const rc = await get("/wham/rate-limit-reset-credits", { "OpenAI-Beta": "codex-1" })
      checkCommon(rc, "Codex 초기화권")
      usage.reset_credits = codexResetCredits(rc.json(), Date.now())
    } catch (e) {
      usage.warnings.push(`초기화권 조회 실패: ${e.message}`)
    }
    return usage
  },
}

// ── Antigravity ──
const AG = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email"],
  apiBase: "https://cloudcode-pa.googleapis.com/v1internal",
  redirectUri: "http://127.0.0.1:8585/callback",
  userAgent: "antigravity/hub/2.9.1 darwin/arm64",
  metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
}

// Antigravity 앱의 Google OAuth 클라이언트(설정에서 입력)
function agClient() {
  try {
    const c = JSON.parse(Keychain.contains(KC_AG_CLIENT) ? Keychain.get(KC_AG_CLIENT) : "null")
    return c && c.id && c.secret ? c : null
  } catch (e) {
    return null
  }
}

function agRequireClient() {
  const c = agClient()
  if (!c) throw new ProviderError("설정 → Antigravity 로그인 설정에서 Client ID와 Secret을 먼저 넣어 주세요.")
  return c
}

function projectRef(v) {
  if (typeof v === "string" && v.trim()) return v.trim()
  if (v && typeof v === "object") return projectRef(v.id || v.projectId)
  return null
}

function pickTier(info) {
  const tiers = info.allowedTiers || []
  const t = tiers.find((x) => x.isDefault && x.id) || tiers.find((x) => x.id)
  return (t && t.id) || (info.paidTier || {}).id || (info.currentTier || {}).id || null
}

function resolvePlan(info, creds) {
  const plan = (info.planInfo || {}).planType
  if (plan) return plan
  const tier = (info.currentTier || {}).id
  const hosted = jwtClaims(creds.id_token).hd
  return { "standard-tier": "Paid", "free-tier": hosted ? "Workspace" : "Free", "legacy-tier": "Legacy" }[tier]
    || (info.currentTier || {}).name || null
}

const usedFromRemaining = (f) => (num(f) == null ? null : clampPct((1 - num(f)) * 100))
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "q"

function agWindowSeconds(window) {
  const w = String(window || "").toUpperCase()
  if (w.includes("HOUR")) {
    const m = w.match(/(\d+)/)
    return m ? Number(m[1]) * 3600 : 5 * 3600
  }
  if (w.includes("WEEK")) return 7 * 86400
  if (w.includes("DAY")) return 86400
  return null
}

function agQuotaSummary(data) {
  if (!data || typeof data !== "object") return []
  const payload = data.response || data.summary || data
  const out = []
  for (const group of payload.groups || []) {
    const gname = group.displayName || group.name || "Quota"
    for (const b of group.buckets || []) {
      const id = b.bucketId || b.id
      if (b.disabled || !id) continue
      let remaining = b.remainingFraction
      if (remaining == null && b.remaining && typeof b.remaining === "object")
        remaining = b.remaining.remainingFraction != null ? b.remaining.remainingFraction
          : b.remaining.case === "remainingFraction" ? b.remaining.value : null
      out.push(makeWindow(`${slug(gname)}:${id}`, b.displayName || b.name || id, usedFromRemaining(remaining),
        isoOf(msOf(b.resetTime)), { seconds: agWindowSeconds(b.window), group: gname }))
    }
  }
  return out
}

function agAvailableModels(data) {
  return Object.entries((data || {}).models || {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .filter(([, m]) => m && m.quotaInfo && m.quotaInfo.remainingFraction != null)
    .map(([id, m]) => makeWindow(`model:${id}`, m.displayName || m.label || id,
      usedFromRemaining(m.quotaInfo.remainingFraction), isoOf(msOf(m.quotaInfo.resetTime)), { group: "모델별" }))
}

function agQuotaBuckets(data) {
  const best = {}
  for (const b of (data || {}).buckets || []) {
    const id = String(b.modelId || "").trim()
    if (!id || b.remainingFraction == null) continue
    if (!best[id] || b.remainingFraction < best[id].remainingFraction) best[id] = b
  }
  return Object.keys(best).sort().map((id) =>
    makeWindow(`model:${id}`, id, usedFromRemaining(best[id].remainingFraction), isoOf(msOf(best[id].resetTime)), { group: "모델별" }))
}

// 작은 위젯에 보여줄 대표 창: 사용률이 가장 높은 것부터 2개
function agMarkPrimary(windows) {
  windows.filter((w) => w.used_percent != null).sort((a, b) => b.used_percent - a.used_percent)
    .slice(0, 2).forEach((w) => (w.primary = true))
  return windows
}

async function agPost(method, token, body) {
  const res = await devHttp("POST", `${AG.apiBase}:${method}`, { json: body,
    headers: { Authorization: `Bearer ${token}`, "User-Agent": AG.userAgent } })
  if (res.status === 401) throw authError("Antigravity 인증 실패(401)")
  if (res.status === 403) throw new ProviderError(`${method}: 권한 없음(403) ${res.text.slice(0, 160)}`)
  checkCommon(res, `Antigravity ${method}`)
  return res.json()
}

const antigravityProvider = {
  methods: ["oauth"],
  configured: () => (agClient() ? [true, null] : [false, "설정 → Antigravity 로그인 설정에서 Client ID와 Secret을 먼저 넣어 주세요."]),
  refreshToken: (c) => c.refresh_token,
  needsRefresh: (c) => (c.expires_at || 0) - 2 * 60 * 1000 < Date.now(),

  startLogin() {
    const state = randomToken(24)
    return {
      authorize_url: authorizeUrl(AG.authUrl, {
        client_id: agRequireClient().id, redirect_uri: AG.redirectUri, response_type: "code", scope: AG.scopes.join(" "),
        access_type: "offline", prompt: "select_account consent", state,
      }),
      instructions: "Antigravity에서 쓰는 Google 계정으로 로그인하면 열리지 않는 페이지로 이동해요. 정상이에요. 주소창의 주소를 통째로 복사한 뒤 돌아오세요.",
      input_hint: "127.0.0.1:8585 로 시작하는 주소 전체",
      pending: { state },
    }
  },

  async finishLogin(pending, input) {
    const client = agRequireClient()
    const { code, state } = parseCallbackInput(input)
    checkState(pending.state, state)
    const res = await devHttp("POST", AG.tokenUrl, { form: {
      code, client_id: client.id, client_secret: client.secret, redirect_uri: AG.redirectUri, grant_type: "authorization_code",
    } })
    if (!res.ok) throw new ProviderError(`토큰 교환 실패: HTTP ${res.status} ${res.text.slice(0, 160)}`)
    const data = res.json()
    if (!data.refresh_token) throw new ProviderError("refresh_token 을 받지 못했습니다. Google 계정 권한에서 앱 연결을 해제한 뒤 다시 시도하세요.")
    const creds = { access_token: data.access_token, refresh_token: data.refresh_token,
      expires_at: Date.now() + (num(data.expires_in) || 3600) * 1000, id_token: data.id_token || null }
    let email = jwtClaims(creds.id_token).email || null
    if (!email) {
      const info = await devHttp("GET", AG.userinfoUrl, { headers: { Authorization: `Bearer ${creds.access_token}` } })
      if (info.ok) email = info.json().email || null
    }
    return { creds, email }
  },

  describe: (c) => ({ oauth: !!c.refresh_token, project_id: !!c.project_id, reset_credits_supported: false }),

  async refresh(c) {
    const client = agRequireClient()
    const res = await devHttp("POST", AG.tokenUrl, { form: {
      client_id: client.id, client_secret: client.secret, refresh_token: c.refresh_token, grant_type: "refresh_token",
    } })
    if (res.status === 400 || res.status === 401) throw authError(`Google 토큰 갱신 거부(HTTP ${res.status}). 다시 로그인하세요.`)
    checkCommon(res, "Google 토큰 갱신")
    const d = res.json()
    return { ...c, access_token: d.access_token, expires_at: Date.now() + (num(d.expires_in) || 3600) * 1000,
      refresh_token: d.refresh_token || c.refresh_token, id_token: d.id_token || c.id_token }
  },

  // 프로젝트 ID 와 플랜. 프로젝트가 없으면 온보딩을 한 번 시도한다.
  async codeAssist(creds, ctx) {
    let info = await agPost("loadCodeAssist", creds.access_token, { metadata: AG.metadata })
    let project = creds.project_id || projectRef(info.cloudaicompanionProject)
    if (!project && pickTier(info)) {
      try {
        const ob = await agPost("onboardUser", creds.access_token, { tierId: pickTier(info), metadata: AG.metadata })
        project = projectRef((ob.response || {}).cloudaicompanionProject)
      } catch (e) {}
      if (!project) {
        info = await agPost("loadCodeAssist", creds.access_token, { metadata: AG.metadata })
        project = projectRef(info.cloudaicompanionProject)
      }
    }
    if (project && creds.project_id !== project) ctx.save({ ...creds, project_id: project })
    return { project, plan: resolvePlan(info, creds) }
  },

  async fetch(creds, ctx) {
    if (this.needsRefresh(creds)) creds = await ctx.refresh(creds)
    let ca
    try {
      ca = await this.codeAssist(creds, ctx)
    } catch (e) {
      if (e.kind !== "needs_login") throw e
      creds = await ctx.refresh(creds)
      ca = await this.codeAssist(creds, ctx)
    }
    const body = ca.project ? { project: ca.project } : {}
    const usage = { windows: [], reset_credits: null, extra: {}, warnings: [], plan: ca.plan,
      email: jwtClaims(creds.id_token).email || null }
    try {
      usage.windows = agQuotaSummary(await agPost("retrieveUserQuotaSummary", creds.access_token, body))
    } catch (e) {
      usage.warnings.push(`요약 조회 실패, 모델별 조회로 대체: ${e.message}`)
    }
    if (!usage.windows.length) {
      try {
        usage.windows = agAvailableModels(await agPost("fetchAvailableModels", creds.access_token, body))
      } catch (e) {
        usage.windows = agQuotaBuckets(await agPost("retrieveUserQuota", creds.access_token, body))
      }
    }
    agMarkPrimary(usage.windows)
    return usage
  },
}

const DEVICE_PROVIDERS = { claude: claudeProvider, codex: codexProvider, antigravity: antigravityProvider }

// ── 기기 저장소 ──
const devPath = (name) => fm.joinPath(fm.documentsDirectory(), name)

// Scriptable 문서 폴더의 JSON 파일(앱과 위젯이 같이 쓴다)
function readJSON(name, fallback) {
  try {
    const p = devPath(name)
    return fm.fileExists(p) ? JSON.parse(fm.readString(p)) : fallback
  } catch (e) {
    return fallback
  }
}

const writeJSON = (name, data) => fm.writeString(devPath(name), JSON.stringify(data))
const devAccounts = () => readJSON(DEV_ACCOUNTS_FILE, []).sort((a, b) => (a.order || 0) - (b.order || 0))
const devSaveAccounts = (list) => writeJSON(DEV_ACCOUNTS_FILE, list)
// 사용량은 계정마다 파일을 나눠, 여러 위젯이 동시에 써도 서로 덮어쓰지 않게 한다
const devSnapName = (id) => `aiusage-device-snap-${id}.json`
const devGetSnap = (id) => readJSON(devSnapName(id), null)
const devPutSnap = (id, snap) => writeJSON(devSnapName(id), snap)
const devCredKey = (id) => `aiusage.dev.creds.${id}`

function devGetCreds(id) {
  try {
    return Keychain.contains(devCredKey(id)) ? JSON.parse(Keychain.get(devCredKey(id))) : null
  } catch (e) {
    return null
  }
}

const devSaveCreds = (id, creds) => Keychain.set(devCredKey(id), JSON.stringify(creds))

function devFind(id) {
  const acc = devAccounts().find((a) => a.id === id)
  if (!acc) throw new ApiError("계정이 없습니다.", 404)
  return acc
}

function devUpdateAccount(id, fn) {
  const list = devAccounts()
  const acc = list.find((a) => a.id === id)
  if (!acc) throw new ApiError("계정이 없습니다.", 404)
  fn(acc)
  devSaveAccounts(list)
  return acc
}

// 토큰 갱신 잠금: 위젯 여러 개와 앱이 동시에 갱신하면 회전된 리프레시 토큰이 무효가 될 수 있다
const devLockName = (id) => `aiusage-device-lock-${id}`

function devTryLock(id) {
  const p = devPath(devLockName(id))
  try {
    if (fm.fileExists(p) && Date.now() - Number(fm.readString(p)) < DEV_LOCK_MS) return false
  } catch (e) {}
  fm.writeString(p, String(Date.now()))
  return true
}

function devUnlock(id) {
  try {
    fm.remove(devPath(devLockName(id)))
  } catch (e) {}
}

async function devRefreshCreds(acc, provider, creds) {
  // 다른 위젯/앱이 먼저 갱신했다면 저장된 새 토큰을 쓴다
  const latest = devGetCreds(acc.id) || creds
  if (provider.refreshToken(latest) !== provider.refreshToken(creds) && !provider.needsRefresh(latest)) return latest
  if (!devTryLock(acc.id)) throw new RefreshBusy()
  try {
    const next = await provider.refresh(latest)
    devSaveCreds(acc.id, next) // 회전된 리프레시 토큰을 즉시 저장
    return next
  } finally {
    devUnlock(acc.id)
  }
}

// 한 계정을 조회해 스냅샷을 갱신한다. minAgeMs 보다 최근에 조회했으면 그대로 둔다.
async function devRefreshAccount(acc, minAgeMs) {
  const prev = devGetSnap(acc.id) || {}
  if (Date.now() - (msOf(prev.fetched_at) || 0) < minAgeMs) return prev
  const provider = DEVICE_PROVIDERS[acc.provider]
  const snap = { ...prev, fetched_at: isoOf(Date.now()) }
  try {
    const creds = devGetCreds(acc.id)
    if (!creds) throw authError("저장된 로그인 정보가 없습니다. 다시 로그인하세요.")
    const ctx = {
      refresh: (c) => devRefreshCreds(acc, provider, c),
      save: (c) => devSaveCreds(acc.id, c),
      knownPlan: prev.plan || acc.plan || null,
    }
    const u = await provider.fetch(creds, ctx)
    Object.assign(snap, {
      status: u.warnings.length ? "partial" : "ok", error: null, warnings: u.warnings, stale: false,
      windows: u.windows, reset_credits: u.reset_credits, extra: u.extra,
      plan: u.plan || prev.plan || null, email: u.email || prev.email || null, last_success_at: snap.fetched_at,
    })
  } catch (e) {
    if (e instanceof RefreshBusy) return prev // 다른 곳에서 갱신 중 — 다음 차례에 다시
    Object.assign(snap, { status: e.kind || "error", error: e.message || String(e), stale: !!(prev.windows || []).length })
  }
  devPutSnap(acc.id, snap)
  return snap
}

function devCommon(acc, snap) {
  return {
    id: acc.id, provider: acc.provider, provider_name: providerName(acc.provider), label: acc.label,
    email: acc.email || snap.email || null, status: snap.status || "pending", error: snap.error || null,
    fetched_at: snap.fetched_at || null, last_success_at: snap.last_success_at || null,
  }
}

function devPublic(acc) {
  const snap = devGetSnap(acc.id) || {}
  const provider = DEVICE_PROVIDERS[acc.provider]
  return { ...devCommon(acc, snap), plan: snap.plan || acc.plan || null, enabled: acc.enabled !== false,
    order: acc.order || 0, created_at: acc.created_at, auth: provider ? provider.describe(devGetCreds(acc.id) || {}) : {} }
}

function devUsageEntry(acc) {
  const snap = devGetSnap(acc.id) || {}
  return { ...devCommon(acc, snap), plan: snap.plan || acc.plan || null, warnings: snap.warnings || [],
    stale: !!snap.stale, windows: snap.windows || [], reset_credits: snap.reset_credits || null, extra: snap.extra || {} }
}

function devUpsert(provider, accountId, label, result) {
  const list = devAccounts()
  const email = (result.email || "").toLowerCase()
  let acc = accountId ? list.find((a) => a.id === accountId)
    : email ? list.find((a) => a.provider === provider && (a.email || "").toLowerCase() === email) : null
  if (acc) {
    // Claude 는 sessionKey 를 유지한 채 OAuth 만 교체
    devSaveCreds(acc.id, { ...(devGetCreds(acc.id) || {}), ...result.creds })
    if (result.email) acc.email = result.email
    if (result.plan) acc.plan = result.plan
    if (label) acc.label = label
  } else {
    acc = {
      id: `${provider}_${randomBytes(4).map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      provider, label: label || (result.email ? result.email.split("@")[0] : providerName(provider)),
      email: result.email || null, plan: result.plan || null, enabled: true,
      order: Math.max(0, ...list.map((a) => a.order || 0)) + 1, created_at: isoOf(Date.now()),
    }
    list.push(acc)
    devSaveCreds(acc.id, result.creds)
  }
  devSaveAccounts(list)
  return acc
}

function devProvider(id) {
  const p = DEVICE_PROVIDERS[id]
  if (!p) throw new ApiError(`알 수 없는 서비스: ${id}`, 400)
  return p
}

// 서버의 /v1 API 를 기기 안에서 처리한다
async function deviceApi(method, path, body) {
  const route = `${method} ${path.split("?")[0]}`
  let m
  try {
    if (route === "GET /v1/usage") {
      const accounts = devAccounts().filter((a) => a.enabled !== false)
      const minAge = path.includes("refresh=1") ? DEV_MIN_REFRESH_MS : DEV_AUTO_REFRESH_MS
      await Promise.all(accounts.map((a) => devRefreshAccount(a, minAge)))
      const entries = accounts.map(devUsageEntry)
      // 가장 오래된 조회 시각을 '업데이트' 시각으로 보여준다
      const oldest = Math.min(...entries.map((e) => msOf(e.fetched_at) || Date.now()), Date.now())
      return { generated_at: isoOf(oldest), poll_interval: 0, accounts: entries }
    }
    if (route === "GET /v1/providers") {
      return { providers: Object.entries(DEVICE_PROVIDERS).map(([id, p]) => {
        const [configured, reason] = p.configured()
        return { id, name: providerName(id), methods: p.methods, configured, reason }
      }) }
    }
    if (route === "GET /v1/accounts") return { accounts: devAccounts().map(devPublic) }
    if (route === "POST /v1/accounts") {
      const result = await devProvider(body.provider).createManual(body)
      const acc = devUpsert(body.provider, null, body.label, result)
      await devRefreshAccount(acc, 0)
      return devPublic(acc)
    }
    if (route === "POST /v1/logins") {
      const p = devProvider(body.provider)
      if (body.account_id) devFind(body.account_id)
      const start = p.startLogin()
      const logins = readJSON(DEV_LOGINS_FILE, {})
      for (const [k, v] of Object.entries(logins)) if (Date.now() - v.created > DEV_LOGIN_TTL_MS) delete logins[k]
      const loginId = randomToken(16)
      logins[loginId] = { provider: body.provider, label: body.label || null, account_id: body.account_id || null,
        pending: start.pending, created: Date.now() }
      writeJSON(DEV_LOGINS_FILE, logins)
      return { login_id: loginId, provider: body.provider, authorize_url: start.authorize_url,
        instructions: start.instructions, input_hint: start.input_hint }
    }
    if ((m = route.match(/^POST \/v1\/logins\/([\w-]+)\/complete$/))) {
      const logins = readJSON(DEV_LOGINS_FILE, {})
      const entry = logins[m[1]]
      if (!entry || Date.now() - entry.created > DEV_LOGIN_TTL_MS)
        throw new ApiError("로그인 세션이 없거나 만료되었습니다. 처음부터 다시 시작하세요.", 400)
      const result = await devProvider(entry.provider).finishLogin(entry.pending, body.input)
      delete logins[m[1]]
      writeJSON(DEV_LOGINS_FILE, logins)
      const acc = devUpsert(entry.provider, entry.account_id, entry.label, result)
      await devRefreshAccount(acc, 0)
      return devPublic(devFind(acc.id))
    }
    if ((m = route.match(/^GET \/v1\/accounts\/([\w-]+)$/))) {
      const acc = devFind(m[1])
      return { account: devPublic(acc), usage: devUsageEntry(acc) }
    }
    if ((m = route.match(/^PATCH \/v1\/accounts\/([\w-]+)$/))) {
      const id = m[1]
      const sessionKey = body.session_key
      if (sessionKey != null) {
        if (devFind(id).provider !== "claude") throw new ApiError("session_key 는 Claude 계정에만 설정할 수 있습니다.", 400)
        const creds = devGetCreds(id) || {}
        if (sessionKey && !String(sessionKey).startsWith("sk-ant-")) throw new ApiError("sessionKey 는 'sk-ant-' 로 시작해야 합니다.", 400)
        if (!sessionKey && !creds.oauth) throw new ApiError("OAuth 로그인이 없는 계정에서는 sessionKey 를 지울 수 없습니다.", 400)
        const next = { ...creds }
        if (sessionKey) {
          next.session_key = sessionKey
        } else {
          delete next.session_key
        }
        devSaveCreds(id, next)
      }
      const acc = devUpdateAccount(id, (a) => {
        if (body.label && String(body.label).trim()) a.label = String(body.label).trim()
        if ("enabled" in body) a.enabled = !!body.enabled
      })
      if (sessionKey != null) await devRefreshAccount(acc, 0)
      return devPublic(acc)
    }
    if ((m = route.match(/^DELETE \/v1\/accounts\/([\w-]+)$/))) {
      const id = m[1]
      devFind(id)
      devSaveAccounts(devAccounts().filter((a) => a.id !== id))
      if (Keychain.contains(devCredKey(id))) Keychain.remove(devCredKey(id))
      for (const name of [devSnapName(id), devLockName(id)]) if (fm.fileExists(devPath(name))) fm.remove(devPath(name))
      return { deleted: id }
    }
    if ((m = route.match(/^POST \/v1\/accounts\/([\w-]+)\/refresh$/))) {
      const acc = devFind(m[1])
      await devRefreshAccount(acc, 0)
      return devUsageEntry(acc)
    }
  } catch (e) {
    if (e instanceof ProviderError) throw new ApiError(e.message, 400)
    throw e
  }
  throw new ApiError(`지원하지 않는 요청: ${route}`, 404)
}

async function api(method, path, body, timeout = 25) {
  const cfg = getConfig()
  if (!cfg) throw new ApiError("연결 방식을 먼저 정해 주세요.", 0)
  if (cfg.device) return deviceApi(method, path, body || {})
  return serverApi(cfg, method, path, body, timeout)
}

// 저장 전에 연결을 확인할 때도 쓰므로 설정을 인자로 받는다.
async function serverApi(cfg, method, path, body, timeout = 25) {
  const req = new Request(cfg.server.replace(/\/+$/, "") + path)
  req.method = method
  req.timeoutInterval = timeout
  req.headers = { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" }
  if (body !== undefined) {
    req.headers["Content-Type"] = "application/json"
    req.body = JSON.stringify(body)
  }
  let data
  try {
    data = await req.loadJSON()
  } catch (e) {
    throw new ApiError(`서버에 연결하지 못했어요: ${e.message || e}`, 0)
  }
  const status = req.response ? req.response.statusCode : 0
  if (status >= 400) throw new ApiError((data && data.error) || `HTTP ${status}`, status)
  return data
}

// ───────────────────────── 캐시 ─────────────────────────
const fm = FileManager.local()
const cachePath = fm.joinPath(fm.documentsDirectory(), CACHE_FILE)

function readCache() {
  try {
    return fm.fileExists(cachePath) ? JSON.parse(fm.readString(cachePath)) : null
  } catch (e) {
    return null
  }
}

function writeCache(data) {
  try {
    fm.writeString(cachePath, JSON.stringify(data))
  } catch (e) {}
}

async function loadUsage(refresh = false) {
  try {
    const data = await api("GET", `/v1/usage${refresh ? "?refresh=1" : ""}`, undefined, refresh ? 40 : 15)
    writeCache(data)
    return { data: cleanUsage(data), offline: false }
  } catch (e) {
    const cached = readCache()
    if (cached) return { data: cleanUsage(cached), offline: true, error: e.message }
    throw e
  }
}

// 서버·캐시가 예전 버전에서 저장한 값이어도 보여줄 창만 남긴다
function visibleWindows(entry) {
  const ws = entry.windows || []
  return entry.provider === "claude" ? ws.filter(claudeWindowShown) : ws
}

function cleanUsage(data) {
  for (const a of data.accounts || []) a.windows = visibleWindows(a)
  return data
}

// ───────────────────────── 포맷 ─────────────────────────
function pctColor(p) {
  if (p == null) return C.sub
  if (p >= 90) return C.bad
  if (p >= 70) return C.warn
  return C.ok
}

function fmtPct(p) {
  return p == null ? "–" : `${Math.round(p)}%`
}

// 남은 기간. 단위는 한글, 큰 단위 두 개까지 (예: 3일 10시간, 2시간 12분, 46분). 지났거나 없으면 null.
function fmtDuration(iso) {
  const ms = iso ? new Date(iso).getTime() - Date.now() : NaN
  if (!(ms > 0)) return null
  const m = Math.max(1, Math.floor(ms / 60000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return h ? `${d}일 ${h}시간` : `${d}일`
  if (h > 0) return mm ? `${h}시간 ${mm}분` : `${h}시간`
  return `${mm}분`
}

// "2시간 12분 후 초기화" · 이미 지났으면 "곧 초기화" · 정보가 없으면 ""
function resetText(iso) {
  if (!iso) return ""
  const left = fmtDuration(iso)
  return left ? `${left} 후 초기화` : "곧 초기화"
}

function fmtAgo(iso) {
  if (!iso) return "–"
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return "방금"
  if (m < 60) return `${m}분 전`
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`
  return `${Math.floor(m / 1440)}일 전`
}

function fmtDate(iso) {
  if (!iso) return ""
  const df = new DateFormatter()
  df.locale = "ko_KR"
  df.dateFormat = "M월 d일 (E) HH:mm"
  return df.string(new Date(iso))
}

function fmtDay(iso) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}월 ${d.getDate()}일`
}

// "Claude (me@example.com)"
function providerLine(acc) {
  const name = providerName(acc.provider)
  return acc.email ? `${name} (${acc.email})` : name
}

const PLAN_NAMES = {
  free: "Free", plus: "Plus", pro: "Pro", max: "Max", team: "Team", business: "Business",
  enterprise: "Enterprise", edu: "Edu", paid: "Paid", workspace: "Workspace", legacy: "Legacy",
  default_claude_max_5x: "Max 5x", default_claude_max_20x: "Max 20x", claude_max: "Max", claude_pro: "Pro",
}

function planLabel(plan, provider) {
  if (!plan) return null
  const key = String(plan).toLowerCase().trim()
  // ChatGPT 는 Team 요금제 이름이 Business 로 바뀌었다(Claude 는 그대로 Team)
  if (provider === "codex" && key === "team") return "Business"
  if (PLAN_NAMES[key]) return PLAN_NAMES[key]
  const m = key.match(/max[_ ]?(\d+)x/)
  if (m) return `Max ${m[1]}x`
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

const GROUP_SHORT = { "gemini models": "Gemini", "claude and gpt models": "Claude/GPT" }

function groupShort(group) {
  return GROUP_SHORT[group.toLowerCase()] || group.split(/\s+/)[0]
}

// compact: 위젯·카드처럼 좁은 칸. 그룹이 있으면 그룹 이름만 쓴다(예: Gemini).
function windowTitle(w, compact = false) {
  if (!w.group) return w.label
  return compact ? groupShort(w.group) : `${groupShort(w.group)} ${w.label}`
}

function primaryWindows(acc, n = 2) {
  const ws = acc.windows || []
  const prim = ws.filter((w) => w.primary)
  return (prim.length ? prim : ws).slice(0, n)
}

// 계정 이름 줄 오른쪽 배지. enabled: false 면 "숨김"(앱), offline 이면 "오프라인"(위젯).
// color 가 없으면 기본 글자색, muted 면 흐린 글자색(위젯/앱이 각자 맞는 색을 고른다).
function statusPills(acc, { enabled, offline } = {}) {
  const pills = []
  const rc = acc.reset_credits
  if (rc && rc.available > 0) pills.push({ text: `초기화권 ${rc.available}` })
  if (acc.status === "needs_login") pills.push({ text: "재로그인", color: C.bad })
  else if (acc.status === "partial") pills.push({ text: "일부 실패", color: C.warn })
  else if (acc.status && !["ok", "pending"].includes(acc.status)) pills.push({ text: STATUS_TEXT[acc.status] || "오류", color: C.bad })
  if (enabled === false) pills.push({ text: "숨김", muted: true })
  if (offline) pills.push({ text: "오프라인", color: C.warn })
  return pills
}

// 사용률 숫자 색: 70% 미만은 기본 글자색, 이상이면 경고색
function pctTextColor(pct, dim, base) {
  return dim || pct == null || pct < 70 ? base : pctColor(pct)
}

const STATUS_TEXT = {
  ok: "정상",
  partial: "일부 실패",
  needs_login: "재로그인 필요",
  error: "오류",
  blocked: "차단됨",
  rate_limited: "요청 한도 초과",
  pending: "대기 중",
}

// ───────────────────────── 공용 그리기 (DrawContext) ─────────────────────────
function newCtx(w, h) {
  const ctx = new DrawContext()
  ctx.size = new Size(w, h)
  ctx.opaque = false
  ctx.respectScreenScale = true
  return ctx
}

function fillRound(ctx, rect, r, color) {
  const p = new Path()
  p.addRoundedRect(rect, r, r)
  ctx.addPath(p)
  ctx.setFillColor(color)
  ctx.fillPath()
}

// 둥근 진행 막대. 0% 초과면 최소한 높이만큼은 채워 보이게 한다.
function drawBar(ctx, x, y, width, height, pct, color, track) {
  const r = height / 2
  fillRound(ctx, new Rect(x, y, width, height), r, track)
  if (pct != null && pct > 0) fillRound(ctx, new Rect(x, y, Math.max(height, (width * Math.min(100, pct)) / 100), height), r, color)
}

// ───────────────────────── 위젯 그리기 ─────────────────────────
// 위젯 크기(pt). iOS 는 기기별로 고정 크기를 쓰므로 화면 폭으로 고른다. 모르는 기기는 비율로 근사.
const WIDGET_SIZES = {
  440: { small: 170, medium: 364, large: 382 },
  430: { small: 170, medium: 364, large: 382 },
  428: { small: 170, medium: 364, large: 382 },
  414: { small: 169, medium: 360, large: 379 },
  402: { small: 162, medium: 345, large: 362 },
  393: { small: 158, medium: 338, large: 354 },
  390: { small: 158, medium: 338, large: 354 },
  375: { small: 155, medium: 329, large: 345 },
}

function widgetWidth(family) {
  const w = Math.round(Math.min(Device.screenSize().width, Device.screenSize().height))
  const s = WIDGET_SIZES[w] || { small: Math.round(w * 0.4), medium: Math.round(w * 0.86) }
  return family === "small" ? s.small : s.medium
}

const LAYOUT = {
  small: { pad: 14, padV: 14, accounts: 1, gap: 0 },
  medium: { pad: 16, padV: 11, accounts: 2, gap: 9 },
  large: { pad: 16, padV: 14, accounts: 4, gap: 10 },
}
const CELL_GAP = 14

const KC_CLAUDE_LOGO = "aiusage.claudeLogo"
let _claudeLogo = null
function claudeLogo() {
  if (_claudeLogo == null) _claudeLogo = Keychain.contains(KC_CLAUDE_LOGO) ? Keychain.get(KC_CLAUDE_LOGO) : "default"
  return _claudeLogo
}
function setClaudeLogo(v) {
  Keychain.set(KC_CLAUDE_LOGO, v)
  _claudeLogo = v
}

// 서비스 → 로고 키. Claude 는 설정에 따라 Clawd, Codex 는 다크 배경(앱)에서 흰 로고.
function logoKey(provider, darkBg = false) {
  if (provider === "claude" && claudeLogo() === "clawd") return "clawd"
  if (provider === "codex" && darkBg) return "codexWhite"
  return provider
}

let logoCache = {}
function logoImage(provider, darkBg = false) {
  const key = logoKey(provider, darkBg)
  if (!LOGOS[key]) return null
  if (!logoCache[key]) logoCache[key] = Image.fromData(Data.fromBase64String(LOGOS[key]))
  return logoCache[key]
}

function addLogo(stack, provider, size, tint) {
  const img = logoImage(provider)
  if (!img) return
  const el = stack.addImage(img)
  el.imageSize = new Size(size, size)
  // OpenAI 로고는 단색이라 글자색(라이트/다크 자동)으로 칠한다
  if (provider === "codex") el.tintColor = tint || C.text
}

function barImage(pct, width, height, color) {
  const ctx = newCtx(width, height)
  drawBar(ctx, 0, 0, width, height, pct, color, C.track)
  return ctx.getImage()
}

function addText(stack, text, font, color, opts = {}) {
  const t = stack.addText(text)
  t.font = font
  t.textColor = color
  t.lineLimit = 1
  if (opts.minScale) t.minimumScaleFactor = opts.minScale
  if (opts.opacity != null) t.textOpacity = opts.opacity
  return t
}

function addPill(stack, text, color) {
  const pill = stack.addStack()
  pill.backgroundColor = C.pill
  pill.cornerRadius = 8
  pill.setPadding(2, 6, 2, 6)
  addText(pill, text, Font.semiboldSystemFont(11), color || C.text)
  return pill
}

function accountHeader(stack, acc, opts) {
  const row = stack.addStack()
  row.layoutHorizontally()
  row.centerAlignContent()
  row.size = new Size(opts.width, 20)
  addLogo(row, acc.provider, opts.logo)
  row.addSpacer(6)
  addText(row, acc.label || providerName(acc.provider), Font.semiboldSystemFont(15), C.text, {
    opacity: opts.dim ? 0.55 : 1,
  })
  if (opts.showProvider) {
    row.addSpacer(6)
    addText(row, providerName(acc.provider), Font.systemFont(12), C.sub)
  }
  row.addSpacer()
  statusPills(acc, { offline: opts.offline }).forEach((pill, i) => {
    if (i > 0) row.addSpacer(4)
    addPill(row, pill.text, pill.muted ? C.sub : pill.color)
  })
  return row
}

function windowCell(parent, w, width, dim) {
  const cell = parent.addStack()
  cell.layoutVertically()
  cell.size = new Size(width, 0)

  const top = cell.addStack()
  top.layoutHorizontally()
  top.bottomAlignContent()
  top.size = new Size(width, 0)
  // minimumScaleFactor 를 쓰면 줄마다 글자 크기가 달라지므로 쓰지 않는다
  addText(top, windowTitle(w, true), Font.systemFont(12), C.sub)
  top.addSpacer()
  addText(top, fmtPct(w.used_percent), Font.semiboldSystemFont(13), pctTextColor(w.used_percent, dim, C.text), { opacity: dim ? 0.55 : 1 })

  cell.addSpacer(3)
  const bar = cell.addImage(barImage(w.used_percent, width, 6, dim ? C.sub : pctColor(w.used_percent)))
  bar.imageSize = new Size(width, 6)
  // 남은 시간은 막대 아래 작은 글씨로 (정보가 없어도 줄 높이는 유지)
  cell.addSpacer(2)
  addText(cell, resetText(w.resets_at) || " ", Font.systemFont(10), C.sub, { opacity: 0.85 })
  return cell
}

function accountBlock(parent, acc, family, inner, offline) {
  const dim = acc.stale || acc.status === "needs_login"
  const block = parent.addStack()
  block.layoutVertically()
  accountHeader(block, acc, {
    width: inner,
    logo: family === "small" ? 16 : 18,
    showProvider: family !== "small",
    dim,
    offline,
  })
  const ws = primaryWindows(acc)
  if (!ws.length) {
    block.addSpacer(7)
    addText(block, acc.error || STATUS_TEXT[acc.status] || "데이터 없음", Font.systemFont(11), C.sub)
    return block
  }
  if (family === "small") {
    // 소형: 폭이 좁아 두 한도를 위아래로
    ws.forEach((w, i) => {
      block.addSpacer(i === 0 ? 5 : 8)
      windowCell(block, w, inner, dim)
    })
    return block
  }
  block.addSpacer(3)
  const row = block.addStack()
  row.layoutHorizontally()
  const cellW = Math.floor((inner - CELL_GAP) / 2)
  ws.forEach((w, i) => {
    if (i > 0) row.addSpacer(CELL_GAP)
    windowCell(row, w, cellW, dim)
  })
  return block
}

function filterAccounts(accounts, param) {
  if (!param) return accounts
  const wanted = param.split(",").map((s) => s.trim()).filter(Boolean)
  if (!wanted.length) return accounts
  return wanted
    .map((w) => accounts.find((a) => a.id === w || a.label === w))
    .filter(Boolean)
}

function emptyWidget(message) {
  const w = new ListWidget()
  w.backgroundColor = C.bg
  w.setPadding(16, 16, 16, 16)
  addText(w, "AI 사용량", Font.semiboldSystemFont(14), C.text)
  w.addSpacer(6)
  const t = addText(w, message, Font.systemFont(11), C.sub)
  t.lineLimit = 4
  return w
}

function buildHomeWidget(result, size, param) {
  const { data, offline } = result
  const accounts = filterAccounts(data.accounts || [], param)
  if (!accounts.length) return emptyWidget("표시할 계정이 없어요. Scriptable 앱에서 계정을 추가해 주세요.")

  const family = size === "extraLarge" ? "large" : LAYOUT[size] ? size : "medium"
  const L = LAYOUT[family]
  const inner = widgetWidth(family) - L.pad * 2

  const w = new ListWidget()
  w.backgroundColor = C.bg
  w.setPadding(L.padV, L.pad, L.padV, L.pad)

  if (family === "large") {
    const head = w.addStack()
    head.layoutHorizontally()
    head.centerAlignContent()
    head.size = new Size(inner, 0)
    addText(head, "AI 사용량", Font.semiboldSystemFont(13), C.text)
    head.addSpacer()
    addText(head, offline ? "오프라인 · " + fmtAgo(data.generated_at) : `${fmtAgo(data.generated_at)} 확인`,
      Font.systemFont(10), offline ? C.warn : C.sub)
    w.addSpacer(8)
  } else if (family === "medium") {
    w.addSpacer()
  }

  const shown = accounts.slice(0, L.accounts)
  shown.forEach((acc, i) => {
    if (i > 0) w.addSpacer(L.gap)
    // 중형은 머리줄이 없으므로 오프라인 표시를 첫 계정에 붙인다
    accountBlock(w, acc, family, inner, family === "medium" && offline && i === 0)
  })

  w.addSpacer()
  if (family === "small" && offline) {
    // 소형은 공간이 빠듯해 오프라인일 때만 알린다
    addText(w, `오프라인 · ${fmtAgo(data.generated_at)}`, Font.systemFont(10), C.warn)
  } else if (family === "large" && accounts.length > shown.length) {
    addText(w, `+${accounts.length - shown.length}개 더 · 위젯 Parameter 로 고를 수 있어요`, Font.systemFont(10), C.sub)
  }
  return w
}

function buildAccessoryWidget(result, family, param) {
  const accounts = filterAccounts(result.data.accounts || [], param)
  const w = new ListWidget()
  if (!accounts.length) {
    addText(w, "AI 사용량 –", Font.systemFont(12), Color.white())
    return w
  }
  const parts = (acc) => primaryWindows(acc).map((x) => fmtPct(x.used_percent)).join(" · ")
  const short = (acc) => providerName(acc.provider)
  if (family === "accessoryInline") {
    addText(w, accounts.slice(0, 2).map((a) => `${(PROVIDER_STYLE[a.provider] || {}).abbr || short(a)} ${parts(a)}`).join("  "), Font.systemFont(12), Color.white())
    return w
  }
  if (family === "accessoryCircular") {
    const acc = accounts[0]
    const pw = primaryWindows(acc, 1)[0]
    w.addAccessoryWidgetBackground = true
    const s = w.addStack()
    s.layoutVertically()
    s.centerAlignContent()
    const top = s.addStack()
    top.addSpacer()
    addLogo(top, acc.provider, 14, Color.white())
    top.addSpacer()
    const bottom = s.addStack()
    bottom.addSpacer()
    addText(bottom, pw ? fmtPct(pw.used_percent) : "–", Font.boldSystemFont(14), Color.white())
    bottom.addSpacer()
    return w
  }
  // accessoryRectangular
  accounts.slice(0, 3).forEach((acc, i) => {
    if (i > 0) w.addSpacer(2)
    const row = w.addStack()
    row.layoutHorizontally()
    row.centerAlignContent()
    addLogo(row, acc.provider, 11, Color.white())
    row.addSpacer(5)
    addText(row, acc.label || short(acc), Font.systemFont(12), Color.white(), { minScale: 0.7 })
    row.addSpacer()
    // 잠금 화면은 폭이 좁아 초기화권은 생략
    addText(row, parts(acc), Font.mediumSystemFont(12), Color.white(), { minScale: 0.7 })
  })
  return w
}

async function runWidget() {
  const family = config.widgetFamily || "medium"
  const param = (args.widgetParameter || "").trim()
  let widget
  if (!getConfig()) {
    widget = emptyWidget("Scriptable 앱에서 이 스크립트를 한 번 실행해 연결 방식을 골라 주세요.")
  } else {
    try {
      const result = await loadUsage(false)
      if (!result.offline) await checkAlerts(result.data.accounts)
      widget = family.startsWith("accessory")
        ? buildAccessoryWidget(result, family, param)
        : buildHomeWidget(result, family, param)
    } catch (e) {
      widget = emptyWidget(`불러오지 못했어요. ${e.message}`)
    }
  }
  widget.refreshAfterDate = new Date(Date.now() + WIDGET_REFRESH_MIN * 60 * 1000)
  Script.setWidget(widget)
}

// ───────────────────────── 알림 ─────────────────────────
// 위젯·앱이 사용량을 받을 때마다 확인해, 필요한 알림을 한 번씩만 보낸다.
// 보낸 기록(sent)과 한도별 직전 값(seen)은 파일에 둔다. seen 으로 예정보다 이른 초기화를 알아챈다.
const KC_NOTIFY = "aiusage.notify"
const NOTIFY_STATE_FILE = "aiusage-notify-state.json"
const NOTIFY_KEEP_MS = 14 * DAY_MS

const NOTIFY_TYPES = [
  { key: "high", title: "사용량 경고", desc: "대표 한도가 기준을 넘었을 때" },
  { key: "reset", title: "초기화 알림", desc: "기준을 넘긴 한도가 예정 시각에 초기화될 때" },
  { key: "early", title: "조기 초기화 감지", desc: "예정보다 일찍 한도가 초기화됐을 때" },
  { key: "login", title: "재로그인 필요", desc: "로그인이 만료돼 사용량을 못 가져올 때" },
  { key: "credit", title: "초기화권 만료 임박", desc: "초기화권이 하루 안에 만료될 때" },
]

function notifySettings() {
  const base = { enabled: true, threshold: 90, types: Object.fromEntries(NOTIFY_TYPES.map((t) => [t.key, true])) }
  try {
    const saved = JSON.parse(Keychain.contains(KC_NOTIFY) ? Keychain.get(KC_NOTIFY) : "{}")
    return { ...base, ...saved, types: { ...base.types, ...(saved.types || {}) } }
  } catch (e) {
    return base
  }
}

function saveNotifySettings(settings) {
  Keychain.set(KC_NOTIFY, JSON.stringify(settings))
}

// at 이 있으면 그 시각에 예약. 같은 id 로 다시 예약하면 이전 예약을 대신한다.
async function sendNotification({ id, title, body, at }) {
  const n = new Notification()
  n.identifier = id
  n.threadIdentifier = "aiusage"
  n.title = title
  n.body = body
  n.openURL = URLScheme.forRunningScript() // 누르면 이 스크립트가 열린다
  if (at) n.setTriggerDate(at)
  await n.schedule()
}

// 예정 초기화 시각 전에 사용률이 10%p 넘게 떨어졌으면 조기 초기화로 본다
function isEarlyReset(prev, w, now) {
  const due = msOf(prev.resets_at)
  if (!due || now >= due - 60 * 1000) return false // 예정 시각이 지났으면 정상 초기화
  if (prev.used == null || w.used_percent == null) return false
  return prev.used >= 10 && w.used_percent <= prev.used - 10
}

async function checkAlerts(accounts) {
  const settings = notifySettings()
  const on = (type) => settings.enabled && settings.types[type]
  const now = Date.now()
  const state = readJSON(NOTIFY_STATE_FILE, {})
  // 예전 형식({키: 시각})도 보낸 기록으로 이어받는다
  const sent = state.sent || (state.seen ? {} : state)
  const seen = state.seen || {}
  const once = (key) => !sent[key] && (sent[key] = now)
  const jobs = []
  const cancel = []
  for (const acc of accounts) {
    const who = `${providerName(acc.provider)} · ${acc.label}`
    if (acc.status === "needs_login") {
      if (on("login") && once(`login:${acc.id}:${acc.last_success_at}`))
        jobs.push({ id: `aiusage-login-${acc.id}`, title: who, body: "다시 로그인해야 사용량을 가져올 수 있어요. 눌러서 열어 주세요." })
      continue
    }
    if (acc.stale) continue // 이전 값이면 비교하지 않는다
    for (const w of acc.windows || []) {
      const key = `${acc.id}:${w.key}`
      const prev = seen[key]
      if (prev && isEarlyReset(prev, w, now)) {
        cancel.push(`aiusage-reset-${acc.id}-${w.key}`) // 예약해 둔 초기화 알림은 필요 없어졌다
        if (on("early") && once(`early:${key}:${prev.resets_at}`))
          jobs.push({ id: `aiusage-early-${acc.id}-${w.key}`, title: who,
            body: `${windowTitle(w)} 한도가 예정보다 일찍 초기화됐어요. (${Math.round(prev.used)}% → ${Math.round(w.used_percent)}%)` })
      }
      seen[key] = { used: w.used_percent, resets_at: w.resets_at, at: now }
    }
    for (const w of primaryWindows(acc)) {
      if (w.used_percent == null || w.used_percent < settings.threshold) continue
      const name = windowTitle(w)
      const period = `${acc.id}:${w.key}:${w.resets_at}`
      if (on("high") && once(`high:${period}`))
        jobs.push({ id: `aiusage-high-${acc.id}-${w.key}`, title: who,
          body: `${name} 사용량이 ${Math.round(w.used_percent)}%예요.${w.resets_at ? ` ${resetText(w.resets_at)}돼요.` : ""}` })
      const at = msOf(w.resets_at)
      if (on("reset") && at && at > now && once(`reset:${period}`))
        jobs.push({ id: `aiusage-reset-${acc.id}-${w.key}`, title: who, body: `${name} 한도가 초기화됐어요. 다시 쓸 수 있어요.`, at: new Date(at) })
    }
    for (const item of (acc.reset_credits && acc.reset_credits.items) || []) {
      const exp = msOf(item.expires_at)
      if (on("credit") && exp && exp > now && exp - now < DAY_MS && once(`credit:${acc.id}:${item.expires_at}`))
        jobs.push({ id: `aiusage-credit-${acc.id}-${exp}`, title: who,
          body: `초기화권 1장이 ${fmtDuration(item.expires_at)} 뒤에 만료돼요. 필요하면 그 전에 쓰세요.` })
    }
  }
  for (const [key, t] of Object.entries(sent)) if (now - t > NOTIFY_KEEP_MS) delete sent[key]
  for (const [key, v] of Object.entries(seen)) if (now - v.at > NOTIFY_KEEP_MS) delete seen[key]
  writeJSON(NOTIFY_STATE_FILE, { sent, seen })
  try {
    if (cancel.length) await Notification.removePending(cancel)
  } catch (e) {}
  for (const job of jobs) {
    try {
      await sendNotification(job)
    } catch (e) {} // 알림 권한이 없으면 조용히 넘어간다
  }
}

// ───────────────────────── 앱 UI: 공용 ─────────────────────────
async function confirm(title, message, okText = "확인", destructive = false) {
  const a = new Alert()
  a.title = title
  a.message = message || ""
  destructive ? a.addDestructiveAction(okText) : a.addAction(okText)
  a.addCancelAction("취소")
  return (await a.presentAlert()) === 0
}

async function prompt(title, message, { placeholder = "", value = "", secure = false, ok = "확인" } = {}) {
  const a = new Alert()
  a.title = title
  a.message = message || ""
  secure ? a.addSecureTextField(placeholder, value) : a.addTextField(placeholder, value)
  a.addAction(ok)
  a.addCancelAction("취소")
  if ((await a.presentAlert()) !== 0) return null
  return a.textFieldValue(0).trim()
}

// ───────────────────────── 앱 UI: 페이지 ─────────────────────────
// 설정·입력도 팝업 대신 메인처럼 '페이지'(표)로 보여준다. 글자를 직접 쳐야 할 때만 작은 입력창을 띄운다.
// build(page) 가 행을 채운다. 행을 누르면 page.run(fn) 이 작업하고 페이지를 다시 그린다(오류는 맨 위에 표시).
const ACCENT = new Color("#0A84FF")

async function openPage(title, build) {
  const table = new UITable()
  table.showSeparators = true
  const page = {
    closed: false,
    notice: null, // 맨 위에 보여줄 결과·오류 { title, detail, color }
    add: (row) => table.addRow(row),
    async render() {
      if (this.closed) return
      table.removeAllRows()
      if (title) table.addRow(titleRow(title))
      if (this.notice) table.addRow(noticeRow(this.notice))
      try {
        await build(this)
      } catch (e) {
        table.addRow(noticeRow({ title: "불러오지 못했어요", detail: e.message || String(e), color: C.bad }))
      }
      table.reload()
    },
    run(fn) {
      return async () => {
        this.notice = null
        try {
          await fn()
        } catch (e) {
          this.notice = { title: "문제가 생겼어요", detail: e.message || String(e), color: C.bad }
        }
        await this.render()
      }
    },
  }
  await page.render()
  await table.present(false)
  page.closed = true
  return page
}

function titleRow(text) {
  const r = new UITableRow()
  r.isHeader = true
  r.height = 56
  r.addText(text).titleFont = Font.boldSystemFont(24)
  return r
}

function noticeRow({ title, detail, color }) {
  const { row, cell } = textRow(title, detail || null, detail ? 64 : 48)
  cell.titleColor = color || Color.gray()
  cell.subtitleColor = Color.gray()
  return row
}

// 회색 안내 문구. 줄 수에 맞춰 높이를 잡는다.
function noteRow(text) {
  const r = new UITableRow()
  const perLine = Math.max(10, cardWidth() - 10)
  const lines = String(text).split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(estWidth(l, 13) / perLine)), 0)
  r.height = Math.max(44, lines * 18 + 18)
  const c = r.addText(text)
  c.titleFont = Font.systemFont(13)
  c.titleColor = Color.gray()
  return r
}

// 왼쪽 제목(+설명), 오른쪽 값. iOS 설정 앱의 한 줄처럼 쓴다.
function valueRow(title, value, onSelect, { subtitle, color, valueWidth = 42 } = {}) {
  const r = new UITableRow()
  r.dismissOnSelect = false
  r.height = subtitle ? 62 : 48
  const t = r.addText(title, subtitle || null)
  t.widthWeight = 100 - valueWidth
  if (subtitle) {
    t.subtitleColor = Color.gray()
    t.subtitleFont = Font.systemFont(12)
  }
  const v = r.addText(value == null ? "" : String(value))
  v.widthWeight = valueWidth
  v.rightAligned()
  v.titleColor = color || Color.gray()
  if (onSelect) r.onSelect = onSelect
  return r
}

const toggleRow = (title, on, onSelect, subtitle) =>
  valueRow(title, on ? "켜짐" : "꺼짐", onSelect, { subtitle, color: on ? C.ok : Color.gray(), valueWidth: 20 })
const checkRow = (title, checked, onSelect, subtitle) =>
  valueRow(title, checked ? "✓" : "", onSelect, { subtitle, color: ACCENT, valueWidth: 12 })
const linkRow = (title, onSelect, subtitle) => valueRow(title, "›", onSelect, { subtitle, valueWidth: 12 })

function providerRow(provider, title, subtitle, onSelect) {
  const r = new UITableRow()
  r.dismissOnSelect = false
  r.height = 62
  const img = logoImage(provider, pal().dark)
  if (img) r.addImage(img).widthWeight = 12
  const t = r.addText(title, subtitle)
  t.widthWeight = 80
  t.subtitleColor = Color.gray()
  const v = r.addText("›")
  v.widthWeight = 8
  v.rightAligned()
  v.titleColor = Color.gray()
  r.onSelect = onSelect
  return r
}

// ───────────────────────── 앱 UI: 연결 설정 ─────────────────────────
async function serverPage() {
  // 저장 전 값은 페이지 안에만 두고, 연결이 확인되면 저장한다
  const draft = {
    server: Keychain.contains(KC_SERVER) ? Keychain.get(KC_SERVER) : "",
    apiKey: Keychain.contains(KC_KEY) ? Keychain.get(KC_KEY) : "",
  }
  let connected = false
  await openPage("서버 연결", async (page) => {
    page.add(noteRow("직접 띄운 사용량 서버에 연결해요. 서버를 설치하는 방법은 저장소의 README에 있어요."))
    page.add(headerRow("서버"))
    page.add(valueRow("주소", draft.server || "입력", page.run(async () => {
      const v = await prompt("서버 주소", "예) https://ai.example.com", { value: draft.server, placeholder: "https://" })
      if (v != null) draft.server = v.replace(/\/+$/, "")
    }), { valueWidth: 60 }))
    page.add(valueRow("API 키", draft.apiKey ? "입력됨" : "입력", page.run(async () => {
      const v = await prompt("API 키", "서버에 설정한 AIUSAGE_API_KEY 값이에요.", { secure: true, value: draft.apiKey })
      if (v != null) draft.apiKey = v
    })))
    page.add(actionRow("연결 확인하고 저장", page.run(async () => {
      if (!draft.server || !draft.apiKey) throw new Error("주소와 API 키를 모두 넣어 주세요.")
      await serverApi(draft, "GET", "/v1/accounts")
      Keychain.set(KC_SERVER, draft.server)
      Keychain.set(KC_KEY, draft.apiKey)
      setMode("server")
      connected = true
      page.notice = { title: "연결됐어요", detail: "이 화면을 닫으면 서버의 계정 목록을 보여 드려요.", color: C.ok }
    }), ACCENT))
  })
  return connected
}

const AG_CLIENT_HELP =
  "PC에 설치한 Antigravity 앱의 resources/app/out/main.js 파일에서 두 값을 찾아 넣어 주세요.\n• Client ID: ….apps.googleusercontent.com 으로 끝나는 값\n• Client Secret: GOCSPX- 로 시작하는 값"

async function antigravityPage() {
  await openPage("Antigravity 로그인 설정", async (page) => {
    let cur = {}
    try {
      cur = JSON.parse(Keychain.contains(KC_AG_CLIENT) ? Keychain.get(KC_AG_CLIENT) : "{}") || {}
    } catch (e) {}
    const save = (patch) => Keychain.set(KC_AG_CLIENT, JSON.stringify({ ...cur, ...patch }))
    page.add(noteRow(AG_CLIENT_HELP))
    page.add(headerRow("Google OAuth 클라이언트"))
    page.add(valueRow("Client ID", cur.id ? `${cur.id.slice(0, 12)}…` : "입력", page.run(async () => {
      const v = await prompt("Client ID", "….apps.googleusercontent.com 으로 끝나는 값이에요.", { value: cur.id || "" })
      if (v != null) save({ id: v })
    })))
    page.add(valueRow("Client Secret", cur.secret ? "입력됨" : "입력", page.run(async () => {
      const v = await prompt("Client Secret", "GOCSPX- 로 시작하는 값이에요.", { secure: true, value: cur.secret || "" })
      if (v != null) save({ secret: v })
    })))
    if (agClient()) page.add(noticeRow({ title: "준비됐어요", detail: "이제 Antigravity 계정을 추가할 수 있어요.", color: C.ok }))
  })
  return !!agClient()
}

// ───────────────────────── 앱 UI: 계정 추가·로그인 ─────────────────────────
const PROVIDER_DESC = { claude: "사용량 · 초기화권 · 플랜", codex: "사용량 · 초기화권 · 플랜", antigravity: "모델 그룹별 사용량" }

const LOGIN_GUIDE = {
  claude: "로그인하고 승인하면 코드가 나와요. 'Copy Code'로 복사한 뒤 돌아와서 '붙여넣기'를 누르세요.",
  codex: "ChatGPT로 로그인하면 '연결할 수 없음' 페이지가 떠요. 정상이에요. 주소창의 주소를 통째로 복사한 뒤 돌아와서 '붙여넣기'를 누르세요.",
  antigravity: "Antigravity에서 쓰는 Google 계정으로 로그인하면 열리지 않는 페이지로 이동해요. 정상이에요. 주소창의 주소를 통째로 복사한 뒤 돌아와서 '붙여넣기'를 누르세요.",
}

const SESSION_KEY_HELP =
  "초기화권은 claude.ai 웹에서만 확인할 수 있어서 sessionKey가 필요해요. PC 브라우저로 claude.ai에 로그인한 뒤 개발자 도구 → Application → Cookies → https://claude.ai 에서 'sessionKey' 값(sk-ant-…)을 복사해 주세요."

async function addAccountPage() {
  let added = false
  await openPage("계정 추가", async (page) => {
    const { providers } = await api("GET", "/v1/providers")
    page.add(headerRow("어떤 서비스를 추가할까요?"))
    for (const p of providers) {
      page.add(providerRow(p.id, p.name, p.configured ? PROVIDER_DESC[p.id] || "" : "설정이 필요해요", page.run(async () => {
        if (!p.configured) {
          if (!(getConfig().device && p.id === "antigravity")) throw new Error(p.reason)
          if (!(await antigravityPage())) return
        }
        if (await loginPage(p.id)) {
          added = true
          page.notice = { title: "계정을 추가했어요", detail: "이 화면을 닫으면 목록에 보여요.", color: C.ok }
        }
      })))
    }
  })
  return added
}

// 새 계정 추가 또는 기존 계정 다시 로그인(accountId). 끝나면 결과를 페이지 맨 위에 보여준다.
async function loginPage(provider, { accountId = null } = {}) {
  const st = { label: "", method: "oauth", login: null, done: null }

  const finish = (page, acc) => {
    st.done = acc
    const status = acc.status === "ok" ? "" : ` · 상태: ${STATUS_TEXT[acc.status] || acc.status}`
    page.notice = { title: accountId ? "다시 로그인했어요" : "계정을 추가했어요",
      detail: `${acc.label}${acc.email ? ` (${acc.email})` : ""}${status} · 닫으면 목록으로 돌아가요.`, color: C.ok }
  }

  const submitCode = async (page, raw) => {
    if (raw == null) return
    if (!st.login) throw new Error("먼저 '1. 로그인 페이지 열기'로 로그인해 주세요.")
    const input = String(raw).trim()
    if (!input) throw new Error("클립보드가 비어 있어요. 로그인 페이지에서 다시 복사해 주세요.")
    try {
      finish(page, await api("POST", `/v1/logins/${st.login.login_id}/complete`, { input }, 60))
    } catch (e) {
      if (/만료/.test(e.message)) st.login = null // 로그인 세션이 끝났으면 처음부터
      throw e
    }
  }

  const submitKey = async (page, raw) => {
    if (raw == null) return
    const key = String(raw).trim()
    if (!key) throw new Error("클립보드가 비어 있어요. sessionKey를 다시 복사해 주세요.")
    finish(page, await api("POST", "/v1/accounts", { provider, session_key: key, label: st.label || undefined }, 60))
  }

  await openPage(accountId ? `${providerName(provider)} 다시 로그인` : `${providerName(provider)} 계정 추가`, async (page) => {
    if (st.done) return
    if (!accountId) {
      page.add(headerRow("이름"))
      page.add(valueRow("위젯에 보일 이름", st.label || "이메일 앞부분", page.run(async () => {
        const v = await prompt("이름", "비워 두면 이메일 앞부분을 써요.", { value: st.label, placeholder: "예) 개인" })
        if (v != null) st.label = v
      }), { valueWidth: 50 }))
    }
    if (provider === "claude" && !accountId) {
      page.add(headerRow("추가 방식"))
      page.add(checkRow("OAuth 로그인 (추천)", st.method === "oauth", page.run(() => (st.method = "oauth")),
        "사용량과 플랜을 안정적으로 가져와요. 초기화권은 나중에 sessionKey로 더할 수 있어요."))
      page.add(checkRow("sessionKey", st.method === "session_key", page.run(() => (st.method = "session_key")),
        "사용량과 초기화권까지 가져와요. claude.ai 쿠키 값이 필요해요."))
    }
    if (st.method === "session_key") {
      page.add(headerRow("sessionKey"))
      page.add(noteRow(SESSION_KEY_HELP))
      page.add(actionRow("복사한 sessionKey 붙여넣기", page.run(() => submitKey(page, Pasteboard.paste())), ACCENT))
      page.add(actionRow("직접 입력", page.run(async () => submitKey(page, await prompt("sessionKey", "sk-ant- 로 시작하는 값이에요.", { secure: true })))))
      return
    }
    page.add(headerRow("로그인"))
    page.add(noteRow(LOGIN_GUIDE[provider]))
    page.add(actionRow("1. 로그인 페이지 열기", page.run(async () => {
      if (!st.login) st.login = await api("POST", "/v1/logins", { provider, label: st.label || undefined, account_id: accountId || undefined })
      Safari.open(st.login.authorize_url)
    }), ACCENT))
    page.add(actionRow("2. 복사한 값 붙여넣기", page.run(() => submitCode(page, Pasteboard.paste())), ACCENT))
    page.add(actionRow("직접 입력", page.run(async () => submitCode(page, await prompt("직접 입력", st.login ? st.login.input_hint : "")))))
  })
  return !!st.done
}

// 기존 Claude 계정에 sessionKey 를 넣거나 바꾸거나 지운다.
// OAuth 가 없는 계정은 sessionKey 가 유일한 인증이라 지울 수 없다(canDelete).
async function sessionKeyPage(accountId, { hasKey = false, canDelete = false } = {}) {
  let done = false
  await openPage("sessionKey", async (page) => {
    if (done) return
    page.add(noteRow(SESSION_KEY_HELP))
    const submit = async (raw) => {
      if (raw == null) return
      const key = String(raw).trim()
      if (!key) throw new Error("클립보드가 비어 있어요. sessionKey를 다시 복사해 주세요.")
      await api("PATCH", `/v1/accounts/${accountId}`, { session_key: key }, 60)
      done = true
      page.notice = { title: "저장했어요", detail: "초기화권을 확인했어요. 닫으면 계정 화면으로 돌아가요.", color: C.ok }
    }
    page.add(headerRow(hasKey ? "새 값으로 바꾸기" : "추가하기"))
    page.add(actionRow("복사한 sessionKey 붙여넣기", page.run(() => submit(Pasteboard.paste())), ACCENT))
    page.add(actionRow("직접 입력", page.run(async () => submit(await prompt("sessionKey", "sk-ant- 로 시작하는 값이에요.", { secure: true })))))
    if (hasKey && canDelete) {
      page.add(actionRow("sessionKey 삭제", page.run(async () => {
        if (!(await confirm("sessionKey 삭제", "초기화권이 더 이상 표시되지 않아요.", "삭제", true))) return
        await api("PATCH", `/v1/accounts/${accountId}`, { session_key: "" })
        done = true
        page.notice = { title: "삭제했어요", detail: "닫으면 계정 화면으로 돌아가요.", color: C.ok }
      }), C.bad))
    }
  })
  return done
}

// ───────────────────────── 앱 UI: 카드 그리기 ─────────────────────────
// UITable 에는 진행 막대가 없어서 카드 전체를 이미지로 그려 행에 넣는다.
function appPalette() {
  const dark = Device.isUsingDarkAppearance()
  return dark
    ? { dark, text: new Color("#F2F2F7"), sub: new Color("#98989F"), track: new Color("#8E8E93", 0.3), pill: new Color("#787880", 0.32) }
    : { dark, text: new Color("#1C1C1E"), sub: new Color("#6E6E73"), track: new Color("#8E8E93", 0.2), pill: new Color("#787880", 0.14) }
}

function cardWidth() {
  return Math.round(Math.min(Device.screenSize().width, 600)) - 40
}

// DrawContext 는 글자 폭을 재지 못하므로 대략 추정한다(한글·이모지는 1em, 영숫자는 0.6em).
function estWidth(text, size) {
  let w = 0
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    if (ch === " ") w += size * 0.3
    else if (c > 0x2000) w += size * 1.0
    else if (/[A-Z%]/.test(ch)) w += size * 0.68
    else w += size * 0.58
  }
  return Math.ceil(w)
}

// ── 글자 폭 측정 (앱 전용) ──
// DrawContext 는 글자 폭을 잴 수 없으므로, 보이지 않는 WebView 에서 같은 시스템 글꼴로 잰다.
// 실패하면 estWidth 로 대신한다.
const _textW = {}
let _measureView = null
const twKey = (text, size, weight) => `${weight}|${size}|${text}`

async function measureTexts(items) {
  const todo = items.filter((i) => i.text && !(twKey(i.text, i.size, i.weight) in _textW))
  if (!todo.length) return
  try {
    if (!_measureView) {
      _measureView = new WebView()
      await _measureView.loadHTML("<html><body></body></html>")
    }
    const js = `(() => { const c = document.createElement("canvas").getContext("2d");
      return JSON.stringify(${JSON.stringify(todo)}.map((i) => {
        c.font = i.weight + " " + i.size + "px -apple-system, system-ui"; return c.measureText(i.text).width })) })()`
    const widths = JSON.parse(await _measureView.evaluateJavaScript(js))
    todo.forEach((i, k) => {
      if (typeof widths[k] === "number" && widths[k] > 0) _textW[twKey(i.text, i.size, i.weight)] = widths[k]
    })
  } catch (e) {}
}

function textW(text, size, weight = 400) {
  const v = _textW[twKey(text, size, weight)]
  return v != null ? Math.ceil(v) : estWidth(text, size)
}

// 카드·상세에 쓰는 글자들을 미리 잰다. style 은 한도 줄 모양(LINE_STYLE 의 키).
function measureItemsFor(acc, usage, nameSize, nameWeight, style) {
  const items = [{ text: acc.label, size: nameSize, weight: nameWeight }]
  const plan = planLabel((usage && usage.plan) || acc.plan, acc.provider)
  if (plan) items.push({ text: plan, size: 10, weight: 700 })
  for (const pill of statusPills(usage || acc, { enabled: acc.enabled })) items.push({ text: pill.text, size: 11, weight: 600 })
  const s = LINE_STYLE[style]
  for (const w of (usage || acc).windows || []) {
    items.push({ text: windowTitle(w), size: s.title[0], weight: s.title[1] }, { text: fmtPct(w.used_percent), size: s.pct, weight: 600 })
    for (const t of timeCandidates(w.resets_at)) items.push({ text: t, size: s.time, weight: 400 })
  }
  return items
}

function drawTextAt(ctx, text, x, y, w, h, font, color, align = "left") {
  ctx.setFont(font)
  ctx.setTextColor(color)
  if (align === "right") ctx.setTextAlignedRight()
  else if (align === "center") ctx.setTextAlignedCenter()
  else ctx.setTextAlignedLeft()
  ctx.drawTextInRect(String(text), new Rect(x, y, w, h))
}

function drawLogo(ctx, provider, x, y, size, pal) {
  const img = logoImage(provider, pal.dark)
  if (img) ctx.drawImageInRect(img, new Rect(x, y, size, size))
}

// pills(왼쪽→오른쪽 순서)를 right 에 붙여 그리고, 남은 오른쪽 경계를 돌려준다.
function drawPills(ctx, pills, right, y, pal) {
  let x = right
  for (const p of [...pills].reverse()) {
    const w = textW(p.text, 11, 600) + 14
    x -= w
    fillRound(ctx, new Rect(x, y, w, 20), 10, pal.pill)
    drawTextAt(ctx, p.text, x, y + 3, w, 16, Font.semiboldSystemFont(11), p.muted ? pal.sub : p.color || pal.text, "center")
    x -= 6
  }
  return x
}

// 이름 바로 옆 플랜 배지(브랜드 색). name: { text, x, y, size, weight } — 이름을 그린 위치.
// 이름 폭은 measureTexts 로 잰 값을 쓰고, 세로는 이름 줄(글자 크기 × 1.19)의 가운데에 맞춘다.
function drawPlanBadge(ctx, provider, plan, name, maxRight) {
  const label = planLabel(plan, provider)
  if (!label) return
  const h = 17
  const w = textW(label, 10, 700) + 12
  const x = name.x + textW(name.text, name.size, name.weight) + 7
  if (x + w > maxRight) return
  const top = name.y + (name.size * 1.19 - h) / 2 + 1
  const brand = (PROVIDER_STYLE[provider] || {}).color || "#8E8E93"
  fillRound(ctx, new Rect(x, top, w, h), 5, new Color(brand, pal().dark ? 0.28 : 0.15))
  drawTextAt(ctx, label, x, top + 2.5, w, h - 2, Font.boldSystemFont(10), new Color(brand), "center")
}

let _pal = null
function pal() {
  return _pal || (_pal = appPalette())
}

// 앱의 한도 한 줄: 왼쪽 이름, 오른쪽 '남은 시간  퍼센트', 아래 막대.
// 글자 크기가 달라도 밑줄(baseline)이 맞도록 y 를 잡았다.
const LINE_STYLE = {
  card: { title: [13, 400], titleY: 2, pct: 15, time: 12, timeY: 3, barY: 23, barH: 7 },
  detail: { title: [15, 500], titleY: 4, pct: 18, time: 13, timeY: 7, barY: 30, barH: 8 },
}

// 남은 시간 표기 후보(긴 것부터). 이름과 겹치면 짧은 것으로 바꾼다.
function timeCandidates(iso) {
  if (!iso) return []
  const left = fmtDuration(iso)
  return left ? [`${left} 후 초기화`, `${left} 후`] : ["곧 초기화"]
}

function drawWindowLine(ctx, w, y, width, dim, p, style) {
  const s = LINE_STYLE[style]
  const pct = w.used_percent
  const pctText = fmtPct(pct)
  const title = windowTitle(w)
  const titleFont = s.title[1] >= 500 ? Font.mediumSystemFont(s.title[0]) : Font.systemFont(s.title[0])
  const pctFont = Font.semiboldSystemFont(s.pct)
  drawTextAt(ctx, pctText, width - 80, y, 80, s.pct + 6, pctFont, pctTextColor(pct, dim, p.text), "right")
  const timeRight = width - textW(pctText, s.pct, 600) - 8
  const room = timeRight - textW(title, s.title[0], s.title[1]) - 14
  const time = timeCandidates(w.resets_at).find((t) => textW(t, s.time, 400) <= room)
  const titleRight = time ? timeRight - textW(time, s.time, 400) - 10 : timeRight
  drawTextAt(ctx, title, 0, y + s.titleY, titleRight, s.title[0] + 6, titleFont, style === "card" ? p.sub : p.text)
  if (time) drawTextAt(ctx, time, 0, y + s.timeY, timeRight, s.time + 5, Font.systemFont(s.time), new Color(p.sub.hex, 0.85), "right")
  drawBar(ctx, 0, y + s.barY, width, s.barH, pct, dim || pct == null ? p.sub : pctColor(pct), p.track)
}

// 메인 화면의 계정 카드. 앱은 공간이 넓어 한도마다 한 줄씩(가로 전체) 모두 보여준다.
const CARD_HEAD_H = 44
const CARD_ROW_H = 42

function accountCard(acc, enabled) {
  const p = pal()
  const W = cardWidth()
  const ws = acc.windows || []
  // 마지막 줄은 막대 아래 여백 없이 끝낸다
  const H = CARD_HEAD_H + (ws.length ? (ws.length - 1) * CARD_ROW_H + LINE_STYLE.card.barY + LINE_STYLE.card.barH + 2 : 36)
  const ctx = newCtx(W, H)
  const dim = acc.stale || acc.status === "needs_login"
  drawLogo(ctx, acc.provider, 0, 6, 24, p)
  const right = drawPills(ctx, statusPills(acc, { enabled }), W, 10, p)
  drawTextAt(ctx, acc.label, 34, 2, right - 40, 22, Font.semiboldSystemFont(17), dim ? p.sub : p.text)
  drawPlanBadge(ctx, acc.provider, acc.plan, { text: acc.label, x: 34, y: 2, size: 17, weight: 600 }, right - 6)
  drawTextAt(ctx, providerLine(acc), 34, 23, right - 40, 16, Font.systemFont(12), p.sub)
  if (!ws.length) drawTextAt(ctx, acc.error || STATUS_TEXT[acc.status] || "데이터 없음", 0, CARD_HEAD_H + 2, W, 32, Font.systemFont(13), p.sub)
  ws.forEach((w, i) => drawWindowLine(ctx, w, CARD_HEAD_H + i * CARD_ROW_H, W, dim, p, "card"))
  return { image: ctx.getImage(), height: H }
}

// 상세 화면의 한도 한 줄. 막대 아래에는 초기화 날짜·시각을 적는다.
function windowRowImage(w, dim) {
  const p = pal()
  const W = cardWidth()
  const ctx = newCtx(W, 58)
  drawWindowLine(ctx, w, 0, W, dim, p, "detail")
  drawTextAt(ctx, w.resets_at ? `${fmtDate(w.resets_at)} 초기화` : "초기화 시각 정보 없음", 0, 42, W, 16, Font.systemFont(11), p.sub)
  return ctx.getImage()
}

// 상세 화면 맨 위 요약
function detailHeaderImage(acc, usage) {
  const p = pal()
  const W = cardWidth()
  const ctx = newCtx(W, 64)
  drawLogo(ctx, acc.provider, 0, 8, 40, p)
  const right = drawPills(ctx, statusPills(usage, { enabled: acc.enabled }), W, 18, p)
  drawTextAt(ctx, acc.label, 52, 6, right - 56, 28, Font.boldSystemFont(22), p.text)
  drawPlanBadge(ctx, acc.provider, usage.plan || acc.plan, { text: acc.label, x: 52, y: 6, size: 22, weight: 700 }, right - 6)
  drawTextAt(ctx, providerLine(acc), 52, 36, right - 56, 18, Font.systemFont(13), p.sub)
  return ctx.getImage()
}

// 상세 화면의 초기화권 한 장
function resetCreditImage(item, index, provider) {
  const p = pal()
  const W = cardWidth()
  const H = 58
  const ctx = newCtx(W, H)
  const brand = new Color((PROVIDER_STYLE[provider] || {}).color || "#8E8E93")
  // 왼쪽 번호 칩
  fillRound(ctx, new Rect(0, 11, 36, 36), 10, new Color(brand.hex, p.dark ? 0.28 : 0.14))
  drawTextAt(ctx, String(index + 1), 0, 19, 36, 20, Font.boldSystemFont(16), brand, "center")
  // 남은 기간 배지
  // 하루 이상 남으면 일 단위로만 (예: 4일 남음)
  const ms = item.expires_at ? new Date(item.expires_at).getTime() - Date.now() : null
  const left = fmtDuration(item.expires_at)
  const leftText = ms == null ? "만료 없음" : ms >= DAY_MS ? `${Math.floor(ms / DAY_MS)}일 남음` : left ? `${left} 남음` : "곧 만료"
  const soon = ms != null && ms < 3 * DAY_MS
  const right = drawPills(ctx, [soon ? { text: leftText, color: C.warn } : { text: leftText, muted: true }], W, 19, p)
  // 제목과 날짜
  const title = item.title || "사용량 초기화권"
  drawTextAt(ctx, title, 48, 10, right - 52, 20, Font.semiboldSystemFont(15), p.text)
  const dates = [item.expires_at ? `${fmtDay(item.expires_at)} 만료` : null, item.granted_at ? `${fmtDay(item.granted_at)} 지급` : null]
    .filter(Boolean)
    .join("  ·  ")
  drawTextAt(ctx, dates || item.description || "", 48, 32, right - 52, 16, Font.systemFont(12), p.sub)
  return ctx.getImage()
}

function headerRow(text) {
  const r = new UITableRow()
  r.isHeader = true
  r.addText(text)
  return r
}

function textRow(title, subtitle, height = 54) {
  const r = new UITableRow()
  r.height = height
  const c = r.addText(title, subtitle)
  return { row: r, cell: c }
}

// 눌러도 표가 닫히지 않는 메뉴 행
function actionRow(title, onSelect, color) {
  const r = new UITableRow()
  r.dismissOnSelect = false
  const c = r.addText(title)
  if (color) c.titleColor = color
  r.onSelect = onSelect
  return r
}

function imageRow(img, height) {
  const r = new UITableRow()
  r.height = height
  const c = r.addImage(img)
  c.centerAligned()
  return r
}

// ───────────────────────── 앱 UI: 계정 상세 ─────────────────────────
async function accountDetail(accountId) {
  let deleted = false
  // 맨 위 머리 이미지가 제목 역할을 한다
  await openPage(null, async (page) => {
    if (deleted) return
    const { account: acc, usage } = await api("GET", `/v1/accounts/${accountId}`)
    usage.windows = visibleWindows({ ...usage, provider: acc.provider })
    const patch = (body, timeout) => api("PATCH", `/v1/accounts/${accountId}`, body, timeout)

    await measureTexts(measureItemsFor(acc, usage, 22, 700, "detail"))
    page.add(imageRow(detailHeaderImage(acc, usage), 80))

    const detail = usage.error || (usage.warnings || []).join(" / ") || null
    const st = textRow(
      `${STATUS_TEXT[usage.status] || usage.status}${usage.stale ? " · 이전에 받은 값" : ""}  ·  ${fmtAgo(usage.fetched_at)} 확인`,
      detail,
      detail ? 64 : 44
    )
    st.cell.titleFont = Font.systemFont(14)
    st.cell.titleColor = usage.status === "ok" ? Color.gray() : usage.status === "partial" ? C.warn : C.bad
    st.cell.subtitleColor = Color.gray()
    page.add(st.row)

    if ((usage.windows || []).length) {
      page.add(headerRow("사용량"))
      const dim = usage.stale || usage.status === "needs_login"
      for (const w of usage.windows) page.add(imageRow(windowRowImage(w, dim), 72))
    }

    // Antigravity 는 초기화권이 없으므로 섹션을 아예 표시하지 않는다
    if (acc.provider !== "antigravity") {
      const rc = usage.reset_credits
      const items = (rc && rc.items) || []
      page.add(headerRow(items.length ? `초기화권 ${items.length}개` : "초기화권"))
      if (items.length) {
        items.forEach((item, i) => page.add(imageRow(resetCreditImage(item, i, acc.provider), 70)))
      } else if (rc) {
        page.add(textRow("지금 쓸 수 있는 초기화권이 없어요", "").row)
      } else if (acc.provider === "claude" && !acc.auth.session_key) {
        page.add(textRow("sessionKey가 있어야 확인할 수 있어요", "아래 'sessionKey'에서 추가할 수 있어요.").row)
      } else {
        page.add(textRow("확인하지 못했어요", usage.error || "").row)
      }
    }

    const { extra_usage: eu, credits: cr } = usage.extra || {}
    if (eu) page.add(textRow("추가 사용량", `${eu.used ?? "–"} / ${eu.limit ?? "–"} ${eu.currency || ""} (${fmtPct(eu.used_percent)})`, 50).row)
    else if (cr) page.add(textRow("크레딧", cr.unlimited ? "무제한" : `잔액 ${cr.balance ?? "–"}`, 50).row)

    page.add(headerRow("관리"))
    page.add(actionRow("지금 새로고침", page.run(() => api("POST", `/v1/accounts/${accountId}/refresh`, undefined, 60)), ACCENT))
    page.add(valueRow("이름", acc.label, page.run(async () => {
      const name = await prompt("이름", "위젯에 보일 이름이에요.", { value: acc.label })
      if (name) await patch({ label: name })
    }), { valueWidth: 55 }))
    page.add(toggleRow("위젯에 표시", acc.enabled, page.run(() => patch({ enabled: !acc.enabled }))))
    if (acc.provider === "claude") {
      page.add(valueRow("sessionKey", acc.auth.session_key ? "있음" : "없음", page.run(() =>
        sessionKeyPage(accountId, { hasKey: !!acc.auth.session_key, canDelete: !!acc.auth.oauth })
      ), { subtitle: "초기화권을 확인할 때 써요" }))
    }
    if (acc.provider !== "claude" || acc.auth.oauth || usage.status === "needs_login") {
      page.add(linkRow("다시 로그인", page.run(() => loginPage(acc.provider, { accountId }))))
    }
    page.add(actionRow("계정 삭제", page.run(async () => {
      const where = getConfig().device ? "이 iPhone" : "서버"
      if (!(await confirm("계정 삭제", `${acc.label} 계정과 로그인 정보를 ${where}에서 지울까요?`, "삭제", true))) return
      await api("DELETE", `/v1/accounts/${accountId}`)
      deleted = true
      page.notice = { title: "삭제했어요", detail: "이 화면을 닫으면 목록으로 돌아가요.", color: C.ok }
    }), C.bad))
  })
}

// ───────────────────────── 앱 UI: 설정 ─────────────────────────
async function settingsPage() {
  await openPage("설정", async (page) => {
    const mode = getMode()
    page.add(headerRow("연결 방식"))
    page.add(checkRow("이 iPhone에서 직접", mode === "device", page.run(() => {
      if (mode === "device") return
      setMode("device")
      page.notice = { title: "이 iPhone에서 직접 가져와요", detail: "계정 목록은 방식마다 따로예요. 필요하면 계정을 다시 추가해 주세요.", color: C.ok }
    }), "서버 없이 이 스크립트가 로그인하고 조회해요."))
    const server = mode === "server" && Keychain.contains(KC_SERVER) ? Keychain.get(KC_SERVER).replace(/^https?:\/\//, "") : null
    page.add(checkRow("내 서버", mode === "server", page.run(async () => {
      if (await serverPage()) page.notice = { title: "서버에 연결했어요", detail: "닫으면 서버의 계정 목록을 보여 드려요.", color: C.ok }
    }), server || "직접 띄운 서버가 모은 사용량을 받아와요."))
    if (mode === "device") {
      page.add(valueRow("Antigravity 로그인 설정", agClient() ? "입력됨" : "없음", page.run(antigravityPage), { valueWidth: 25 }))
    }

    const n = notifySettings()
    page.add(headerRow("위젯·알림"))
    page.add(valueRow("알림", n.enabled ? `켜짐 · ${n.threshold}%` : "꺼짐", page.run(notifyPage)))
    page.add(linkRow("위젯 미리보기", page.run(widgetPreviewPage)))

    page.add(headerRow("Claude 로고"))
    for (const [value, title] of [["default", "기본"], ["clawd", "Clawd"]]) {
      page.add(checkRow(title, claudeLogo() === value, page.run(() => {
        setClaudeLogo(value)
        logoCache = {}
      })))
    }
    page.add(noteRow(`버전 ${VERSION}`))
  })
}

async function notifyPage() {
  await openPage("알림", async (page) => {
    const cur = notifySettings()
    const save = (patch) => saveNotifySettings({ ...cur, ...patch })
    page.add(toggleRow("알림 받기", cur.enabled, page.run(() => save({ enabled: !cur.enabled }))))
    if (!cur.enabled) return

    page.add(headerRow("받을 알림"))
    for (const t of NOTIFY_TYPES) {
      const on = cur.types[t.key]
      page.add(toggleRow(t.title, on, page.run(() => save({ types: { ...cur.types, [t.key]: !on } })), t.desc))
    }

    page.add(headerRow("경고 기준"))
    for (const v of [80, 90, 95]) page.add(checkRow(`${v}% 이상`, cur.threshold === v, page.run(() => save({ threshold: v }))))
    page.add(noteRow("사용량 경고와 초기화 알림은 위젯 대표 한도(현재 세션·이번 주 등)가 이 기준을 넘었을 때만 와요."))

    page.add(headerRow("테스트"))
    page.add(actionRow("테스트 알림 보내기", page.run(async () => {
      await sendNotification({ id: "aiusage-test", title: "AI 사용량", body: "알림이 이렇게 와요." })
      page.notice = { title: "보냈어요", detail: "알림이 오지 않으면 iPhone 설정 → 앱 → Scriptable → 알림을 확인해 주세요.", color: C.ok }
    }), ACCENT))
    page.add(noteRow("위젯이 새로 고쳐질 때(약 15분마다)와 앱을 열 때 확인해요. 그래서 조기 초기화는 몇 분 늦게 알 수 있어요."))
  })
}

async function widgetPreviewPage() {
  await openPage("위젯 미리보기", async (page) => {
    page.add(noteRow("홈 화면에 올렸을 때의 모습이에요. 위젯은 약 15분마다 새로 고쳐져요."))
    for (const [size, title] of [["small", "소형"], ["medium", "중형"], ["large", "대형"]]) {
      page.add(linkRow(title, page.run(async () => {
        const w = buildHomeWidget(await loadUsage(false), size, "")
        await { small: () => w.presentSmall(), medium: () => w.presentMedium(), large: () => w.presentLarge() }[size]()
      })))
    }
    page.add(noteRow("위젯을 길게 눌러 '위젯 편집' → Parameter에 계정 이름을 쉼표로 적으면 그 계정만 보여요. 예) 개인,회사"))
  })
}

// ───────────────────────── 앱 UI: 메인 ─────────────────────────
async function mainMenu() {
  let refresh = false
  await openPage("AI 사용량", async (page) => {
    if (!getConfig()) {
      page.add(noteRow("Claude · Codex · Antigravity 사용량을 한곳에서 보여 줘요. 먼저 사용량을 어디서 가져올지 골라 주세요. 나중에 설정에서 바꿀 수 있어요."))
      page.add(headerRow("시작하기"))
      page.add(linkRow("이 iPhone에서 직접", page.run(() => setMode("device")), "서버 없이 바로 시작해요. 로그인 정보는 키체인에 저장돼요."))
      page.add(linkRow("내 서버에 연결", page.run(serverPage), "직접 띄운 서버의 주소와 API 키가 필요해요."))
      return
    }

    const doRefresh = refresh
    refresh = false
    let accounts = []
    const usage = {}
    try {
      const [acc, u] = await Promise.all([api("GET", "/v1/accounts"), loadUsage(doRefresh)])
      accounts = acc.accounts
      for (const a of u.data.accounts) usage[a.id] = a
      if (u.offline) page.add(noticeRow({ title: "마지막으로 받은 값이에요", detail: u.error, color: C.warn }))
      else await checkAlerts(u.data.accounts)
    } catch (e) {
      page.add(noticeRow({ title: getConfig().device ? "불러오지 못했어요" : "서버에 연결하지 못했어요", detail: e.message, color: C.bad }))
    }

    page.add(headerRow(`계정 (${accounts.length})`))
    if (!accounts.length) page.add(textRow("아직 계정이 없어요", "아래 '계정 추가'로 시작해 보세요.").row)
    await measureTexts(accounts.flatMap((acc) => measureItemsFor(acc, usage[acc.id], 17, 600, "card")))
    for (const acc of accounts) {
      const u = usage[acc.id] || { ...acc, windows: [] }
      const card = accountCard({ ...acc, ...u, label: acc.label }, acc.enabled)
      const r = imageRow(card.image, card.height + 20)
      r.dismissOnSelect = false
      r.onSelect = page.run(() => accountDetail(acc.id))
      page.add(r)
    }

    page.add(headerRow("작업"))
    page.add(linkRow("계정 추가", page.run(addAccountPage)))
    page.add(actionRow("전체 새로고침", page.run(() => (refresh = true)), ACCENT))
    page.add(linkRow("설정", page.run(settingsPage)))
  })
}

// ───────────────────────── 로고 (LobeHub Icons, MIT) ─────────────────────────
const LOGOS = {
  claude: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAANEUlEQVR4nNRbCXRU1Rn+752ZQELArVWrYg/CJIMilKVapAoeq0crVAEnQ7UeqSJarEdFsqCHNipKJkCxR62t1oookmQArdtxOa0bKB4VUI+QDVBwieLCOkOSeffvd2dMmOW9N29mEqXfOZn33t3vf//733+5cVOeaCoPzGDBQSGEm4naBPFG5gMzfLVP7aX/A7gpD7TOCQwzJD0oSMS+8TsAvyWC+hbj80LKAU0VgVlo6Ga8PlgarK+hXoagHLGtenrf9nB4I1a+1CyfjegI36JV71MWaKooW0pCXJGQVAMizKVehKQc0RHeP9xq8vGW3TdSFth6y2+PSZm8RtWWuYES6kXkTADlim6xyxeCft8y1/9jcoiOqDHdtB+jM0y9iJwJMHTBE1+D0TfZlVFK/pEcAtz0s7RE5nZv7epPqBeRMwE0BNOLdvlMfJ2WFeQIfJxJ4mbqZeR1CniYg+0krga79zPLx+lwVMf+yO/w+s9MbTHTMSJVJAvRSA6gidwRidzJzKO/67eptLb+Gid18+KAQQtDbeitnOx7uJmcQIijTVKbM9SibTdefHh7OPI2XmdjG43XfxjTzKYK/+XkAHkRQMMXrL8fq/eOXZGmysAFlAFY/CPS0hTbcsBn1ZOKOvr0eR6cMyw1j0nc11gx7TjKgLwJEIf4g20280122VYDBQHes6u3N1LYgMfppnWF6C9YBSgDeoQAvtq6d0DyhywLCHFuU1Xg51bZLtl5TFoic2RI/1MsOSCmNJGw1TaZjf9QBlgKwcaKsjVgSy9YaTv0+09cqvOaIYue+NKyJUNWsdsIQAAVm+YrvhO/55lXdqfpC7Ar1ovqakXmY6s0UZqS6zN97EQTNeWAxsqylWChcVowYX+NwfNiw+VZj708wqqh0sUrvhIsrNVWzQXl0840yzKYzQTgu2Zlm8sDEzG2jDaCYP4rOYApAbCKU01SjwdV1zZX+i8lC+DouRdn/wdW+SxUkMwHcWz6GDhNsGq1mCUtp0xgeqZ0YcMScgALGcCtZqn6vGeSy8EJD1spOBj4LLIAVm6s2YkAdj8xNU0KtT7x+8tqf3GnwU9RzOK0A39a0NHu6AiM9WPehniV7DG9PRJ5b3Ol/9TUjNJgaA1mVG9T9870JJFEAHBR2Btc9WFi2rdhucLW+OpuSkwedPeTu8ghTAkgI+7ZnEEJgYAskSTfb64ouzY1zy1UhU3VkU1V/smJCdhaA5PaZkoSXuCaP6HDiZQBGPOs0pr6tykLmBLAe8/yPcSRMXovUaZOhbgfUjnUWPGb/l1pg4Oh7ZjVYptK8xM/RcoWYEHd539Tedmv8biNMo2D6HGtlFGWsNQDtEsLQm0Sjq/ZlAFgzUsEFW5oLvd3W3RuwXdAN//GosbJTeX+g0qKoB8lD0ps0M8tlf4TkedE6L3fr0PNoByQURHS0hQseTI6sbfMBA0GN6zr2hLggt1IvMO6ZzkPqybMtEAQ4AOunuCOklgJ6h5u1y2IvFdJcdHAJaEI5YCsXGKY3BJMMrOnB0KQKXK15iLsX+04Ocm0mFIX4Fj7VMuSxPTDjILi3bL9Nkw+oyElWfm9taGVlCOy9gk2lpeNA8s/olfcviS3smFMFW45mFiuNi9CD0gpVijmlw8m8T5w3KpMml68MP+ttLbhOsoDWdsCvoUNawuKCofZCrkYxBDhcr+HyQ+yKgF3+vlM6qikWlqVdjJ5og35Tj7eXx5omeMfq6R8NDM3WAN7+GVw1NmUJVxCeYfUhFopT+RFAI2YNyYcxjktetV9nQhsk3m+YMN8p+VbKqeewuwuxfFaAor7IMc8YL8l2orNmwBdiJm7TMvw6qPexVbECkw5rnXO5KOjwj0KHDUSCzKc9OklaLhNWzU9RoAuNFYEakUmN1kekMTne4MNL7RUTDnBEJ7RsPowWRqDI3UU5MdPKDvU9TgBNForp50RZX4chPgp9TSYn8TO/WWq8pQLYLiNjxFAsy+Uj34K8Sx4IHZ7Ol27ou7wrnwCnDtu8heGCwTMX3E9HUpg3oWZvwiOeRpy5DGBYGQdEgLW5Vl7fneCUjshOHaSfuIbBsweaCF7cI7uVsTfuqPyy6Li8Nbjqp9OiuTATjgbnADrUDiOEvU0MIc3IRdekoZ63rso9GZinibAdkxoIPUc9oA42o22HVJ3B5SaNqRdAKF0Gn0PQN/r0fc6zGmjVOJd78L69Xbl4RNUlzDLNVglD/UMBsTd1GJYbH/1ipSJA2z8EZpfh+c6F9Nb7UVq/bDqUEc2bcSG1zx32ulKqZlocSgkqY7y9IOWVvTd+wA6FAAvsZ4oWPktoWit4e54Mx6fzA+O1ycWgSnoW+Thzn5R6S7Cfioy3FQoDVkEwVkoJP7wxHtf/cSA+yb0cplWjSkPxIIvgrXRtA3bagdL3uEil0ovp5SI8lfRgugXTgjUiwwah3ZkRhX/VztV6YcA8ydw7bdholoWQaDzNhn23Btz+lAvEkDfDVCGnK/jdHSogekrbKcbfbX1y3ucAPFIbVj7FOdaBklygYwOFVH3ELA+LEiaJFIcqbkAobPzepQAOiILQyNopZJi4G/gZ4RVON0OMIA+9yhj/OCFq1r0d3PVlJNIecZDWI9lFhPQppeyBNrc3iMEaCn3j1dC3E1mtzziHUE5Erfg7WsQ51HKGbwTStc5Q4OhtODLtnL/se1SnIUJ/Qqf47TfMWNrzGvzIkBcwFEtXi+y6eUlOEhnKCF9iumF5Cz6OHt7geFr5Imx+IMNNs+dfJSLPRPQx3hwCLxYNKq7BSyE9kxDBtydEwFiAk6JebZ6flznrigNNjzYUh4YZUh+HatflFDiQwxuAQb2GOUAHIVTS2rrVzstr+8S7DtQeAb6LGU+sKzLzsmaAHByQsDxbfYCjp9wGZ3X6mgyjKIjwx65MUXdPiCjarRyydlIv6q7FgJAZhclrLuh63U8kvKAY59g6+xpA5sqy3TIbLHV5DVrCcGXYNWndIXSwx5Rl2ZrKLrBuzi0CeVPTqi73SXEFIvuD2Dl0kNqgu5pqihbRHnAEQEaK/xXRd0KsTpxlk2xZYXC7S2paVjVlYDBVeuweFIp5udKF9Y/oF9ByG7JrY0mb03dK5p7TNrui61SiCDNhXGBmgC4zuGEaeCZM3OyZWxviX231x+2v4nBn0ohrvTW1CddmWupCpwHoffn5KK0o6Cj4zL9qlXrjgSnBsc1NYKwnC2ZJ5t0pHWL1WQYY0m6nsXET+jKAHH8zYfvPhLbbVK2ARJLDmibc3k/ZYi37CaPAd1/RCH7UiffdKv/eIOpLq2CUJd2RW47CjxJV2DBDTECDK2p+8iU3XUZKZb1Ke7fLF08Stv4yZl0DrbbK5qwlAUsCbDXHS4BaU19+hgglBF1JoKRs46uDu1LK9ApVqYJM+bqxKMLClNJygTaul4HFIXvQh+fmXR9Uns4crt3QWinr7bhDLT5SHIb4rT2gj6va+coOYQlAZhd/S2yanB+llidw3Cw3IOB/CKltTUIYiRFeLHiI5NK0EECaK+SkMr0mq12uELjjDlX0OZ0yIT5KfnDDOlZt/XmKY70C0sClAQbXgMVFmjJDnZ7VbO7VDTa7vo6jshpmFnywKEPuDqlybUaPi154Kot8bu0JgRhyA1kPuylXW/w682DAL2Skhsb1OFyI1AbGEoZ0GO2gO5MCX4nRdlBB2piSTD0bGIaV1fL5vCmfRhoYVeai8S4IcG6NxLLaR1iv0e0wAlyZHqPfBeO21u7vvRtFfT9TKKRpBfPJYxzvTWrNpAFeuSeYExgEv07dfLgnL+nTl6jObL51MTJa0QN4/PUcpDo30jBFtqmuKWlamr3NtL2AcI9wxMvdei7yopdL5MNeoQAu2T70nRrjDf1KSoyvyGqKO3SZD+D2syKgoCPW91UMZR7WeK3vpOgL3WA8FUHU8VhZneZupA3ARorAzfoGyIpyQckGWWDqpceMK0kkgmgLznYnd8FrK7GY09aMxB4cLvPS03HCRGEQqGVti/Q+mtm1uPBoeSB2F0BKdJOA/jlLvLVhp6yqgdhuRGPEQfLU4s+WcgGsYtVFvcM0J8P/TVRDsiZAz6uuvQIrPwKSh6JkWnyOmKERxJLwn74gjJAnwoQav8wy5NCTqAckTMBIip6V6qRA+fjFXaT12gvcI1M7Rf2+ufkAH0Ki/T1nA9T00GYnN1jucsAHX5O/MRZrJ2MmaopVmPSm+I2cgAtU2BGl5lk9acckQcB+CEsXfz2uKJr4Jx42Ek1RaYhMkcE0NBmNB5X6LtE+lvfTYYQvY9yRF5CUHtZwvvcxbbX6FMAVbk19UoNHJtX+Woa/kVZQh9vdhLeCXo9MJKILZX+w6Ik0+/xws4vXdjwHP0A6KF/mXGG2OVJkwuXLlfmU6C38L0SIAZBtycncGtxtK+jf4/rDXzvBIA1WUdKTdMxO3z+RXL07GMXPbqffiD8DwAA//+JCaoQAAAABklEQVQDANuwQuYJT8EsAAAAAElFTkSuQmCC",
  codex: "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",
  codexWhite: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAALnUlEQVR4nNRbC7RVRRn+z61WWkGBqUgCgqKopIJYqGjXEgQVLSgoNb1pZWIYYKsSVoCmGAu1ePiIUsxWEkogKZJpkmilhSIQUpB6BY0QMTMw39fvuzPnrjn/mZk9e58DLL+1vrX3mcc/jz2P//9nzntlB6GlpeUIPAaDJ4JdwL3BD4ObwC3gk+B8cGGpVPq/7CKUpI5Ao9vj8VXw6+BBidleAeeC09AR/5CdjLp1ABp/Dh7TxXzlolgAXoCOeF52EmruADT8Q3jMA0+OJHtBzNDnUO8BfjSSlulORSc85pTREY/OYjp3K+Uh/gWpA2rqANv4e8BjPNF3ivminOP/Vfn2FLM+jABPDYifBR4K9hX/qNoO3gb+GvIXS0HU2gEP4XGsCp4DTkGl/pko4wA8poGfleJ4DhyPMm+RnCjcAaj4TDy+qYJHoBK3S05A1pF4LBSzW9SCx8Hz3OmThUIdgApz6M5TwQNQ8B8lByCnEx5Xgk2BJP8Gl4HrwLdA7jLcTrkeNIYly0Woy0xJQNEO4D7uLmRnoMC5OURQxng8JoAf8EQ/DV4MmQsj+ZlvEPgt8XfGzcj/FclAg+SE3e7cxs/L03jkPwXk+nCFVDf+ZTEN7xFrPIH4V8A7wBPw8wtiRouLJpQzUTKQewRA6O/wGOgEdUclmhPy9cTjWpXXxU3gd4tub5DPaXEX2EdFDYt1Zq4OQCG7i9HcyuAW9PmMPNzCLhUzVH3gTsI5u0JqhJ0WD4D9nOCNkN01lCfvFDhN/f6NxCv0NTw43H2Nfxb8Eip3XD0aT3Ba4DFUKqdDF9RjbDCPJAACyvr9USrKO/yRngoM14WPB0ROBqci76uSXfYn8TgOfALp75YEIM8ZePzSCXoeeff2pS1lCPoyHpeDoSHUDoK3efJRXe3oSX+rmHn+rGQAMrqJsS1Od4KXg6OQ/68J+Z9R9fZu0w2BzHuB9+H1Fgk3XgKNP1iqG7/CVuDMrMYj/wdB7hDNUtl4gnP7L4ifDe4hcVynfp/uS9TgqQDt+FXgZzzptwfeXbxf/X4Ije6boiTZEbceHJ+RlGvLeqT/RiTNfPX7RF+iBlWBffDgPNPzhdsI7fuVTlho+ujwP0kGqAqDj4gZcft4kqz1hHUAr0e+FXadqKxEqUSHywYnqJtHRtUIWKwq0AweBWHcS6mOuo1L7YDgOmOn2o1i5vYnPEnoIBmEsg/Bk1PrXk8ajtiHKcdamS7c6dbRbpMVaHAqM04qlQiquwNR+HK3zoF3iYR706G8i8WovOd6ov8DjkbZvcDWRuP5d5Cq73Ax7jQNynkSckc7YXq96awzNdjK0Ci5wgmn/T4w1aTNA5Q1FHwKr1eJ3w6gtngAyp7ly4/wBSBN6O9JpVJGtANnQP4qkGb6Gypep28bAVRUdnPCJ6KQlVJHUBUGl4hRnrpnJH8rI54dMVWMd+kmTzT1D2qYQ1Wef+mEDagUG36hE/Y/cLYEynXzShrao4xrxJi0gxPSsy4cyhdkJUSDNoPn4fVw8BFf2c77Op8MNoIuqXZO2MwUDU3Ca4Be9LhV+VRRLnCDLbU3mHv8deiENWCjZAD1XQX2x+tZUm0VlrHNF8gOaFRhSyQNRb1J1BK5UB2KSt9DivH9MexFlZar/1J0wu3gvlmCIYvq7/7gD8Q4YF30hYyqdYUdcLQKa5Yw3K/+dkIajR+zglzgwLZ5zne76HFOT/fko8W5EQ2YbKdsENZPQD8A9Rb9MS9E/gluADugk/P7zQxVNWUN8I0MeogPhOyx2kNckRFx4BimFaOTaEwC16ERX5QMQM5GMdP7tyrqcuRv2+7ZiA5O5DNxsYVGwA2ozGngekkE04Ks/E890XSczkUjloGHZ8hhHYeBS1VUm7+QHfCmE/G6ZNTNeU8dAdukOF6OxNFEfswaRsGDFnvuOEzJOhZ5PscXNuI5J2IvicP9urslpCFCI6UItF3B+tMwehoNGhPKhE54CY/LVPCYsoCNTuAe1iAKoaJxSDs8K43EF8W8oI7wKTH+fxc8ofoR6rMa3C+Q9ydiNNwyjqcfkR2gLa1GCeMl9Xs+hNwL9nLCko2hIsDXXAZyEaMCtEVF9wanBPJxKuqzjBHsgEUq8BQJ4zZPGO3stdxj7SHmjhwBbUCDqAJTpb5BRfWOZFugfvdvgKD7xai/ZZxp3VG+Qmmv0zHq2y04PGk8NelssoOA+mwHtcr8nkiWh9XvruWV/FcqYqqEC+WeziHvO3Tglqo9wDusAxxsTinP6iBu2i7lDmBj3O1qJEbBoIigV0Gqm9yTb5V3F7Y67/u2dgAaQwNigkq40NrUQVBrpKNTzMr8RCAZj8IGSE4gD/f5kyU/stYc1/Db3KbMoCEzpNLlRGfFYuskjcKuzDRoeHbgM2gehJy7wEOyZDENSL8kT4UPlvrDPYLfrLU5akeuz53HWiucFT4KdAJVVxo013qiubvQvJ0DVt0DYBjjmAYcIsUR80HqmyxrKjqAq6oY+3yDSsgVfn2ik4IGDS9OcDv6gydJE+VD1nT69i2n2zKbpHbEpoDu2KXe3kKFeMOiT0AI5zoPM38vKbVpaaEpS/+fb2vlqsw6tPfEPSpG0XG9SH1Q7uOeMriGlV35a5Cmd6Au9EW67rjuIYMm1HiC8/g+CFsE9pAMoDI8oOC2OckTzSmmG89t6lzk4ynQGsmP0Efl+abb+Lt5ruk7GdK2AN3id3hkUiGi724Kj7MkViOzbdIYOUbioO+QfoM5UhxVU8Aqdlq34aj0mrQfUb/XokJcHKny+ra6S8RYY00SqhEOJOjNkfApEZUreop4OyRmAqegpMrm4s1dxV3El6CcVh+BrwO0x6b1jh7nvN3qRok5uHDBExmu7sv1MZX13tDp6ZsCdJIMtg6Tp6TO4MmTmAsT7vZLh+/55R9VHeDxnXdS8dfjwYMJbYQQvO7GY6qfgyeBPBDlPQHt0ORX/g5kHWidonUHyh4pxtLVC+L51l3WitAiuMl576kjIeBFa4TwAOIBT/6zxfjifHOeVhxPfqZJNtpLfvC8kYc6tG+07nJlSV2mDHWAex7YIaTKQtjfwEa8cphvkDg4Go7gQQa4JSNt2dlylqTBnfd0jx3mSXMJyq06dg91gF71R0qs9FKJjga6oX0WIvfoJqQZkHLcxus1IHUMbp+7q+hQJ8dcecxzNMr+oS8ytGeyF/VX6urOnRDsAQYXPE4d3jK5xl5eysrH0yBulaMCSXiWMFrS6lrG1eD3S5E/ZMT05l9I5RDMvBJXFCiLPgR2WgdPdDM4LnTXz07PB50gGlGs+508O5QMxDrgY2LO79/nBE+0foC6AGV8Wozh1MsTTbuE/r2rUeZrERn8yuOcoM5Iv0kSETzhhRC6y2eo4Mti7udUQMb+II/JOdd9jecX7Ik6TIk13sL1TD+ap/FE9Igbwr4t1dsc3c8/y1J/fUCe8lE5fYdDPUloAPVHuWenNASyuF64RtbNkhOZ/joUwnn5Z6n+ExQ1Ro6Q2aXsq29Ur7meTBZz9K3BuToBcm6URNj7QDSWyveC6OrqUsr5D7TUm6I0NXkRuV8gCZ0o1OdpRtNc5apPJYlaGN1lIyLiOYcnWV9EEuwJMRc79+bqpZAxWXIi2WPbYi5Kc24Ol/qAHTbWXmdLRov5nxJ1hJOcYNoaR+bpxDKKXJenUkTTspsUB6fMEGqSeTLZEygebri+Qo62fpC1Vgog9Z5PG6j1gfuJ8f/fn5hN3zajsrTa3u07LCszfXkgT6XYSLfxNKqGFG08UZdDC6uMcM4fZMmhSKuSQ3MRF0mkoV9xVkAEG8AtcasKp5bHO76+6zGUT1N6tdSAnXFq0wZ0AhdE/qtsT6kNtOguit02SUXuKVALUGHqFPQlXCXFQD3hBMg5px6Nb62T7CJgNPAaPm0LqsPHS+WJjQtakLxuv8CeS9YVu6wDNKgei1nguIbwj1MrfS7weuMdAAAA//91KRhNAAAABklEQVQDAObFNmgYZ1k+AAAAAElFTkSuQmCC",
  clawd: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAsElEQVR4nOzZwQ2CQBQA0SGhF0uyFGuwFEuyGr1zcGNWQ2DmXSHZZLIbPrAityJXAOQKgFwBkCsAcgVArgCjG56364sDu9wfy6fr7QDkCoBcAZArAHLTAbaDxr8Hp1+v1w5ArgDIFQC55ejv+7M6AsgVALkCINccMLqh/wInVwDkCoBcAZBrEOJL28Fo9J1+NIjsvV5HALkCIFcA5KYeUWfQEUCuAMgVALkCIFcA5N4AAAD//76p40kAAAAGSURBVAMAedAjm/SojOUAAAAASUVORK5CYII=",
  antigravity: "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",
}

// ───────────────────────── 진입점 ─────────────────────────
if (config.runsInWidget || config.runsInAccessoryWidget) {
  await runWidget()
} else {
  await mainMenu()
}
Script.complete()
