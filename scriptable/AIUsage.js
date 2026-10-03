// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-purple; icon-glyph: tachometer-alt;

// AI 사용량 위젯 — Claude / Codex / Antigravity
// 서버: https://github.com/tmmmzk/scriptable-ai-usage
//
// • 앱에서 실행하면 설정·계정 관리 화면이 열립니다.
// • 위젯 Parameter 에 계정 이름(또는 id)을 쉼표로 적으면 그 계정만 표시합니다. 예) 개인,회사
// • 서버 없이 디자인만 보려면 앱에서 '데모 모드'를 켜거나, 위젯 Parameter 에 demo 를 적으세요.

const VERSION = "0.1.0"
const KC_SERVER = "aiusage.server"
const KC_KEY = "aiusage.apikey"
const CACHE_FILE = "aiusage-cache.json"
const WIDGET_REFRESH_MIN = 15

const PROVIDER_STYLE = {
  claude: { color: "#D97757", short: "Claude", abbr: "CL" },
  codex: { color: "#10A37F", short: "Codex", abbr: "CX" },
  antigravity: { color: "#4285F4", short: "Antigravity", abbr: "AG" },
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
// 데모 모드: 서버 없이 가짜 데이터로 위젯·앱 UI 를 확인한다.
// 앱 첫 화면에서 켜거나, 위젯 Parameter 에 `demo` 를 적으면 그 위젯만 데모로 그린다.
const KC_DEMO = "aiusage.demo"
let FORCE_DEMO = false

function isDemo() {
  return FORCE_DEMO || (Keychain.contains(KC_DEMO) && Keychain.get(KC_DEMO) === "1")
}

function setDemo(on) {
  if (on) Keychain.set(KC_DEMO, "1")
  else if (Keychain.contains(KC_DEMO)) Keychain.remove(KC_DEMO)
}

function getConfig() {
  if (isDemo()) return { server: "데모 모드", apiKey: "demo", demo: true }
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

// ── 데모용 가짜 서버 (상태는 기기 로컬 파일에 저장) ──
const DEMO_FILE = "aiusage-demo.json"
const H = 3600
const D = 86400

function demoWin(key, label, used, resetIn, opts = {}) {
  return { key, label, group: opts.group || null, used_percent: used, remaining_percent: used == null ? null : 100 - used,
    reset_in: resetIn, window_seconds: opts.seconds || null, primary: !!opts.primary }
}

function demoSeed() {
  return [
    { id: "claude_demo1", provider: "claude", label: "개인", email: "me@example.com", plan: "max", enabled: true,
      status: "ok", auth: { oauth: true, session_key: true, reset_credits_supported: true },
      windows: [demoWin("session", "5시간", 42, 2 * H + 13 * 60, { primary: true, seconds: 5 * H }),
        demoWin("weekly", "주간", 68, 3 * D + 11 * H, { primary: true, seconds: 7 * D }),
        demoWin("weekly_opus", "Opus 주간", 23, 3 * D + 11 * H, { seconds: 7 * D })],
      reset_credits: { available: 2, expires_in: [5 * D, 12 * D] },
      extra: { extra_usage: { used: 12.4, limit: 50, used_percent: 24.8, currency: "USD" } } },
    { id: "codex_demo1", provider: "codex", label: "회사", email: "work@example.com", plan: "plus", enabled: true,
      status: "ok", auth: { oauth: true, reset_credits_supported: true },
      windows: [demoWin("session", "5시간", 93, 47 * 60, { primary: true, seconds: 5 * H }),
        demoWin("weekly", "주간", 77, 5 * D + 2 * H, { primary: true, seconds: 7 * D }),
        demoWin("spark:session", "5시간", 4, 47 * 60, { group: "GPT-5.3-Codex-Spark", seconds: 5 * H })],
      reset_credits: { available: 1, expires_in: [20 * D] }, extra: { credits: { unlimited: false, balance: 3.5 } } },
    { id: "ag_demo1", provider: "antigravity", label: "구글", email: "me@gmail.com", plan: "Paid", enabled: true,
      status: "partial", warnings: ["요약 조회 실패, 모델별 조회로 대체"], auth: { oauth: true, reset_credits_supported: false },
      windows: [demoWin("gemini:5h", "5시간", 55, 3 * H, { group: "Gemini Models", primary: true, seconds: 5 * H }),
        demoWin("gemini:wk", "주간", 31, 6 * D, { group: "Gemini Models", seconds: 7 * D }),
        demoWin("claude_gpt:5h", "5시간", 12, 3 * H, { group: "Claude and GPT models", primary: true, seconds: 5 * H })],
      reset_credits: null, extra: {} },
    { id: "claude_demo2", provider: "claude", label: "부계정", email: "alt@example.com", plan: "pro", enabled: true,
      status: "needs_login", stale: true, error: "토큰 갱신 거부(HTTP 400). 다시 로그인하세요.",
      auth: { oauth: true, session_key: false, reset_credits_supported: false },
      windows: [demoWin("session", "5시간", 8, 4 * H, { primary: true, seconds: 5 * H }),
        demoWin("weekly", "주간", 15, 6 * D, { primary: true, seconds: 7 * D })],
      reset_credits: null, extra: {} },
  ]
}

function demoLoad() {
  const p = fm.joinPath(fm.documentsDirectory(), DEMO_FILE)
  try {
    if (fm.fileExists(p)) return JSON.parse(fm.readString(p))
  } catch (e) {}
  return { accounts: demoSeed(), updated: Date.now() }
}

function demoSave(state) {
  fm.writeString(fm.joinPath(fm.documentsDirectory(), DEMO_FILE), JSON.stringify(state))
}

function demoReset() {
  const p = fm.joinPath(fm.documentsDirectory(), DEMO_FILE)
  if (fm.fileExists(p)) fm.remove(p)
}

const PROVIDER_NAMES = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" }

function demoUsage(a, updated) {
  const at = (sec) => (sec == null ? null : new Date(updated + sec * 1000).toISOString())
  const ts = new Date(updated).toISOString()
  return {
    id: a.id, provider: a.provider, provider_name: PROVIDER_NAMES[a.provider], label: a.label, email: a.email,
    plan: a.plan, status: a.status, error: a.error || null, warnings: a.warnings || [], stale: !!a.stale,
    fetched_at: ts, last_success_at: a.stale ? new Date(updated - 2 * D * 1000).toISOString() : ts,
    windows: a.windows.map((w) => ({ ...w, resets_at: at(w.reset_in) })),
    reset_credits: a.reset_credits && {
      available: a.reset_credits.available,
      next_expires_at: at(a.reset_credits.expires_in[0]),
      expirations: a.reset_credits.expires_in.map(at),
      items: a.reset_credits.expires_in.map((e, i) => ({
        title: a.provider === "codex" ? "Rate limit reset" : null,
        description: null,
        reset_type: null,
        granted_at: at(e - 30 * D + i * D),
        expires_at: at(e),
      })),
    },
    extra: a.extra || {},
  }
}

function demoAccount(a, updated) {
  const u = demoUsage(a, updated)
  return { id: a.id, provider: a.provider, provider_name: u.provider_name, label: a.label, email: a.email, plan: a.plan,
    enabled: a.enabled, auth: a.auth, status: a.status, error: u.error, fetched_at: u.fetched_at,
    last_success_at: u.last_success_at }
}

function demoNewAccount(provider, label) {
  const n = Math.floor(Math.random() * 1000)
  const rnd = () => Math.round(Math.random() * 90)
  const base = { id: `${provider}_demo${n}`, provider, label: label || `${PROVIDER_NAMES[provider]} ${n}`,
    email: `demo${n}@example.com`, plan: null, enabled: true, status: "ok", extra: {} }
  if (provider === "antigravity") {
    return { ...base, auth: { oauth: true, reset_credits_supported: false }, reset_credits: null,
      windows: [demoWin("gemini:5h", "5시간", rnd(), 2 * H, { group: "Gemini Models", primary: true, seconds: 5 * H }),
        demoWin("claude_gpt:5h", "5시간", rnd(), 2 * H, { group: "Claude and GPT models", primary: true, seconds: 5 * H })] }
  }
  return { ...base, auth: { oauth: true, session_key: false, reset_credits_supported: provider === "codex" },
    reset_credits: provider === "codex" ? { available: 0, expires_in: [] } : null,
    windows: [demoWin("session", "5시간", rnd(), 3 * H, { primary: true, seconds: 5 * H }),
      demoWin("weekly", "주간", rnd(), 4 * D, { primary: true, seconds: 7 * D })] }
}

async function demoApi(method, path, body) {
  const state = demoLoad()
  const { accounts } = state
  const find = (id) => {
    const a = accounts.find((x) => x.id === id)
    if (!a) throw new ApiError("계정이 없습니다.", 404)
    return a
  }
  const save = () => demoSave(state)
  const route = `${method} ${path.split("?")[0]}`
  let m

  if (route === "GET /v1/usage") {
    if (path.includes("refresh=1")) {
      state.updated = Date.now()
      save()
    }
    return { generated_at: new Date(state.updated).toISOString(), poll_interval: 300,
      accounts: accounts.filter((a) => a.enabled).map((a) => demoUsage(a, state.updated)) }
  }
  if (route === "GET /v1/providers") {
    return { providers: [
      { id: "claude", name: "Claude", methods: ["oauth", "session_key"], configured: true, reason: null },
      { id: "codex", name: "Codex", methods: ["oauth"], configured: true, reason: null },
      { id: "antigravity", name: "Antigravity", methods: ["oauth"], configured: true, reason: null },
    ] }
  }
  if (route === "GET /v1/accounts") return { accounts: accounts.map((a) => demoAccount(a, state.updated)) }
  if (route === "POST /v1/accounts") {
    if (!String(body.session_key || "").startsWith("sk-ant-")) throw new ApiError("sessionKey 는 'sk-ant-' 로 시작해야 합니다.", 400)
    const a = demoNewAccount("claude", body.label)
    a.auth = { oauth: false, session_key: true, reset_credits_supported: true }
    a.reset_credits = { available: 1, expires_in: [9 * D] }
    accounts.push(a)
    save()
    return demoAccount(a, state.updated)
  }
  if (route === "POST /v1/logins") {
    const loginId = `demo${Date.now()}`
    state.logins = state.logins || {}
    state.logins[loginId] = { provider: body.provider, label: body.label, accountId: body.account_id }
    save()
    return { login_id: loginId, provider: body.provider, authorize_url: null,
      instructions: "데모 모드에서는 실제 로그인 페이지를 열지 않습니다.",
      input_hint: "아무 값이나 입력하면 로그인된 것으로 처리합니다." }
  }
  if ((m = route.match(/^POST \/v1\/logins\/([\w-]+)\/complete$/))) {
    const pending = (state.logins || {})[m[1]]
    if (!pending) throw new ApiError("로그인 세션이 없거나 만료되었습니다.", 400)
    delete state.logins[m[1]]
    const { provider, label, accountId } = pending
    if (accountId) {
      const a = find(accountId)
      Object.assign(a, { status: "ok", stale: false, error: null })
      save()
      return demoAccount(a, state.updated)
    }
    const a = demoNewAccount(provider, label)
    accounts.push(a)
    save()
    return demoAccount(a, state.updated)
  }
  if ((m = route.match(/^GET \/v1\/accounts\/([\w-]+)$/))) {
    const a = find(m[1])
    return { account: demoAccount(a, state.updated), usage: demoUsage(a, state.updated) }
  }
  if ((m = route.match(/^PATCH \/v1\/accounts\/([\w-]+)$/))) {
    const a = find(m[1])
    if (body.label) a.label = body.label
    if ("enabled" in body) a.enabled = !!body.enabled
    if ("session_key" in body) {
      a.auth.session_key = !!body.session_key
      a.auth.reset_credits_supported = !!body.session_key
      a.reset_credits = body.session_key ? { available: 1, expires_in: [7 * D] } : null
    }
    save()
    return demoAccount(a, state.updated)
  }
  if ((m = route.match(/^DELETE \/v1\/accounts\/([\w-]+)$/))) {
    find(m[1])
    state.accounts = accounts.filter((a) => a.id !== m[1])
    save()
    return { deleted: m[1] }
  }
  if ((m = route.match(/^POST \/v1\/accounts\/([\w-]+)\/refresh$/))) {
    const a = find(m[1])
    for (const w of a.windows) w.used_percent = Math.min(100, Math.round((w.used_percent || 0) + Math.random() * 5))
    save()
    return demoUsage(a, state.updated)
  }
  throw new ApiError(`데모에서 지원하지 않는 요청: ${route}`, 404)
}

async function api(method, path, body, timeout = 25) {
  const cfg = getConfig()
  if (!cfg) throw new ApiError("서버 설정이 필요합니다.", 0)
  if (cfg.demo) return demoApi(method, path, body || {})
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
    throw new ApiError(`서버에 연결할 수 없습니다: ${e.message || e}`, 0)
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
    if (!isDemo()) writeCache(data)
    return { data, offline: false }
  } catch (e) {
    const cached = readCache()
    if (cached) return { data: cached, offline: true, error: e.message }
    throw e
  }
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

function fmtUntil(iso, compact = false) {
  if (!iso) return ""
  const ms = new Date(iso).getTime() - Date.now()
  if (isNaN(ms)) return ""
  if (ms <= 0) return compact ? "곧" : "곧 초기화"
  const m = Math.floor(ms / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return compact ? `${d}일${h ? ` ${h}h` : ""}` : `${d}일 ${h}시간`
  if (h > 0) return compact ? `${h}h${mm ? ` ${mm}m` : ""}` : `${h}시간${mm ? ` ${mm}분` : ""}`
  return compact ? `${mm}m` : `${mm}분`
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
  if (!iso) return "만료 없음"
  const df = new DateFormatter()
  df.locale = "ko_KR"
  df.dateFormat = "M월 d일 HH:mm"
  return df.string(new Date(iso))
}

// "Claude (me@example.com)"
function providerLine(acc) {
  const name = PROVIDER_NAMES[acc.provider] || acc.provider_name || acc.provider
  return acc.email ? `${name} (${acc.email})` : name
}

const PLAN_NAMES = {
  free: "Free", plus: "Plus", pro: "Pro", max: "Max", team: "Team", business: "Business",
  enterprise: "Enterprise", edu: "Edu", paid: "Paid", workspace: "Workspace", legacy: "Legacy",
  default_claude_max_5x: "Max 5x", default_claude_max_20x: "Max 20x", claude_max: "Max", claude_pro: "Pro",
}

function planLabel(plan) {
  if (!plan) return null
  const key = String(plan).toLowerCase().trim()
  if (PLAN_NAMES[key]) return PLAN_NAMES[key]
  const m = key.match(/max[_ ]?(\d+)x/)
  if (m) return `Max ${m[1]}x`
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function windowTitle(w) {
  if (!w.group) return w.label
  const g = w.group.split(/\s+/)[0]
  return `${g} ${w.label}`
}

function primaryWindows(acc, n = 2) {
  const ws = acc.windows || []
  const prim = ws.filter((w) => w.primary)
  return (prim.length ? prim : ws).slice(0, n)
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

function widgetSize(family) {
  const w = Math.round(Math.min(Device.screenSize().width, Device.screenSize().height))
  const s = WIDGET_SIZES[w] || { small: Math.round(w * 0.4), medium: Math.round(w * 0.86), large: Math.round(w * 0.9) }
  if (family === "small") return { w: s.small, h: s.small }
  if (family === "large" || family === "extraLarge") return { w: s.medium, h: s.large }
  return { w: s.medium, h: s.small }
}

const LAYOUT = {
  small: { pad: 14, accounts: 1, gap: 0 },
  medium: { pad: 16, accounts: 2, gap: 14 },
  large: { pad: 16, accounts: 4, gap: 16 },
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
function logoImage(provider) {
  const key = logoKey(provider)
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
  const ctx = new DrawContext()
  ctx.size = new Size(width, height)
  ctx.opaque = false
  ctx.respectScreenScale = true
  const r = height / 2
  const track = new Path()
  track.addRoundedRect(new Rect(0, 0, width, height), r, r)
  ctx.addPath(track)
  ctx.setFillColor(C.track)
  ctx.fillPath()
  if (pct != null && pct > 0) {
    const w = Math.max(height, (width * Math.min(100, pct)) / 100)
    const fill = new Path()
    fill.addRoundedRect(new Rect(0, 0, w, height), r, r)
    ctx.addPath(fill)
    ctx.setFillColor(color)
    ctx.fillPath()
  }
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
  addText(pill, text, Font.semiboldSystemFont(10.5), color || C.text)
  return pill
}

function accountHeader(stack, acc, opts) {
  const row = stack.addStack()
  row.layoutHorizontally()
  row.centerAlignContent()
  row.size = new Size(opts.width, 18)
  const style = PROVIDER_STYLE[acc.provider] || { short: acc.provider }
  addLogo(row, acc.provider, opts.logo)
  row.addSpacer(6)
  addText(row, acc.label || style.short, Font.semiboldSystemFont(14), C.text, {
    minScale: 0.7,
    opacity: opts.dim ? 0.55 : 1,
  })
  if (opts.showProvider) {
    row.addSpacer(6)
    addText(row, style.short, Font.systemFont(11), C.sub, { minScale: 0.8 })
  }
  row.addSpacer()
  const rc = acc.reset_credits
  if (rc && rc.available > 0) addPill(row, `초기화권 ${rc.available}`)
  if (acc.status === "needs_login") {
    row.addSpacer(4)
    addPill(row, "재로그인", C.bad)
  } else if (acc.status === "partial") {
    row.addSpacer(4)
    addPill(row, "일부 실패", C.warn)
  } else if (acc.status !== "ok" && acc.status !== "pending") {
    row.addSpacer(4)
    addPill(row, STATUS_TEXT[acc.status] || "오류", C.bad)
  }
  if (opts.extraPill) {
    row.addSpacer(4)
    addPill(row, opts.extraPill, C.warn)
  }
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
  const until = fmtUntil(w.resets_at, true)
  addText(top, windowTitle(w), Font.systemFont(11), C.sub, { minScale: 0.7 })
  top.addSpacer()
  if (until) {
    addText(top, until, Font.systemFont(11), C.sub, { minScale: 0.7, opacity: 0.7 })
    top.addSpacer(5)
  }
  const pctColorFor = dim || w.used_percent == null || w.used_percent < 70 ? C.text : pctColor(w.used_percent)
  addText(top, fmtPct(w.used_percent), Font.semiboldSystemFont(12), pctColorFor, { opacity: dim ? 0.55 : 1 })

  cell.addSpacer(4)
  const bar = cell.addImage(barImage(w.used_percent, width, 6, dim ? C.sub : pctColor(w.used_percent)))
  bar.imageSize = new Size(width, 6)
  return cell
}

function accountBlock(parent, acc, family, inner, extraPill) {
  const dim = acc.stale || acc.status === "needs_login"
  const block = parent.addStack()
  block.layoutVertically()
  accountHeader(block, acc, {
    width: inner,
    logo: family === "small" ? 16 : 18,
    showProvider: family !== "small",
    dim,
    extraPill,
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
      block.addSpacer(i === 0 ? 6 : 10)
      windowCell(block, w, inner, dim)
    })
    return block
  }
  block.addSpacer(4)
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
  if (!accounts.length) return emptyWidget("표시할 계정이 없습니다. Scriptable 앱에서 계정을 추가하세요.")

  const family = size === "extraLarge" ? "large" : LAYOUT[size] ? size : "medium"
  const L = LAYOUT[family]
  const inner = widgetSize(family).w - L.pad * 2

  const w = new ListWidget()
  w.backgroundColor = C.bg
  w.setPadding(L.pad, L.pad, L.pad, L.pad)

  if (family === "large") {
    const head = w.addStack()
    head.layoutHorizontally()
    head.centerAlignContent()
    head.size = new Size(inner, 0)
    addText(head, "AI 사용량", Font.semiboldSystemFont(13), C.text)
    head.addSpacer()
    addText(head, offline ? "오프라인 · " + fmtAgo(data.generated_at) : `${fmtAgo(data.generated_at)} 업데이트`,
      Font.systemFont(10), offline ? C.warn : C.sub)
    w.addSpacer(12)
  } else if (family === "medium") {
    w.addSpacer()
  }

  const shown = accounts.slice(0, L.accounts)
  shown.forEach((acc, i) => {
    if (i > 0) w.addSpacer(L.gap)
    // 중형은 머리줄이 없으므로 오프라인 표시를 첫 계정에 붙인다
    const extra = family === "medium" && offline && i === 0 ? "오프라인" : null
    accountBlock(w, acc, family, inner, extra)
  })

  w.addSpacer()
  if (family === "small") {
    const more = accounts.length > 1 ? `  ·  +${accounts.length - 1}개` : ""
    addText(w, `${offline ? "오프라인 · " : ""}${fmtAgo(data.generated_at)} 업데이트${more}`, Font.systemFont(10), offline ? C.warn : C.sub)
  } else if (family === "large" && accounts.length > shown.length) {
    addText(w, `+${accounts.length - shown.length}개 더 · 위젯 Parameter 로 계정을 고를 수 있어요`, Font.systemFont(10), C.sub)
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
  const short = (acc) => (PROVIDER_STYLE[acc.provider] || {}).short || acc.label
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
  let param = (args.widgetParameter || "").trim()
  const parts = param.split(",").map((x) => x.trim())
  if (parts.includes("demo")) {
    FORCE_DEMO = true
    param = parts.filter((x) => x && x !== "demo").join(",")
  }
  let widget
  if (!getConfig()) {
    widget = emptyWidget("Scriptable 앱에서 이 스크립트를 실행해 서버를 설정하세요.")
  } else {
    try {
      const result = await loadUsage(false)
      widget = family.startsWith("accessory")
        ? buildAccessoryWidget(result, family, param)
        : buildHomeWidget(result, family, param)
    } catch (e) {
      widget = emptyWidget(`불러오기 실패: ${e.message}`)
    }
  }
  widget.refreshAfterDate = new Date(Date.now() + WIDGET_REFRESH_MIN * 60 * 1000)
  Script.setWidget(widget)
}

// ───────────────────────── 앱 UI: 공용 ─────────────────────────
async function alertMsg(title, message) {
  const a = new Alert()
  a.title = title
  a.message = message || ""
  a.addAction("확인")
  await a.presentAlert()
}

async function confirm(title, message, okText = "확인", destructive = false) {
  const a = new Alert()
  a.title = title
  a.message = message || ""
  destructive ? a.addDestructiveAction(okText) : a.addAction(okText)
  a.addCancelAction("취소")
  return (await a.presentAlert()) === 0
}

async function choose(title, message, options, sheet = true) {
  const a = new Alert()
  a.title = title
  if (message) a.message = message
  options.forEach((o) => a.addAction(o))
  a.addCancelAction("취소")
  const i = sheet ? await a.presentSheet() : await a.presentAlert()
  return i
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

async function guarded(fn) {
  try {
    return await fn()
  } catch (e) {
    await alertMsg("오류", e.message || String(e))
    return undefined
  }
}

// ───────────────────────── 앱 UI: 설정 ─────────────────────────
async function setupServer() {
  const cfg = getConfig()
  const cur = cfg && !cfg.demo ? cfg : {}
  const server = await prompt("서버 주소", "리버스 프록시 뒤의 서버 URL\n예) https://ai.example.com", {
    placeholder: "https://",
    value: cur.server || "",
  })
  if (!server) return false
  const key = await prompt("API 키", "서버의 AIUSAGE_API_KEY 값", {
    secure: true,
    value: cur.apiKey || "",
  })
  if (!key) return false
  Keychain.set(KC_SERVER, server.replace(/\/+$/, ""))
  Keychain.set(KC_KEY, key)
  setDemo(false)
  try {
    await api("GET", "/v1/accounts")
    await alertMsg("연결 성공", "서버에 연결되었습니다.")
    return true
  } catch (e) {
    await alertMsg("연결 실패", `${e.message}\n설정은 저장되었습니다. 주소와 키를 확인하세요.`)
    return false
  }
}

// ───────────────────────── 앱 UI: 로그인 ─────────────────────────
async function oauthLogin(provider, { label, accountId } = {}) {
  const start = await api("POST", "/v1/logins", { provider, label: label || undefined, account_id: accountId })
  const hasPage = !!start.authorize_url
  const go = new Alert()
  go.title = "로그인"
  go.message = hasPage
    ? `${start.instructions}\n\n1) '로그인 페이지 열기'를 누르세요.\n2) 로그인을 마친 뒤 안내된 값을 복사하세요.\n3) Scriptable 로 돌아와 붙여넣으세요.`
    : start.instructions
  go.addAction(hasPage ? "로그인 페이지 열기" : "계속")
  go.addCancelAction("취소")
  if ((await go.presentAlert()) !== 0) return null
  if (hasPage) Safari.open(start.authorize_url)

  while (true) {
    const a = new Alert()
    a.title = "로그인 결과 붙여넣기"
    a.message = `${start.input_hint}\n\n복사했다면 '클립보드에서 붙여넣기'를 누르세요.`
    a.addAction("클립보드에서 붙여넣기")
    a.addAction("직접 입력")
    if (hasPage) a.addAction("로그인 페이지 다시 열기")
    a.addCancelAction("취소")
    const i = await a.presentAlert()
    if (i === -1) return null
    if (i === 2) {
      Safari.open(start.authorize_url)
      continue
    }
    let input = i === 0 ? (Pasteboard.paste() || "").trim() : await prompt("직접 입력", start.input_hint)
    if (!input) {
      await alertMsg("비어 있음", "클립보드나 입력값이 비어 있습니다.")
      continue
    }
    try {
      const acc = await api("POST", `/v1/logins/${start.login_id}/complete`, { input }, 60)
      await alertMsg("완료", `${acc.label} (${acc.email || acc.provider_name}) 계정이 등록되었습니다.\n상태: ${STATUS_TEXT[acc.status] || acc.status}`)
      return acc
    } catch (e) {
      const retry = await confirm("로그인 실패", `${e.message}\n\n다시 붙여넣을까요?`, "다시 시도")
      if (!retry) return null
    }
  }
}

const SESSION_KEY_HELP =
  "claude.ai 에 로그인된 PC 브라우저에서 개발자 도구 → Application(저장소) → Cookies → https://claude.ai 의 'sessionKey' 값(sk-ant-…)을 복사하세요.\n\n초기화권은 claude.ai 웹 API 에서만 조회할 수 있어서 필요합니다."

async function addAccount() {
  const { providers } = await api("GET", "/v1/providers")
  const labels = providers.map((p) => (p.configured ? p.name : `${p.name} (서버 설정 필요)`))
  const i = await choose("계정 추가", "서비스를 선택하세요.", labels)
  if (i < 0) return
  const p = providers[i]
  if (!p.configured) return alertMsg("설정 필요", p.reason)

  const label = await prompt("이름 (선택)", "위젯에 표시할 이름. 비우면 이메일 앞부분을 씁니다.", { placeholder: "예) 개인" })
  if (label === null) return

  if (p.id === "claude") {
    const m = await choose(
      "Claude 등록 방식",
      "OAuth: 사용량 (안정적)\nsessionKey: 사용량 + 초기화권\n\nOAuth 로 등록한 뒤 계정 화면에서 sessionKey 를 추가하는 것을 추천합니다.",
      ["OAuth 로그인", "sessionKey 만 사용"]
    )
    if (m < 0) return
    if (m === 1) {
      const key = await prompt("sessionKey", SESSION_KEY_HELP, { secure: true, placeholder: "sk-ant-..." })
      if (!key) return
      const acc = await api("POST", "/v1/accounts", { provider: "claude", session_key: key, label: label || undefined }, 60)
      return alertMsg("완료", `${acc.label} 계정이 등록되었습니다.`)
    }
  }
  await oauthLogin(p.id, { label })
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

function drawTextAt(ctx, text, x, y, w, h, font, color, align = "left") {
  ctx.setFont(font)
  ctx.setTextColor(color)
  if (align === "right") ctx.setTextAlignedRight()
  else if (align === "center") ctx.setTextAlignedCenter()
  else ctx.setTextAlignedLeft()
  ctx.drawTextInRect(String(text), new Rect(x, y, w, h))
}

function drawLogo(ctx, provider, x, y, size, pal) {
  const key = logoKey(provider, pal.dark)
  if (!LOGOS[key]) return
  ctx.drawImageInRect(Image.fromData(Data.fromBase64String(LOGOS[key])), new Rect(x, y, size, size))
}

// 오른쪽부터 배지를 그리고, 남은 오른쪽 경계를 돌려준다.
function drawPills(ctx, pills, right, y, pal) {
  let x = right
  for (const p of pills) {
    const w = estWidth(p.text, 11) + 14
    x -= w
    fillRound(ctx, new Rect(x, y, w, 20), 10, pal.pill)
    drawTextAt(ctx, p.text, x, y + 3, w, 16, Font.semiboldSystemFont(11), p.color || pal.text, "center")
    x -= 6
  }
  return x
}

// 이름 바로 뒤에 플랜 배지. 브랜드 색을 옅게 깔고 글자는 브랜드 색.
function drawPlanBadge(ctx, provider, plan, x, y, maxRight) {
  const label = planLabel(plan)
  if (!label) return
  const w = estWidth(label, 10.5) + 12
  if (x + w > maxRight) return
  const brand = (PROVIDER_STYLE[provider] || {}).color || "#8E8E93"
  fillRound(ctx, new Rect(x, y, w, 17), 5, new Color(brand, pal().dark ? 0.28 : 0.15))
  drawTextAt(ctx, label, x, y + 2, w, 14, Font.boldSystemFont(10.5), new Color(brand), "center")
}

function accountPills(acc, enabled) {
  const pills = []
  const rc = acc.reset_credits
  if (rc && rc.available > 0) pills.push({ text: `초기화권 ${rc.available}` })
  if (acc.status === "needs_login") pills.push({ text: "재로그인", color: C.bad })
  else if (acc.status === "partial") pills.push({ text: "일부 실패", color: C.warn })
  else if (acc.status && !["ok", "pending"].includes(acc.status)) pills.push({ text: STATUS_TEXT[acc.status] || "오류", color: C.bad })
  if (enabled === false) pills.push({ text: "숨김", color: pal().sub })
  return pills.reverse() // 오른쪽부터 그리므로 뒤집는다
}

let _pal = null
function pal() {
  return _pal || (_pal = appPalette())
}

function drawBarCell(ctx, w, x, y, width, dim, p) {
  const until = fmtUntil(w.resets_at, true)
  const pct = w.used_percent
  const color = dim || pct == null ? p.sub : pctColor(pct)
  const pctText = pct == null ? "–" : `${Math.round(pct)}%`
  const pctW = estWidth(pctText, 14)
  const title = windowTitle(w)
  drawTextAt(ctx, title, x, y + 3, width - pctW - 8, 16, Font.systemFont(12), p.sub)
  drawTextAt(ctx, pctText, x + width - 60, y + 1, 60, 20, Font.semiboldSystemFont(14),
    dim || pct == null || pct < 70 ? p.text : pctColor(pct), "right")
  // 남은 시간은 퍼센트 앞에 흐리게. 이름과 겹치면 생략(상세 화면에서 볼 수 있음)
  if (until && estWidth(title, 12) + estWidth(until, 12) + pctW + 18 <= width) {
    const end = x + width - pctW - 6
    drawTextAt(ctx, until, end - 80, y + 3, 80, 16, Font.systemFont(12), new Color(p.sub.hex, 0.7), "right")
  }
  fillRound(ctx, new Rect(x, y + 23, width, 7), 3.5, p.track)
  if (pct != null && pct > 0) fillRound(ctx, new Rect(x, y + 23, Math.max(7, (width * Math.min(100, pct)) / 100), 7), 3.5, color)
}

// 메인 화면의 계정 카드
function accountCardImage(acc, enabled) {
  const p = pal()
  const W = cardWidth()
  const H = 82
  const ctx = newCtx(W, H)
  const dim = acc.stale || acc.status === "needs_login"
  drawLogo(ctx, acc.provider, 0, 6, 24, p)
  const right = drawPills(ctx, accountPills(acc, enabled), W, 8, p)
  drawTextAt(ctx, acc.label, 34, 2, right - 40, 22, Font.semiboldSystemFont(17), dim ? p.sub : p.text)
  drawPlanBadge(ctx, acc.provider, acc.plan, 34 + estWidth(acc.label, 17) + 6, 5, right - 4)
  drawTextAt(ctx, providerLine(acc), 34, 22, right - 40, 16, Font.systemFont(12), p.sub)
  const ws = primaryWindows(acc)
  if (!ws.length) {
    drawTextAt(ctx, acc.error || STATUS_TEXT[acc.status] || "데이터 없음", 0, 46, W, 32, Font.systemFont(13), p.sub)
    return ctx.getImage()
  }
  const gap = 18
  const cw = ws.length > 1 ? (W - gap) / 2 : W
  ws.forEach((w, i) => drawBarCell(ctx, w, i * (cw + gap), 44, cw, dim, p))
  return ctx.getImage()
}

// 상세 화면의 한도 한 줄
function windowRowImage(w, dim) {
  const p = pal()
  const W = cardWidth()
  const ctx = newCtx(W, 58)
  const pct = w.used_percent
  drawTextAt(ctx, windowTitle(w), 0, 4, W - 80, 20, Font.mediumSystemFont(15), p.text)
  drawTextAt(ctx, pct == null ? "–" : `${Math.round(pct)}%`, W - 80, 2, 80, 22, Font.semiboldSystemFont(18),
    dim || pct == null || pct < 70 ? p.text : pctColor(pct), "right")
  fillRound(ctx, new Rect(0, 30, W, 8), 4, p.track)
  if (pct != null && pct > 0) fillRound(ctx, new Rect(0, 30, Math.max(8, (W * Math.min(100, pct)) / 100), 8), 4, dim ? p.sub : pctColor(pct))
  const reset = w.resets_at ? `${fmtUntil(w.resets_at)} 후 초기화 (${fmtDate(w.resets_at)})` : "초기화 시각 정보 없음"
  drawTextAt(ctx, reset, 0, 42, W, 16, Font.systemFont(11), p.sub)
  return ctx.getImage()
}

// 상세 화면 맨 위 요약
function detailHeaderImage(acc, usage) {
  const p = pal()
  const W = cardWidth()
  const ctx = newCtx(W, 64)
  drawLogo(ctx, acc.provider, 0, 8, 40, p)
  const right = drawPills(ctx, accountPills(usage, acc.enabled), W, 18, p)
  drawTextAt(ctx, acc.label, 52, 6, right - 56, 28, Font.boldSystemFont(22), p.text)
  drawPlanBadge(ctx, acc.provider, usage.plan || acc.plan, 52 + estWidth(acc.label, 22) + 8, 12, right - 4)
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
  const ms = item.expires_at ? new Date(item.expires_at).getTime() - Date.now() : null
  const leftText = ms == null ? "만료 없음" : ms >= 86400000 ? `${Math.floor(ms / 86400000)}일 남음` : `${fmtUntil(item.expires_at)} 남음`
  const soon = item.expires_at && new Date(item.expires_at).getTime() - Date.now() < 3 * 86400 * 1000
  const right = drawPills(ctx, [{ text: leftText, color: soon ? C.warn : p.sub }], W, 19, p)
  // 제목과 날짜
  const title = item.title || "사용량 초기화권"
  drawTextAt(ctx, title, 48, 10, right - 52, 20, Font.semiboldSystemFont(15), p.text)
  const day = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}월 ${d.getDate()}일` }
  const dates = [item.expires_at ? `${day(item.expires_at)} 만료` : null, item.granted_at ? `${day(item.granted_at)} 지급` : null]
    .filter(Boolean)
    .join("  ·  ")
  drawTextAt(ctx, dates || item.description || "", 48, 32, right - 52, 16, Font.systemFont(12), p.sub)
  return ctx.getImage()
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
  const table = new UITable()
  table.showSeparators = true
  let closed = false

  async function render() {
    const { account: acc, usage } = await api("GET", `/v1/accounts/${accountId}`)
    table.removeAllRows()

    table.addRow(imageRow(detailHeaderImage(acc, usage), 80))

    const st = new UITableRow()
    st.height = usage.error || (usage.warnings || []).length ? 64 : 44
    const stc = st.addText(
      `${STATUS_TEXT[usage.status] || usage.status}${usage.stale ? " · 이전 값 표시 중" : ""}  ·  ${fmtAgo(usage.fetched_at)} 조회`,
      usage.error || (usage.warnings || []).join(" / ") || null
    )
    stc.titleFont = Font.systemFont(14)
    stc.titleColor = usage.status === "ok" ? Color.gray() : usage.status === "partial" ? C.warn : C.bad
    stc.subtitleColor = Color.gray()
    table.addRow(st)

    if ((usage.windows || []).length) {
      const sec = new UITableRow()
      sec.isHeader = true
      sec.addText("사용량")
      table.addRow(sec)
      const dim = usage.stale || usage.status === "needs_login"
      for (const w of usage.windows) table.addRow(imageRow(windowRowImage(w, dim), 72))
    }

    const rc = usage.reset_credits
    // Antigravity 는 초기화권이 없으므로 섹션을 아예 표시하지 않는다
    const showResets = acc.provider !== "antigravity"
    const rcItems = rc ? rc.items || (rc.expirations || []).map((e) => ({ expires_at: e })) : []
    const rcHead = new UITableRow()
    rcHead.isHeader = true
    rcHead.addText(rcItems.length ? `초기화권 ${rcItems.length}개` : "초기화권")
    if (showResets) table.addRow(rcHead)
    const rcRow = new UITableRow()
    rcRow.height = 54
    if (rc && rcItems.length) {
      if (showResets) rcItems.forEach((item, i) => table.addRow(imageRow(resetCreditImage(item, i, acc.provider), 70)))
    } else if (rc) {
      rcRow.addText("사용 가능한 초기화권이 없습니다", "")
    } else if (acc.auth && acc.auth.reset_credits_supported === false && acc.provider === "claude") {
      rcRow.addText("sessionKey 가 없어 조회하지 않음", "아래 'sessionKey 설정'으로 추가하세요.")
    } else {
      rcRow.addText("없음 / 대상 아님", "")
    }
    if (showResets && !(rc && rcItems.length)) table.addRow(rcRow)

    const extra = usage.extra || {}
    if (extra.extra_usage || extra.credits) {
      const r = new UITableRow()
      r.height = 50
      if (extra.extra_usage) {
        const e = extra.extra_usage
        r.addText("추가 사용량(Extra usage)", `${e.used ?? "–"} / ${e.limit ?? "–"} ${e.currency || ""} (${fmtPct(e.used_percent)})`)
      } else {
        const cr = extra.credits
        r.addText("크레딧", cr.unlimited ? "무제한" : `잔액 ${cr.balance ?? "–"}`)
      }
      table.addRow(r)
    }

    const actHead = new UITableRow()
    actHead.isHeader = true
    actHead.addText("관리")
    table.addRow(actHead)

    const action = (title, fn, color) => {
      const r = new UITableRow()
      r.dismissOnSelect = false
      const c = r.addText(title)
      if (color) c.titleColor = color
      r.onSelect = async () => {
        await guarded(fn)
        if (!closed) await guarded(render)
      }
      table.addRow(r)
    }

    action("지금 새로고침", () => api("POST", `/v1/accounts/${accountId}/refresh`, undefined, 60))
    action("이름 변경", async () => {
      const name = await prompt("이름 변경", "", { value: acc.label })
      if (name) await api("PATCH", `/v1/accounts/${accountId}`, { label: name })
    })
    if (acc.provider !== "claude" || acc.auth.oauth || usage.status === "needs_login") {
      action("다시 로그인", () => oauthLogin(acc.provider, { accountId }))
    }
    if (acc.provider === "claude") {
      const setKey = async () => {
        const key = await prompt("sessionKey", SESSION_KEY_HELP, { secure: true, placeholder: "sk-ant-..." })
        if (key) await api("PATCH", `/v1/accounts/${accountId}`, { session_key: key }, 60)
      }
      if (!acc.auth.session_key) {
        action("sessionKey 설정 (초기화권 표시)", setKey)
      } else {
        action("sessionKey 관리", async () => {
          // OAuth 가 없는 계정은 sessionKey 가 유일한 인증이라 제거할 수 없다
          const opts = acc.auth.oauth ? ["교체", "제거"] : ["교체"]
          const i = await choose("sessionKey", "초기화권 조회에 쓰는 claude.ai 쿠키입니다.", opts)
          if (i === 0) await setKey()
          if (i === 1 && (await confirm("sessionKey 제거", "초기화권 표시가 사라집니다.", "제거", true)))
            await api("PATCH", `/v1/accounts/${accountId}`, { session_key: "" })
        })
      }
    }
    action(acc.enabled ? "위젯에서 숨기기" : "위젯에 다시 표시", () =>
      api("PATCH", `/v1/accounts/${accountId}`, { enabled: !acc.enabled })
    )
    action(
      "계정 삭제",
      async () => {
        if (await confirm("계정 삭제", `${acc.label} 계정과 저장된 토큰을 서버에서 삭제합니다.`, "삭제", true)) {
          await api("DELETE", `/v1/accounts/${accountId}`)
          closed = true
          await alertMsg("삭제됨", "닫기를 눌러 목록으로 돌아가세요.")
        }
      },
      Color.red()
    )
    table.reload()
    return true
  }

  if (!(await guarded(render))) return
  await table.present(false)
  closed = true
}

// ───────────────────────── 앱 UI: 설정 메뉴 ─────────────────────────
// 자주 쓰지 않는 항목을 모은다. 화면을 다시 그려야 하면 true.
async function settingsMenu() {
  const items = []
  items.push(isDemo()
    ? { label: "서버 연결 (데모 종료)", run: () => setupServer() }
    : { label: "서버 주소 / API 키 변경", run: () => setupServer() })
  items.push({
    label: `Claude 로고 바꾸기 (현재: ${claudeLogo() === "clawd" ? "Clawd" : "기본"})`,
    run: () => {
      setClaudeLogo(claudeLogo() === "clawd" ? "default" : "clawd")
      logoCache = {}
    },
  })
  if (isDemo()) {
    items.push({ label: "데모 데이터 초기화", run: () => demoReset() })
    if (Keychain.contains(KC_SERVER)) items.push({ label: "데모 종료 (기존 서버로)", run: () => setDemo(false) })
  } else {
    items.push({ label: "데모 모드로 보기", run: () => setDemo(true) })
  }
  const i = await choose("설정", `v${VERSION}`, items.map((x) => x.label))
  if (i < 0) return false
  await items[i].run()
  return true
}

// ───────────────────────── 앱 UI: 메인 ─────────────────────────
async function mainMenu() {
  if (!getConfig()) {
    const i = await choose(
      "처음 설정",
      "사용량 서버에 연결하거나, 서버 없이 가짜 데이터로 UI 와 위젯을 먼저 둘러볼 수 있습니다.",
      ["서버 연결", "데모 모드로 둘러보기"],
      false
    )
    if (i === 1) setDemo(true)
    else if (i !== 0 || !(await setupServer())) return
  }

  const table = new UITable()
  table.showSeparators = true

  async function render(refresh = false) {
    table.removeAllRows()
    const head = new UITableRow()
    head.isHeader = true
    head.height = 60
    const h = head.addText("AI 사용량", `${getConfig().server}  ·  v${VERSION}`)
    h.titleFont = Font.boldSystemFont(22)
    table.addRow(head)

    if (isDemo()) {
      const r = new UITableRow()
      r.height = 54
      r.backgroundColor = new Color("#FF9F0A", 0.15)
      const c = r.addText("데모 모드", "가짜 데이터입니다. 설정에서 끌 수 있어요.")
      c.titleColor = new Color("#FF9F0A")
      table.addRow(r)
    }

    let accounts = []
    let usage = {}
    let errorMsg = null
    try {
      const [acc, u] = await Promise.all([api("GET", "/v1/accounts"), loadUsage(refresh)])
      accounts = acc.accounts
      for (const a of u.data.accounts) usage[a.id] = a
      if (u.offline) errorMsg = `오프라인(캐시 표시): ${u.error}`
    } catch (e) {
      errorMsg = e.message
    }

    if (errorMsg) {
      const r = new UITableRow()
      r.height = 60
      const c = r.addText("서버 오류", errorMsg)
      c.titleColor = Color.red()
      table.addRow(r)
    }

    const sec = new UITableRow()
    sec.isHeader = true
    sec.addText(`계정 (${accounts.length})`)
    table.addRow(sec)

    if (!accounts.length && !errorMsg) {
      const r = new UITableRow()
      r.addText("등록된 계정이 없습니다", "아래 '계정 추가'를 눌러 시작하세요.")
      r.height = 54
      table.addRow(r)
    }

    for (const acc of accounts) {
      const u = usage[acc.id] || { ...acc, windows: [] }
      const r = imageRow(accountCardImage({ ...acc, ...u, label: acc.label }, acc.enabled), 102)
      r.dismissOnSelect = false
      r.onSelect = async () => {
        await accountDetail(acc.id)
        await guarded(() => render(false))
      }
      table.addRow(r)
    }

    const actions = new UITableRow()
    actions.isHeader = true
    actions.addText("작업")
    table.addRow(actions)

    const action = (title, fn) => {
      const r = new UITableRow()
      r.dismissOnSelect = false
      r.addText(title)
      r.onSelect = async () => {
        await guarded(fn)
      }
      table.addRow(r)
    }
    action("계정 추가", async () => {
      await addAccount()
      await render(false)
    })
    action("전체 새로고침", () => render(true))
    action("위젯 미리보기", async () => {
      const i = await choose("위젯 미리보기", null, ["소형", "중형", "대형"])
      if (i < 0) return
      const size = ["small", "medium", "large"][i]
      const w = buildHomeWidget(await loadUsage(false), size, "")
      await [() => w.presentSmall(), () => w.presentMedium(), () => w.presentLarge()][i]()
    })
    action("설정", async () => {
      if (await settingsMenu()) await render(false)
    })
    table.reload()
  }

  await render(false)
  await table.present(false)
}

// ───────────────────────── 로고 (LobeHub Icons, MIT) ─────────────────────────
const LOGOS = {
  claude: "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",
  codex: "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",
  codexWhite: "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",
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
