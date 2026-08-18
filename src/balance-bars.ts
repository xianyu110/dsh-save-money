/**
 * dsh-save-money — Model classification + spend bars (Host side).
 *
 * Two pure logic groups:
 *  - classifyModel / modelApplyEnabled: which model tier a request belongs to
 *    and whether that tier is checked in the save-mode config (checked = pause
 *    inside windows, unchecked = exempt). Used by the request gate.
 *  - spendBars / alignWallClock: aggregate balance samples into per-10-minute
 *    spend bars aligned to wall-clock boundaries in the configured timezone.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive, so cross-module references are `declare`d for standalone
 * type-checking and resolve to the inlined scope at runtime.
 */

/** One bar: a 10-minute spend window. at = window start (ms), spent = spend
 * in that window (positive = spent, negative = balance top-up), null when
 * history is insufficient. activity = whether this environment produced model
 * requests in the window (true → a drop is attributable to local spend; false
 * → it may come from elsewhere, the UI shows it in the warn color). */
export interface SpendBar {
  at: number
  spent: number | null
  activity: boolean
}

/**
 * Model tier classification: only models clearly identified as official /
 * OpenCode with a flash/pro tier enter the gate's tier check; null means the
 * recognition failed → exempt (never paused).
 */
export type ModelClass =
  | 'official-flash'
  | 'official-pro'
  | 'opencode-flash'
  | 'opencode-pro'
  | null

/** Official DeepSeek provider route name (hard-coded by the harness). */
export const OFFICIAL_PROVIDER = 'deepseek-official'

/**
 * Classify a request's tier from the provider name + model name. Pure
 * function, never throws:
 *  - Provider: lowercase contains 'opencode' → OpenCode (the go/zen gateway
 *    reuses the same route); provider === 'deepseek-official' → official;
 *    anything else → null (exempt).
 *  - Tier: model name lowercase contains 'pro' → pro; contains 'flash' →
 *    flash; otherwise null (exempt, including the legacy chat/reasoner names
 *    and unknown models — only explicit flash/pro can ever be paused).
 * Any input shape (undefined / non-string) safely returns null.
 */
export function classifyModel(provider: any, model: any): ModelClass {
  const p = typeof provider === 'string' ? provider.toLowerCase() : ''
  const m = typeof model === 'string' ? model.toLowerCase() : ''
  if (p.length === 0 || m.length === 0) return null
  const isPro = m.indexOf('pro') >= 0
  const isFlash = m.indexOf('flash') >= 0
  if (!isPro && !isFlash) return null // unknown → exempt
  if (p === OFFICIAL_PROVIDER) return isPro ? 'official-pro' : 'official-flash'
  if (p.indexOf('opencode') >= 0) return isPro ? 'opencode-pro' : 'opencode-flash'
  return null // other third parties → exempt (they have no DeepSeek peak pricing)
}

/**
 * Whether a tier is checked in the current modelApply config (should save).
 * Missing/corrupt config returns false (safe direction: no pause); a null
 * tier is always false.
 */
export function modelApplyEnabled(applied: any, cls: ModelClass): boolean {
  if (!applied || typeof applied !== 'object' || cls === null) return false
  return applied[cls] === true
}

/** Wall-clock minutes-of-day (0..1439) for tz. Internal helper for tz alignment. */
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
  } catch (e) { return -1 } // invalid tz → caller falls back to UTC alignment
}

/** Align an absolute instant ms to "whole `step` minutes of the tz wall
 * clock". E.g. tz=Asia/Shanghai, step=10min: any instant aligns to
 * xx:00 / xx:10 / xx:20 …. Key point: alignment is based on the WALL-CLOCK
 * minute, not UTC milliseconds — timezones whose offset is not a multiple of
 * 10 minutes (e.g. Asia/Kathmandu +5:45) are still correct, and bar
 * boundaries always display as integer 10 minutes, comparable with the
 * official local per-hour billing. DST-safe (real timezone rules, not a fixed
 * offset). Returns undefined for an invalid tz (caller falls back to UTC). */
export function alignWallClock(tz: string, ms: number, stepMs: number): number | undefined {
  const m = tzMinutes(tz, new Date(ms))
  if (m < 0) return undefined
  const stepMin = Math.round(stepMs / 60000)
  if (!(stepMin >= 1)) return undefined
  const aligned = m - (m % stepMin)
  // Reconstruct the absolute instant from the aligned wall-clock minute:
  // start from an approximate UTC guess, then correct iteratively by the tz
  // rules (wallToUTC's approach: fix the day difference from DST offsets,
  // then the minute difference).
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
 * Aggregate balance samples into "last 8 hours, one bar per 10 minutes" spend
 * data. Each bar = balance at window start − balance at window end (positive =
 * spent, negative = top-up). Window boundaries: with tz given (recommended)
 * they align to the INTEGER 10-minute marks of that tz's wall clock, so bars
 * are always "07:40–07:50" / "07:50–08:00" intervals, naturally comparable
 * with the official local per-hour billing (DST-safe); without tz (or invalid
 * tz) it falls back to UTC alignment. Each end's balance is the nearest sample
 * not later than that instant; if either end has no sample, or both ends land
 * on the SAME sample (no observable balance change inside the window, history
 * too thin), the bar is null — never a fake 0 pretending "no spend".
 * activity: true when any sample inside the window carries activity=true.
 * The array runs newest-first (index 0 = the most recent 10 minutes).
 * Pure function, never throws, length always `count` (default 48 = 8 hours).
 */
export function spendBars(points: { at: number; total: number; activity?: boolean }[], now: number = Date.now(), count: number = 48, barMs: number = 10 * 60 * 1000, tz?: string): SpendBar[] {
  // Index of the nearest sample not later than t; -1 when none.
  const indexAt = (t: number): number => {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].at <= t) return i
    }
    return -1
  }
  // Align now: prefer the tz wall-clock integer barMs marks (official billing
  // uses local whole hours); fall back to UTC alignment without tz / invalid tz.
  const alignedNow = (tz ? alignWallClock(tz, now, barMs) : undefined) ?? (now - (now % barMs))
  const out: SpendBar[] = []
  for (let i = 0; i < count; i++) {
    const end = alignedNow - i * barMs
    const start = alignedNow - (i + 1) * barMs
    const endIdx = indexAt(end)
    const startIdx = indexAt(start)
    // Either end has no sample, or both ends are the same sample (no balance
    // change info inside the window) → null.
    const spent = (startIdx >= 0 && endIdx >= 0 && startIdx !== endIdx)
      ? points[startIdx].total - points[endIdx].total
      : null
    // Any sample with activity=true inside the window (start..end] → local activity
    let activity = false
    for (let j = Math.max(0, startIdx); j <= endIdx && j < points.length; j++) {
      if (points[j].activity === true) { activity = true; break }
    }
    out.push({ at: start, spent, activity })
  }
  return out
}
