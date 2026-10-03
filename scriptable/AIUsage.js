// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-purple; icon-glyph: tachometer-alt;

// AI 사용량 위젯 — Claude / Codex / Antigravity
// https://github.com/tmmmzk/scriptable-ai-usage
//
// • 두 가지 방식: 서버 모드(직접 띄운 서버가 수집) / 기기 모드(서버 없이 이 스크립트가 직접 조회)
// • 앱에서 실행하면 설정·계정 관리 화면이 열립니다.
// • 위젯 Parameter 에 계정 이름(또는 id)을 쉼표로 적으면 그 계정만 표시합니다. 예) 개인,회사

const VERSION = "0.7.3"
// 앱의 '업데이트'가 새 버전을 받아오는 주소(공개 저장소의 raw 파일). 포크했다면 여기를 바꾸세요.
const UPDATE_URL = "https://raw.githubusercontent.com/tmmmzk/scriptable-ai-usage/main/scriptable/AIUsage.js"
const KC_SERVER = "aiusage.server"
const KC_KEY = "aiusage.apikey"

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
  dimBar: new Color("#8E8E93", 0.7),
  ok: new Color("#34C759"),
  warn: new Color("#FF9F0A"),
  bad: new Color("#FF453A"),
}

// ───────────────────────── 설정 / API ─────────────────────────
const fm = FileManager.local() // 앱과 위젯이 같이 쓰는 Scriptable 문서 폴더

const kcGet = (key, fallback = null) => (Keychain.contains(key) ? Keychain.get(key) : fallback)

function kcJSON(key, fallback) {
  try {
    const v = JSON.parse(kcGet(key, "null"))
    return v == null ? fallback : v
  } catch (e) {
    return fallback
  }
}

function getConfig() {
  if (getMode() === "device") return { device: true }
  const server = kcGet(KC_SERVER)
  const apiKey = kcGet(KC_KEY)
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
const KC_AG_CLIENT = "aiusage.dev.antigravityClient"

// "server" | "device". 저장된 값이 없는데 서버 주소가 있으면 기기 모드가 생기기 전 설정이다.
function getMode() {
  return kcGet("aiusage.mode") || (Keychain.contains(KC_SERVER) ? "server" : null)
}

function setMode(mode) {
  Keychain.set("aiusage.mode", mode)
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
    throw new ProviderError(t("err.network", { msg: e.message || e }))
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
        throw new ProviderError(t("err.json", { text: this.text.slice(0, 120) }))
      }
    },
  }
}

// 401/403(챌린지 제외) → 재로그인 필요
function checkAuth(res, what) {
  if ((res.status === 401 || res.status === 403) && !res.challenge) throw authError(t("err.auth", { what, status: res.status }))
}

// 429, Cloudflare, 그 밖의 오류
function checkCommon(res, what) {
  if (res.status === 429) throw new ProviderError(t("err.rateLimited", { what }), "rate_limited")
  if (res.status === 403 && res.challenge) throw new ProviderError(t("err.blocked", { what }), "blocked")
  if (!res.ok) throw new ProviderError(`${what}: HTTP ${res.status} ${res.text.slice(0, 160)}`)
}

// ── 정규화 공통 (서버의 providers/base.py 와 같은 형식) ──
const isoOf = (ms) => (ms == null || isNaN(ms) ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"))

// ISO-8601 → epoch ms. 소수점 자릿수가 긴 값(나노초)도 처리.
function msOf(v) {
  if (typeof v !== "string" || !v.trim()) return null
  const ms = Date.parse(v.trim().replace(/(\.\d{3})\d+/, "$1"))
  return isNaN(ms) ? null : ms
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
  if (!text) throw new ProviderError(t("err.emptyInput"))
  if (text.includes("://") || text.includes("code=")) {
    const query = text.includes("?") ? text.split("?").slice(1).join("?").split("#")[0] : text
    const params = {}
    for (const part of query.split("&")) {
      const [k, v = ""] = part.split("=")
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "))
    }
    if (params.error) throw new ProviderError(t("err.loginDenied", { error: params.error }))
    if (!params.code) throw new ProviderError(t("err.noCode"))
    return { code: params.code, state: params.state || null }
  }
  if (text.includes("#")) {
    const [code, state] = text.split("#")
    return { code: code.trim(), state: state.trim() || null }
  }
  return { code: text, state: null }
}

function checkState(expected, got) {
  if (got != null && got !== expected) throw new ProviderError(t("err.state"))
}

const authorizeUrl = (base, params) => `${base}?${formEncode(params)}`
const expiresAt = (data) => Date.now() + (num(data.expires_in) || 3600) * 1000

function checkTokenExchange(res) {
  if (!res.ok) throw new ProviderError(t("err.tokenExchange", { status: res.status, text: res.text.slice(0, 160) }))
}

// ── Claude ──
const CLAUDE = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  scopes: ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"],
  apiBase: "https://api.anthropic.com/api/oauth",
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
const claudeModelShown = (name) => typeof name === "string" && /^(fable|opus|sonnet|haiku)\b/i.test(name.trim())

// 저장된 창 중 보여줄 것. 예전 버전이 저장한 코드네임 창(iguana_necktie 등)도 여기서 걸러진다.
function claudeWindowShown(w) {
  const key = String((w && w.key) || "")
  return CLAUDE_WINDOWS.some(([, k]) => k === key) || key === "cowork_credit" || (key.startsWith("model:") && claudeModelShown(key.slice(6)))
}

// /api/oauth/profile 의 organization_type → 플랜. Max 는 rate_limit_tier 로 5x/20x 를 구분한다.
function claudePlan(profile) {
  const org = profile && profile.organization
  if (!org || typeof org !== "object") return null
  if (typeof org.rate_limit_tier === "string" && /max_\d+x/.test(org.rate_limit_tier)) return org.rate_limit_tier
  return { claude_max: "max", claude_pro: "pro", claude_team: "team", claude_enterprise: "enterprise" }[org.organization_type] || null
}

const claudeOAuthHeaders = (token) => ({ Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": CLAUDE.userAgent })

// 프로필(플랜·조직)은 부가 정보라 실패해도 사용량 조회를 막지 않는다
async function claudeProfile(accessToken) {
  try {
    const res = await devHttp("GET", `${CLAUDE.apiBase}/profile`, { headers: claudeOAuthHeaders(accessToken) })
    return res.ok ? res.json() : null
  } catch (e) {
    return null
  }
}

// 선불 크레딧 잔액(Claude Code 의 /usage-credits 와 같은 곳). 없거나 실패하면 null.
async function claudePrepaid(accessToken, org) {
  try {
    const res = await devHttp("GET", `${CLAUDE.apiBase}/organizations/${org}/prepaid/credits`,
      { headers: { ...claudeOAuthHeaders(accessToken), "x-organization-uuid": org } })
    const d = res.ok ? res.json() : null
    return d && typeof d.amount === "number" ? { balance: fromMinor(d.amount, d.currency), currency: d.currency || "USD" } : null
  } catch (e) {
    return null
  }
}

// 금액은 최소 단위(센트)로 온다. 원·엔처럼 소수점이 없는 통화는 그대로.
function fromMinor(v, currency) {
  const n = num(v)
  if (n == null) return null
  return ["JPY", "KRW"].includes(String(currency || "USD").toUpperCase()) ? n : n / 100
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
  // Claude Code·Cowork 일회성 크레딧(cinder_cove). resets_at 은 만료 시각이다.
  const cc = data.cinder_cove
  if (cc && typeof cc === "object")
    out.push({ ...makeWindow("cowork_credit", "Claude Code·Cowork 크레딧", clampPct(num(cc.utilization)), isoOf(msOf(cc.resets_at))), kind: "credit" })
  return out
}

// 추가 사용량. used_credits·monthly_limit 은 센트 단위다(한도가 없으면 monthly_limit 이 null).
function claudeExtra(data) {
  const e = data.extra_usage
  if (!e || typeof e !== "object" || !e.is_enabled) return {}
  const currency = e.currency || "USD"
  return { extra_usage: { used: fromMinor(e.used_credits, currency), limit: fromMinor(e.monthly_limit ?? e.monthly_credit_limit, currency),
    used_percent: clampPct(num(e.utilization)), currency } }
}

// cedar_ember → 초기화권. 일시정지·소진·미시작·만료된 grant 는 빼고 resets_left 만큼 펼친다.
function claudeResetCredits(block, at) {
  if (!block || typeof block !== "object") return null
  if (block.eligible !== true) return resetCreditsSummary([]) // 대상이 아니면 0장(모르는 것과 구분)
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
  if (!data.access_token) throw new ProviderError(t("err.noAccessToken"))
  const scopes = typeof data.scope === "string" ? data.scope.split(" ") : data.scope
  return {
    access_token: data.access_token,
    // 리프레시 토큰은 쓸 때마다 바뀐다. 응답에 없으면 이전 값을 유지.
    refresh_token: data.refresh_token || prev.refresh_token,
    expires_at: expiresAt(data),
    scopes: scopes || prev.scopes || CLAUDE.scopes,
  }
}

const claudeWebHeaders = (key) => ({ Cookie: `sessionKey=${key}`, "User-Agent": CLAUDE.webUserAgent })

async function claudeWebOrg(sessionKey) {
  const res = await devHttp("GET", `${CLAUDE.webBase}/organizations`, { headers: claudeWebHeaders(sessionKey) })
  checkAuth(res, "sessionKey")
  checkCommon(res, t("what.claudeOrg"))
  const orgs = res.json()
  if (!Array.isArray(orgs) || !orgs.length) throw new ProviderError(t("err.noOrgs"))
  const caps = (o) => (o.capabilities || []).map((c) => String(c).toLowerCase())
  return orgs.find((o) => caps(o).includes("chat")) || orgs.find((o) => caps(o).join() !== "api") || orgs[0]
}

async function claudeWebUsage(creds, ctx) {
  if (!creds.org_id) {
    creds = { ...creds, org_id: (await claudeWebOrg(creds.session_key)).uuid }
    ctx.save({ org_id: creds.org_id })
  }
  const base = `${CLAUDE.webBase}/organizations/${creds.org_id}/usage`
  const headers = claudeWebHeaders(creds.session_key)
  let res = await devHttp("GET", `${base}?cedar_ember=1`, { headers })
  checkAuth(res, "sessionKey")
  // 초기화권 옵트인이 거부되면 옵션 없이 한 번 더(사용량은 받을 수 있음)
  if (!res.ok && res.status !== 429 && !res.challenge) res = await devHttp("GET", base, { headers })
  checkCommon(res, t("what.claudeWeb"))
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
      pending: { verifier, state },
    }
  },

  async finishLogin(pending, code) {
    const res = await devHttp("POST", CLAUDE.tokenUrl, { json: {
      grant_type: "authorization_code", code, redirect_uri: CLAUDE.redirectUri, client_id: CLAUDE.clientId,
      code_verifier: pending.verifier, state: pending.state,
    } })
    checkTokenExchange(res)
    const data = res.json()
    const creds = { oauth: claudeOAuth(data) }
    if (data.organization && data.organization.uuid) creds.org_id = data.organization.uuid
    const account = data.account || {}
    return { creds, email: account.email_address || account.email || null, plan: claudePlan(await claudeProfile(creds.oauth.access_token)) }
  },

  async createManual({ session_key }) {
    const key = String(session_key || "").trim()
    if (!key.startsWith("sk-ant-")) throw new ProviderError(t("err.skPrefix"))
    const org = await claudeWebOrg(key)
    return { creds: { session_key: key, org_id: org.uuid }, email: null }
  },

  describe: (c) => ({ oauth: !!(c.oauth && c.oauth.refresh_token), session_key: !!c.session_key,
    reset_credits_supported: !!(c.session_key || c.oauth) }),

  async refresh(c) {
    if (!c.oauth || !c.oauth.refresh_token) throw authError(t("err.noRefresh"))
    const res = await devHttp("POST", CLAUDE.tokenUrl, { json: {
      grant_type: "refresh_token", refresh_token: c.oauth.refresh_token, client_id: CLAUDE.clientId,
      scope: (c.oauth.scopes || CLAUDE.scopes).join(" "),
    } })
    if ([400, 401, 403].includes(res.status)) throw authError(t("err.refreshDenied", { status: res.status }))
    checkCommon(res, t("what.claudeRefresh"))
    return { ...c, oauth: claudeOAuth(res.json(), c.oauth) }
  },

  async fetch(creds, ctx) {
    const usage = { windows: [], reset_credits: null, plan: null, email: null, extra: {}, warnings: [] }
    if (creds.oauth) {
      // cedar_ember=1 이면 초기화권도 같이 온다(Claude Code 와 같은 요청). 거부되면 옵션 없이 한 번 더.
      const get = (query = "?cedar_ember=1") => devHttp("GET", `${CLAUDE.apiBase}/usage${query}`, { headers: claudeOAuthHeaders(creds.oauth.access_token) })
      let res = await get()
      if (res.status === 401) {
        creds = await ctx.refresh(creds)
        res = await get()
      }
      if (!res.ok && ![401, 403, 429].includes(res.status) && !res.challenge) res = await get("")
      checkAuth(res, "Claude OAuth")
      checkCommon(res, t("what.claudeUsage"))
      const data = res.json()
      usage.windows = claudeWindows(data)
      usage.extra = claudeExtra(data)
      if (data.cedar_ember) usage.reset_credits = claudeResetCredits(data.cedar_ember, Date.now())
      // 사용량 응답에는 플랜·조직이 없어 프로필로 따로 조회(바뀔 일이 드물어 모를 때만)
      if (!ctx.knownPlan || !creds.org_id) {
        const profile = await claudeProfile(creds.oauth.access_token)
        if (!ctx.knownPlan) usage.plan = claudePlan(profile)
        const org = profile && profile.organization && profile.organization.uuid
        if (org && !creds.org_id) {
          creds = { ...creds, org_id: org }
          ctx.save({ org_id: org })
        }
      }
      if (creds.org_id) {
        const prepaid = await claudePrepaid(creds.oauth.access_token, creds.org_id)
        if (prepaid) usage.extra = { ...usage.extra, prepaid }
      }
    }
    // OAuth 로 초기화권을 못 받았을 때만 claude.ai 웹(sessionKey)으로
    if (creds.session_key && !usage.reset_credits) {
      let web = null
      try {
        web = await claudeWebUsage(creds, ctx)
      } catch (e) {
        if (!creds.oauth) throw e
        usage.warnings.push(t(e.kind === "needs_login" ? "warn.skExpired" : "warn.creditsFailed", { msg: e.message }))
      }
      if (web) {
        if (!usage.windows.length) {
          usage.windows = claudeWindows(web)
          usage.extra = claudeExtra(web)
        } else {
          // 웹 응답에만 오는 항목(예: Claude Code·Cowork 크레딧)은 더한다
          const have = new Set(usage.windows.map((w) => w.key))
          usage.windows.push(...claudeWindows(web).filter((w) => !have.has(w.key)))
        }
        usage.reset_credits = claudeResetCredits(web.cedar_ember, Date.now())
        if (!usage.reset_credits) usage.warnings.push(t("warn.noCreditsInfo"))
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
  if (!data.access_token) throw new ProviderError(t("err.noAccessToken"))
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
      pending: { verifier, state },
    }
  },

  async finishLogin(pending, code) {
    const res = await devHttp("POST", `${CODEX.issuer}/oauth/token`, { form: {
      grant_type: "authorization_code", code, redirect_uri: CODEX.redirectUri, client_id: CODEX.clientId,
      code_verifier: pending.verifier,
    } })
    checkTokenExchange(res)
    const creds = codexCreds(res.json())
    const info = codexIdInfo(creds.id_token)
    return { creds, email: info.email, plan: info.plan }
  },

  describe: (c) => ({ oauth: !!c.refresh_token, reset_credits_supported: true }),

  async refresh(c) {
    if (!c.refresh_token) throw authError(t("err.noRefresh"))
    const res = await devHttp("POST", `${CODEX.issuer}/oauth/token`, { json: {
      client_id: CODEX.clientId, grant_type: "refresh_token", refresh_token: c.refresh_token, scope: "openid profile email",
    } })
    if (res.status === 400 || res.status === 401) throw authError(`${t("err.refreshDenied", { status: res.status })} ${res.text.slice(0, 120)}`)
    checkCommon(res, t("what.codexRefresh"))
    return codexCreds(res.json(), c)
  },

  async fetch(creds, ctx) {
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
    checkCommon(res, t("what.codexUsage"))
    const data = res.json()
    const usage = {
      windows: codexWindows(data), reset_credits: null, extra: codexExtra(data), warnings: [],
      plan: typeof data.plan_type === "string" ? data.plan_type : null, email: codexIdInfo(creds.id_token).email,
    }
    try {
      const rc = await get("/wham/rate-limit-reset-credits", { "OpenAI-Beta": "codex-1" })
      checkCommon(rc, t("what.codexCredits"))
      usage.reset_credits = codexResetCredits(rc.json(), Date.now())
    } catch (e) {
      usage.warnings.push(t("warn.creditsFailed", { msg: e.message }))
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
  // 사용량은 요청을 처리한 배포에만 잡히고, 다른 배포는 안 쓴 것처럼(100% 남음) 답한다.
  // Antigravity 는 daily 배포를 주로 쓰므로 요약은 두 곳에 묻고 창마다 더 많이 쓴 쪽을 고른다.
  summaryBases: ["https://daily-cloudcode-pa.googleapis.com/v1internal", "https://cloudcode-pa.googleapis.com/v1internal"],
  redirectUri: "http://127.0.0.1:8585/callback",
  userAgent: "antigravity/hub/2.9.1 darwin/arm64",
  metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
}

// Antigravity 앱의 Google OAuth 클라이언트(설정에서 입력)
function agClient() {
  const c = kcJSON(KC_AG_CLIENT, null)
  return c && c.id && c.secret ? c : null
}

function agRequireClient() {
  const c = agClient()
  if (!c) throw new ProviderError(t("err.agClient"))
  return c
}

function projectRef(v) {
  if (typeof v === "string" && v.trim()) return v.trim()
  if (v && typeof v === "object") return projectRef(v.id || v.projectId)
  return null
}

function pickTier(info) {
  const tiers = info.allowedTiers || []
  const tier = tiers.find((x) => x.isDefault && x.id) || tiers.find((x) => x.id)
  return (tier && tier.id) || (info.paidTier || {}).id || (info.currentTier || {}).id || null
}

function resolvePlan(info, creds) {
  const plan = (info.planInfo || {}).planType
  if (plan) return plan
  // Google AI Pro/Ultra 구독은 currentTier 가 free/standard 여도 paidTier 에 g1-pro-tier 처럼 온다
  const paid = (info.paidTier || {}).id
  if (paid) return paid
  const tier = (info.currentTier || {}).id
  const hosted = jwtClaims(creds.id_token).hd
  return { "standard-tier": "Paid", "free-tier": hosted ? "Workspace" : "Free", "legacy-tier": "Legacy" }[tier]
    || (info.currentTier || {}).name || null
}

const usedFromRemaining = (f) => (num(f) == null ? null : clampPct((1 - num(f)) * 100))
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "q"

// "FIVE_HOUR", "5h", "18000s", "Five Hour Limit Remaining", "WEEKLY" 등 → 초. 모르면 null.
function agWindowSeconds(window) {
  if (typeof window !== "string") return null
  const w = window.toUpperCase()
  const sec = w.match(/^(\d+)S$/)
  if (sec) return Number(sec[1])
  if (w.includes("HOUR") || /\d\s*H\b/.test(w)) {
    const m = w.match(/(\d+)/)
    const words = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, EIGHT: 8, TWELVE: 12 }
    const word = Object.keys(words).find((k) => w.includes(k))
    return (m ? Number(m[1]) : word ? words[word] : 5) * 3600
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
      // 이름은 'Weekly Limit Remaining' 처럼 길게 오므로, 기간을 알면 Claude·Codex 처럼 5시간·주간으로 쓴다
      const name = b.displayName || b.name || id
      // window 값으로 기간을 모르면 이름에서 찾는다(예: window 는 다른 형식, 이름은 'Five Hour Limit Remaining')
      const seconds = agWindowSeconds(b.window) || agWindowSeconds(name)
      out.push(makeWindow(`${slug(gname)}:${id}`, seconds ? windowLabel(seconds) : name.replace(/\s*(limit\s*)?remaining\s*$/i, "") || name,
        usedFromRemaining(remaining), isoOf(msOf(b.resetTime)), { seconds, group: gname }))
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

// 그룹 순서는 그대로, 그룹 안에서는 짧은 기간부터(5시간 → 주간). 대표 창은 첫 그룹(보통 Gemini)의 앞 2개.
const bySeconds = (a, b) => (a.window_seconds || Infinity) - (b.window_seconds || Infinity)

function agOrder(windows) {
  const groups = [...new Set(windows.map((w) => w.group))]
  const out = groups.flatMap((g) => windows.filter((w) => w.group === g).sort(bySeconds))
  out.filter((w) => w.group === groups[0]).slice(0, 2).forEach((w) => (w.primary = true))
  return out
}

// 같은 창(key)이 여러 응답에 있으면 사용률이 가장 높은 쪽을 쓴다(초기화 시각도 그쪽 것)
function agMergeMostUsed(lists) {
  const best = new Map()
  for (const w of lists.flat()) {
    const cur = best.get(w.key)
    if (!cur || (w.used_percent ?? -1) > (cur.used_percent ?? -1)) best.set(w.key, w)
  }
  return [...best.values()]
}

async function agQuotaSummaryAll(token, body) {
  const results = await Promise.allSettled(AG.summaryBases.map((base) => agPost("retrieveUserQuotaSummary", token, body, base)))
  const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason)
  const auth = failed.find((e) => e.kind === "needs_login")
  if (auth) throw auth
  const found = results.filter((r) => r.status === "fulfilled").map((r) => agQuotaSummary(r.value))
  if (!found.length) throw failed[failed.length - 1]
  return agMergeMostUsed(found)
}

async function agPost(method, token, body, base = AG.apiBase) {
  const res = await devHttp("POST", `${base}:${method}`, { json: body,
    headers: { Authorization: `Bearer ${token}`, "User-Agent": AG.userAgent } })
  if (res.status === 401) throw authError(t("err.agAuth"))
  if (res.status === 403) throw new ProviderError(t("err.forbidden", { method, text: res.text.slice(0, 160) }))
  checkCommon(res, `Antigravity ${method}`)
  return res.json()
}

const antigravityProvider = {
  methods: ["oauth"],
  configured: () => (agClient() ? [true, null] : [false, t("err.agClient")]),
  refreshToken: (c) => c.refresh_token,
  needsRefresh: (c) => (c.expires_at || 0) - 2 * 60 * 1000 < Date.now(),

  startLogin() {
    const state = randomToken(24)
    return {
      authorize_url: authorizeUrl(AG.authUrl, {
        client_id: agRequireClient().id, redirect_uri: AG.redirectUri, response_type: "code", scope: AG.scopes.join(" "),
        access_type: "offline", prompt: "select_account consent", state,
      }),
      pending: { state },
    }
  },

  async finishLogin(pending, code) {
    const client = agRequireClient()
    const res = await devHttp("POST", AG.tokenUrl, { form: {
      code, client_id: client.id, client_secret: client.secret, redirect_uri: AG.redirectUri, grant_type: "authorization_code",
    } })
    checkTokenExchange(res)
    const data = res.json()
    if (!data.refresh_token) throw new ProviderError(t("err.noGoogleRefresh"))
    const creds = { access_token: data.access_token, refresh_token: data.refresh_token,
      expires_at: expiresAt(data), id_token: data.id_token || null }
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
    if (res.status === 400 || res.status === 401) throw authError(t("err.refreshDenied", { status: res.status }))
    checkCommon(res, t("what.googleRefresh"))
    const d = res.json()
    return { ...c, access_token: d.access_token, expires_at: expiresAt(d),
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
    if (project && creds.project_id !== project) ctx.save({ project_id: project })
    return { project, plan: resolvePlan(info, creds) }
  },

  async fetch(creds, ctx) {
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
      usage.windows = await agQuotaSummaryAll(creds.access_token, body)
    } catch (e) {
      usage.warnings.push(t("warn.summaryFallback", { msg: e.message }))
    }
    if (!usage.windows.length) {
      try {
        usage.windows = agAvailableModels(await agPost("fetchAvailableModels", creds.access_token, body))
      } catch (e) {
        usage.windows = agQuotaBuckets(await agPost("retrieveUserQuota", creds.access_token, body))
      }
    }
    usage.windows = agOrder(usage.windows)
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
const devAccounts = () => readJSON("aiusage-device-accounts.json", []).sort((a, b) => (a.order || 0) - (b.order || 0))
const devSaveAccounts = (list) => writeJSON("aiusage-device-accounts.json", list)
// 사용량은 계정마다 파일을 나눠, 여러 위젯이 동시에 써도 서로 덮어쓰지 않게 한다
const devSnapName = (id) => `aiusage-device-snap-${id}.json`
const devGetSnap = (id) => readJSON(devSnapName(id), null)
const devPutSnap = (id, snap) => writeJSON(devSnapName(id), snap)
const devCredKey = (id) => `aiusage.dev.creds.${id}`

const devGetCreds = (id) => kcJSON(devCredKey(id), null)

const devSaveCreds = (id, creds) => Keychain.set(devCredKey(id), JSON.stringify(creds))

function devFind(id) {
  const acc = devAccounts().find((a) => a.id === id)
  if (!acc) throw new ApiError(t("err.noAccount"), 404)
  return acc
}

function devUpdateAccount(id, fn) {
  const list = devAccounts()
  const acc = list.find((a) => a.id === id)
  if (!acc) throw new ApiError(t("err.noAccount"), 404)
  fn(acc)
  devSaveAccounts(list)
  return acc
}

// 토큰 갱신 잠금: 위젯 여러 개와 앱이 동시에 갱신하면 회전된 리프레시 토큰이 무효가 될 수 있다
const devLockName = (id) => `aiusage-device-lock-${id}`

// 파일 잠금이라 완전히 원자적이진 않다. 쓴 뒤 다시 읽어, 그 사이 다른 쪽이 썼으면 양보한다.
function devTryLock(id) {
  const p = devPath(devLockName(id))
  try {
    if (fm.fileExists(p) && Date.now() - parseInt(fm.readString(p), 10) < 30 * 1000) return false // 30초 넘은 잠금은 버려진 것
  } catch (e) {}
  const mine = `${Date.now()}:${randomToken(6)}`
  fm.writeString(p, mine)
  try {
    return fm.readString(p) === mine
  } catch (e) {
    return false
  }
}

function devUnlock(id) {
  try {
    fm.remove(devPath(devLockName(id)))
  } catch (e) {}
}

async function devRefreshCreds(acc, provider, creds) {
  if (!devTryLock(acc.id)) throw new RefreshBusy()
  try {
    // 잠금을 잡은 뒤 다시 읽는다. 다른 위젯/앱이 먼저 갱신했다면 저장된 새 토큰을 쓴다.
    const latest = devGetCreds(acc.id) || creds
    if (provider.refreshToken(latest) !== provider.refreshToken(creds) && !provider.needsRefresh(latest)) return latest
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
    let creds = devGetCreds(acc.id)
    if (!creds) throw authError(t("err.noCreds"))
    const ctx = {
      refresh: (c) => devRefreshCreds(acc, provider, c),
      // 조회 중에 알아낸 값(org_id, project_id)만 최신 저장값에 덧붙인다(그새 회전된 토큰을 덮지 않게)
      save: (patch) => devSaveCreds(acc.id, { ...(devGetCreds(acc.id) || {}), ...patch }),
      knownPlan: prev.plan || acc.plan || null,
    }
    if (provider.needsRefresh(creds)) creds = await ctx.refresh(creds)
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
    plan: snap.plan || acc.plan || null,
  }
}

function devPublic(acc) {
  const snap = devGetSnap(acc.id) || {}
  const provider = DEVICE_PROVIDERS[acc.provider]
  return { ...devCommon(acc, snap), enabled: acc.enabled !== false,
    order: acc.order || 0, created_at: acc.created_at, auth: provider ? provider.describe(devGetCreds(acc.id) || {}) : {} }
}

function devUsageEntry(acc) {
  const snap = devGetSnap(acc.id) || {}
  return { ...devCommon(acc, snap), enabled: acc.enabled !== false, warnings: snap.warnings || [],
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
  if (!p) throw new ApiError(t("err.unknownProvider", { id }), 400)
  return p
}

// 서버의 /v1 API 를 기기 안에서 처리한다
async function deviceApi(method, path, body) {
  const route = `${method} ${path.split("?")[0]}`
  let m
  try {
    if (route === "GET /v1/usage") {
      // ?accounts=개인,claude_ab12 처럼 이름이나 id 로 거를 수 있다(서버와 같음)
      const q = (path.match(/[?&]accounts=([^&]*)/) || [])[1]
      const only = q ? decodeURIComponent(q).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) : null
      // 위젯에서 숨긴 계정은 빼고 준다. 앱은 ?all=1 로 모두 받는다.
      const all = /[?&]all=1/.test(path)
      const accounts = devAccounts().filter((a) => (all || a.enabled !== false)
        && (!only || only.includes(a.id.toLowerCase()) || only.includes(String(a.label).toLowerCase())))
      // 10분 넘게 지난 계정만 다시 조회. '새로고침'(refresh=1)도 1분 안에 조회한 계정은 건너뛴다.
      const minAge = /[?&]refresh=1/.test(path) ? 60 * 1000 : 10 * 60 * 1000
      await Promise.all(accounts.map((a) => devRefreshAccount(a, minAge)))
      const entries = accounts.map(devUsageEntry)
      // 가장 오래된 조회 시각을 '업데이트' 시각으로 보여준다
      const oldest = Math.min(...entries.map((e) => msOf(e.fetched_at) || Date.now()), Date.now())
      return { generated_at: isoOf(oldest), poll_interval: 600, accounts: entries }
    }
    if (route === "GET /v1/providers") {
      return { providers: Object.entries(DEVICE_PROVIDERS).map(([id, p]) => {
        const [configured, reason] = p.configured()
        return { id, name: providerName(id), methods: p.methods, configured, reason }
      }) }
    }
    if (route === "GET /v1/accounts") return { accounts: devAccounts().map(devPublic) }
    if (route === "POST /v1/accounts") {
      const p = devProvider(body.provider)
      if (!p.createManual) throw new ApiError(t("err.unsupported", { route: `${route} (${body.provider})` }), 400)
      const result = await p.createManual(body)
      const acc = devUpsert(body.provider, null, body.label, result)
      await devRefreshAccount(acc, 0)
      return devPublic(acc)
    }
    // 로그인 진행 중인 세션(15분 유효)
    const LOGINS = "aiusage-device-logins.json"
    const expired = (v) => Date.now() - v.created > 15 * 60 * 1000
    if (route === "POST /v1/logins") {
      const p = devProvider(body.provider)
      if (body.account_id && devFind(body.account_id).provider !== body.provider) throw new ApiError(t("err.noAccount"), 404)
      const start = p.startLogin()
      const logins = readJSON(LOGINS, {})
      for (const [k, v] of Object.entries(logins)) if (expired(v)) delete logins[k]
      const loginId = randomToken(16)
      logins[loginId] = { provider: body.provider, label: body.label || null, account_id: body.account_id || null,
        pending: start.pending, created: Date.now() }
      writeJSON(LOGINS, logins)
      return { login_id: loginId, provider: body.provider, authorize_url: start.authorize_url }
    }
    if ((m = route.match(/^POST \/v1\/logins\/([\w-]+)\/complete$/))) {
      const logins = readJSON(LOGINS, {})
      const entry = logins[m[1]]
      if (!entry || expired(entry))
        throw new ApiError(t("err.loginExpired"), 404)
      const { code, state } = parseCallbackInput(body.input)
      checkState(entry.pending.state, state)
      const result = await devProvider(entry.provider).finishLogin(entry.pending, code)
      delete logins[m[1]]
      writeJSON(LOGINS, logins)
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
        if (devFind(id).provider !== "claude") throw new ApiError(t("err.skClaudeOnly"), 400)
        const creds = devGetCreds(id) || {}
        if (sessionKey && !String(sessionKey).startsWith("sk-ant-")) throw new ApiError(t("err.skPrefix"), 400)
        if (!sessionKey && !creds.oauth) throw new ApiError(t("err.skCantRemove"), 400)
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
  throw new ApiError(t("err.unsupported", { route }), 404)
}

async function api(method, path, body, timeout = 25) {
  const cfg = getConfig()
  if (!cfg) throw new ApiError(t("err.noMode"), 0)
  if (cfg.device) return deviceApi(method, path, body || {})
  return serverApi(cfg, method, path, body, timeout)
}

// 저장 전에 연결을 확인할 때도 쓰므로 설정을 인자로 받는다.
async function serverApi(cfg, method, path, body, timeout = 25) {
  let res
  try {
    res = await devHttp(method, cfg.server.replace(/\/+$/, "") + path,
      { headers: { Authorization: `Bearer ${cfg.apiKey}` }, json: body, timeout })
  } catch (e) {
    throw new ApiError(t("err.server", { msg: e.message || e }), 0)
  }
  let data = null
  try {
    data = JSON.parse(res.text)
  } catch (e) {}
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status)
  if (data == null) throw new ApiError(t("err.server", { msg: t("err.json", { text: res.text.slice(0, 120) }) }), res.status)
  return data
}

// ───────────────────────── 캐시 ─────────────────────────
// 마지막으로 받은 사용량. 연결이 안 될 때 이 값을 흐리게 보여준다.
const readCache = () => readJSON("aiusage-cache.json", null)

function writeCache(data) {
  try {
    writeJSON("aiusage-cache.json", data)
  } catch (e) {}
}

// all: 위젯에서 숨긴 계정까지(앱). 캐시는 앱과 위젯이 같이 쓰므로 위젯은 그릴 때 한 번 더 거른다.
async function loadUsage(refresh = false, { all = false } = {}) {
  try {
    const query = [refresh && "refresh=1", all && "all=1"].filter(Boolean).join("&")
    const data = await api("GET", `/v1/usage${query ? `?${query}` : ""}`, undefined, refresh ? 40 : 15)
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
  if (p == null) return C.dimBar
  if (p >= 90) return C.bad
  if (p >= 70) return C.warn
  return C.ok
}

function fmtPct(p) {
  return p == null ? "–" : `${Math.round(p)}%`
}

// 퍼센트를 사용한 양으로 볼지 남은 양으로 볼지(앱·위젯 공통). 색은 늘 사용률로 정한다.
let _showLeft = null
const showLeft = () => (_showLeft == null ? (_showLeft = kcGet("aiusage.show") === "left") : _showLeft)

function setShowLeft(on) {
  Keychain.set("aiusage.show", on ? "left" : "used")
  _showLeft = on
}

const shownPct = (used) => (used == null ? null : showLeft() ? Math.round((100 - used) * 10) / 10 : used)

// 금액 표시 (예: $12.40, ₩3,000)
function money(v, currency = "USD") {
  if (v == null) return "–"
  const cur = String(currency || "USD").toUpperCase()
  const zero = ["JPY", "KRW"].includes(cur)
  const n = zero ? Math.round(v).toLocaleString("en-US") : v.toFixed(2)
  const sym = { USD: "$", EUR: "€", GBP: "£", KRW: "₩", JPY: "¥" }[cur]
  return sym ? `${sym}${n}` : `${n} ${cur}`
}

// 남은 기간. 큰 단위 두 개까지 (예: 3일 10시간, 2시간 12분, 46분). 지났거나 없으면 null.
function fmtDuration(iso) {
  const ms = iso ? new Date(iso).getTime() - Date.now() : NaN
  if (!(ms > 0)) return null
  const m = Math.max(1, Math.floor(ms / 60000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  const parts = d > 0 ? [t("dur.d", { n: d }), h && t("dur.h", { n: h })]
    : h > 0 ? [t("dur.h", { n: h }), mm && t("dur.m", { n: mm })] : [t("dur.m", { n: mm })]
  return parts.filter(Boolean).join(t("dur.sep"))
}

function fmtAgo(iso) {
  if (!iso) return "–"
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return t("ago.now")
  if (m < 60) return t("ago.m", { n: m })
  if (m < 1440) return t("ago.h", { n: Math.floor(m / 60) })
  return t("ago.d", { n: Math.floor(m / 1440) })
}

function fmtDate(iso) {
  if (!iso) return ""
  const df = new DateFormatter()
  df.locale = LANG_INFO[LANG].locale
  df.dateFormat = LANG_INFO[LANG].dateFormat
  return df.string(new Date(iso))
}

function fmtDay(iso) {
  const d = new Date(iso)
  const mon = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getMonth()]
  return t("date.md", { m: d.getMonth() + 1, d: d.getDate(), mon })
}

// "Claude (me@example.com)"
function providerLine(acc) {
  const name = providerName(acc.provider)
  return acc.email ? `${name} (${acc.email})` : name
}

const PLAN_NAMES = {
  free: "Free", plus: "Plus", pro: "Pro", max: "Max", team: "Team", business: "Business",
  enterprise: "Enterprise", edu: "Edu", paid: "Paid", workspace: "Workspace", legacy: "Legacy",
  claude_max: "Max", claude_pro: "Pro",
  // Antigravity(Gemini Code Assist) 등급
  "g1-pro-tier": "AI Pro", "g1-ultra-tier": "AI Ultra", "standard-tier": "Paid", "free-tier": "Free", "legacy-tier": "Legacy",
}

function planLabel(plan, provider) {
  if (!plan) return null
  const key = String(plan).toLowerCase().trim()
  // ChatGPT 는 Team 요금제 이름이 Business 로 바뀌었다(Claude 는 그대로 Team)
  if (provider === "codex" && key === "team") return "Business"
  if (PLAN_NAMES[key]) return PLAN_NAMES[key]
  const m = key.match(/max[_ ]?(\d+)x/)
  if (m) return `Max ${m[1]}x`
  const g1 = key.match(/^g1-(\w+)-tier$/) // 새 Google One 등급(예: g1-plus-tier)
  if (g1) return `AI ${g1[1][0].toUpperCase()}${g1[1].slice(1)}`
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function groupShort(group) {
  if (group === "모델별" || group === "추가 한도") return localLabel(group) // 우리가 붙인 이름은 통째로(번역)
  return { "gemini models": "Gemini", "claude and gpt models": "Claude/GPT" }[group.toLowerCase()] || group.split(/\s+/)[0]
}

// 그룹이 있으면 짧은 그룹 이름을 앞에 붙인다(예: Gemini 5시간).
function windowTitle(w) {
  const label = localLabel(w.label)
  return w.group ? `${groupShort(w.group)} ${label}` : label
}

// 위젯에 보일 Antigravity 그룹(계정 id → 그룹 이름). 이 기기에만 저장한다.
const widgetGroups = () => kcJSON("aiusage.widgetGroups", {})
const setWidgetGroup = (id, group) => Keychain.set("aiusage.widgetGroups", JSON.stringify({ ...widgetGroups(), [id]: group }))
const windowGroups = (acc) => [...new Set((acc.windows || []).map((w) => w.group).filter(Boolean))]

// 위젯 그룹: 고른 것이 있으면 그것, 없으면 대표 창의 그룹(보통 Gemini)
function widgetGroupOf(acc) {
  const ws = acc.windows || []
  const pref = widgetGroups()[acc.id]
  return windowGroups(acc).includes(pref) ? pref : (ws.find((w) => w.primary) || ws[0] || {}).group
}

function primaryWindows(acc, n = 2) {
  const ws = acc.windows || []
  if (acc.provider === "antigravity") {
    const group = widgetGroupOf(acc)
    return ws.filter((w) => w.group === group).sort(bySeconds).slice(0, n)
  }
  const prim = ws.filter((w) => w.primary)
  return (prim.length ? prim : ws).slice(0, n)
}

// 계정 이름 줄 오른쪽 배지. enabled: false 면 "숨김"(앱), offline 이면 "오프라인"(위젯).
// color 가 없으면 기본 글자색, muted 면 흐린 글자색(위젯/앱이 각자 맞는 색을 고른다).
function statusPills(acc, { enabled, offline } = {}) {
  const pills = []
  const rc = acc.reset_credits
  if (rc && rc.available > 0) pills.push({ text: t("pill.credits", { n: rc.available }) })
  if (acc.status === "needs_login") pills.push({ text: t("pill.relogin"), color: C.bad })
  else if (acc.status === "partial") pills.push({ text: t("pill.partial"), color: C.warn })
  else if (acc.status && !["ok", "pending"].includes(acc.status)) pills.push({ text: statusText(acc.status), color: C.bad })
  if (enabled === false) pills.push({ text: t("pill.hidden"), muted: true })
  if (offline) pills.push({ text: t("pill.offline"), color: C.warn })
  return pills
}

// 사용률 숫자 색: 70% 미만은 기본 글자색, 이상이면 경고색
function pctTextColor(pct, dim, base) {
  return dim || pct == null || pct < 70 ? base : pctColor(pct)
}

function statusText(status) {
  return STRINGS[`status.${status}`] ? t(`status.${status}`) : status || t("status.error")
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
// 위젯 폭(pt). iOS 는 기기별로 고정 크기를 쓰므로 화면 폭으로 고른다. 모르는 기기는 비율로 근사.
function widgetWidth(family) {
  const w = Math.round(Math.min(Device.screenSize().width, Device.screenSize().height))
  const [small, medium] = { 440: [170, 364], 430: [170, 364], 428: [170, 364], 414: [169, 360], 402: [162, 345],
    393: [158, 338], 390: [158, 338], 375: [155, 329] }[w] || [Math.round(w * 0.4), Math.round(w * 0.86)]
  return family === "small" ? small : medium
}

const LAYOUT = {
  small: { pad: 14, padV: 14, accounts: 1, gap: 0 },
  medium: { pad: 16, padV: 11, accounts: 2, gap: 9 },
  large: { pad: 16, padV: 14, accounts: 4, gap: 10 },
}

let _claudeLogo = null
function claudeLogo() {
  if (_claudeLogo == null) _claudeLogo = kcGet("aiusage.claudeLogo", "default")
  return _claudeLogo
}
function setClaudeLogo(v) {
  Keychain.set("aiusage.claudeLogo", v)
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
  const el = stack.addText(text)
  el.font = font
  el.textColor = color
  el.lineLimit = 1
  if (opts.minScale) el.minimumScaleFactor = opts.minScale
  if (opts.opacity != null) el.textOpacity = opts.opacity
  return el
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
  addText(top, windowTitle(w), Font.systemFont(12), C.sub, { minScale: 0.8 })
  top.addSpacer()
  addText(top, fmtPct(shownPct(w.used_percent)), Font.semiboldSystemFont(13), pctTextColor(w.used_percent, dim, C.text), { opacity: dim ? 0.55 : 1 })

  cell.addSpacer(3)
  const bar = cell.addImage(barImage(shownPct(w.used_percent), width, 6, dim ? C.dimBar : pctColor(w.used_percent)))
  bar.imageSize = new Size(width, 6)
  // 남은 시간은 막대 아래 작은 글씨로 (정보가 없어도 줄 높이는 유지)
  cell.addSpacer(2)
  addText(cell, timeCandidates(w.resets_at, w.kind)[0] || " ", Font.systemFont(10), C.sub, { opacity: 0.85 })
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
    addText(block, acc.error || statusText(acc.status) || t("common.noData"), Font.systemFont(11), C.sub)
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
  const gap = 14
  const cellW = Math.floor((inner - gap) / 2)
  ws.forEach((w, i) => {
    if (i > 0) row.addSpacer(gap)
    windowCell(row, w, cellW, dim)
  })
  return block
}

function filterAccounts(all, param) {
  const accounts = all.filter((a) => a.enabled !== false) // 위젯에서 숨긴 계정(앱이 쓴 캐시에 섞여 있을 수 있다)
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
  addText(w, "AI Usage", Font.semiboldSystemFont(14), C.text)
  w.addSpacer(6)
  const msg = addText(w, message, Font.systemFont(11), C.sub)
  msg.lineLimit = 4
  return w
}

function buildHomeWidget(result, size, param) {
  const { data, offline } = result
  const accounts = filterAccounts(data.accounts || [], param)
  if (!accounts.length) return emptyWidget(t("widget.empty"))

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
    addText(head, "AI Usage", Font.semiboldSystemFont(13), C.text)
    head.addSpacer()
    addText(head, offline ? `${t("pill.offline")} · ${fmtAgo(data.generated_at)}` : t("widget.updated", { ago: fmtAgo(data.generated_at) }),
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
    addText(w, `${t("pill.offline")} · ${fmtAgo(data.generated_at)}`, Font.systemFont(10), C.warn)
  } else if (family === "large" && accounts.length > shown.length) {
    addText(w, t("widget.more", { n: accounts.length - shown.length }), Font.systemFont(10), C.sub)
  }
  return w
}

function buildAccessoryWidget(result, family, param) {
  const accounts = filterAccounts(result.data.accounts || [], param)
  const w = new ListWidget()
  if (!accounts.length) {
    addText(w, "AI Usage –", Font.systemFont(12), Color.white())
    return w
  }
  const parts = (acc) => primaryWindows(acc).map((x) => fmtPct(shownPct(x.used_percent))).join(" · ")
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
    addText(bottom, pw ? fmtPct(shownPct(pw.used_percent)) : "–", Font.boldSystemFont(14), Color.white())
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
    widget = emptyWidget(t("widget.setup"))
  } else {
    try {
      const result = await loadUsage(false)
      if (!result.offline) await checkAlerts(result.data.accounts)
      widget = family.startsWith("accessory")
        ? buildAccessoryWidget(result, family, param)
        : buildHomeWidget(result, family, param)
    } catch (e) {
      widget = emptyWidget(t("widget.loadFailed", { msg: e.message }))
    }
  }
  widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000) // iOS 가 정하지만 15분 뒤를 요청
  Script.setWidget(widget)
  if (getConfig()) await notifyUpdate()
}

// ───────────────────────── 알림 ─────────────────────────
// 위젯·앱이 사용량을 받을 때마다 확인해, 필요한 알림을 한 번씩만 보낸다.
// 보낸 기록(sent)과 한도별 직전 값(seen)은 파일에 둔다. seen 으로 예정보다 이른 초기화를 알아챈다.
// 알림 종류. 이름·설명은 문구의 notify.<종류>.title / .desc
const NOTIFY_TYPES = ["high", "reset", "early", "login", "credit", "update"]

function notifySettings() {
  const base = { enabled: true, threshold: 90, types: Object.fromEntries(NOTIFY_TYPES.map((type) => [type, true])) }
  try {
    const saved = kcJSON("aiusage.notify", {})
    return { ...base, ...saved, types: { ...base.types, ...(saved.types || {}) } }
  } catch (e) {
    return base
  }
}

function saveNotifySettings(settings) {
  Keychain.set("aiusage.notify", JSON.stringify(settings))
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

// 사용량 경고 끝에 붙는 " 2시간 후 초기화돼요."
function resetSuffix(iso) {
  if (!iso) return ""
  const left = fmtDuration(iso)
  return left ? t("notify.high.resetIn", { t: left }) : t("notify.high.resetSoon")
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
  const state = readJSON("aiusage-notify-state.json", {})
  // 예전 형식({키: 시각})도 보낸 기록으로 이어받는다
  const sent = state.sent || (state.seen ? {} : state)
  const seen = state.seen || {}
  const once = (key) => !sent[key] && (sent[key] = now)
  const jobs = []
  const cancel = []
  for (const acc of accounts) {
    const who = `${providerName(acc.provider)} (${acc.label})`
    if (acc.status === "needs_login") {
      if (on("login") && once(`login:${acc.id}:${acc.last_success_at}`))
        jobs.push({ id: `aiusage-login-${acc.id}`, title: who, body: t("notify.login.body") })
      continue
    }
    if (acc.stale) continue // 이전 값이면 비교하지 않는다
    for (const w of (acc.windows || []).filter((x) => x.kind !== "credit")) {
      const key = `${acc.id}:${w.key}`
      const prev = seen[key]
      if (prev && isEarlyReset(prev, w, now)) {
        cancel.push(`aiusage-reset-${acc.id}-${w.key}`) // 예약해 둔 초기화 알림은 필요 없어졌다
        if (on("early") && once(`early:${key}:${prev.resets_at}`))
          jobs.push({ id: `aiusage-early-${acc.id}-${w.key}`, title: who,
            body: t("notify.early.body", { name: windowTitle(w), from: Math.round(prev.used), to: Math.round(w.used_percent) }) })
      }
      seen[key] = { used: w.used_percent, resets_at: w.resets_at, at: now }
    }
    for (const w of primaryWindows(acc)) {
      if (w.used_percent == null || w.used_percent < settings.threshold) continue
      const name = windowTitle(w)
      const period = `${acc.id}:${w.key}:${w.resets_at}`
      if (on("high") && once(`high:${period}`))
        jobs.push({ id: `aiusage-high-${acc.id}-${w.key}`, title: who,
          body: t("notify.high.body", { name, pct: Math.round(w.used_percent) }) + resetSuffix(w.resets_at) })
      const at = msOf(w.resets_at)
      if (on("reset") && at && at > now && once(`reset:${period}`))
        jobs.push({ id: `aiusage-reset-${acc.id}-${w.key}`, title: who, body: t("notify.reset.body", { name }), at: new Date(at) })
    }
    for (const item of (acc.reset_credits && acc.reset_credits.items) || []) {
      const exp = msOf(item.expires_at)
      if (on("credit") && exp && exp > now && exp - now < DAY_MS && once(`credit:${acc.id}:${item.expires_at}`))
        jobs.push({ id: `aiusage-credit-${acc.id}-${exp}`, title: who,
          body: t("notify.credit.body", { t: fmtDuration(item.expires_at) }) })
    }
  }
  // 2주 지난 기록은 지운다
  for (const [key, at] of Object.entries(sent)) if (now - at > 14 * DAY_MS) delete sent[key]
  for (const [key, v] of Object.entries(seen)) if (now - v.at > 14 * DAY_MS) delete seen[key]
  writeJSON("aiusage-notify-state.json", { sent, seen })
  try {
    if (cancel.length) await Notification.removePending(cancel)
  } catch (e) {}
  for (const job of jobs) {
    try {
      await sendNotification(job)
    } catch (e) {} // 알림 권한이 없으면 조용히 넘어간다
  }
}

// ───────────────────────── 업데이트 ─────────────────────────
// UPDATE_URL 에서 새 스크립트를 받아 이 스크립트 파일을 바꿔 쓴다. 바로 전 버전은 되돌릴 수 있게 남겨 둔다.
// 확인 결과는 파일에 남겨 두고, 앱을 열 때 12시간마다 한 번 다시 확인한다(위젯에서는 확인하지 않는다).
const scriptVersion = (src) => (String(src).match(/^const VERSION = "([^"]+)"/m) || [])[1] || null

// a 가 b 보다 새 버전인가 ("0.10.0" > "0.9.1")
function isNewer(a, b) {
  const pa = String(a || "").split(".").map(Number)
  const pb = String(b || "").split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

const updateState = () => readJSON("aiusage-update.json", {})

async function fetchLatestScript() {
  const res = await devHttp("GET", UPDATE_URL, { headers: { Accept: "*/*" }, timeout: 30 })
  if (!res.ok) throw new Error(t("update.fetchFailed", { status: res.status }))
  const version = scriptVersion(res.text)
  if (!version) throw new Error(t("update.invalid"))
  return { version, source: res.text }
}

async function checkUpdate(force = false) {
  const state = updateState()
  if (!force && Date.now() - (state.checked_at || 0) < 12 * 3600 * 1000) return state
  const { version } = await fetchLatestScript()
  const next = { ...state, checked_at: Date.now(), latest: version }
  writeJSON("aiusage-update.json", next)
  return next
}

// 스크립트 파일이 iCloud 에 있으면 iCloud 파일 관리자로 써야 한다
function scriptFiles(path) {
  try {
    const cloud = FileManager.iCloud()
    if (path.startsWith(cloud.documentsDirectory())) return cloud
  } catch (e) {}
  return FileManager.local()
}

// 되돌리기용으로 남겨 둔 바로 전 버전. .js 가 아니어야 스크립트 목록에 나타나지 않는다.
const backupPath = () => devPath("aiusage-previous.txt")
const backupVersion = () => (fm.fileExists(backupPath()) ? scriptVersion(fm.readString(backupPath())) : null)

async function installUpdate() {
  const { version, source } = await fetchLatestScript()
  // 다운로드가 잘렸거나 다른 파일이면 설치하지 않는다(실행하지 않고 문법만 확인)
  try {
    new Function(`return (async () => {\n${source}\n})`)
  } catch (e) {
    throw new Error(t("update.invalid"))
  }
  const path = module.filename
  const files = scriptFiles(path)
  fm.writeString(backupPath(), files.readString(path))
  files.writeString(path, source)
  writeJSON("aiusage-update.json", { ...updateState(), checked_at: Date.now(), latest: version })
  return version
}

// 새 버전을 사용자가 봤다고 기록한다(앱 배너를 봤거나 알림을 보냈으면 다시 알리지 않는다)
const markUpdateSeen = (v) => writeJSON("aiusage-update.json", { ...updateState(), seen: v })

// 위젯이 12시간마다 새 버전을 확인해 한 번 알린다. 실패해도 조용히 넘어간다.
async function notifyUpdate() {
  try {
    const state = await checkUpdate()
    if (!isNewer(state.latest, VERSION) || state.seen === state.latest) return
    const settings = notifySettings()
    if (settings.enabled && settings.types.update)
      await sendNotification({ id: "aiusage-update", title: "AI Usage", body: t("update.banner", { v: state.latest }) })
    markUpdateSeen(state.latest)
  } catch (e) {}
}

function restoreBackup() {
  const source = fm.readString(backupPath())
  scriptFiles(module.filename).writeString(module.filename, source)
  fm.remove(backupPath())
  return scriptVersion(source)
}

// ───────────────────────── 앱 UI: 공용 ─────────────────────────
async function confirm(title, message, okText = t("common.ok"), destructive = false) {
  const a = new Alert()
  a.title = title
  a.message = message || ""
  destructive ? a.addDestructiveAction(okText) : a.addAction(okText)
  a.addCancelAction(t("common.cancel"))
  return (await a.presentAlert()) === 0
}

// 글자를 직접 받을 때만 쓰는 작은 입력창. 취소하면 null.
async function prompt(title, message, { placeholder = "", value = "", secure = false } = {}) {
  const a = new Alert()
  a.title = title
  a.message = message || ""
  secure ? a.addSecureTextField(placeholder, value) : a.addTextField(placeholder, value)
  a.addAction(t("common.ok"))
  a.addCancelAction(t("common.cancel"))
  if ((await a.presentAlert()) !== 0) return null
  return a.textFieldValue(0).trim()
}

// ───────────────────────── 앱 UI: 페이지 ─────────────────────────
// 설정·입력도 팝업 대신 메인처럼 '페이지'(표)로 보여준다. 글자를 직접 쳐야 할 때만 작은 입력창을 띄운다.
// build(page) 가 행을 채운다. 행을 누르면 page.run(fn) 이 작업하고 페이지를 다시 그린다(오류는 맨 위에 표시).
// 끝내는 행(저장·삭제·로그인 완료)은 page.after(fn): 페이지를 닫고 fn 을 한 뒤 그 결과를 openPage 가 돌려준다.
// 취소(false)나 오류면 페이지를 다시 띄운다. 결과는 앞 페이지가 받아서 알린다.
// title 이 함수면 그릴 때마다 다시 구한다(설정에서 언어를 바꾸면 바로 반영).
const ACCENT = new Color("#0A84FF")

async function openPage(title, build) {
  const table = new UITable()
  table.showSeparators = true
  let rows = []
  let heads = []
  const page = {
    closed: false,
    notice: null, // 맨 위에 보여줄 결과·오류 { title, detail, color }
    add: (row) => rows.push(row),
    head: (row) => heads.push(row), // 제목 대신 맨 위에 둘 행(알림은 그 아래에 온다)
    ok(head, detail) {
      this.notice = { title: head, detail, color: C.ok }
    },
    // 그리는 도중에 다시 그리라고 하면(예: 백그라운드 확인이 끝남) 줄이 섞이므로, 끝난 뒤 한 번 더 그린다
    async render() {
      if (this.closed) return
      if (this.rendering) {
        this.again = true
        return
      }
      this.rendering = true
      try {
        do {
          this.again = false
          rows = []
          heads = []
          let failed = null
          try {
            await build(this)
          } catch (e) {
            failed = e
          }
          table.removeAllRows()
          const head = typeof title === "function" ? title() : title
          if (head) table.addRow(titleRow(head))
          for (const r of heads) table.addRow(r)
          if (this.notice) table.addRow(noticeRow(this.notice))
          for (const r of rows) table.addRow(r)
          if (failed) table.addRow(noticeRow({ title: t("common.loadFailed"), detail: failed.message || String(failed), color: C.bad }))
        } while (this.again && !this.closed)
        table.reload()
      } finally {
        this.rendering = false
      }
    },
    after(fn) {
      const go = () => (this.next = fn)
      go.dismiss = true
      return go
    },
    run(fn) {
      return async () => {
        this.notice = null
        try {
          await fn()
        } catch (e) {
          this.notice = { title: t("common.error"), detail: e.message || String(e), color: C.bad }
        }
        await this.render()
      }
    },
  }
  for (;;) {
    page.closed = false
    page.next = null
    await page.render()
    await table.present(false)
    page.closed = true
    if (!page.next) return undefined
    page.notice = null
    try {
      const result = await page.next()
      if (result !== false) return result
    } catch (e) {
      page.notice = { title: t("common.error"), detail: e.message || String(e), color: C.bad }
    }
  }
}

// ── 행 ──
function titleRow(text) {
  const r = new UITableRow()
  r.isHeader = true
  r.height = 56
  r.addText(text).titleFont = Font.boldSystemFont(24)
  return r
}

function headerRow(text) {
  const r = new UITableRow()
  r.isHeader = true
  r.addText(text)
  return r
}

// 누를 수 없는 글 한 줄(+설명)
function textRow(title, subtitle, { height, color, font } = {}) {
  const r = new UITableRow()
  r.height = height || (subtitle ? 62 : 48)
  const c = r.addText(title, subtitle || null)
  if (color) c.titleColor = color
  if (font) c.titleFont = font
  c.subtitleColor = Color.gray()
  return r
}

function noticeRow({ title, detail, color }) {
  return textRow(title, detail, { height: detail ? 64 : 48, color: color || Color.gray() })
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
  r.dismissOnSelect = !!(onSelect && onSelect.dismiss)
  r.height = subtitle ? 62 : 48
  const c = r.addText(title, subtitle || null)
  c.widthWeight = 100 - valueWidth
  if (subtitle) {
    c.subtitleColor = Color.gray()
    c.subtitleFont = Font.systemFont(12)
  }
  const v = r.addText(value == null ? "" : String(value))
  v.widthWeight = valueWidth
  v.rightAligned()
  v.titleColor = color || Color.gray()
  if (onSelect) r.onSelect = onSelect
  return r
}

const toggleRow = (title, on, onSelect, subtitle) =>
  valueRow(title, on ? t("common.on") : t("common.off"), onSelect, { subtitle, color: on ? C.ok : Color.gray(), valueWidth: 20 })
const checkRow = (title, checked, onSelect, subtitle) =>
  valueRow(title, checked ? "✓" : "", onSelect, { subtitle, color: ACCENT, valueWidth: 12 })
const linkRow = (title, onSelect, subtitle) => valueRow(title, "›", onSelect, { subtitle, valueWidth: 12 })

// 메뉴 행
function actionRow(title, onSelect, color, subtitle) {
  const r = new UITableRow()
  r.dismissOnSelect = !!(onSelect && onSelect.dismiss)
  if (subtitle) r.height = 62
  const c = r.addText(title, subtitle || null)
  if (color) c.titleColor = color
  c.subtitleColor = Color.gray()
  r.onSelect = onSelect
  return r
}

function imageRow(img, height) {
  const r = new UITableRow()
  r.height = height
  r.addImage(img).centerAligned()
  return r
}

// 서비스 고르기 한 줄: 로고 · 이름(+설명) · ›
function providerRow(provider, title, subtitle, onSelect) {
  const r = new UITableRow()
  r.dismissOnSelect = !!(onSelect && onSelect.dismiss)
  r.height = subtitle ? 62 : 52
  const img = providerRowLogo(provider)
  if (img) r.addImage(img).widthWeight = 10
  const c = r.addText(title, subtitle || null)
  c.widthWeight = 82
  c.subtitleColor = Color.gray()
  const v = r.addText("›")
  v.widthWeight = 8
  v.rightAligned()
  v.titleColor = Color.gray()
  r.onSelect = onSelect
  return r
}

// 눈에 띄어야 하는 안내 한 줄(초록 배경, 흰 글자)
function bannerRow(text, onSelect) {
  const r = new UITableRow()
  r.dismissOnSelect = false
  r.backgroundColor = C.ok
  const c = r.addText(text)
  c.titleColor = Color.white()
  c.titleFont = Font.semiboldSystemFont(16)
  c.widthWeight = 90
  const v = r.addText("›")
  v.widthWeight = 10
  v.rightAligned()
  v.titleColor = Color.white()
  r.onSelect = onSelect
  return r
}

// '복사한 값 붙여넣기' + '직접 입력' 두 줄. 넣으면 페이지를 닫고 submit(값) 의 결과를 돌려준다(page.after).
// 빈 값이면 emptyMessage 로 알린다. 클립보드에 글자가 없으면 Pasteboard.paste() 는 null 이므로 빈 글자로 바꾼다(취소와 구분).
function pasteRows(page, { pasteTitle, pasteHint, promptTitle, promptHint, secure, emptyMessage, submit }) {
  const send = async (raw) => {
    if (raw == null) return false // 입력창에서 취소
    const value = String(raw).trim()
    if (!value) throw new Error(emptyMessage)
    return submit(value)
  }
  page.add(actionRow(pasteTitle, page.after(() => send(Pasteboard.paste() ?? "")), ACCENT, pasteHint))
  page.add(actionRow(t("common.typeIn"), page.after(async () => send(await prompt(promptTitle, promptHint, { secure })))))
}

// ───────────────────────── 앱 UI: 카드 그리기 ─────────────────────────
// UITable 에는 진행 막대가 없어서 카드 전체를 이미지로 그려 행에 넣는다.
// DrawContext 이미지에는 dynamic 색이 적용되지 않으므로 지금 모드에 맞는 색을 고른다.
let _pal = null
function pal() {
  if (_pal) return _pal
  const dark = Device.isUsingDarkAppearance()
  return (_pal = dark
    ? { dark, text: new Color("#F2F2F7"), sub: new Color("#98989F"), track: new Color("#8E8E93", 0.3), pill: new Color("#787880", 0.32) }
    : { dark, text: new Color("#1C1C1E"), sub: new Color("#6E6E73"), track: new Color("#8E8E93", 0.2), pill: new Color("#787880", 0.14) })
}

function brandHex(provider) {
  return (PROVIDER_STYLE[provider] || {}).color || "#8E8E93"
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

const PILL_FONT = [11, 600]

// 계정 머리(로고 · 이름 + 플랜 배지 · 서비스(이메일) · 오른쪽 배지)와 한도 줄의 모양
const HEAD_STYLE = {
  card: { logo: 24, logoY: 6, x: 34, name: [17, 600], nameY: 2, lineY: 23, line: 12, pillY: 10, height: 44 },
  detail: { logo: 40, logoY: 8, x: 52, name: [22, 700], nameY: 6, lineY: 36, line: 13, pillY: 18, height: 64 },
}
// 글자 크기가 달라도 밑줄(baseline)이 맞도록 y 를 잡았다.
const LINE_STYLE = {
  card: { title: [13, 400], titleY: 2, pct: 15, time: 12, timeY: 3, barY: 23, barH: 7, rowH: 42 },
  detail: { title: [15, 500], titleY: 2, pct: 18, time: 13, timeY: 4, barY: 30, barH: 8 },
}

// 카드·상세에 쓰는 글자들을 미리 잰다. style: "card" | "detail"
function measureItemsFor(acc, usage, style) {
  const u = usage || acc
  const h = HEAD_STYLE[style]
  const s = LINE_STYLE[style]
  const items = [{ text: acc.label, size: h.name[0], weight: h.name[1] }]
  const plan = planLabel(u.plan || acc.plan, acc.provider)
  if (plan) items.push({ text: plan, size: 10, weight: 700 })
  for (const pill of statusPills(u, { enabled: acc.enabled })) items.push({ text: pill.text, size: PILL_FONT[0], weight: PILL_FONT[1] })
  for (const w of u.windows || []) {
    items.push({ text: windowTitle(w), size: s.title[0], weight: s.title[1] }, { text: fmtPct(shownPct(w.used_percent)), size: s.pct, weight: 600 })
    for (const c of timeCandidates(w.resets_at, w.kind)) items.push({ text: c, size: s.time, weight: 400 })
  }
  if (style === "detail")
    for (const item of (u.reset_credits && u.reset_credits.items) || []) items.push({ text: creditLeft(item).text, size: PILL_FONT[0], weight: PILL_FONT[1] })
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

function drawLogo(ctx, provider, x, y, size) {
  const img = logoImage(provider, pal().dark)
  if (img) ctx.drawImageInRect(img, new Rect(x, y, size, size))
}

// pills(왼쪽→오른쪽 순서)를 right 에 붙여 그리고, 남은 오른쪽 경계를 돌려준다.
function drawPills(ctx, pills, right, y) {
  const p = pal()
  let x = right
  for (const pill of [...pills].reverse()) {
    const w = textW(pill.text, PILL_FONT[0], PILL_FONT[1]) + 14
    x -= w
    fillRound(ctx, new Rect(x, y, w, 20), 10, p.pill)
    drawTextAt(ctx, pill.text, x, y + 3, w, 16, Font.semiboldSystemFont(PILL_FONT[0]), pill.muted ? p.sub : pill.color || p.text, "center")
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
  const brand = brandHex(provider)
  fillRound(ctx, new Rect(x, top, w, h), 5, new Color(brand, pal().dark ? 0.28 : 0.15))
  drawTextAt(ctx, label, x, top + 2.5, w, h - 2, Font.boldSystemFont(10), new Color(brand), "center")
}

// 계정 머리. 카드와 상세 화면이 크기만 다르게 같이 쓴다.
function drawAccountHead(ctx, acc, { plan, pills, dim }, W, style) {
  const p = pal()
  const h = HEAD_STYLE[style]
  const [size, weight] = h.name
  const nameFont = weight >= 700 ? Font.boldSystemFont(size) : Font.semiboldSystemFont(size)
  drawLogo(ctx, acc.provider, 0, h.logoY, h.logo)
  const right = drawPills(ctx, pills, W, h.pillY)
  drawTextAt(ctx, acc.label, h.x, h.nameY, right - h.x - 6, size + 6, nameFont, dim ? p.sub : p.text)
  drawPlanBadge(ctx, acc.provider, plan, { text: acc.label, x: h.x, y: h.nameY, size, weight }, right - 6)
  drawTextAt(ctx, providerLine(acc), h.x, h.lineY, right - h.x - 6, h.line + 5, Font.systemFont(h.line), p.sub)
}

// 남은 시간 표기 후보(긴 것부터). 이름과 겹치면 짧은 것으로 바꾼다. 크레딧(kind: credit)은 초기화 대신 만료.
function timeCandidates(iso, kind) {
  if (!iso) return []
  const left = fmtDuration(iso)
  if (kind === "credit") return left ? [t("credit.expiresIn", { t: left }), t("reset.inShort", { t: left })] : [t("credit.soon")]
  return left ? [t("reset.in", { t: left }), t("reset.inShort", { t: left })] : [t("reset.soon")]
}

// 앱의 한도 한 줄: 왼쪽 이름, 오른쪽 '남은 시간  퍼센트', 아래 막대.
function drawWindowLine(ctx, w, y, width, dim, style) {
  const p = pal()
  const s = LINE_STYLE[style]
  const pct = w.used_percent
  const pctText = fmtPct(shownPct(pct))
  const title = windowTitle(w)
  const titleFont = s.title[1] >= 500 ? Font.mediumSystemFont(s.title[0]) : Font.systemFont(s.title[0])
  drawTextAt(ctx, pctText, width - 80, y, 80, s.pct + 6, Font.semiboldSystemFont(s.pct), pctTextColor(pct, dim, p.text), "right")
  const timeRight = width - textW(pctText, s.pct, 600) - 8
  const room = timeRight - textW(title, s.title[0], s.title[1]) - 14
  const time = timeCandidates(w.resets_at, w.kind).find((c) => textW(c, s.time, 400) <= room)
  const titleRight = time ? timeRight - textW(time, s.time, 400) - 10 : timeRight
  drawTextAt(ctx, title, 0, y + s.titleY, titleRight, s.title[0] + 6, titleFont, style === "card" ? p.sub : p.text)
  if (time) drawTextAt(ctx, time, 0, y + s.timeY, timeRight, s.time + 5, Font.systemFont(s.time), new Color(p.sub.hex, 0.85), "right")
  drawBar(ctx, 0, y + s.barY, width, s.barH, shownPct(pct), dim || pct == null ? p.sub : pctColor(pct), p.track)
}

// 메인 화면의 계정 카드. 앱은 공간이 넓어 한도마다 한 줄씩(가로 전체) 모두 보여준다.
function accountCard(acc, enabled) {
  const p = pal()
  const W = cardWidth()
  const ws = acc.windows || []
  const head = HEAD_STYLE.card.height
  const line = LINE_STYLE.card
  // 마지막 줄은 막대 아래 여백 없이 끝낸다
  const H = head + (ws.length ? (ws.length - 1) * line.rowH + line.barY + line.barH + 2 : 36)
  const ctx = newCtx(W, H)
  const dim = acc.stale || acc.status === "needs_login"
  drawAccountHead(ctx, acc, { plan: acc.plan, pills: statusPills(acc, { enabled }), dim }, W, "card")
  if (!ws.length) drawTextAt(ctx, acc.error || statusText(acc.status) || t("common.noData"), 0, head + 2, W, 32, Font.systemFont(13), p.sub)
  ws.forEach((w, i) => drawWindowLine(ctx, w, head + i * line.rowH, W, dim, "card"))
  return { image: ctx.getImage(), height: H }
}

// 상세 화면 맨 위 요약
function detailHeaderImage(acc, usage) {
  const W = cardWidth()
  const ctx = newCtx(W, HEAD_STYLE.detail.height)
  drawAccountHead(ctx, acc, { plan: usage.plan || acc.plan, pills: statusPills(usage, { enabled: acc.enabled }) }, W, "detail")
  return ctx.getImage()
}

// 상세 화면의 한도 한 줄. 막대 아래에는 초기화 날짜·시각을 적는다.
function windowRowImage(w, dim) {
  const p = pal()
  const W = cardWidth()
  const ctx = newCtx(W, 58)
  drawWindowLine(ctx, w, 0, W, dim, "detail")
  const date = !w.resets_at ? t("detail.noReset")
    : t(w.kind === "credit" ? "credit.oneTimeExpires" : "detail.resetAt", { date: fmtDate(w.resets_at) })
  drawTextAt(ctx, date, 0, 42, W, 16, Font.systemFont(11), p.sub)
  return ctx.getImage()
}

// 초기화권 남은 기간 배지. 하루 이상 남으면 일 단위로만 (예: 4일 남음), 3일 안이면 경고색.
function creditLeft(item) {
  const ms = item.expires_at ? new Date(item.expires_at).getTime() - Date.now() : null
  const left = fmtDuration(item.expires_at)
  const text = ms == null ? t("credit.noExpiry")
    : ms >= DAY_MS ? t("credit.daysLeft", { n: Math.floor(ms / DAY_MS) })
    : left ? t("credit.left", { t: left }) : t("credit.soon")
  return ms != null && ms < 3 * DAY_MS ? { text, color: C.warn } : { text, muted: true }
}

// 상세 화면의 초기화권 한 장
function resetCreditImage(item, index, provider) {
  const p = pal()
  const W = cardWidth()
  const ctx = newCtx(W, 58)
  const brand = brandHex(provider)
  // 왼쪽 번호 칩
  fillRound(ctx, new Rect(0, 11, 36, 36), 10, new Color(brand, p.dark ? 0.28 : 0.14))
  drawTextAt(ctx, String(index + 1), 0, 19, 36, 20, Font.boldSystemFont(16), new Color(brand), "center")
  const right = drawPills(ctx, [creditLeft(item)], W, 19)
  // 이름이 따로 없으면(Claude) 만료일을 제목으로
  const expires = item.expires_at ? t("credit.expires", { date: fmtDay(item.expires_at) }) : t("credit.noExpiry")
  const sub = [item.title && expires, item.granted_at && t("credit.granted", { date: fmtDay(item.granted_at) })].filter(Boolean).join("  ·  ")
  drawTextAt(ctx, item.title || expires, 48, sub ? 10 : 19, right - 52, 20, Font.semiboldSystemFont(15), p.text)
  if (sub) drawTextAt(ctx, sub, 48, 32, right - 52, 16, Font.systemFont(12), p.sub)
  return ctx.getImage()
}

// 서비스 고르기 줄의 로고. 표 칸은 이미지를 칸 크기에 맞춰 늘리므로,
// 오른쪽에 투명한 여백을 둔 그림을 만들어 로고는 작게, 이름과는 떨어지게 한다.
function providerRowLogo(provider) {
  const ctx = newCtx(34, 26)
  drawLogo(ctx, provider, 0, 1, 24)
  return ctx.getImage()
}

// ───────────────────────── 앱 UI: 연결 설정 ─────────────────────────
async function serverPage() {
  // 저장 전 값은 페이지 안에만 두고, 연결이 확인되면 저장한다
  const draft = { server: kcGet(KC_SERVER, ""), apiKey: kcGet(KC_KEY, "") }
  return openPage(t("server.title"), async (page) => {
    page.add(valueRow(t("server.address"), draft.server || t("common.enter"), page.run(async () => {
      const v = await prompt(t("server.addressPrompt"), t("server.addressExample"), { value: draft.server, placeholder: "https://" })
      if (v != null) draft.server = v.replace(/\/+$/, "")
    }), { valueWidth: 60 }))
    page.add(valueRow(t("server.apiKey"), draft.apiKey ? t("common.set") : t("common.enter"), page.run(async () => {
      const v = await prompt(t("server.apiKey"), t("server.apiKeyHelp"), { secure: true, value: draft.apiKey })
      if (v != null) draft.apiKey = v
    })))
    page.add(actionRow(t("server.save"), page.after(async () => {
      if (!draft.server || !draft.apiKey) throw new Error(t("server.missing"))
      await serverApi(draft, "GET", "/v1/accounts")
      Keychain.set(KC_SERVER, draft.server)
      Keychain.set(KC_KEY, draft.apiKey)
      setMode("server")
      return true
    }), ACCENT))
  })
}

async function antigravityPage() {
  await openPage(t("ag.title"), async (page) => {
    const cur = kcJSON(KC_AG_CLIENT, {})
    const save = (patch) => Keychain.set(KC_AG_CLIENT, JSON.stringify({ ...cur, ...patch }))
    page.add(noteRow(t("ag.help")))
    page.add(valueRow("Client ID", cur.id ? `${cur.id.slice(0, 12)}…` : t("common.enter"), page.run(async () => {
      const v = await prompt("Client ID", t("ag.idHelp"), { value: cur.id || "" })
      if (v != null) save({ id: v })
    })))
    page.add(valueRow("Client Secret", cur.secret ? t("common.set") : t("common.enter"), page.run(async () => {
      const v = await prompt("Client Secret", t("ag.secretHelp"), { secure: true, value: cur.secret || "" })
      if (v != null) save({ secret: v })
    })))
  })
  return !!agClient()
}

// ───────────────────────── 앱 UI: 계정 추가·로그인 ─────────────────────────
// 서비스를 고르면 이 페이지를 닫고 로그인 페이지로 간다. 로그인을 그만두면 다시 이 페이지로.
async function addAccountPage() {
  return openPage(t("add.title"), async (page) => {
    const { providers } = await api("GET", "/v1/providers")
    for (const p of providers) {
      page.add(providerRow(p.id, p.name, p.configured ? null : t("provider.needsSetup"), page.after(async () => {
        if (!p.configured) {
          if (!(getConfig().device && p.id === "antigravity")) throw new Error(p.reason)
          if (!(await antigravityPage())) return false
        }
        return (await loginPage(p.id)) || false
      })))
    }
  })
}

// 로그인·추가가 끝났을 때 앞 페이지에 띄우는 설명: 이름(이메일) · 상태
function loginDetail(acc) {
  const status = acc.status === "ok" ? "" : t("login.status", { status: statusText(acc.status) })
  return `${acc.label}${acc.email ? ` (${acc.email})` : ""}${status}`
}

// 새 계정 추가 또는 기존 계정 다시 로그인(accountId). 단계(방식 → 로그인 → 붙여넣기)마다 머리로 묶고,
// 끝난 단계에는 ✓ 를 붙인다. 이름은 마지막에 선택으로. 끝나면 계정을 돌려준다.
async function loginPage(provider, { accountId = null } = {}) {
  const st = { label: "", method: "oauth", login: null }
  const name = providerName(provider)

  const submitCode = async (input) => {
    if (!st.login) throw new Error(t("login.needOpenFirst"))
    try {
      return await api("POST", `/v1/logins/${st.login.login_id}/complete`, { input }, 60)
    } catch (e) {
      if (e.status === 404) st.login = null // 로그인 세션이 끝났으면 처음부터
      throw e
    }
  }

  return openPage(t(accountId ? "login.titleRelogin" : "login.titleAdd", { provider: name }), async (page) => {
    let n = 0
    const step = (key, done) => page.add(headerRow(`${++n}. ${t(key)}${done ? "  ✓" : ""}`))

    if (provider === "claude" && !accountId) {
      step("login.stepMethod")
      page.add(checkRow(t("login.oauth"), st.method === "oauth", page.run(() => (st.method = "oauth")), t("login.oauthDesc")))
      page.add(checkRow("sessionKey", st.method === "session_key", page.run(() => (st.method = "session_key")), t("login.skDesc")))
    }
    if (st.method === "session_key") {
      step("login.stepKey")
      page.add(noteRow(t("sk.help")))
      pasteRows(page, { pasteTitle: t("sk.paste"), promptTitle: "sessionKey", promptHint: t("sk.prompt"), secure: true,
        emptyMessage: t("sk.clipEmpty"),
        submit: (key) => api("POST", "/v1/accounts", { provider, session_key: key, label: st.label || undefined }, 60) })
    } else {
      step("login.stepLogin", !!st.login)
      page.add(actionRow(t(st.login ? "login.reopen" : "login.open"), page.run(async () => {
        if (!st.login) st.login = await api("POST", "/v1/logins", { provider, label: st.label || undefined, account_id: accountId || undefined })
        Safari.open(st.login.authorize_url)
      }), ACCENT, t(`login.openDesc.${provider}`)))
      step(provider === "claude" ? "login.stepCode" : "login.stepUrl")
      pasteRows(page, { pasteTitle: t("login.paste"), pasteHint: t(`login.pasteDesc.${provider}`), promptTitle: t("common.typeIn"),
        promptHint: t(`login.hint.${provider}`), emptyMessage: t("login.clipEmpty"), submit: submitCode })
    }
    if (!accountId) {
      page.add(headerRow(t("login.nameOptional")))
      page.add(valueRow(t("common.name"), st.label || t("login.nameDefault"), page.run(async () => {
        const v = await prompt(t("common.name"), t("login.namePrompt"), { value: st.label, placeholder: t("login.namePlaceholder") })
        if (v != null) st.label = v
      }), { valueWidth: 50 }))
    }
  })
}

// 기존 Claude 계정에 sessionKey 를 넣거나 바꾸거나 지운다.
// OAuth 가 없는 계정은 sessionKey 가 유일한 인증이라 지울 수 없다(canDelete).
// 저장하거나 지우면 닫히고 "saved" / "deleted" 를 돌려준다.
async function sessionKeyPage(accountId, { hasKey = false, canDelete = false } = {}) {
  return openPage("sessionKey", async (page) => {
    page.add(noteRow(t("sk.help")))
    pasteRows(page, { pasteTitle: t("sk.paste"), promptTitle: "sessionKey", promptHint: t("sk.prompt"), secure: true,
      emptyMessage: t("sk.clipEmpty"),
      submit: async (key) => {
        await api("PATCH", `/v1/accounts/${accountId}`, { session_key: key }, 60)
        return "saved"
      } })
    if (hasKey && canDelete) {
      page.add(actionRow(t("sk.delete"), page.after(async () => {
        if (!(await confirm(t("sk.delete"), null, t("common.delete"), true))) return false
        await api("PATCH", `/v1/accounts/${accountId}`, { session_key: "" })
        return "deleted"
      }), C.bad))
    }
  })
}

// ───────────────────────── 앱 UI: 계정 상세 ─────────────────────────
// 지우면 닫히고 { deleted: 이름 } 을 돌려준다
async function accountDetail(accountId) {
  // 맨 위 머리 이미지가 제목 역할을 한다
  return openPage(null, async (page) => {
    const { account: acc, usage } = await api("GET", `/v1/accounts/${accountId}`)
    usage.windows = visibleWindows({ ...usage, provider: acc.provider })
    const patch = (body, timeout) => api("PATCH", `/v1/accounts/${accountId}`, body, timeout)

    await measureTexts(measureItemsFor(acc, usage, "detail"))
    page.head(imageRow(detailHeaderImage(acc, usage), 80))

    const detail = usage.error || (usage.warnings || []).join(" / ") || null
    const color = usage.status === "ok" ? Color.gray() : usage.status === "partial" ? C.warn : C.bad
    const checked = t("detail.checked", { ago: fmtAgo(usage.fetched_at) })
    page.add(textRow(usage.status === "ok" ? checked : `${statusText(usage.status)}${usage.stale ? t("detail.stale") : ""}  ·  ${checked}`,
      detail, { height: detail ? 64 : 44, color, font: Font.systemFont(14) }))

    if ((usage.windows || []).length) {
      page.add(headerRow(t("detail.usage")))
      const dim = usage.stale || usage.status === "needs_login"
      for (const w of usage.windows) page.add(imageRow(windowRowImage(w, dim), 72))
    }

    // Antigravity 는 초기화권이 없으므로 섹션을 아예 표시하지 않는다
    if (acc.provider !== "antigravity") {
      const rc = usage.reset_credits
      const items = (rc && rc.items) || []
      page.add(headerRow(items.length ? t("detail.creditsN", { n: items.length }) : t("detail.credits")))
      if (items.length) items.forEach((item, i) => page.add(imageRow(resetCreditImage(item, i, acc.provider), 70)))
      else if (rc) page.add(textRow(t("detail.noCredits")))
      else if (acc.provider === "claude" && !acc.auth.session_key) page.add(textRow(t("detail.needSk"), null, { color: Color.gray() }))
      else page.add(textRow(t("detail.creditsFailed"), usage.error || (usage.warnings || []).join(" / ") || null))
    }

    const { extra_usage: eu, prepaid, credits: cr } = usage.extra || {}
    if (eu || prepaid) {
      page.add(headerRow(t("detail.usageCredits")))
      if (eu) {
        const spent = eu.limit != null
          ? t("detail.spentOf", { used: money(eu.used, eu.currency), limit: money(eu.limit, eu.currency), pct: fmtPct(eu.used_percent) })
          : t("detail.spent", { used: money(eu.used, eu.currency) })
        page.add(textRow(t("detail.extraUsage"), spent))
      }
      if (prepaid) page.add(valueRow(t("detail.prepaid"), money(prepaid.balance, prepaid.currency)))
    } else if (cr) {
      page.add(textRow(t("detail.creditBalance"), cr.unlimited ? t("detail.unlimited") : t("detail.balance", { n: cr.balance ?? "–" })))
    }

    page.add(headerRow(t("detail.manage")))
    page.add(actionRow(t("detail.refresh"), page.run(() => api("POST", `/v1/accounts/${accountId}/refresh`, undefined, 60)), ACCENT))
    page.add(valueRow(t("common.name"), acc.label, page.run(async () => {
      const label = await prompt(t("common.name"), null, { value: acc.label })
      if (label) await patch({ label })
    }), { valueWidth: 55 }))
    page.add(toggleRow(t("detail.showInWidget"), acc.enabled, page.run(() => patch({ enabled: !acc.enabled }))))
    const groups = windowGroups(usage)
    if (acc.provider === "antigravity" && groups.length > 1) {
      const cur = widgetGroupOf({ ...usage, id: accountId })
      const next = groups[(groups.indexOf(cur) + 1) % groups.length]
      page.add(valueRow(t("detail.widgetModel"), groupShort(cur), page.run(() => setWidgetGroup(accountId, next))))
    }
    // sessionKey 는 OAuth 로 초기화권을 못 받을 때만 필요하다
    if (acc.provider === "claude" && (acc.auth.session_key || !usage.reset_credits)) {
      page.add(valueRow("sessionKey", acc.auth.session_key ? t("common.saved") : t("common.none"), page.run(async () => {
        const done = await sessionKeyPage(accountId, { hasKey: !!acc.auth.session_key, canDelete: !!acc.auth.oauth })
        if (done) page.ok(t(done === "deleted" ? "common.didDelete" : "common.didSave"), "sessionKey")
      }), { subtitle: t("sk.rowDesc") }))
    }
    if (acc.provider !== "claude" || acc.auth.oauth || usage.status === "needs_login") {
      page.add(linkRow(t("detail.relogin"), page.run(async () => {
        const done = await loginPage(acc.provider, { accountId })
        if (done) page.ok(t("login.relogged"), loginDetail(done))
      })))
    }
    page.add(actionRow(t("detail.delete"), page.after(async () => {
      const where = t(getConfig().device ? "detail.whereDevice" : "detail.whereServer")
      if (!(await confirm(t("detail.delete"), t("detail.deleteConfirm", { name: acc.label, where }), t("common.delete"), true))) return false
      await api("DELETE", `/v1/accounts/${accountId}`)
      return { deleted: acc.label }
    }), C.bad))
  })
}

// ───────────────────────── 앱 UI: 설정 ─────────────────────────
async function settingsPage() {
  await openPage(() => t("settings.title"), async (page) => {
    const mode = getMode()
    page.add(headerRow(t("settings.connection")))
    page.add(checkRow(t("mode.device"), mode === "device", page.run(() => {
      if (mode === "device") return
      setMode("device")
      page.ok(t("mode.deviceSet"), t("mode.deviceSetDetail"))
    })))
    const server = mode === "server" ? kcGet(KC_SERVER, "").replace(/^https?:\/\//, "") : ""
    page.add(checkRow(t("mode.server"), mode === "server", page.run(async () => {
      if (await serverPage()) page.ok(t("mode.serverSet"))
    }), server || null))
    // 처음 넣는 건 계정 추가에서 물어본다. 여기서는 넣은 값을 바꿀 때만.
    if (mode === "device" && agClient()) page.add(linkRow(t("ag.title"), page.run(antigravityPage)))

    page.add(headerRow(t("settings.general")))
    page.add(valueRow(t("settings.notify"), t(notifySettings().enabled ? "common.on" : "common.off"), page.run(notifyPage)))
    page.add(valueRow(t("show.title"), t(showLeft() ? "show.left" : "show.used"), page.run(() => setShowLeft(!showLeft())), { valueWidth: 40 }))
    const setting = langSetting()
    page.add(valueRow(t("settings.language"), LANG_INFO[setting] ? LANG_INFO[setting].name : t("lang.auto"), page.run(languagePage), { valueWidth: 50 }))
    page.add(valueRow(t("settings.claudeLogo"), claudeLogo() === "clawd" ? "Clawd" : t("settings.logoDefault"), page.run(() => {
      setClaudeLogo(claudeLogo() === "clawd" ? "default" : "clawd")
      logoCache = {}
    })))
    page.add(linkRow(t("settings.preview"), page.run(widgetPreviewPage)))
    const latest = updateState().latest
    const fresh = isNewer(latest, VERSION)
    page.add(valueRow(t("settings.version", { v: VERSION }), fresh ? t("update.available", { v: latest }) : "›",
      page.run(updatePage), { color: fresh ? ACCENT : null, valueWidth: fresh ? 40 : 12 }))
  })
}

async function updatePage() {
  let state = updateState()
  let checking = true
  let started = false
  let installed = false
  await openPage(t("update.title"), async (page) => {
    // 들어오자마자 다시 확인하고, 끝나면 화면을 새로 그린다
    if (!started) {
      started = true
      checkUpdate(true)
        .then((next) => (state = next))
        .catch((e) => (page.notice = { title: t("common.error"), detail: e.message, color: C.bad }))
        .finally(() => {
          checking = false
          page.render()
        })
    }
    page.add(valueRow(t("update.current"), VERSION))
    page.add(valueRow(t("update.latest"), checking ? t("update.checking") : state.latest || "–", page.run(async () => {
      state = await checkUpdate(true)
    }), { subtitle: state.checked_at ? t("update.checkedAt", { ago: fmtAgo(isoOf(state.checked_at)) }) : null }))
    if (installed) return
    if (isNewer(state.latest, VERSION)) {
      page.add(actionRow(t("update.install", { v: state.latest }), page.run(async () => {
        const v = await installUpdate()
        installed = true
        page.ok(t("update.done", { v }), t("update.restart"))
      }), ACCENT))
    }
    const prev = backupVersion()
    if (prev) {
      page.add(actionRow(t("update.restore", { v: prev }), page.run(async () => {
        if (!(await confirm(t("update.restore", { v: prev }), t("update.restoreConfirm")))) return
        const v = restoreBackup()
        installed = true
        page.ok(t("update.restored", { v }), t("update.restart"))
      })))
    }
  })
}

async function languagePage() {
  await openPage(() => t("settings.language"), async (page) => {
    const cur = langSetting()
    const choose = (value) => page.run(() => setLang(value))
    page.add(checkRow(t("lang.auto"), !LANG_INFO[cur], choose("auto"), LANG_INFO[resolveLang("auto")].name))
    for (const code of LANG_CODES) page.add(checkRow(LANG_INFO[code].name, cur === code, choose(code)))
  })
}

async function notifyPage() {
  await openPage(t("settings.notify"), async (page) => {
    const cur = notifySettings()
    const save = (patch) => saveNotifySettings({ ...cur, ...patch })
    page.add(toggleRow(t("notify.receive"), cur.enabled, page.run(() => save({ enabled: !cur.enabled }))))
    if (!cur.enabled) return

    page.add(headerRow(t("notify.types")))
    for (const type of NOTIFY_TYPES) {
      const on = cur.types[type]
      const desc = STRINGS[`notify.${type}.desc`] ? t(`notify.${type}.desc`) : null // 이름만으로 알 수 있으면 설명 없음
      page.add(toggleRow(t(`notify.${type}.title`), on, page.run(() => save({ types: { ...cur.types, [type]: !on } })), desc))
    }

    page.add(headerRow(t("notify.threshold")))
    for (const v of [80, 90, 95]) page.add(checkRow(t("notify.thresholdRow", { n: v }), cur.threshold === v, page.run(() => save({ threshold: v }))))

    page.add(actionRow(t("notify.test"), page.run(async () => {
      await sendNotification({ id: "aiusage-test", title: "AI Usage", body: t("notify.test.body") })
      page.ok(t("notify.sent"), t("notify.sentDetail"))
    }), ACCENT))
  })
}

async function widgetPreviewPage() {
  await openPage(t("settings.preview"), async (page) => {
    for (const size of ["small", "medium", "large"]) {
      page.add(linkRow(t(`preview.${size}`), page.run(async () => {
        const w = buildHomeWidget(await loadUsage(false), size, "")
        await { small: () => w.presentSmall(), medium: () => w.presentMedium(), large: () => w.presentLarge() }[size]()
      })))
    }
    page.add(noteRow(t("preview.paramNote")))
  })
}

// ───────────────────────── 앱 UI: 메인 ─────────────────────────
async function mainMenu() {
  let refresh = false
  let checked = false
  await openPage("AI Usage", async (page) => {
    // 새 버전 확인은 화면을 늦추지 않게 따로 돌리고, 새 버전이 있으면 다시 그린다
    if (!checked) {
      checked = true
      const before = updateState().latest
      checkUpdate()
        .then((s) => s.latest !== before && isNewer(s.latest, VERSION) && page.render())
        .catch(() => {})
    }
    const latest = updateState().latest
    if (isNewer(latest, VERSION)) {
      page.add(bannerRow(t("update.banner", { v: latest }), page.run(updatePage)))
      markUpdateSeen(latest) // 봤으니 위젯이 따로 알리지 않는다
    }

    if (!getConfig()) {
      page.add(noteRow(t("main.intro")))
      page.add(headerRow(t("main.start")))
      page.add(linkRow(t("mode.device"), page.run(() => setMode("device")), t("main.startDeviceDesc")))
      page.add(linkRow(t("main.startServer"), page.run(serverPage), t("main.startServerDesc")))
      return
    }

    const doRefresh = refresh
    refresh = false
    let accounts = []
    const usage = {}
    try {
      const [acc, u] = await Promise.all([api("GET", "/v1/accounts"), loadUsage(doRefresh, { all: true })])
      accounts = acc.accounts
      for (const a of u.data.accounts) usage[a.id] = a
      if (u.offline) page.add(noticeRow({ title: t("main.cached"), detail: u.error, color: C.warn }))
      else await checkAlerts(u.data.accounts.filter((a) => a.enabled !== false)) // 알림은 위젯과 같은 계정만
    } catch (e) {
      page.add(noticeRow({ title: t(getConfig().device ? "common.loadFailed" : "main.serverFailed"), detail: e.message, color: C.bad }))
    }

    page.add(headerRow(t("main.accounts", { n: accounts.length })))
    if (!accounts.length) page.add(textRow(t("main.noAccounts"), null, { color: Color.gray() }))
    await measureTexts(accounts.flatMap((acc) => measureItemsFor(acc, usage[acc.id], "card")))
    for (const acc of accounts) {
      const u = usage[acc.id] || { ...acc, windows: [] }
      const card = accountCard({ ...acc, ...u, label: acc.label }, acc.enabled)
      const r = imageRow(card.image, card.height + 20)
      r.dismissOnSelect = false
      r.onSelect = page.run(async () => {
        const done = await accountDetail(acc.id)
        if (done && done.deleted) page.ok(t("common.didDelete"), done.deleted)
      })
      page.add(r)
    }

    page.add(headerRow(t("main.actions")))
    page.add(linkRow(t("add.title"), page.run(async () => {
      const acc = await addAccountPage()
      if (acc) page.ok(t("add.done"), loginDetail(acc))
    })))
    page.add(actionRow(t("main.refreshAll"), page.run(() => (refresh = true)), ACCENT))
    page.add(linkRow(t("settings.title"), page.run(settingsPage)))
  })
}

// ───────────────────────── 문구 (i18n) ─────────────────────────
// 한국어 · English · 日本語 · 简体中文. 설정 → 언어에서 고르거나 기기 언어를 따른다(지원하지 않는 언어는 영어).
// 서버가 내려주는 오류 문구는 서버 언어(한국어) 그대로다.
const LANG_CODES = ["ko", "en", "ja", "zh"]
const LANG_INFO = {
  ko: { name: "한국어", locale: "ko_KR", dateFormat: "M월 d일 (E) HH:mm" },
  en: { name: "English", locale: "en_US", dateFormat: "EEE, MMM d HH:mm" },
  ja: { name: "日本語", locale: "ja_JP", dateFormat: "M月d日(E) HH:mm" },
  zh: { name: "简体中文", locale: "zh_CN", dateFormat: "M月d日 (E) HH:mm" },
}

function langSetting() {
  return kcGet("aiusage.lang", "auto") // "auto" | LANG_CODES
}

function resolveLang(setting) {
  if (LANG_INFO[setting]) return setting
  try {
    const code = String(Device.language() || "").toLowerCase().slice(0, 2)
    return LANG_INFO[code] ? code : "en"
  } catch (e) {
    return "ko" // 기기 언어를 알 수 없으면(테스트 등) 원래 언어
  }
}

let LANG = resolveLang(langSetting())

function setLang(setting) {
  Keychain.set("aiusage.lang", setting)
  LANG = resolveLang(setting)
}

// 문구 하나를 현재 언어로. {이름} 자리에 vars 값을 넣는다. 번역이 없으면 영어 → 한국어 순으로 쓴다.
function t(key, vars = {}) {
  const row = STRINGS[key]
  if (!row) return key
  const own = row[LANG_CODES.indexOf(LANG)]
  const s = own != null ? own : row[1] != null ? row[1] : row[0]
  if (typeof s === "function") return s(vars)
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m))
}

// 서버·기기 모드가 만드는 한도 이름은 한국어가 기준이다. 화면에 낼 때 현재 언어로 바꾼다.
function localLabel(label) {
  if (LANG === "ko" || !label) return label
  let m
  if (label === "현재 세션") return t("win.session")
  if (label === "이번 주") return t("win.week")
  if (label === "주간") return t("win.weekly")
  if (label === "추가 한도") return t("win.extra")
  if (label === "모델별") return t("win.byModel")
  if (label === "Claude Code·Cowork 크레딧") return t("win.coworkCredit")
  if ((m = label.match(/^(\d+)시간$/))) return t("dur.h", { n: m[1] })
  if ((m = label.match(/^(\d+)일$/))) return t("dur.d", { n: m[1] })
  if ((m = label.match(/^(.+) 이번 주$/))) return t("win.modelWeek", { model: m[1] })
  return label
}

// [한국어, English, 日本語, 简体中文]
const STRINGS = {
  // 공통
  "common.ok": ["확인", "OK", "OK", "确定"],
  "common.cancel": ["취소", "Cancel", "キャンセル", "取消"],
  "common.delete": ["삭제", "Delete", "削除", "删除"],
  "common.on": ["켜짐", "On", "オン", "开"],
  "common.off": ["꺼짐", "Off", "オフ", "关"],
  "common.enter": ["입력", "Enter", "入力", "输入"],
  "common.set": ["입력됨", "Set", "設定済み", "已设置"],
  "common.none": ["없음", "None", "なし", "无"],
  "common.saved": ["있음", "Saved", "あり", "已保存"],
  "common.typeIn": ["직접 입력", "Type it in", "直接入力", "手动输入"],
  "common.name": ["이름", "Name", "名前", "名称"],
  "common.error": ["문제가 생겼어요", "Something went wrong", "問題が発生しました", "出错了"],
  "common.loadFailed": ["불러오지 못했어요", "Couldn't load", "読み込めませんでした", "加载失败"],
  "common.noData": ["데이터 없음", "No data", "データなし", "暂无数据"],
  "common.didSave": ["저장했어요", "Saved", "保存しました", "已保存"],
  "common.didDelete": ["삭제했어요", "Deleted", "削除しました", "已删除"],

  // 상태
  "status.ok": ["정상", "OK", "正常", "正常"],
  "status.partial": ["일부 실패", "Partly failed", "一部失敗", "部分失败"],
  "status.needs_login": ["재로그인 필요", "Sign-in needed", "再ログインが必要", "需要重新登录"],
  "status.error": ["오류", "Error", "エラー", "错误"],
  "status.blocked": ["차단됨", "Blocked", "ブロック中", "被拦截"],
  "status.rate_limited": ["요청 한도 초과", "Rate limited", "リクエスト制限", "请求过多"],
  "status.pending": ["대기 중", "Pending", "待機中", "等待中"],
  "pill.credits": ["초기화권 {n}", (v) => `${v.n} reset${v.n == 1 ? "" : "s"}`, "リセット券 {n}", "重置券 {n}"],
  "pill.relogin": ["재로그인", "Sign in", "再ログイン", "需重新登录"],
  "pill.partial": ["일부 실패", "Partial", "一部失敗", "部分失败"],
  "pill.hidden": ["숨김", "Hidden", "非表示", "已隐藏"],
  "pill.offline": ["오프라인", "Offline", "オフライン", "离线"],

  // 시간
  "dur.d": ["{n}일", "{n}d", "{n}日", "{n}天"],
  "dur.h": ["{n}시간", "{n}h", "{n}時間", "{n}小时"],
  "dur.m": ["{n}분", "{n}m", "{n}分", "{n}分钟"],
  "dur.sep": [" ", " ", "", ""],
  "reset.in": ["{t} 후 초기화", "Resets in {t}", "{t}後にリセット", "{t}后重置"],
  "reset.inShort": ["{t} 후", "in {t}", "{t}後", "{t}后"],
  "reset.soon": ["곧 초기화", "Resets soon", "まもなくリセット", "即将重置"],
  "ago.now": ["방금", "just now", "たった今", "刚刚"],
  "ago.m": ["{n}분 전", "{n}m ago", "{n}分前", "{n}分钟前"],
  "ago.h": ["{n}시간 전", "{n}h ago", "{n}時間前", "{n}小时前"],
  "ago.d": ["{n}일 전", "{n}d ago", "{n}日前", "{n}天前"],
  "date.md": ["{m}월 {d}일", "{mon} {d}", "{m}月{d}日", "{m}月{d}日"],

  // 한도 이름
  "win.session": ["현재 세션", "Current session", "現在のセッション", "当前会话"],
  "win.week": ["이번 주", "This week", "今週", "本周"],
  "win.modelWeek": ["{model} 이번 주", "{model} this week", "{model} 今週", "{model} 本周"],
  "win.weekly": ["주간", "Weekly", "週間", "每周"],
  "win.extra": ["추가 한도", "Extra limit", "追加枠", "额外额度"],
  "win.coworkCredit": ["Claude Code·Cowork 크레딧", "Claude Code & Cowork credit", "Claude Code・Cowork クレジット", "Claude Code·Cowork 额度"],
  "win.byModel": ["모델별", "By model", "モデル別", "按模型"],

  // 위젯
  "widget.empty": ["표시할 계정이 없어요. 앱에서 추가해 주세요.", "No accounts to show. Add one in the app.", "表示するアカウントがありません。アプリで追加してください。", "没有可显示的账号。请在应用中添加。"],
  "widget.updated": ["{ago} 확인", "Updated {ago}", "更新: {ago}", "{ago}更新"],
  "widget.more": ["+{n}개 더", "+{n} more", "他 {n} 件", "还有 {n} 个"],
  "widget.setup": ["앱에서 한 번 실행해 연결 방식을 골라 주세요.", "Open the script in the app once to set it up.", "アプリで一度実行して接続方法を選んでください。", "请先在应用中运行一次并选择连接方式。"],
  "widget.loadFailed": ["불러오지 못했어요. {msg}", "Couldn't load. {msg}", "読み込めませんでした。{msg}", "加载失败。{msg}"],

  // 알림
  "notify.high.title": ["사용량 경고", "Usage warning", "使用量の警告", "用量警告"],
  "notify.reset.title": ["초기화 알림", "Reset", "リセット", "重置提醒"],
  "notify.reset.desc": ["기준을 넘긴 한도가 초기화될 때", "When a limit that passed the threshold resets", "しきい値を超えた上限がリセットされたとき", "超过阈值的额度重置时"],
  "notify.early.title": ["조기 초기화 감지", "Early reset", "早期リセットの検知", "提前重置"],
  "notify.early.desc": ["예정보다 일찍 초기화됐을 때", "When a limit resets earlier than scheduled", "予定より早くリセットされたとき", "比预定时间更早重置时"],
  "notify.login.title": ["재로그인 필요", "Sign-in needed", "再ログインが必要", "需要重新登录"],
  "notify.credit.title": ["초기화권 만료 임박", "Reset credit expiring", "リセット券の期限が近い", "重置券即将过期"],
  "notify.update.title": ["업데이트", "Updates", "アップデート", "更新"],
  "notify.credit.desc": ["초기화권이 하루 안에 만료될 때", "When a reset credit expires within a day", "リセット券が1日以内に期限切れになるとき", "重置券将在一天内过期时"],
  "notify.login.body": ["로그인이 만료됐어요. 다시 로그인해 주세요.", "Your sign-in expired. Please sign in again.", "ログインの有効期限が切れました。再ログインしてください。", "登录已过期，请重新登录。"],
  "notify.early.body": ["{name} 한도가 예정보다 일찍 초기화됐어요. ({from}% → {to}%)", "{name} reset earlier than scheduled. ({from}% → {to}%)",
    "{name} が予定より早くリセットされました。({from}% → {to}%)", "{name} 比预定时间更早重置了。({from}% → {to}%)"],
  "notify.high.body": ["{name} 사용량이 {pct}%예요.", "{name} is at {pct}%.", "{name} の使用量が {pct}% です。", "{name} 已用 {pct}%。"],
  "notify.high.resetIn": [" {t} 후 초기화돼요.", " Resets in {t}.", " {t}後にリセットされます。", " {t}后重置。"],
  "notify.high.resetSoon": [" 곧 초기화돼요.", " Resets soon.", " まもなくリセットされます。", " 即将重置。"],
  "notify.reset.body": ["{name} 한도가 초기화됐어요.", "{name} has reset.", "{name} がリセットされました。", "{name} 已重置。"],
  "notify.credit.body": ["초기화권 1장이 {t} 뒤에 만료돼요.", "A reset credit expires in {t}.", "リセット券が {t}後に期限切れになります。", "一张重置券将在 {t}后过期。"],
  "notify.test.body": ["테스트 알림이에요.", "This is a test notification.", "テスト通知です。", "这是一条测试通知。"],

  // 서버 연결
  "server.title": ["서버 연결", "Server", "サーバー接続", "服务器连接"],
  "server.address": ["주소", "Address", "アドレス", "地址"],
  "server.addressPrompt": ["서버 주소", "Server address", "サーバーアドレス", "服务器地址"],
  "server.addressExample": ["예) https://ai.example.com", "e.g. https://ai.example.com", "例) https://ai.example.com", "例如 https://ai.example.com"],
  "server.apiKey": ["API 키", "API key", "API キー", "API 密钥"],
  "server.apiKeyHelp": ["서버에 설정한 AIUSAGE_API_KEY 값이에요.", "The AIUSAGE_API_KEY value set on your server.",
    "サーバーに設定した AIUSAGE_API_KEY の値です。", "服务器上设置的 AIUSAGE_API_KEY 值。"],
  "server.save": ["연결 확인하고 저장", "Test connection and save", "接続を確認して保存", "测试连接并保存"],
  "server.missing": ["주소와 API 키를 모두 넣어 주세요.", "Enter both the address and the API key.", "アドレスと API キーを両方入力してください。", "请填写地址和 API 密钥。"],
  "server.connected": ["연결됐어요", "Connected", "接続しました", "已连接"],

  // Antigravity 로그인 설정
  "ag.title": ["Antigravity 로그인 설정", "Antigravity sign-in setup", "Antigravity ログイン設定", "Antigravity 登录设置"],
  "ag.help": ["Antigravity 앱의 resources/app/out/main.js 에 들어 있는 값이에요.", "Both values are in resources/app/out/main.js of the Antigravity app.", "どちらも Antigravity アプリの resources/app/out/main.js にあります。", "两个值都在 Antigravity 应用的 resources/app/out/main.js 中。"],
  "ag.idHelp": ["….apps.googleusercontent.com 으로 끝나는 값이에요.", "Ends with ….apps.googleusercontent.com.",
    "….apps.googleusercontent.com で終わる値です。", "以 ….apps.googleusercontent.com 结尾。"],
  "ag.secretHelp": ["GOCSPX- 로 시작하는 값이에요.", "Starts with GOCSPX-.", "GOCSPX- で始まる値です。", "以 GOCSPX- 开头。"],

  // 계정 추가·로그인
  "add.title": ["계정 추가", "Add account", "アカウントを追加", "添加账号"],
  "add.done": ["계정을 추가했어요", "Account added", "アカウントを追加しました", "已添加账号"],
  "provider.needsSetup": ["설정이 필요해요", "Needs setup", "設定が必要です", "需要设置"],
  "login.stepMethod": ["로그인 방식", "Method", "ログイン方法", "登录方式"],
  "login.stepLogin": ["로그인", "Sign in", "ログイン", "登录"],
  "login.stepCode": ["코드 붙여넣기", "Paste the code", "コードを貼り付け", "粘贴代码"],
  "login.stepUrl": ["주소 붙여넣기", "Paste the URL", "URL を貼り付け", "粘贴网址"],
  "login.stepKey": ["sessionKey 붙여넣기", "Paste the sessionKey", "sessionKey を貼り付け", "粘贴 sessionKey"],
  "login.reopen": ["로그인 페이지 다시 열기", "Open sign-in page again", "ログインページをもう一度開く", "重新打开登录页面"],
  "login.openDesc.claude": ["로그인하고 승인하면 코드가 나와요", "Sign in and approve to get a code", "ログインして承認するとコードが表示されます", "登录并授权后会显示代码"],
  "login.openDesc.codex": ["ChatGPT 계정으로 로그인", "Sign in with your ChatGPT account", "ChatGPT アカウントでログイン", "使用 ChatGPT 账号登录"],
  "login.openDesc.antigravity": ["Antigravity에서 쓰는 Google 계정으로 로그인", "Sign in with the Google account you use in Antigravity", "Antigravity で使う Google アカウントでログイン", "使用 Antigravity 的 Google 账号登录"],
  "login.pasteDesc.claude": ["'Copy Code'로 복사한 코드", "The code copied with 'Copy Code'", "'Copy Code' でコピーしたコード", "用 'Copy Code' 复制的代码"],
  "login.pasteDesc.codex": ["로그인 후 열리지 않는 화면의 주소 전체", "The full URL of the page that won't load after sign-in", "ログイン後に開けない画面の URL 全体", "登录后无法打开的页面的完整网址"],
  "login.pasteDesc.antigravity": ["로그인 후 열리지 않는 화면의 주소 전체", "The full URL of the page that won't load after sign-in", "ログイン後に開けない画面の URL 全体", "登录后无法打开的页面的完整网址"],
  "login.nameOptional": ["이름 (선택)", "Name (optional)", "名前（任意）", "名称（可选）"],
  "login.titleAdd": ["{provider} 계정 추가", "Add {provider} account", "{provider} アカウントを追加", "添加 {provider} 账号"],
  "login.titleRelogin": ["{provider} 다시 로그인", "Sign in to {provider} again", "{provider} に再ログイン", "重新登录 {provider}"],
  "login.hint.claude": ["복사한 코드 (code#state 형식)", "The copied code (code#state)", "コピーしたコード (code#state 形式)", "复制的代码（code#state 格式）"],
  "login.hint.codex": ["localhost:1455 로 시작하는 주소 전체", "The full URL starting with localhost:1455", "localhost:1455 で始まる URL 全体", "以 localhost:1455 开头的完整网址"],
  "login.hint.antigravity": ["127.0.0.1:8585 로 시작하는 주소 전체", "The full URL starting with 127.0.0.1:8585", "127.0.0.1:8585 で始まる URL 全体", "以 127.0.0.1:8585 开头的完整网址"],
  "login.relogged": ["다시 로그인했어요", "Signed in again", "再ログインしました", "已重新登录"],
  "login.status": [" · 상태: {status}", " · Status: {status}", " · 状態: {status}", " · 状态：{status}"],
  "login.needOpenFirst": ["먼저 로그인 페이지를 열어 로그인해 주세요.", "Open the sign-in page and sign in first.", "先にログインページを開いてログインしてください。", "请先打开登录页面并登录。"],
  "login.clipEmpty": ["클립보드가 비어 있어요. 로그인 페이지에서 다시 복사해 주세요.", "The clipboard is empty. Copy it again from the sign-in page.",
    "クリップボードが空です。ログインページでもう一度コピーしてください。", "剪贴板为空。请在登录页面重新复制。"],
  "login.nameDefault": ["이메일 앞부분", "Email prefix", "メールの前半", "邮箱前缀"],
  "login.namePrompt": ["비워 두면 이메일 앞부분을 써요.", "Leave empty to use the part of the email before @.",
    "空欄ならメールアドレスの @ より前を使います。", "留空则使用邮箱 @ 前的部分。"],
  "login.namePlaceholder": ["예) 개인", "e.g. Personal", "例) 個人", "例如 个人"],
  "login.oauth": ["OAuth 로그인 (추천)", "OAuth sign-in (recommended)", "OAuth ログイン（おすすめ）", "OAuth 登录（推荐）"],
  "login.oauthDesc": ["사용량·플랜 (초기화권은 나중에 sessionKey로)", "Usage and plan (reset credits later via sessionKey)", "使用量・プラン（リセット券は後で sessionKey で）", "用量和套餐（重置券之后用 sessionKey）"],
  "login.skDesc": ["사용량·초기화권 (claude.ai 쿠키 필요)", "Usage and reset credits (needs a claude.ai cookie)", "使用量・リセット券（claude.ai の Cookie が必要）", "用量和重置券（需要 claude.ai Cookie）"],
  "login.open": ["로그인 페이지 열기", "Open sign-in page", "ログインページを開く", "打开登录页面"],
  "login.paste": ["복사한 값 붙여넣기", "Paste from clipboard", "コピーした値を貼り付け", "粘贴剪贴板内容"],

  // sessionKey
  "sk.help": ["PC 브라우저로 claude.ai에 로그인한 뒤 개발자 도구 → Application → Cookies → claude.ai 에서 sessionKey 값(sk-ant-…)을 복사하세요.", "Sign in to claude.ai in a desktop browser, then copy the sessionKey value (sk-ant-…) from Developer Tools → Application → Cookies → claude.ai.", "PC のブラウザで claude.ai にログインし、開発者ツール → Application → Cookies → claude.ai から sessionKey の値 (sk-ant-…) をコピーしてください。", "在电脑浏览器登录 claude.ai，然后在开发者工具 → Application → Cookies → claude.ai 中复制 sessionKey 的值（sk-ant-…）。"],
  "sk.paste": ["복사한 sessionKey 붙여넣기", "Paste copied sessionKey", "コピーした sessionKey を貼り付け", "粘贴复制的 sessionKey"],
  "sk.prompt": ["sk-ant- 로 시작하는 값이에요.", "Starts with sk-ant-.", "sk-ant- で始まる値です。", "以 sk-ant- 开头。"],
  "sk.clipEmpty": ["클립보드가 비어 있어요. sessionKey를 다시 복사해 주세요.", "The clipboard is empty. Copy the sessionKey again.",
    "クリップボードが空です。sessionKey をもう一度コピーしてください。", "剪贴板为空。请重新复制 sessionKey。"],
  "sk.delete": ["sessionKey 삭제", "Delete sessionKey", "sessionKey を削除", "删除 sessionKey"],
  "sk.rowDesc": ["초기화권을 확인할 때 써요", "Used to check reset credits", "リセット券の確認に使います", "用于查看重置券"],

  // 계정 화면
  "detail.resetAt": ["{date} 초기화", "Resets {date}", "{date} にリセット", "{date} 重置"],
  "detail.noReset": ["초기화 시각 정보 없음", "No reset time", "リセット時刻の情報なし", "无重置时间信息"],
  "detail.stale": [" · 이전에 받은 값", " · Last known value", " · 前回の値", " · 上次获取的值"],
  "detail.checked": ["{ago} 확인", "Checked {ago}", "確認: {ago}", "{ago}检查"],
  "detail.usage": ["사용량", "Usage", "使用量", "用量"],
  "detail.credits": ["초기화권", "Reset credits", "リセット券", "重置券"],
  "detail.creditsN": ["초기화권 {n}개", "Reset credits ({n})", "リセット券 {n}枚", "重置券 {n} 张"],
  "detail.noCredits": ["지금 쓸 수 있는 초기화권이 없어요", "No reset credits available right now", "今使えるリセット券はありません", "目前没有可用的重置券"],
  "detail.needSk": ["sessionKey가 있어야 확인할 수 있어요", "A sessionKey is needed to check", "確認には sessionKey が必要です", "需要 sessionKey 才能查看"],
  "detail.creditsFailed": ["확인하지 못했어요", "Couldn't check", "確認できませんでした", "无法查询"],
  "detail.usageCredits": ["사용 크레딧", "Usage credits", "利用クレジット", "用量积分"],
  "detail.spentOf": ["{used} / {limit} 사용 ({pct})", "{used} of {limit} used ({pct})", "{used} / {limit} 使用（{pct}）", "已用 {used} / {limit}（{pct}）"],
  "detail.spent": ["{used} 사용 (한도 없음)", "{used} used (no limit)", "{used} 使用（上限なし）", "已用 {used}（无上限）"],
  "detail.prepaid": ["선불 잔액", "Prepaid balance", "前払い残高", "预付余额"],
  "detail.extraUsage": ["추가 사용량", "Extra usage", "追加使用量", "额外用量"],
  "detail.creditBalance": ["크레딧", "Credits", "クレジット", "积分"],
  "detail.unlimited": ["무제한", "Unlimited", "無制限", "无限"],
  "detail.balance": ["잔액 {n}", "Balance {n}", "残高 {n}", "余额 {n}"],
  "detail.manage": ["관리", "Manage", "管理", "管理"],
  "detail.refresh": ["지금 새로고침", "Refresh now", "今すぐ更新", "立即刷新"],
  "detail.showInWidget": ["위젯에 표시", "Show in widget", "ウィジェットに表示", "在小组件中显示"],
  "detail.widgetModel": ["위젯에 보일 모델", "Widget shows", "ウィジェットに表示", "小组件显示"],
  "detail.relogin": ["다시 로그인", "Sign in again", "再ログイン", "重新登录"],
  "detail.delete": ["계정 삭제", "Delete account", "アカウントを削除", "删除账号"],
  "detail.deleteConfirm": ["{name} 계정과 로그인 정보를 {where}에서 지울까요?", "Delete {name} and its sign-in data from {where}?",
    "{name} とログイン情報を{where}から削除しますか？", "要从{where}删除 {name} 及其登录信息吗？"],
  "detail.whereDevice": ["이 iPhone", "this iPhone", "この iPhone", "此 iPhone"],
  "detail.whereServer": ["서버", "the server", "サーバー", "服务器"],
  "credit.noExpiry": ["만료 없음", "No expiry", "期限なし", "无期限"],
  "credit.daysLeft": ["{n}일 남음", "{n}d left", "残り{n}日", "剩 {n} 天"],
  "credit.left": ["{t} 남음", "{t} left", "残り{t}", "剩 {t}"],
  "credit.expiresIn": ["{t} 후 만료", "Expires in {t}", "{t}後に期限切れ", "{t}后过期"],
  "credit.oneTimeExpires": ["일회성 · {date} 만료", "One-time · expires {date}", "1回限り · {date} 期限", "一次性 · {date} 过期"],
  "credit.soon": ["곧 만료", "Expiring", "まもなく期限切れ", "即将过期"],
  "credit.expires": ["{date} 만료", "Expires {date}", "{date} 期限", "{date} 过期"],
  "credit.granted": ["{date} 지급", "Granted {date}", "{date} 付与", "{date} 发放"],

  // 설정
  "show.title": ["퍼센트 표시", "Percent shows", "パーセント表示", "百分比显示"],
  "show.used": ["사용한 양", "Used", "使用量", "已用"],
  "show.left": ["남은 양", "Remaining", "残り", "剩余"],
  "settings.title": ["설정", "Settings", "設定", "设置"],
  "settings.general": ["일반", "General", "一般", "通用"],
  "settings.connection": ["연결 방식", "Connection", "接続方法", "连接方式"],
  "settings.notify": ["알림", "Notifications", "通知", "通知"],
  "settings.preview": ["위젯 미리보기", "Widget preview", "ウィジェットのプレビュー", "小组件预览"],
  "settings.claudeLogo": ["Claude 로고", "Claude logo", "Claude ロゴ", "Claude 图标"],
  "settings.logoDefault": ["기본", "Default", "標準", "默认"],
  "settings.language": ["언어", "Language", "言語", "语言"],
  "settings.version": ["버전 {v}", "Version {v}", "バージョン {v}", "版本 {v}"],
  "lang.auto": ["기기 설정 따르기", "Use device language", "端末の言語に合わせる", "跟随系统"],

  // 업데이트
  "update.title": ["업데이트", "Updates", "アップデート", "更新"],
  "update.current": ["현재 버전", "Current version", "現在のバージョン", "当前版本"],
  "update.latest": ["최신 버전", "Latest version", "最新バージョン", "最新版本"],
  "update.checking": ["확인 중…", "Checking…", "確認中…", "正在检查…"],
  "update.checkedAt": ["{ago} 확인", "Checked {ago}", "確認: {ago}", "{ago}检查"],
  "update.available": ["{v} 있음", "{v} available", "{v} あり", "有 {v}"],
  "update.banner": ["새 버전이 나왔어요 ({v})", "Version {v} is available", "新しいバージョン {v} があります", "有新版本 {v}"],
  "update.install": ["지금 업데이트 ({v})", "Update now ({v})", "今すぐアップデート ({v})", "立即更新（{v}）"],
  "update.done": ["업데이트했어요 ({v})", "Updated to {v}", "{v} にアップデートしました", "已更新到 {v}"],
  "update.restart": ["스크립트를 닫고 다시 실행하면 적용돼요.", "Close and run the script again to apply it.",
    "スクリプトを閉じてもう一度実行すると反映されます。", "关闭并重新运行脚本即可生效。"],
  "update.restore": ["이전 버전으로 되돌리기 ({v})", "Restore previous version ({v})", "前のバージョンに戻す ({v})", "恢复上一版本（{v}）"],
  "update.restoreConfirm": ["업데이트하기 전 버전으로 되돌릴까요?", "Go back to the version from before the update?",
    "アップデート前のバージョンに戻しますか？", "要恢复到更新前的版本吗？"],
  "update.restored": ["되돌렸어요 ({v})", "Restored {v}", "{v} に戻しました", "已恢复到 {v}"],
  "update.fetchFailed": ["새 버전을 받지 못했어요 (HTTP {status})", "Couldn't download the update (HTTP {status})",
    "アップデートをダウンロードできませんでした (HTTP {status})", "无法下载更新（HTTP {status}）"],
  "update.invalid": ["받은 파일이 올바른 스크립트가 아니에요. 잠시 뒤 다시 시도해 주세요.", "The download isn't a valid script. Please try again later.",
    "ダウンロードしたファイルが正しいスクリプトではありません。しばらくしてからもう一度お試しください。", "下载的文件不是有效的脚本。请稍后再试。"],
  "mode.device": ["이 iPhone에서 직접", "Directly on this iPhone", "この iPhone で直接", "直接在此 iPhone 上"],
  "mode.deviceSet": ["이 iPhone에서 직접 가져와요", "Now fetching on this iPhone", "この iPhone で直接取得します", "现在直接在此 iPhone 上获取"],
  "mode.deviceSetDetail": ["계정 목록은 방식마다 따로예요.", "Each mode keeps its own account list.", "アカウント一覧は方法ごとに別です。", "每种方式的账号列表是分开的。"],
  "mode.server": ["내 서버", "My server", "自分のサーバー", "我的服务器"],
  "mode.serverSet": ["서버에 연결했어요", "Connected to the server", "サーバーに接続しました", "已连接到服务器"],

  // 알림 설정
  "notify.receive": ["알림 받기", "Allow notifications", "通知を受け取る", "接收通知"],
  "notify.types": ["받을 알림", "Notify me about", "受け取る通知", "通知类型"],
  "notify.threshold": ["경고 기준", "Warning threshold", "警告のしきい値", "警告阈值"],
  "notify.thresholdRow": ["{n}% 이상", "{n}% or more", "{n}% 以上", "{n}% 及以上"],
  "notify.test": ["테스트 알림 보내기", "Send a test notification", "テスト通知を送る", "发送测试通知"],
  "notify.sent": ["보냈어요", "Sent", "送信しました", "已发送"],
  "notify.sentDetail": ["알림이 오지 않으면 iPhone 설정 → 앱 → Scriptable → 알림을 확인해 주세요.",
    "If nothing arrives, check iPhone Settings → Apps → Scriptable → Notifications.",
    "届かない場合は iPhone の設定 → アプリ → Scriptable → 通知 を確認してください。", "如果没有收到，请检查 iPhone 设置 → App → Scriptable → 通知。"],

  // 위젯 미리보기
  "preview.small": ["소형", "Small", "小", "小"],
  "preview.medium": ["중형", "Medium", "中", "中"],
  "preview.large": ["대형", "Large", "大", "大"],
  "preview.paramNote": ["위젯 편집 → Parameter에 계정 이름을 쉼표로 적으면 그 계정만 보여요 (예: 개인,회사)", "Edit Widget → enter account names separated by commas in Parameter to show only those (e.g. Personal,Work)", "ウィジェットを編集 → Parameter にアカウント名をカンマ区切りで入れると、そのアカウントだけ表示します（例: 個人,仕事）", "编辑小组件 → 在 Parameter 中用逗号分隔填写账号名称，即可只显示这些账号（例如 个人,工作）"],

  // 메인
  "main.intro": ["사용량을 어디서 가져올지 골라 주세요. 설정에서 언제든 바꿀 수 있어요.", "Choose where to get usage from. You can change it any time in Settings.", "使用量の取得先を選んでください。設定からいつでも変更できます。", "请选择从哪里获取用量。之后可随时在设置中更改。"],
  "main.start": ["시작하기", "Get started", "はじめる", "开始使用"],
  "main.startDeviceDesc": ["로그인 정보는 이 iPhone의 키체인에만 저장돼요", "Sign-in data stays in this iPhone's Keychain", "ログイン情報はこの iPhone のキーチェーンにだけ保存されます", "登录信息仅保存在此 iPhone 的钥匙串中"],
  "main.startServer": ["내 서버에 연결", "Connect to my server", "自分のサーバーに接続", "连接到我的服务器"],
  "main.startServerDesc": ["직접 띄운 서버의 주소와 API 키가 필요해요", "Needs your server's address and API key", "自分のサーバーのアドレスと API キーが必要です", "需要你的服务器地址和 API 密钥"],
  "main.cached": ["마지막으로 받은 값이에요", "Showing the last values received", "最後に取得した値です", "显示的是上次获取的数据"],
  "main.serverFailed": ["서버에 연결하지 못했어요", "Couldn't reach the server", "サーバーに接続できませんでした", "无法连接到服务器"],
  "main.accounts": ["계정 ({n})", "Accounts ({n})", "アカウント ({n})", "账号 ({n})"],
  "main.noAccounts": ["아직 계정이 없어요", "No accounts yet", "まだアカウントがありません", "还没有账号"],
  "main.actions": ["작업", "Actions", "操作", "操作"],
  "main.refreshAll": ["전체 새로고침", "Refresh all", "すべて更新", "全部刷新"],

  // 기기 모드 오류
  "err.network": ["네트워크 오류: {msg}", "Network error: {msg}", "ネットワークエラー: {msg}", "网络错误：{msg}"],
  "err.json": ["응답을 읽지 못했어요: {text}", "Couldn't read the response: {text}", "応答を読み取れませんでした: {text}", "无法解析响应：{text}"],
  "err.auth": ["{what}: 인증 실패(HTTP {status})", "{what}: authentication failed (HTTP {status})", "{what}: 認証に失敗しました (HTTP {status})", "{what}：认证失败（HTTP {status}）"],
  "err.rateLimited": ["{what}: 요청 한도 초과(429)", "{what}: rate limited (429)", "{what}: リクエスト制限 (429)", "{what}：请求过多（429）"],
  "err.blocked": ["{what}: Cloudflare 챌린지로 차단됨", "{what}: blocked by a Cloudflare challenge", "{what}: Cloudflare のチャレンジでブロックされました", "{what}：被 Cloudflare 验证拦截"],
  "err.emptyInput": ["입력이 비어 있어요.", "The input is empty.", "入力が空です。", "输入为空。"],
  "err.loginDenied": ["로그인이 거부됐거나 실패했어요: {error}", "Sign-in was denied or failed: {error}", "ログインが拒否されたか失敗しました: {error}", "登录被拒绝或失败：{error}"],
  "err.noCode": ["URL에 code 값이 없어요. 주소창의 주소를 통째로 복사했는지 확인해 주세요.", "The URL has no code. Make sure you copied the whole URL from the address bar.",
    "URL に code がありません。アドレスバーの URL を丸ごとコピーしたか確認してください。", "网址中没有 code。请确认复制了地址栏中的完整网址。"],
  "err.state": ["state 값이 맞지 않아요. 로그인을 처음부터 다시 해 주세요.", "The state doesn't match. Please start the sign-in again.",
    "state の値が一致しません。最初からログインし直してください。", "state 不匹配。请重新开始登录。"],
  "err.noAccessToken": ["토큰 응답에 access_token이 없어요.", "The token response has no access_token.", "トークン応答に access_token がありません。", "令牌响应中没有 access_token。"],
  "err.noOrgs": ["claude.ai 조직 목록이 비어 있어요.", "The claude.ai organization list is empty.", "claude.ai の組織一覧が空です。", "claude.ai 组织列表为空。"],
  "err.tokenExchange": ["토큰 교환 실패: HTTP {status} {text}", "Token exchange failed: HTTP {status} {text}", "トークン交換に失敗: HTTP {status} {text}", "令牌交换失败：HTTP {status} {text}"],
  "err.skPrefix": ["sessionKey는 'sk-ant-'로 시작해야 해요.", "The sessionKey must start with 'sk-ant-'.", "sessionKey は 'sk-ant-' で始まる必要があります。", "sessionKey 必须以 'sk-ant-' 开头。"],
  "err.noRefresh": ["리프레시 토큰이 없어요. 다시 로그인해 주세요.", "No refresh token. Please sign in again.", "リフレッシュトークンがありません。再ログインしてください。", "没有刷新令牌。请重新登录。"],
  "err.refreshDenied": ["토큰 갱신이 거부됐어요(HTTP {status}). 다시 로그인해 주세요.", "Token refresh was rejected (HTTP {status}). Please sign in again.",
    "トークンの更新が拒否されました (HTTP {status})。再ログインしてください。", "令牌刷新被拒绝（HTTP {status}）。请重新登录。"],
  "err.agClient": ["설정 → Antigravity 로그인 설정에서 Client ID와 Secret을 먼저 넣어 주세요.", "Enter the Client ID and Secret first in Settings → Antigravity sign-in setup.",
    "先に 設定 → Antigravity ログイン設定 で Client ID と Secret を入力してください。", "请先在 设置 → Antigravity 登录设置 中填写 Client ID 和 Secret。"],
  "err.agAuth": ["Antigravity 인증 실패(401)", "Antigravity authentication failed (401)", "Antigravity の認証に失敗しました (401)", "Antigravity 认证失败（401）"],
  "err.forbidden": ["{method}: 권한 없음(403) {text}", "{method}: forbidden (403) {text}", "{method}: 権限がありません (403) {text}", "{method}：无权限（403）{text}"],
  "err.noGoogleRefresh": ["refresh_token을 받지 못했어요. Google 계정 설정에서 앱 연결을 해제한 뒤 다시 시도해 주세요.",
    "No refresh_token was returned. Remove the app's access in your Google account settings and try again.",
    "refresh_token を受け取れませんでした。Google アカウントの設定でアプリの連携を解除してから再試行してください。",
    "未获得 refresh_token。请在 Google 账号设置中移除该应用的访问权限后重试。"],
  "err.noAccount": ["계정이 없어요.", "Account not found.", "アカウントがありません。", "账号不存在。"],
  "err.noCreds": ["저장된 로그인 정보가 없어요. 다시 로그인해 주세요.", "No saved sign-in data. Please sign in again.", "保存されたログイン情報がありません。再ログインしてください。", "没有已保存的登录信息。请重新登录。"],
  "err.unknownProvider": ["알 수 없는 서비스: {id}", "Unknown service: {id}", "不明なサービス: {id}", "未知服务：{id}"],
  "err.loginExpired": ["로그인 세션이 없거나 만료됐어요. 처음부터 다시 해 주세요.", "The sign-in session is missing or expired. Please start again.",
    "ログインセッションがないか期限切れです。最初からやり直してください。", "登录会话不存在或已过期。请重新开始。"],
  "err.skClaudeOnly": ["sessionKey는 Claude 계정에만 넣을 수 있어요.", "A sessionKey can only be set on Claude accounts.", "sessionKey は Claude アカウントにのみ設定できます。", "只有 Claude 账号可以设置 sessionKey。"],
  "err.skCantRemove": ["OAuth 로그인이 없는 계정에서는 sessionKey를 지울 수 없어요.", "Can't remove the sessionKey from an account without OAuth sign-in.",
    "OAuth ログインのないアカウントでは sessionKey を削除できません。", "没有 OAuth 登录的账号不能删除 sessionKey。"],
  "err.unsupported": ["지원하지 않는 요청: {route}", "Unsupported request: {route}", "未対応のリクエスト: {route}", "不支持的请求：{route}"],
  "err.noMode": ["연결 방식을 먼저 정해 주세요.", "Choose how to connect first.", "先に接続方法を選んでください。", "请先选择连接方式。"],
  "err.server": ["서버에 연결하지 못했어요: {msg}", "Couldn't reach the server: {msg}", "サーバーに接続できませんでした: {msg}", "无法连接到服务器：{msg}"],
  "warn.skExpired": ["sessionKey 만료: {msg}", "sessionKey expired: {msg}", "sessionKey の期限切れ: {msg}", "sessionKey 已过期：{msg}"],
  "warn.creditsFailed": ["초기화권 조회 실패: {msg}", "Couldn't fetch reset credits: {msg}", "リセット券の取得に失敗: {msg}", "获取重置券失败：{msg}"],
  "warn.noCreditsInfo": ["claude.ai 응답에 초기화권 정보가 없어요", "The claude.ai response has no reset credit info", "claude.ai の応答にリセット券の情報がありません", "claude.ai 的响应中没有重置券信息"],
  "warn.summaryFallback": ["요약 조회 실패, 모델별 조회로 대체: {msg}", "Summary failed, used per-model data instead: {msg}",
    "概要の取得に失敗したため、モデル別の取得で代替: {msg}", "获取概要失败，已改用按模型查询：{msg}"],
  "what.claudeOrg": ["claude.ai 조직 조회", "claude.ai organizations", "claude.ai 組織の取得", "claude.ai 组织查询"],
  "what.claudeWeb": ["claude.ai 사용량", "claude.ai usage", "claude.ai 使用量", "claude.ai 用量"],
  "what.claudeRefresh": ["Claude 토큰 갱신", "Claude token refresh", "Claude トークン更新", "Claude 令牌刷新"],
  "what.claudeUsage": ["Claude 사용량", "Claude usage", "Claude 使用量", "Claude 用量"],
  "what.codexRefresh": ["Codex 토큰 갱신", "Codex token refresh", "Codex トークン更新", "Codex 令牌刷新"],
  "what.codexUsage": ["Codex 사용량", "Codex usage", "Codex 使用量", "Codex 用量"],
  "what.codexCredits": ["Codex 초기화권", "Codex reset credits", "Codex リセット券", "Codex 重置券"],
  "what.googleRefresh": ["Google 토큰 갱신", "Google token refresh", "Google トークン更新", "Google 令牌刷新"],
}

// ───────────────────────── 로고 (LobeHub Icons, MIT) ─────────────────────────
const LOGOS = {
  claude: "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",
  codex: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAKqklEQVR4nNSbCdRVVRXH/2qtNINEQ4FExDJxyNQsSa2wNFEjKwobrL4sKy2KrNXEKjGzcmUDpEWDYrayNEPLxGiQzAZtEjOsNO0TLCIlw8SypNw/zrt63n7n3Om9D5f/tfZa755z7v3u2WfP+36P0MhhH6PpRocaTTTaweixRquNbje62egio4uN/qWHCJtpsBht9HqjNxjtVvOee4y+avQxoz9oE2OQDHiN0XyFU26LxUYnGP1NmwiDYMBjjC4wOrJkzR0Koo+o72L0uJK1rHu+0a+jsW2NJigwd23neXdoAOiXAWx+qdGBiblLFU4UHV/n5sYq2IdZCptN4UyjPY32U1qq1htdaPQNo8vUEv0y4MdGB7mxRUYfNvqj6uGJCvr/QrXHn43eZ3SeGqIfBnza6C1ujBP9uprjqQqSMlH9YbnR69StPqVoywA2eoEbO9joJ2qGcUYfMRrKzP/V6EdGNxptUPAyuFPswTTl8VaFA6pEWwbgx2ND9goFV9YEiOxco0cn5v5k9A4FqciB+55n9DalmXGu0WtVgc3VHLi7ePNIQpPNH6VgH05T7+bvUtg4nuLiiucQP1xidIjRSxWkJcaQ0QcqntFKAr5rdFh0PdlouMZ9uxqd5e6NcY7Ru9XevaEW3zba142/WCXMbMqArRQ4XwAX9JKKe3BhpyiIagp4EnT2WvUPJOpKo/2jsVVGO+VuaKoCL3DX36pYf7yCuKc2f5vRy42eqcFsHnA4M9StDniWt+duqCsBRXz/NDeeE38CGOzCk5XGPKPTjf6tahygwKQbjJaoHjDKX4muCa13SC2sYsCrjD6kvAiNMro7MU64um1i/HwFPb9N1ZikkFscHY390uhEo1/UuP9Wdb930k3nVGB7o+8rRFZZ/VF687urd/PXdl7glare/NYKHmJY3ZsH6PbPjT5vtF3Fcz7jro9OLUoxgDz+N0bPTcytz/yO8Sh3jZEjnq8TJCFxNynECGU4vrPuTSVrLnLXh6YWeQaMV9Azry+4EfL766KxnPr48Z+qGoTC1yhI3PjE/O8SY2OMPqsgXQck5im4rIyuJyXW9DDgMvcCwwqGD19KOBpvri4DyuwMqna2gm4/PTFPgYRobw8F1fpeYg0Se3XnOWPdXKxuqGVP1Bkz4CR1BxGEu4d1Xq7A/zO/VTKeW0fER8h7XGLuTqPZRlP04KZ/r8CMmQqn63FcZ3x2NObtzQR/U8EAkpLTonHydzZfN6VtAvz0LUZnKJ0HEC2SIp+ZuX9xZ/496g7KAF5pgYINI03/r5v36x9gAIHKltE4MfR1GiwIhS9XCJ4mV6zdoGoQR5AznJOYI/7A+M5w43/xC2EA4e2bo7F/Gn1BaWzm7q0DUthPKNiQ6TXW8y6I8gk11q5RyP+xA9dk/naBG1MPYBNkZ6OiMfLoOmXqnG57o4erSoWiGLjpHfLVYHw8fnyFyvP+AkjrVKNj1ZsVFkjFLBsZMM2NXa56aFtLIErEUBEuL+3Qnp2xv7u1WP9lClWmHasfvTH8fYLRqeo9RGKRHrsCA57hxoaVR3zq/6uxxuNTnRfkRWI939AZQ6fnJ+4j4ySrm6duW5UChg4bRtziDxP1mhsPwIBx0fV9CgXGHOrYgJRkUCF+koIqrFMezM3prE1Vek9W0OWXqRowDCP4HTdObrNfccEmxkSTJBBlJ9hGAhYqpNE3qT5YS7k8ZYxJb8k0qRU+peI5SBZB3DI3vqD4AQPuiyb+o3K0kYC71R53lcyRIlP9JTEqa7RgC2a6ZxEjvIgfbCIW+e1Vjvh0t6yxBuQkpQ18XsH7kxgRUc4puY/I8oNubE7xgFXRIO5nfMmD/OZm1lhTplJNgRF7tkL9PwYdqk8aXW+0c+bez6nb/jzLaAIM8JnWNOXxD3dNykmsPiUaa5IMtQG6T85CAHS7m9tLoSuVAqroexmzYMA33eBRyuPCxBh5NkzEjZFxjaQExCAEJqRe6Mb3KrlnsbueCgOuUAh/C1C1mZR5APk6Fv3WxBziSfI05MYHLQExKMr4kHmLkvVXu+udCkv+NTdxuvLApyPyqaYDLtVXgEeSAQXW1Px769zaiQUD2Ezsro5RyL1zoJpLuIlPPl8PL6yNfu9YMIAEYq5bSBnsIJWDggMqg2W+IbMGm3KwmgM/f6Sao8rmxInfmjiYITqKS04UKwhH91E1sMwkNPQOUgnNVQptqz1qPIs1SzrP3F2DR9yCX+OjOaKjuOZOW4uiY2Hhq0DoSkJzVmIOSSC9XaT0dwATO3OsOULtUWYD/JcsKzwDsKrk5yvdOBae+LxOkQJDw4cTuKMfJuaHOs8n69uuQ/M7Y0PqH2Uq4Bm7LMctYux9M3PoOs3MH6geSGWp/6VcK8ziHUYn5n6lEOjEVSTeaXliLTasKOUjQblYgFpkXI6bnEtocpsH6ChdIwKoXVQNokXc5smJOVTMbx43RYWXLtAKNUfuUOlvxpvHzgynGOBzAcrilyTWERBRuyP03FrlwG2SjBxYsY7aIbWARWqPlAogfT62QSqTKe027powF+NIyJtyde9VyMaGlAceZZ7yXSKCKypF9ArKUuA68BKA8V6ibiNOpWhjjSDFAF+xKb7RQ+dxdXRn73Rr6MhwakiLb1NRvaHomVIBDCs6jjTdosGD9J4PJmL3izS+sbhIMcDXzse5a/pxNCYWJu6lx0e8/SWjwxUaolRvfEGTU36Xgrgv1ciAaBbp9QaRzT9QAsgZwdXR710T8wQ7uEQaEFcm5l+tUItL6TxZXPFxZBVGqzk4dcrk5Dc+duGTvPPigRwD4n4gCU4ulP2tQv0AMV+pciANRJWpPD4Fii3Hqh5ivac8tndiDbaqp+2eY4C3+seoHBQaKEOnMkR89JACE+u027Az2Bvc51ZuLsfkslIe91D6/2hqMucz4aI/Jb4UWaVqoO8YPFSHeAHXdk+N+4gIcZUnZuYJx2er3rsW+LjR+1XS6SqLm7+sbhGs80lcW1BDgGljEnPDCq373Ld+SNZV0TVJFO+Oa12jCpQxgJPENT0yGkPET9XgwGc4nOyUxBx5CUEWp3hvyTOYPym6frwSXeAcyjq85PoL3BgiWlZ+rguCHtrkqEhq85wgKgQD7q14VlyZJn+ovXmwecX8O9Xr5ig/f1HV4W8KRauc2uGMxDwboMuLG11d43nYizjJOlcNUadeh17+TL3/BEXEiITQman69I3wGnsyT+nP29BVKlJnqz6IPlfowe+CKHVRU2j0H2h1C5akmlR09s/MU0TB6JBGk65i9QmSiMIol80qeTY6jAFcr/qgK4Wxi79cPUWBwY3QpGKLT0Y3Z2owgGF0i29ueB9dIGKEw6Mxcg3C8CZM3IgtGqyliUpjhK+14Pw2ag9Uhpy/6f8JYjAxnFOjMaQNb9LI+BWoMoIpEPXtrOC7r6h5j//aDBdLHw+d37vG/eQUMJ/kJi6UklQdofSHlLUwqKYFwQg6v1uHEEVOhBOmcsSJU1fMffrGBgh/17pxojy+8U19HsPzSaWvVx/YFF2bGBhEvvcZq/5ARkddcp36RBsV6AfEFKTCZ6gdiBMOUfi/pb43Dza1BMQguSK3eI5Cr35UZh0ZJL0JOruXasB4KBngQXiMgcOG8I9TbHy5Rhj3AwAA//9U1hhvAAAABklEQVQDAFqzHWP+HZgfAAAAAElFTkSuQmCC",
  codexWhite: "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",
  clawd: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAdUlEQVR42u3YsQnAIBBAUbd0lMyaaUxaSXWKIV7eByuFw9cIliJJkiRJenYete28AAAAAAAAAAAAlgHcR7r1woVC8wAAAAAAAIDE7/w0KAAAAAAAAPBjAP8BAAAAAAAAAAAAgyDR/a/PAwAAAAAAACRJkqT0XWH5g0dTSJtfAAAAAElFTkSuQmCC",
  antigravity: "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",
}

// ───────────────────────── 진입점 ─────────────────────────
if (config.runsInWidget || config.runsInAccessoryWidget) {
  await runWidget()
} else {
  await mainMenu()
}
Script.complete()
