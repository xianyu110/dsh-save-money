/**
 * dsh-save-money — Balance history (sampling queue + persistence), Host side.
 *
 * A fixed-size queue of balance samples (one per 5-minute wall-clock window,
 * up to 288 points = 24 hours), used to derive "how much was spent in the
 * last 1 hour / 10 minutes / 24 hours" from balance changes, plus the
 * account-level persistence file (~/.dsh/dsh-save-money-balance.json).
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive, so cross-module references are `declare`d for standalone
 * type-checking and resolve to the inlined scope at runtime.
 */

/** Balance sampling period: the backend records the balance every 5 minutes. */
export const SAMPLE_MS = 5 * 60 * 1000
/** Sample cap: 5min × 288 = 24 hours. */
export const HISTORY_LEN = 288

/**
 * Balance history queue: one sample per 5 minutes, keeps the last 24 hours.
 * Purpose: derive "spend in the last 1h / 10min / 24h" from balance changes.
 *
 * Anti-growth guarantees (hard ceiling, no input can ever break through):
 *  - record() validates input first: non-finite numbers (NaN / ±Infinity /
 *    non-numbers) are ignored, never enqueued, cannot pollute latest()/spend().
 *  - A second record() inside the same 5-minute window only updates the
 *    newest value (no new point).
 *  - Out-of-order timestamps (going backwards) never add a point: at <=
 *    last.at is treated as a same-window update, so out-of-order pushes can
 *    never break the ascending order; only strictly increasing gaps >=
 *    SAMPLE_MS add a point.
 *  - After a push the array is immediately trimmed to HISTORY_LEN with one
 *    splice — even a batch push peaks at HISTORY_LEN + batch size, and
 *    splice(0, overflow) happens exactly once. The current call path pushes
 *    1 point at a time, so the actual peak is always HISTORY_LEN + 1 = 289,
 *    then back to 288.
 */
export function createBalanceHistory() {
  const points: { at: number; total: number; activity?: boolean }[] = []
  const pushPoint = (at: number, total: number, activity: boolean | undefined) => {
    points.push({ at, total, ...(activity === undefined ? {} : { activity }) })
    if (points.length > HISTORY_LEN) {
      points.splice(0, points.length - HISTORY_LEN) // trim all overflow at once
    }
  }
  return {
    record(total: number, at: number = Date.now(), activity?: boolean): void {
      if (typeof at !== 'number' || !Number.isFinite(at)) return
      if (typeof total !== 'number' || !Number.isFinite(total)) return
      // Align the sample to an integer 5-minute boundary (07:42:37 → 07:40):
      // every timezone offset is a whole number of minutes, so
      // ms % SAMPLE_MS == 0 lands on an integer 5-minute mark in every zone —
      // aligned with the wall clock, comparable with the official per-hour
      // billing. After alignment, repeated records in the same window share
      // one `at` and naturally fall into the same-window update branch.
      at = at - (at % SAMPLE_MS)
      const last = points[points.length - 1]
      // Out-of-order (backwards or same instant) always updates in place,
      // never adds: keeps the array ascending by `at`.
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
    /** Latest balance, or null when nothing has been sampled yet. */
    latest(): number | null {
      return points.length > 0 ? points[points.length - 1].total : null
    },
    /** Balance at `now - ms` (nearest sample not later than that instant); null when history is too short. */
    totalAgo(ms: number, now: number = Date.now()): number | null {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || typeof now !== 'number' || !Number.isFinite(now)) return null
      const target = now - ms
      for (let i = points.length - 1; i >= 0; i--) {
        if (points[i].at <= target) return points[i].total
      }
      return null
    },
    /** Spend over the last `ms` (positive = spent; balance top-up = negative); null when history is too short. */
    spend(ms: number, now: number = Date.now()): number | null {
      const cur = this.latest()
      const prev = this.totalAgo(ms, now)
      if (cur === null || prev === null) return null
      return prev - cur
    },
    /** All current samples (debug/display). */
    points(): { at: number; total: number; activity?: boolean }[] {
      return points.slice()
    },
    /** Replace the whole history with persisted data (startup); empty/invalid input is ignored. */
    load(persisted: { at: number; total: number; activity?: boolean }[]): void {
      if (!Array.isArray(persisted) || persisted.length === 0) return
      const clean: { at: number; total: number; activity?: boolean }[] = []
      for (const p of persisted) {
        if (!p || typeof p.at !== 'number' || !Number.isFinite(p.at)) continue
        if (typeof p.total !== 'number' || !Number.isFinite(p.total)) continue
        // Align to an integer 5-minute boundary (same as record): old versions
        // may have stored arbitrary instants; unify on load.
        const aligned = p.at - (p.at % SAMPLE_MS)
        clean.push({ at: aligned, total: p.total, ...(p.activity === undefined ? {} : { activity: !!p.activity }) })
      }
      if (clean.length === 0) return
      // Ascending order (the persisted file may be out of order)
      clean.sort((a, b) => a.at - b.at)
      // Dedupe (same instant keeps the last entry)
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
 * Account fingerprint: FNV-1a 32-bit hash of the DeepSeek API key (first 8 hex
 * chars). Only used to compare "new key = new account = old history is
 * invalid"; NOT a security primitive (the key itself never enters the
 * persisted file and cannot be recovered from this hash).
 */
export function keyFingerprint(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Balance history persistence file name (under the user home ~/.dsh, account-level, shared across projects). */
export const BALANCE_HISTORY_FILE = 'dsh-save-money-balance.json'

/** Persisted file shape: keyId is the account fingerprint, points mirror the in-memory history. */
export interface BalanceHistoryPersisted {
  keyId: string
  points: { at: number; total: number; activity?: boolean }[]
}

/** Serialize the history (for writing to disk). */
export function serializeBalanceHistory(p: BalanceHistoryPersisted): string {
  return JSON.stringify({ keyId: p.keyId, points: p.points })
}

/** Parse persisted history; invalid JSON / non-object / wrong shape returns null (never throws). */
export function parseBalanceHistory(text: string): BalanceHistoryPersisted | null {
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || typeof data.keyId !== 'string') return null
    if (!Array.isArray(data.points)) return null
    return { keyId: data.keyId, points: data.points }
  } catch (e) { return null }
}
