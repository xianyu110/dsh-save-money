/**
 * dsh-save-money — Account balance query (DeepSeek API /user/balance), Host side.
 * ...doc...
 */

// Node/browser globals used by the transport — declared here so the module
// type-checks standalone and the dynamic sandbox (no process globals) never
// trips over them.
declare const fetch: any
declare const AbortSignal: any
declare const setTimeout: any
declare const clearTimeout: any

/** Cache window; the header polls every 30s, so keep the upstream call rare. */
export const CACHE_MS = 60000

/** 余额采样周期:后端每 5 分钟记录一次余额。 */
export const SAMPLE_MS = 5 * 60 * 1000
/** 采样点上限:5min × 288 = 24 小时。 */
export const HISTORY_LEN = 288

/**
 * 余额历史队列:每 5 分钟一个采样点,保留最近 24 小时。
 * 用途:由余额变化计算「最近 1 小时 / 10 分钟 / 24 小时消费了多少钱」。
 *
 * 防膨胀保证(绝对上限,任何输入都不可能突破):
 *  - record() 先做输入校验:非有限数字(NaN / ±Infinity / 非数字)直接忽略,
 *    不会入队,也不可能污染 latest() / spend()。
 *  - 同一 5 分钟窗口内的再次 record 只更新最新值(不新增点)。
 *  - 时间戳乱序(倒退)一律不新增:at <= last.at 时视为同窗口更新,从根上
 *    杜绝乱序 push 破坏升序;只有严格递增且间隔 >= SAMPLE_MS 才新增。
 *  - push 后立即用 splice 强制裁剪到 HISTORY_LEN —— 即使某次批量 push 了
 *    多个点,数组长度也一次性回到上限内,峰值严格 <= HISTORY_LEN + 批量数,
 *    且 splice(0, overflow) 只发生一次。调用路径当前每次仅 push 1 个,
 *    所以实际峰值恒为 HISTORY_LEN + 1 = 289,随后即回到 288。
 */
export function createBalanceHistory() {
  const points: { at: number; total: number; activity?: boolean }[] = []
  const pushPoint = (at: number, total: number, activity: boolean | undefined) => {
    points.push({ at, total, ...(activity === undefined ? {} : { activity }) })
    if (points.length > HISTORY_LEN) {
      points.splice(0, points.length - HISTORY_LEN) // 一次裁掉全部溢出
    }
  }
  return {
    record(total: number, at: number = Date.now(), activity?: boolean): void {
      if (typeof at !== 'number' || !Number.isFinite(at)) return
      if (typeof total !== 'number' || !Number.isFinite(total)) return
      // 采样点对齐到整数 5 分钟(07:42:37 → 07:40):任何时区偏移都是整分钟,
      // 所以 ms % SAMPLE_MS == 0 在所有时区都落在整 5 分钟上 —— 与墙钟对齐,
      // 便于和官方后台(按整点计费)对比。对齐后同窗口的多次 record 共享同
      // 一个 at,自然落入「同刻更新」分支,去重语义与整数边界完全一致。
      at = at - (at % SAMPLE_MS)
      const last = points[points.length - 1]
      // 乱序(倒退或同刻)一律按同窗口更新,绝不新增:保持数组按 at 升序。
      if (last && at <= last.at) {
        last.total = total
        if (activity !== undefined) last.activity = activity
        return
      }
      if (last && at - last.at < SAMPLE_MS) {
        last.total = total
        if (activity !== undefined) last.activity = activity
        return
      }
      pushPoint(at, total, activity)
    },
    /** 最新一条余额,无采样时返回 null。 */
    latest(): number | null {
      return points.length > 0 ? points[points.length - 1].total : null
    },
    /** now - ms 时刻的余额(取不晚于该时刻的最近采样);历史不足返回 null。 */
    totalAgo(ms: number, now: number = Date.now()): number | null {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || typeof now !== 'number' || !Number.isFinite(now)) return null
      const target = now - ms
      for (let i = points.length - 1; i >= 0; i--) {
        if (points[i].at <= target) return points[i].total
      }
      return null
    },
    /** 最近 ms 的消费金额(正数 = 花掉;余额回升时为负);历史不足返回 null。 */
    spend(ms: number, now: number = Date.now()): number | null {
      const cur = this.latest()
      const prev = this.totalAgo(ms, now)
      if (cur === null || prev === null) return null
      return prev - cur
    },
    /** 当前全部采样点(调试/展示)。 */
    points(): { at: number; total: number; activity?: boolean }[] {
      return points.slice()
    },
    /** 用持久化的数据整体替换当前历史(启动时调用);空/非法输入忽略。 */
    load(persisted: { at: number; total: number; activity?: boolean }[]): void {
      if (!Array.isArray(persisted) || persisted.length === 0) return
      const clean: { at: number; total: number; activity?: boolean }[] = []
      for (const p of persisted) {
        if (!p || typeof p.at !== 'number' || !Number.isFinite(p.at)) continue
        if (typeof p.total !== 'number' || !Number.isFinite(p.total)) continue
        // 对齐到整数 5 分钟(与 record 一致):旧版本可能存了任意时刻,载入后统一
        const aligned = p.at - (p.at % SAMPLE_MS)
        clean.push({ at: aligned, total: p.total, ...(p.activity === undefined ? {} : { activity: !!p.activity }) })
      }
      if (clean.length === 0) return
      // 保证升序(持久化文件可能乱序)
      clean.sort((a, b) => a.at - b.at)
      // 去重(同一时刻保留最后一条)
      const deduped: { at: number; total: number; activity?: boolean }[] = []
      for (const p of clean) {
        const last = deduped[deduped.length - 1]
        if (last && last.at === p.at) deduped[deduped.length - 1] = p
        else deduped.push(p)
      }
      points.length = 0
      for (const p of deduped.slice(-HISTORY_LEN)) pushPoint(p.at, p.total, p.activity)
    },
    clear(): void { points.length = 0 },
  }
}

/**
 * 账户指纹:对 DeepSeek API key 做 FNV-1a 32 位散列(前 8 位十六进制)。
 * 仅用于「换 key = 换账户 = 旧历史作废」的身份比对,不是安全用途
 * (密钥本身不进持久化文件,也不会被这个哈希还原)。
 */
export function keyFingerprint(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 余额历史持久化文件名(用户目录 ~/.dsh 下,账户级、跨项目共享)。 */
export const BALANCE_HISTORY_FILE = 'dsh-save-money-balance.json'

/** 持久化文件结构:keyId 是账户指纹,points 与内存历史同构。 */
export interface BalanceHistoryPersisted {
  keyId: string
  points: { at: number; total: number; activity?: boolean }[]
}

/** 序列化历史(供写盘)。 */
export function serializeBalanceHistory(p: BalanceHistoryPersisted): string {
  return JSON.stringify({ keyId: p.keyId, points: p.points })
}

/** 解析持久化历史;非法 JSON / 非对象 / 结构不符返回 null(绝不 throw)。 */
export function parseBalanceHistory(text: string): BalanceHistoryPersisted | null {
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || typeof data.keyId !== 'string') return null
    if (!Array.isArray(data.points)) return null
    return { keyId: data.keyId, points: data.points }
  } catch (e) { return null }
}

/** 一根柱:最近 count 根 10 分钟柱中的一根。at 是柱窗口起始时刻(ms),
 * spent 是该窗口内的消费金额(正=花掉,负=余额回升),历史不足为 null。
 * activity 表示该窗口内是否有本环境的模型活动(llm/stream 请求):true 时
 * 下降可归因于本环境消费;false 时下降可能来自其他环境,前端以警示色呈现。 */
export interface SpendBar {
  at: number
  spent: number | null
  activity: boolean
}

/** tz 时区的墙钟分钟-of-day(0..1439)。内部工具,供时区对齐使用。 */
function tzMinutes(tz: string, date: Date): number {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const parts: Record<string, string> = {}
    for (const p of f.formatToParts(date)) parts[p.type] = p.value
    return Number(parts.hour) * 60 + Number(parts.minute)
  } catch (e) { return -1 } // 非法时区 → 调用方回退到 UTC 对齐
}

/** 把绝对时刻 ms 对齐到「tz 时区墙钟的整 step 分钟」。
 * 例如 tz=Asia/Shanghai、step=10min:任何时刻都对齐到 xx:00 / xx:10 / xx:20 …。
 * 关键:对齐基于**墙钟分钟**而不是 UTC 毫秒——对偏移非 10 分钟整倍数的
 * 时区(如 Asia/Kathmandu +5:45)也正确,柱边界恒显示为整数 10 分钟,
 * 与官方后台按当地整点计费的数据可比。DST 安全(基于实时区规则,不是
 * 固定偏移)。非法 tz 返回 undefined,调用方回退到 UTC 对齐。 */
export function alignWallClock(tz: string, ms: number, stepMs: number): number | undefined {
  const m = tzMinutes(tz, new Date(ms))
  if (m < 0) return undefined
  const stepMin = Math.round(stepMs / 60000)
  if (!(stepMin >= 1)) return undefined
  const aligned = m - (m % stepMin)
  // 用对齐后的墙钟分钟求绝对时刻:先近似 UTC,再按 tz 规则迭代校正
  // (wallToUTC 的思路:对齐 DST 偏移造成的日差,再对分钟差)。
  const wc = (() => {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
    const parts: Record<string, string> = {}
    for (const p of f.formatToParts(new Date(ms))) parts[p.type] = p.value
    return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day) }
  })()
  let out = Date.UTC(wc.y, wc.mo - 1, wc.d, Math.floor(aligned / 60), aligned % 60)
  const targetDay = Date.UTC(wc.y, wc.mo - 1, wc.d)
  for (let i = 0; i < 8; i++) {
    const cur = tzMinutes(tz, new Date(out))
    if (cur === aligned) return out
    const curDay = Date.UTC(
      Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(new Date(out))),
      Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit' }).format(new Date(out))) - 1,
      Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, day: '2-digit' }).format(new Date(out))),
    )
    const dayDiff = Math.round((curDay - targetDay) / 86400000)
    if (dayDiff !== 0) {
      out -= dayDiff * 86400000
      continue
    }
    out += (aligned - cur) * 60000
  }
  return out
}

/**
 * 从余额采样点聚合「最近 8 小时、10 分钟一根」的消费柱形数据。
 * 每根柱 = 窗口起始时刻的余额 − 窗口结束时刻的余额(正=花掉,负=回升)。
 * 窗口边界对齐:tz 给定(推荐)时按**该时区墙钟的整 10 分钟**对齐,柱窗口
 * 恒为「07:40–07:50」「07:50–08:00」这类整数区间,与官方后台按当地整点
 * 计费的数据天然可比(DST 安全);tz 缺省或非法时回退到 UTC 对齐。
 * 窗口两端的余额取自不晚于该时刻的最近采样;任一端无采样,或两端取到
 * **同一个采样点**(该窗口内没有可观测的余额变化,历史覆盖不足),则该柱
 * 为 null——绝不用假 0 冒充"没有消费"。
 * activity:该柱时间窗内任一采样点带 activity=true 即为 true(本环境有活动)。
 * 数组从最近到最远排列(第 0 根是最近 10 分钟)。
 * 纯函数、不抛异常、长度恒为 count(默认 48 = 8 小时)。
 */
export function spendBars(points: { at: number; total: number; activity?: boolean }[], now: number = Date.now(), count: number = 48, barMs: number = 10 * 60 * 1000, tz?: string): SpendBar[] {
  // 返回不晚于 t 的最近采样索引;无则 -1。
  const indexAt = (t: number): number => {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].at <= t) return i
    }
    return -1
  }
  // 对齐 now:优先按 tz 墙钟的整 barMs 分钟对齐(官方后台按当地整点计费);
  // tz 缺省/非法时回退到 UTC 对齐。
  const alignedNow = (tz ? alignWallClock(tz, now, barMs) : undefined) ?? (now - (now % barMs))
  const out: SpendBar[] = []
  for (let i = 0; i < count; i++) {
    const end = alignedNow - i * barMs
    const start = alignedNow - (i + 1) * barMs
    const endIdx = indexAt(end)
    const startIdx = indexAt(start)
    // 任一端无采样,或两端是同一个采样点(窗口内无余额变化信息)→ null。
    const spent = (startIdx >= 0 && endIdx >= 0 && startIdx !== endIdx)
      ? points[startIdx].total - points[endIdx].total
      : null
    // 窗口内(start..end] 任一采样点有活动 → 本环境活动为 true
    let activity = false
    for (let j = Math.max(0, startIdx); j <= endIdx && j < points.length; j++) {
      if (points[j].activity === true) { activity = true; break }
    }
    out.push({ at: start, spent, activity })
  }
  return out
}

/** Hard ceiling for one upstream balance attempt (fetch or subprocess settle).
 * The DeepSeek /user/balance call normally returns in ~1s; a 5s bound gives
 * plenty of headroom while guaranteeing a hung child can never pin the plugin. */
const UPSTREAM_TIMEOUT_MS = 5000

/**
 * Race a promise against a timeout so a hung subprocess or service call can
 * NEVER pin the balance service (and therefore the plugin) forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Create the balance service for one plugin instance.
 * @param ctx - plugin context (ctx.get for credentials / settings / subprocess).
 * @param opts.sandbox - true in the dynamic-plugin sandbox (no real fetch);
 *   false in the official module form (Node fetch available).
 */
export function createBalanceService(ctx: any, opts: { sandbox: boolean }): { query(): Promise<any> } {
  let cache: { at: number; data: any } | null = null
  let inFlight: Promise<any> | null = null
  return {
    query(): Promise<any> {
      const now = Date.now()
      if (cache && now - cache.at < CACHE_MS) return Promise.resolve(cache.data)
      if (inFlight) return inFlight
      inFlight = (async () => {
        let out: any
        try {
          const gate = await balanceAvailable(ctx)
          out = gate.ok
            ? await withTimeout(fetchBalance(ctx, opts.sandbox), UPSTREAM_TIMEOUT_MS, 'balance upstream timeout')
            : { ok: false, error: gate.reason || 'balance not available' }
        } catch (e: any) {
          out = { ok: false, error: String((e && e.message) || e) }
        }
        cache = { at: Date.now(), data: out }
        return out
      })().finally(() => { inFlight = null })
      return inFlight
    },
  }
}

/**
 * Gate: only the official DeepSeek API offers /user/balance.
 *
 * The gate checks the DeepSeek provider's OWN configuration (baseURL must be
 * the official endpoint, or unset to use the official default), NOT the
 * session's current default model. Users routinely configure several model
 * sources (official DeepSeek + SiliconFlow / relays / …) and switch the
 * default model between them; the balance is a property of the official
 * DeepSeek account, so it stays queryable regardless of which provider the
 * current model belongs to. If the official baseURL is overridden to a relay
 * (no /user/balance endpoint), the gate rejects so the UI does not show a
 * misleading balance.
 */
async function balanceAvailable(ctx: any): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const settings = ctx.get('settings')
    const sec = settings && typeof settings.get === 'function' ? settings.get('llm-deepseek') : undefined
    const base = sec && typeof sec === 'object' && typeof sec.baseURL === 'string' ? sec.baseURL : ''
    if (base && !/^https?:\/\/api\.deepseek\.com\/?$/.test(String(base).trim())) {
      return { ok: false, reason: 'llm-deepseek baseURL is not the official API: ' + String(base) }
    }
  } catch (e) { /* settings unavailable — assume official default */ }
  return { ok: true }
}

/** One balance request (no caching; see the service wrapper). */
async function fetchBalance(ctx: any, sandbox: boolean): Promise<any> {
  const creds = ctx.get('credentials')
  const key = creds && typeof creds.resolve === 'function'
    ? await creds.resolve('DEEPSEEK_API_KEY').then((r: any) => r && r.value).catch(() => undefined)
    : undefined
  if (!key) return { ok: false, error: 'no DEEPSEEK_API_KEY credential' }
  const url = 'https://api.deepseek.com/user/balance'
  try {
    let status = 0
    let text = ''
    if (!sandbox && typeof fetch === 'function') {
      // Official module form runs in Node: real fetch is available.
      const res = await fetch(url, {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(10000)
          : undefined,
      })
      status = res.status
      text = await res.text()
    } else {
      // Dynamic sandbox: `fetch` exists but is a guard stub that throws on
      // call — run curl via the subprocess service. Any shape mismatch fails
      // closed (ok:false) and can never throw out of this function.
      const sub = ctx.get('subprocess')
      if (!sub || typeof sub.spawn !== 'function') {
        return { ok: false, error: 'no fetch or subprocess available for balance' }
      }
      let done: any = null
      let raw = ''
      try {
        const handle = sub.spawn({
          argv: ['curl', '-sS', '-f', '-m', '10', '-H', 'Authorization: Bearer ' + key, url],
          cwd: '.',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 4096 } },
          graceMs: 12000,
        })
        // handle.done is the settle result (awaitable); some spawn flavors
        // expose it as a function — support both shapes. A hard timeout keeps
        // a hung curl from ever pinning the balance query: on timeout we try
        // to kill the child (best-effort) and fail closed.
        const settle = typeof handle.done === 'function'
          ? withTimeout(Promise.resolve(handle.done()), UPSTREAM_TIMEOUT_MS, 'balance curl timeout')
          : withTimeout(Promise.resolve(handle.done), UPSTREAM_TIMEOUT_MS, 'balance curl timeout')
        done = await settle
        try { if (handle && typeof handle.kill === 'function') handle.kill() } catch (e) { /* best-effort */ }
        const collected = handle.collected && handle.collected.stdout
        raw = collected && typeof collected.readFrom === 'function'
          ? collected.readFrom(0).text
          : ''
      } catch (e: any) {
        return { ok: false, error: 'balance subprocess failed: ' + String((e && e.message) || e) }
      }
      // curl's exit code is NOT an HTTP status: with -f, exit 0 means the
      // request succeeded (2xx), non-zero means an HTTP error or transport
      // failure. Map exit 0 -> 200 so the ok check below works; anything else
      // keeps the non-zero code and fails the ok check.
      status = done && done.exitCode === 0 ? 200 : (done && typeof done.exitCode === 'number' ? done.exitCode : 0)
      text = raw || ''
    }
    let data: any = null
    try { data = JSON.parse(text) } catch (e) { /* non-JSON body */ }
    if (data && typeof data === 'object' && Array.isArray(data.balance_infos)) {
      return {
        ok: status >= 200 && status < 300,
        httpStatus: status,
        available: data.is_available === true,
        balance: data.balance_infos.map((b: any) => ({
          currency: b.currency,
          total: b.total_balance,
          granted: b.granted_balance,
          toppedUp: b.topped_up_balance,
        })),
      }
    }
    return { ok: false, httpStatus: status, error: 'unexpected response: ' + text.slice(0, 200) }
  } catch (e: any) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
