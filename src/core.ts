/**
 * dsh-save-money — Pure scheduling/time logic (single source of truth).
 *
 * All timezone conversion, window matching and validation helpers live here as
 * plain exported functions so they can be unit-tested (tests/core.test.js) and
 * are inlined into the Host plugin body at build time (scripts/build.js).
 * Nothing in this module touches Cordis, services, or the sandbox.
 */

export interface TimeWindow {
  pauseAt: string
  resumeAt: string
  days?: number[]
  timezone?: string
}

export interface WallClock {
  y: number
  mo: number
  d: number
  weekday: number
  minutes: number
}

export interface NextPause {
  dayOffset: number
  minutes: number
}

/** Convert a Date to wall-clock components in the given IANA timezone. */
export function wallClock(tz: string, date: Date): WallClock {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const p of f.formatToParts(date)) parts[p.type] = p.value
  const y = Number(parts.year), mo = Number(parts.month), d = Number(parts.day)
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return { y, mo, d, weekday, minutes }
}

/** Parse "HH:mm" into minutes-of-day, or null when invalid. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** Sunday (0) → 7 so ISO weekday numbering is 1..7. */
export function dowNum(wd: number): number { return wd === 0 ? 7 : wd }

/** True when the window is active at the given wall-clock time. */
export function windowMatchesAt(w: TimeWindow, wc: WallClock): boolean {
  if (w.days && w.days.length && !w.days.includes(dowNum(wc.weekday))) return false
  const p = parseHHMM(w.pauseAt), r = parseHHMM(w.resumeAt)
  if (p === null || r === null || p === r) return false
  const m = wc.minutes
  if (p < r) return m >= p && m < r
  return m >= p || m < r
}

/** Next pause offset (in days and minutes-of-day) for a window, or null. */
export function nextPause(w: TimeWindow, tz: string, wc: WallClock): NextPause | null {
  const p = parseHHMM(w.pauseAt), r = parseHHMM(w.resumeAt)
  if (p === null || r === null || p === r) return null
  for (let off = 0; off <= 8; off++) {
    const d = new Date(Date.UTC(wc.y, wc.mo - 1, wc.d + off))
    const wd = dowNum(d.getUTCDay())
    if (w.days && w.days.length && !w.days.includes(wd)) continue
    if (off === 0) {
      if (p > wc.minutes) return { dayOffset: 0, minutes: p }
      continue
    }
    return { dayOffset: off, minutes: p }
  }
  return null
}

/**
 * Convert a wall-clock HH:mm on a given date to an epoch-ms UTC instant.
 * Robust for any real offset (incl. ±12/±13h like Pacific/Auckland): first
 * align the wall-clock DATE (full-day steps), then align the minutes within
 * that day — forward-only stepping would cross days for large offsets.
 */
export function wallToUTC(tz: string, y: number, mo: number, d: number, hhmm: number): number {
  let ms = Date.UTC(y, mo - 1, d, Math.floor(hhmm / 60), hhmm % 60)
  const targetDay = Date.UTC(y, mo - 1, d)
  for (let i = 0; i < 8; i++) {
    const w = wallClock(tz, new Date(ms))
    if (w.y === y && w.mo === mo && w.d === d && w.minutes === hhmm) return ms
    const curDay = Date.UTC(w.y, w.mo - 1, w.d)
    const dayDiff = Math.round((curDay - targetDay) / 86400000)
    if (dayDiff !== 0) {
      ms -= dayDiff * 86400000
      continue
    }
    ms += (hhmm - w.minutes) * 60000
  }
  return ms
}

/** Format minutes-of-day as "HH:mm" (zero-padded). */
export function formatHHMM(m: number): string {
  const h = Math.floor(m / 60)
  const mi = m % 60
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
}

/**
 * Convert a wall-clock HH:mm from one IANA timezone to another, using the
 * given reference date (default: now) so real timezone rules apply
 * (daylight-saving aware). The result keeps the same absolute instant:
 * Beijing 08:58 on a summer day becomes London 01:58, on a winter day 00:58.
 */
export function convertHHMM(tzFrom: string, tzTo: string, hhmm: number, ref?: Date): number {
  const date = ref || new Date()
  const wc = wallClock(tzFrom, date)
  const ms = wallToUTC(tzFrom, wc.y, wc.mo, wc.d, hhmm)
  return wallClock(tzTo, new Date(ms)).minutes
}

/**
 * UTC offset of a timezone at the given instant, in minutes (DST-aware).
 * Correct at minute precision: interpret the timezone's wall-clock minute as
 * if it were UTC, and subtract the real UTC instant that wall-clock minute
 * maps to. E.g. Asia/Shanghai -> 480, Europe/London -> 60 in summer / 0 in
 * winter, America/New_York -> -240 in summer / -300 in winter.
 */
export function utcOffsetMinutes(tz: string, date: Date): number {
  const wc = wallClock(tz, date)
  const tzMs = wallToUTC(tz, wc.y, wc.mo, wc.d, wc.minutes)
  const utcMs = Date.UTC(wc.y, wc.mo - 1, wc.d, Math.floor(wc.minutes / 60), wc.minutes % 60)
  return Math.round((utcMs - tzMs) / 60000)
}

/** True when the string is a valid IANA timezone name. */
export function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch (e) { return false }
}

/** Window as half-open minute ranges (handles midnight-crossing). */
function rangesOf(w: TimeWindow): [number, number][] {
  const p = parseHHMM(w.pauseAt)!, r = parseHHMM(w.resumeAt)!
  if (p < r) return [[p, r]]
  return [[p, 1440], [0, r]]
}

function rangesIntersect(a: [number, number][], b: [number, number][]): boolean {
  for (const sa of a) for (const sb of b) {
    if (sa[0] < sb[1] && sb[0] < sa[1]) return true
  }
  return false
}

function daysOverlap(a: TimeWindow, b: TimeWindow): boolean {
  const da = (a.days && a.days.length) ? a.days : [1, 2, 3, 4, 5, 6, 7]
  const db = (b.days && b.days.length) ? b.days : [1, 2, 3, 4, 5, 6, 7]
  return da.some((d) => db.includes(d))
}

export interface ValidationResult {
  ok: boolean
  error?: string
}

/**
 * Validate a windows array: shape, HH:mm syntax, pause != resume, IANA
 * timezone, days 1-7, and same-timezone overlap (incl. midnight-crossing and
 * weekday-intersection cases).
 */
export function validateWindows(windows: TimeWindow[], defaultTz: string): ValidationResult {
  if (!Array.isArray(windows)) return { ok: false, error: 'windows must be an array' }
  for (const w of windows) {
    if (!w || typeof w !== 'object') return { ok: false, error: 'window must be an object' }
    if (parseHHMM(w.pauseAt) === null || parseHHMM(w.resumeAt) === null) {
      return { ok: false, error: 'bad HH:mm in window ' + JSON.stringify(w) }
    }
    if (parseHHMM(w.pauseAt) === parseHHMM(w.resumeAt)) {
      return { ok: false, error: 'pauseAt == resumeAt in window ' + JSON.stringify(w) }
    }
    if (w.timezone !== undefined && !isValidTz(w.timezone)) {
      return { ok: false, error: 'invalid IANA timezone: ' + w.timezone }
    }
    if (w.days !== undefined && (!Array.isArray(w.days) || !w.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7))) {
      return { ok: false, error: 'days must be array of 1-7' }
    }
  }
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i], b = windows[j]
      const aTz = a.timezone || defaultTz, bTz = b.timezone || defaultTz
      if (aTz !== bTz) continue
      if (!daysOverlap(a, b)) continue
      if (rangesIntersect(rangesOf(a), rangesOf(b))) {
        return { ok: false, error: 'overlapping windows: ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b) }
      }
    }
  }
  return { ok: true }
}
