// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-purple; icon-glyph: tachometer-alt;

// AI 사용량 위젯 — Claude / ChatGPT·Codex / Antigravity
// 서버: https://github.com/tmmmzk/scriptable-ai-usage
//
// • 앱에서 실행하면 설정·계정 관리 화면이 열립니다.
// • 위젯 Parameter 에 계정 이름(또는 id)을 쉼표로 적으면 그 계정만 표시합니다. 예) 개인,회사

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
  track: new Color("#8E8E93", 0.25),
  ok: new Color("#34C759"),
  warn: new Color("#FF9F0A"),
  bad: new Color("#FF453A"),
}

// ───────────────────────── 설정 / API ─────────────────────────
function getConfig() {
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

async function api(method, path, body, timeout = 25) {
  const cfg = getConfig()
  if (!cfg) throw new ApiError("서버 설정이 필요합니다.", 0)
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
    writeCache(data)
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
  if (h > 0) return compact ? `${h}h ${mm}m` : `${h}시간 ${mm}분`
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

function statusBadge(acc) {
  if (acc.status === "ok") return null
  if (acc.status === "partial") return { text: "⚠︎", color: C.warn }
  if (acc.status === "needs_login") return { text: "🔑", color: C.bad }
  if (acc.status === "pending") return { text: "…", color: C.sub }
  return { text: "⚠︎", color: C.bad }
}

function textBar(p, len = 10) {
  if (p == null) return "░".repeat(len)
  const filled = Math.round((Math.min(100, Math.max(0, p)) / 100) * len)
  return "▓".repeat(filled) + "░".repeat(len - filled)
}

// ───────────────────────── 위젯 그리기 ─────────────────────────
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
  if (opts.right) t.rightAlignText()
  return t
}

function accountHeader(stack, acc, fontSize) {
  const row = stack.addStack()
  row.layoutHorizontally()
  row.centerAlignContent()
  const style = PROVIDER_STYLE[acc.provider] || { color: "#8E8E93", short: acc.provider }
  addText(row, "●", Font.systemFont(fontSize - 2), new Color(style.color))
  row.addSpacer(4)
  addText(row, acc.label || style.short, Font.semiboldSystemFont(fontSize), C.text, { minScale: 0.7 })
  row.addSpacer(4)
  addText(row, style.short, Font.systemFont(fontSize - 3), C.sub, { minScale: 0.7 })
  row.addSpacer()
  const rc = acc.reset_credits
  if (rc && rc.available > 0) {
    addText(row, `🎟${rc.available}`, Font.mediumSystemFont(fontSize - 2), C.text)
    row.addSpacer(3)
  }
  const badge = statusBadge(acc)
  if (badge) addText(row, badge.text, Font.systemFont(fontSize - 2), badge.color)
  return row
}

function windowLine(stack, w, barWidth, fontSize, dim) {
  const line = stack.addStack()
  line.layoutHorizontally()
  line.centerAlignContent()
  const label = addText(line, windowTitle(w), Font.systemFont(fontSize - 2), C.sub, { minScale: 0.6 })
  label.lineLimit = 1
  line.addSpacer(4)
  const img = line.addImage(barImage(w.used_percent, barWidth, 5, dim ? C.sub : pctColor(w.used_percent)))
  img.imageSize = new Size(barWidth, 5)
  line.addSpacer(4)
  addText(line, fmtPct(w.used_percent), Font.semiboldMonospacedSystemFont(fontSize - 1), C.text)
  return line
}

function accountBlock(parent, acc, size) {
  const fontSize = size === "small" ? 12 : 13
  const block = parent.addStack()
  block.layoutVertically()
  block.spacing = 2
  accountHeader(block, acc, fontSize)
  const ws = primaryWindows(acc)
  const dim = acc.stale || acc.status === "needs_login"
  if (!ws.length) {
    addText(block, acc.error || STATUS_TEXT[acc.status] || "데이터 없음", Font.systemFont(fontSize - 3), C.sub)
    return block
  }
  if (size === "small") {
    for (const w of ws) {
      const l = windowLine(block, w, 58, fontSize, dim)
      l.addSpacer()
    }
    return block
  }
  // 중·대형: 한 줄에 창 두 개 + 초기화까지 남은 시간
  const row = block.addStack()
  row.layoutHorizontally()
  row.centerAlignContent()
  ws.forEach((w, i) => {
    if (i > 0) row.addSpacer(10)
    const cell = row.addStack()
    cell.layoutVertically()
    windowLine(cell, w, 62, fontSize, dim)
    const until = fmtUntil(w.resets_at, true)
    addText(cell, until ? `↻ ${until}` : " ", Font.systemFont(fontSize - 4), C.sub)
  })
  row.addSpacer()
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
  addText(w, "AI 사용량", Font.semiboldSystemFont(13), C.text)
  w.addSpacer(6)
  const t = addText(w, message, Font.systemFont(11), C.sub)
  t.lineLimit = 4
  return w
}

function buildHomeWidget(result, size, param) {
  const { data, offline } = result
  const accounts = filterAccounts(data.accounts || [], param)
  if (!accounts.length) return emptyWidget("표시할 계정이 없습니다. Scriptable 앱에서 계정을 추가하세요.")

  const w = new ListWidget()
  w.backgroundColor = C.bg
  w.setPadding(12, 14, 12, 14)
  const capacity = { small: 2, medium: 3, large: 7, extraLarge: 7 }[size] || 3

  if (size !== "small") {
    const head = w.addStack()
    head.layoutHorizontally()
    head.centerAlignContent()
    addText(head, "AI 사용량", Font.boldSystemFont(13), C.text)
    head.addSpacer()
    addText(head, `${offline ? "오프라인 · " : ""}${fmtAgo(data.generated_at)}`, Font.systemFont(10), offline ? C.warn : C.sub)
    w.addSpacer(6)
  }

  const shown = accounts.slice(0, capacity)
  shown.forEach((acc, i) => {
    if (i > 0) w.addSpacer(size === "small" ? 6 : 7)
    accountBlock(w, acc, size)
  })
  if (accounts.length > shown.length) {
    w.addSpacer(4)
    addText(w, `+${accounts.length - shown.length}개 더`, Font.systemFont(10), C.sub)
  }
  w.addSpacer()
  return w
}

function buildAccessoryWidget(result, family, param) {
  const accounts = filterAccounts(result.data.accounts || [], param)
  const w = new ListWidget()
  if (!accounts.length) {
    addText(w, "AI 사용량 –", Font.systemFont(12), Color.white())
    return w
  }
  const parts = (acc) => primaryWindows(acc).map((x) => fmtPct(x.used_percent)).join("·")
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
    addText(s, short(acc).slice(0, 6), Font.systemFont(9), Color.white())
    addText(s, pw ? fmtPct(pw.used_percent) : "–", Font.boldSystemFont(15), Color.white())
    return w
  }
  // accessoryRectangular
  for (const acc of accounts.slice(0, 3)) {
    const rc = acc.reset_credits && acc.reset_credits.available ? ` 🎟${acc.reset_credits.available}` : ""
    addText(w, `${acc.label || short(acc)}  ${parts(acc)}${rc}`, Font.systemFont(12), Color.white(), { minScale: 0.7 })
  }
  return w
}

async function runWidget() {
  const family = config.widgetFamily || "medium"
  const param = (args.widgetParameter || "").trim()
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
  const cur = getConfig() || {}
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
  const go = new Alert()
  go.title = "로그인"
  go.message = `${start.instructions}\n\n1) '로그인 페이지 열기'를 누르세요.\n2) 로그인을 마친 뒤 안내된 값을 복사하세요.\n3) Scriptable 로 돌아와 붙여넣으세요.`
  go.addAction("로그인 페이지 열기")
  go.addCancelAction("취소")
  if ((await go.presentAlert()) !== 0) return null
  Safari.open(start.authorize_url)

  while (true) {
    const a = new Alert()
    a.title = "로그인 결과 붙여넣기"
    a.message = `${start.input_hint}\n\n복사했다면 '클립보드에서 붙여넣기'를 누르세요.`
    a.addAction("클립보드에서 붙여넣기")
    a.addAction("직접 입력")
    a.addAction("로그인 페이지 다시 열기")
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

// ───────────────────────── 앱 UI: 계정 상세 ─────────────────────────
async function accountDetail(accountId) {
  const table = new UITable()
  table.showSeparators = true
  let closed = false

  async function render() {
    const { account: acc, usage } = await api("GET", `/v1/accounts/${accountId}`)
    table.removeAllRows()
    const style = PROVIDER_STYLE[acc.provider] || { color: "#8E8E93" }

    const head = new UITableRow()
    head.isHeader = true
    head.height = 64
    const ht = head.addText(`${acc.label}`, `${acc.provider_name}${acc.email ? " · " + acc.email : ""}${acc.plan ? " · " + acc.plan : ""}`)
    ht.titleColor = new Color(style.color)
    ht.titleFont = Font.boldSystemFont(20)
    table.addRow(head)

    const st = new UITableRow()
    st.height = usage.error ? 80 : 50
    const stc = st.addText(
      `상태: ${STATUS_TEXT[usage.status] || usage.status}${usage.stale ? " (이전 값 표시 중)" : ""}${acc.enabled ? "" : " · 비활성"}`,
      `${usage.error || (usage.warnings || []).join(" / ") || "마지막 조회 " + fmtAgo(usage.fetched_at)}`
    )
    stc.subtitleColor = usage.error ? Color.red() : Color.gray()
    table.addRow(st)

    if ((usage.windows || []).length) {
      const sec = new UITableRow()
      sec.isHeader = true
      sec.addText("사용량")
      table.addRow(sec)
      for (const w of usage.windows) {
        const r = new UITableRow()
        r.height = 54
        const c = r.addText(
          `${windowTitle(w)}   ${fmtPct(w.used_percent)}`,
          `${textBar(w.used_percent, 16)}   ${w.resets_at ? "↻ " + fmtUntil(w.resets_at) + " 후" : ""}`
        )
        c.titleColor = pctColor(w.used_percent)
        table.addRow(r)
      }
    }

    const rc = usage.reset_credits
    const rcHead = new UITableRow()
    rcHead.isHeader = true
    rcHead.addText("초기화권")
    table.addRow(rcHead)
    const rcRow = new UITableRow()
    rcRow.height = 54
    if (rc) {
      rcRow.addText(`🎟 ${rc.available}개 사용 가능`, rc.available ? `가장 빠른 만료: ${fmtDate(rc.next_expires_at)}` : "")
    } else if (acc.auth && acc.auth.reset_credits_supported === false && acc.provider === "claude") {
      rcRow.addText("sessionKey 가 없어 조회하지 않음", "아래 'sessionKey 설정'으로 추가하세요.")
    } else if (acc.provider === "antigravity") {
      rcRow.addText("지원하지 않음", "")
    } else {
      rcRow.addText("없음 / 대상 아님", "")
    }
    table.addRow(rcRow)

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

    action("↻ 지금 새로고침", () => api("POST", `/v1/accounts/${accountId}/refresh`, undefined, 60))
    action("✎ 이름 변경", async () => {
      const name = await prompt("이름 변경", "", { value: acc.label })
      if (name) await api("PATCH", `/v1/accounts/${accountId}`, { label: name })
    })
    if (acc.provider !== "claude" || acc.auth.oauth || usage.status === "needs_login") {
      action("🔑 다시 로그인", () => oauthLogin(acc.provider, { accountId }))
    }
    if (acc.provider === "claude") {
      action(acc.auth.session_key ? "🍪 sessionKey 교체" : "🍪 sessionKey 설정 (초기화권)", async () => {
        const key = await prompt("sessionKey", SESSION_KEY_HELP, { secure: true, placeholder: "sk-ant-..." })
        if (key) await api("PATCH", `/v1/accounts/${accountId}`, { session_key: key }, 60)
      })
      if (acc.auth.session_key && acc.auth.oauth) {
        action("🍪 sessionKey 제거", async () => {
          if (await confirm("sessionKey 제거", "초기화권 표시가 사라집니다.", "제거", true))
            await api("PATCH", `/v1/accounts/${accountId}`, { session_key: "" })
        })
      }
    }
    action(acc.enabled ? "⏸ 위젯에서 숨기기" : "▶︎ 위젯에 다시 표시", () =>
      api("PATCH", `/v1/accounts/${accountId}`, { enabled: !acc.enabled })
    )
    action(
      "🗑 계정 삭제",
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

// ───────────────────────── 앱 UI: 메인 ─────────────────────────
async function mainMenu() {
  if (!getConfig()) {
    await alertMsg("처음 설정", "사용량 서버 주소와 API 키를 입력하세요.")
    if (!(await setupServer())) return
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
      const c = r.addText("⚠︎ 서버 오류", errorMsg)
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
      const u = usage[acc.id] || { windows: [] }
      const style = PROVIDER_STYLE[acc.provider] || { color: "#8E8E93" }
      const r = new UITableRow()
      r.height = 64
      r.dismissOnSelect = false
      const ws = primaryWindows(u)
        .map((w) => `${windowTitle(w)} ${fmtPct(w.used_percent)}`)
        .join("  ·  ")
      const rc = u.reset_credits && u.reset_credits.available ? `  ·  🎟${u.reset_credits.available}` : ""
      const status = acc.status === "ok" ? "" : `  [${STATUS_TEXT[acc.status] || acc.status}]`
      const c = r.addText(`● ${acc.label}${acc.enabled ? "" : " (숨김)"}${status}`, `${acc.provider_name}  ·  ${ws || "데이터 없음"}${rc}`)
      c.titleColor = acc.status === "needs_login" || acc.status === "error" ? Color.red() : new Color(style.color)
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
    action("＋ 계정 추가", async () => {
      await addAccount()
      await render(false)
    })
    action("↻ 전체 새로고침", () => render(true))
    action("▦ 위젯 미리보기 (중형)", async () => {
      const w = buildHomeWidget(await loadUsage(false), "medium", "")
      await w.presentMedium()
    })
    action("▦ 위젯 미리보기 (소형)", async () => {
      const w = buildHomeWidget(await loadUsage(false), "small", "")
      await w.presentSmall()
    })
    action("▦ 위젯 미리보기 (대형)", async () => {
      const w = buildHomeWidget(await loadUsage(false), "large", "")
      await w.presentLarge()
    })
    action("⚙︎ 서버 설정", async () => {
      await setupServer()
      await render(false)
    })
    table.reload()
  }

  await render(false)
  await table.present(false)
}

// ───────────────────────── 진입점 ─────────────────────────
if (config.runsInWidget || config.runsInAccessoryWidget) {
  await runWidget()
} else {
  await mainMenu()
}
Script.complete()
