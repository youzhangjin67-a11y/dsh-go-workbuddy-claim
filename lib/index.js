// WorkBuddy 每日签到积分领取 —— dsh-go 本地插件。
//
// 复用本机已有的 CodeBuddy / WorkBuddy 登录态（不写 token 进配置、不进日志）：
//   1. 状态条与面板：只读查询今天的签到状态（无副作用）；
//   2. 「领积分」按钮 / 面板里的「立即领取」：手动触发领取（只在点击时发生，
//      不做后台自动刷）；token 快过期或 401/403 时用 refreshToken 续期，并把
//      续期结果落到本插件自己的缓存文件。
//
// 凭据来源（按新到旧排序取第一份可用的）：
//   - 本插件自己的缓存：~/.dsh/.workbuddy-daily-claim.cn.json
//   - CodeBuddy CLI 登录态：~/.local/share/CodeBuddyExtension/Data/Public/auth/*.info
//   - 其它 WorkBuddy 登录副本：~/.dsh/.workbuddy-auth.cn.json

import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'local-workbuddy-claim'

/** 国内版账单域（签到接口所在主机）。 */
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
/** 国内版网关（token 刷新所在主机）。 */
const CN_CHAT_BASE = 'https://copilot.tencent.com'
/** 上游声明的 billing 域 UA。 */
const APP_VERSION = '5.8.3'
/** 刷新 token 用的 UA。 */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/** 一次普通 JSON 请求的超时。 */
const JSON_TIMEOUT_MS = 20_000
/** 提前多久认为 token 该刷新了。 */
const REFRESH_MARGIN_MS = 5 * 60_000
/** 上游「今天已签到」业务码。 */
const ALREADY_CHECKED_IN_CODE = 10001

const HOME = homedir()
/** 本插件自己的续期缓存。 */
const CACHE_FILE = join(HOME, '.dsh', '.workbuddy-daily-claim.cn.json')
/** 登录态候选文件，按优先级排列。 */
const AUTH_CANDIDATES = [
  CACHE_FILE,
  join(HOME, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info'),
  join(HOME, '.dsh', '.workbuddy-auth.cn.json'),
]

/** 最近领取历史（内存态，只在本次引擎生命周期内保留）。 */
const claimHistory = []

// #region 凭据读取（只读，不落盘）

function isExpiring(cred) {
  return cred.expiresAtMs > 0 && cred.expiresAtMs - Date.now() < REFRESH_MARGIN_MS
}

function normalizeCredential(accessToken, refreshToken, extra = {}) {
  const token = typeof accessToken === 'string' ? accessToken.trim() : ''
  if (token === '') return null
  const expiresSec = typeof extra.expiresAt === 'number' ? extra.expiresAt : 0
  const lastRefreshSec = typeof extra.lastRefreshTime === 'number' ? extra.lastRefreshTime : 0
  return {
    accessToken: token,
    refreshToken: typeof refreshToken === 'string' ? refreshToken.trim() : '',
    domain: typeof extra.domain === 'string' && extra.domain !== '' ? extra.domain : 'www.codebuddy.cn',
    expiresAtMs: expiresSec > 0 ? expiresSec * 1000 : 0,
    lastRefreshAtMs: lastRefreshSec > 0 ? lastRefreshSec * 1000 : 0,
    uid: typeof extra.uid === 'string' ? extra.uid : '',
    uin: typeof extra.uin === 'string' ? extra.uin : '',
    nickname: typeof extra.nickname === 'string' ? extra.nickname : '',
  }
}

/** 读取一份候选文件并归一化；文件不可用返回 null。 */
async function readCredentialSource(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    // CLI 的某些状态文件是 gzip(base64)；解码后再试一次。
    try {
      const { gunzipSync } = await import('node:zlib')
      const buf = gunzipSync(Buffer.from(raw.trim(), 'base64'))
      data = JSON.parse(buf.toString('utf8'))
    } catch {
      return null
    }
  }
  // 形状一：本插件缓存 / 通用平铺 { accessToken, ... }
  if (data && typeof data.accessToken === 'string') {
    return normalizeCredential(data.accessToken, data.refreshToken, {
      expiresAt: data.expiresAt, lastRefreshTime: data.lastRefreshTime,
      domain: data.domain, uid: data.uid, uin: data.uin, nickname: data.nickname,
    })
  }
  // 形状二：{ credential: { accessToken, ... } }
  if (data && typeof data.credential === 'object' && data.credential) {
    const c = data.credential
    return normalizeCredential(c.accessToken, c.refreshToken, {
      expiresAt: c.expiresAt, lastRefreshTime: c.lastRefreshTime,
      domain: c.domain, uid: c.uid, uin: c.uin, nickname: c.nickname,
    })
  }
  // 形状三：CodeBuddy CLI 登录态 { account, auth, accounts[] }
  const pick = (obj) => obj && typeof obj.accessToken === 'string'
    ? normalizeCredential(obj.accessToken, obj.refreshToken, {
        expiresAt: obj.expiresAt, lastRefreshTime: obj.lastRefreshTime ?? obj.lastRefreshTimeMs,
        domain: obj.domain, uid: obj.uid, uin: obj.uin, nickname: obj.nickname,
      })
    : null
  const top = pick(data?.auth)
  if (top) {
    return { ...top, uid: top.uid || data?.account?.uid || '', uin: top.uin || data?.account?.uin || '', nickname: top.nickname || data?.account?.nickname || '' }
  }
  if (Array.isArray(data?.accounts)) {
    for (const acc of data.accounts) {
      const c = pick(acc?.auth)
      if (c) return { ...c, uid: c.uid || acc?.uid || acc?.account?.uid || '', uin: c.uin || acc?.uin || acc?.account?.uin || '', nickname: c.nickname || acc?.nickname || acc?.account?.nickname || '' }
    }
  }
  return null
}

/** 读全部候选，按最后刷新时间从新到旧排序，返回第一份可用的。 */
async function resolveCredential() {
  const list = []
  for (const path of AUTH_CANDIDATES) {
    try {
      const cred = await readCredentialSource(path)
      if (cred) list.push(cred)
    } catch {
      /* 跳过 */
    }
  }
  if (list.length === 0) return null
  list.sort((a, b) => (b.lastRefreshAtMs || b.expiresAtMs) - (a.lastRefreshAtMs || a.expiresAtMs))
  return list[0]
}

// #endregion

// #region 上游接口

function billingHeaders(cred) {
  const headers = {
    Authorization: `Bearer ${cred.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': `WorkBuddy/${APP_VERSION}`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    Origin: CN_BILLING_BASE,
    Referer: `${CN_BILLING_BASE}/`,
  }
  if (cred.uid !== '') headers['X-User-Id'] = cred.uid
  if (cred.domain !== '') headers['X-Domain'] = cred.domain
  return headers
}

function refreshHeaders(cred) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: CN_BILLING_BASE,
    Referer: `${CN_BILLING_BASE}/`,
    'User-Agent': CLIENT_UA,
    'X-Refresh-Token': cred.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
}

async function readEnvelope(response) {
  let text
  try {
    text = await response.text()
  } catch (error) {
    throw new Error(`读取响应失败：${error instanceof Error ? error.message : String(error)}`)
  }
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 120).replace(/\s+/gu, ' ')}`)
  }
  return { response, envelope }
}

function envelopeError(status, envelope) {
  const code = typeof envelope?.code === 'number' ? envelope.code : undefined
  const message = typeof envelope?.msg === 'string' && envelope.msg !== '' ? envelope.msg : '上游没有给出原因'
  return new Error(`HTTP ${status} / code ${code ?? '?'}：${message}`)
}

function isCredentialRejection(error) {
  const m = error instanceof Error ? error.message : String(error)
  return /\bHTTP (401|403)\b/u.test(m) || /\bcode (14001|11138|401|403)\b/u.test(m)
}

/** 查今天的签到状态。只读。 */
async function fetchCheckinStatus(cred) {
  const response = await fetch(`${CN_BILLING_BASE}/v2/billing/meter/checkin-activity-status`, {
    method: 'POST',
    headers: billingHeaders(cred),
    body: '{}',
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const { envelope } = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
  const numberField = (key) => (typeof data[key] === 'number' && Number.isFinite(data[key]) ? data[key] : 0)
  return {
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: numberField('streak_days'),
    dailyCredit: numberField('daily_credit'),
    todayCredit: numberField('today_credit'),
    totalCredits: numberField('total_credits'),
    isStreakDay: data.is_streak_day === true,
    activityName: typeof data.activity_name === 'string' ? data.activity_name : '',
    endsAt: typeof data.end_time === 'string' ? data.end_time : '',
  }
}

/** 领取今天这一份。上游幂等：已领过不会重复发。 */
async function claimDailyCheckin(cred) {
  const response = await fetch(`${CN_BILLING_BASE}/v2/billing/meter/daily-checkin`, {
    method: 'POST',
    headers: billingHeaders(cred),
    body: '{}',
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const { envelope } = await readEnvelope(response)
  if (envelope.code === ALREADY_CHECKED_IN_CODE) return { already: true, credit: 0, streakDays: 0, isStreakDay: false }
  if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
  return {
    already: false,
    credit: typeof data.credit === 'number' ? data.credit : 0,
    streakDays: typeof data.streak_days === 'number' ? data.streak_days : 0,
    isStreakDay: data.is_streak_day === true,
  }
}

/** 用 refreshToken 换一个新的 accessToken。 */
async function refreshCredential(cred) {
  if (cred.refreshToken === '') throw new Error('凭据里没有 refreshToken，无法自动续期；请重新登录 WorkBuddy')
  const response = await fetch(`${CN_CHAT_BASE}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers: refreshHeaders(cred),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const { envelope } = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken.trim() : ''
  if (accessToken === '') throw new Error('刷新响应里没有 accessToken；请重新登录 WorkBuddy')
  return {
    ...cred,
    accessToken,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : cred.refreshToken,
    expiresAtMs: typeof data.expiresIn === 'number' && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1000 : cred.expiresAtMs,
    domain: typeof data.domain === 'string' && data.domain !== '' ? data.domain : cred.domain,
    lastRefreshAtMs: Date.now(),
  }
}

/** 把刷新后的凭据写成本插件自己的缓存副本（仅领取/续期路径调用）。 */
async function cacheRefreshedCredential(cred) {
  const body = JSON.stringify(
    {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAtMs > 0 ? Math.floor(cred.expiresAtMs / 1000) : 0,
      lastRefreshTime: Math.floor(cred.lastRefreshAtMs / 1000),
      domain: cred.domain,
      uid: cred.uid,
      uin: cred.uin,
      nickname: cred.nickname,
    },
    undefined,
    2,
  )
  await mkdir(join(HOME, '.dsh'), { recursive: true })
  const tmp = `${CACHE_FILE}.tmp`
  await writeFile(tmp, `${body}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, CACHE_FILE)
  try {
    await chmod(CACHE_FILE, 0o600)
  } catch {
    /* 权限不是必须 */
  }
}

// #endregion

// #region 业务编排

function accountLabel(cred) {
  if (typeof cred.nickname === 'string' && cred.nickname !== '') return cred.nickname
  if (typeof cred.uin === 'string' && cred.uin !== '') return cred.uin
  if (typeof cred.uid === 'string' && cred.uid !== '') return cred.uid.slice(0, 6)
  return '未登录'
}

function isZh(eventOrCaps) {
  const locale = eventOrCaps?.locale ?? ''
  return !String(locale).startsWith('en')
}

/** 领取一次；失败但能续期时用新 token 重试一次。 */
async function runClaim() {
  let cred = await resolveCredential()
  if (!cred) throw new Error('未找到 WorkBuddy 登录态，请先登录 CodeBuddy / WorkBuddy')
  if (isExpiring(cred)) {
    try {
      cred = await refreshCredential(cred)
      await cacheRefreshedCredential(cred)
    } catch {
      /* 续期失败就用旧 token 再试一次，若仍 401 会走下面的重试分支 */
    }
  }
  try {
    return await claimDailyCheckin(cred)
  } catch (error) {
    if (isCredentialRejection(error) && cred.refreshToken !== '') {
      const fresh = await refreshCredential(cred)
      await cacheRefreshedCredential(fresh)
      return claimDailyCheckin(fresh)
    }
    throw error
  }
}

/** 状态条文案。绝不抛错。 */
async function statusSummary(zh) {
  try {
    const cred = await resolveCredential()
    if (!cred) return { text: zh ? '未登录' : 'Signed out', tone: 'warn' }
    const s = await fetchCheckinStatus(cred)
    if (s.todayCheckedIn) return { text: zh ? '今日已领 ✓' : 'Claimed ✓', tone: 'good' }
    return { text: zh ? '今日未领' : 'Not claimed', tone: 'warn' }
  } catch {
    return { text: zh ? '查询失败' : 'Error', tone: 'bad' }
  }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function historyList(zh) {
  const recent = claimHistory.slice(-8).reverse()
  return recent.map((h) => ({
    title: h.time,
    subtitle: h.text,
    icon: 'wallet',
    tone: h.tone,
  }))
}

/** 面板数据对象。绝不抛错。 */
async function panelData(zh) {
  let cred
  try {
    cred = await resolveCredential()
  } catch {
    cred = null
  }
  if (!cred) {
    return {
      account: '—', today: zh ? '未登录' : 'Signed out', todayTone: 'warn', streak: '—',
      todayCredit: '—', total: '—',
      note: zh ? '未找到 WorkBuddy 登录态，请先登录 CodeBuddy / WorkBuddy' : 'No WorkBuddy sign-in found',
      noteTone: 'warn', history: historyList(zh),
    }
  }
  const account = accountLabel(cred)
  try {
    const s = await fetchCheckinStatus(cred)
    return {
      account,
      today: s.todayCheckedIn ? (zh ? '已领' : 'Claimed') : (zh ? '未领' : 'Not yet'),
      todayTone: s.todayCheckedIn ? 'good' : 'warn',
      streak: `${s.streakDays}`,
      todayCredit: `${s.todayCredit}`,
      total: `${s.totalCredits}`,
      note: s.todayCheckedIn
        ? (zh ? '今天已签到，明天再来' : 'Checked in today')
        : (zh ? '今天还没领，点「立即领取」' : 'Not claimed yet — tap Claim now'),
      noteTone: s.todayCheckedIn ? 'good' : 'info',
      history: historyList(zh),
    }
  } catch (error) {
    return {
      account,
      today: '?', todayTone: 'warn', streak: '—', todayCredit: '—', total: '—',
      note: `查询失败：${error instanceof Error ? error.message : String(error)}`,
      noteTone: 'bad', history: historyList(zh),
    }
  }
}

// 状态条回调里赋值，领取成功后立刻刷新它。
let pushStrip = null

/** 领取的通用处理：返回延后效果（先 pending，再 toast + patch）。 */
function claimEffect(zh) {
  return {
    pending: { label: zh ? '正在领取…' : 'Claiming…', timeoutMs: 60_000 },
    result: async (signal) => {
      if (signal?.aborted) return {}
      try {
        const r = await runClaim()
        const data = await panelData(zh)
        const text = r.already
          ? (zh ? '今天已经领过了' : 'Already claimed today')
          : (zh ? `已领取 +${r.credit} 积分` : `Claimed +${r.credit} pts`)
        claimHistory.push({
          time: stamp(),
          text: `${text}${r.streakDays > 0 ? ` · 连续 ${r.streakDays} 天` : ''}`,
          tone: r.already ? 'info' : 'good',
        })
        if (pushStrip) pushStrip(await statusSummary(zh))
        return { toast: text, patch: data }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { toast: (zh ? '领取失败：' : 'Claim failed: ') + msg.slice(0, 30) }
      }
    },
  }
}

// #endregion

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    // 状态条：显示今天的签到状态，点它打开面板。
    ctx.dshGo.strip('wb-strip', (scope, emit, caps) => {
      const zh = isZh(caps)
      let cancelled = false
      const tick = async () => {
        if (cancelled) return
        const s = await statusSummary(zh)
        if (cancelled) return
        emit(s)
      }
      pushStrip = tick
      tick()
      const timer = setInterval(tick, 5 * 60_000)
      return () => {
        cancelled = true
        pushStrip = null
        clearInterval(timer)
      }
    })

    // 「领积分」一键领取。
    ctx.dshGo.on('claim', (scope, event) => claimEffect(isZh(event)))

    // 面板：状态 + 立即领取 + 刷新。
    ctx.dshGo.panel('wb', {
      view: (scope, caps) => {
        const zh = isZh(caps)
        return {
          type: 'stack',
          title: zh ? 'WorkBuddy 每日签到' : 'WorkBuddy Daily Check-in',
          children: [
            { type: 'metric', label: zh ? '账号' : 'Account', value: { $: 'data.account' } },
            { type: 'metric', label: zh ? '今日' : 'Today', value: { $: 'data.today' }, tone: { $: 'data.todayTone' } },
            {
              type: 'row',
              children: [
                { type: 'metric', label: zh ? '连续' : 'Streak', value: { $: 'data.streak' } },
                { type: 'metric', label: zh ? '今日积分' : 'Today pts', value: { $: 'data.todayCredit' } },
                { type: 'metric', label: zh ? '总积分' : 'Total', value: { $: 'data.total' } },
              ],
            },
            { type: 'callout', text: { $: 'data.note' }, tone: { $: 'data.noteTone' } },
            {
              type: 'actions',
              items: [
                { label: zh ? '立即领取' : 'Claim now', action: 'claim', icon: 'wallet', style: 'primary' },
                { label: zh ? '刷新' : 'Refresh', action: 'refresh', icon: 'refresh' },
              ],
            },
            { type: 'list', title: zh ? '最近记录' : 'Recent', items: { $: 'data.history' } },
          ],
        }
      },
      data: (scope, emit, caps) => {
        const zh = isZh(caps)
        let cancelled = false
        const push = async () => {
          if (cancelled) return
          const d = await panelData(zh)
          if (cancelled) return
          emit(d)
        }
        push()
        const timer = setInterval(push, 5 * 60_000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      },
      actions: {
        claim: (scope, event) => claimEffect(isZh(event)),
        refresh: (scope, event) => ({ refresh: true }),
      },
    })
  })
}
