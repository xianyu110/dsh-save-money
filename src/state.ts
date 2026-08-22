/**
 * dsh-save-money — Pure state machine (window scheduling decisions).
 *
 * computeRawState decides the plugin's state (NORMAL / WARN / PAUSED) from the
 * config + "end this save mode" in-memory state. Pure and side-effect free —
 * the caller (host.ts onTick) owns the mutable endWindow/lastState state and
 * performs the freeze/resume side effects. Extracted from src/host.ts so this
 * decision logic is independently testable.
 *
 * Inlined into the Host plugin body at build time (scripts/build.js), same as
 * src/core.ts / src/balance-host.ts / src/config.ts: the `import` below is
 * stripped by the inline pass (stripExports) and resolves to the same-scope
 * core helpers at runtime, while dist/state.js stays a runnable ESM module
 * (it imports core.js) for the unit tests.
 */

import { wallClock, windowMatchesAt, nextPause, dowNum } from './core.js'
import type { TimeWindow } from './core.js'

export interface RawState {
  name: 'NORMAL' | 'WARN' | 'PAUSED'
  reason?: string
  window?: TimeWindow
  minutesToPause?: number
}

/** Immutable inputs the state machine reads (snapshot of the live config). */
export interface StateInput {
  enabled: boolean
  timezone: string
  warnMinutes: number
  windows: TimeWindow[]
  /** Global weekday switch (ISO 1-7): saving only applies on these days.
   * Empty/absent = every day. Composed with each window's own `days` field
   * (both must match for a window to apply). */
  activeDays?: number[]
  /** "End this save mode" — only affects the exact window whose key matches. */
  endWindowUntil: number
  endWindowKey: string | null
}

/** Window identity key (pauseAt|resumeAt|timezone) used by end-this-save-mode. */
export function windowKey(w: TimeWindow, tz: string): string {
  return w.pauseAt + '|' + w.resumeAt + '|' + (w.timezone || tz)
}

/**
 * Decide the raw plugin state at `now`.
 *
 * Order: disabled → NORMAL; today (in the configured timezone) not in the
 * global weekday switch → NORMAL; inside a window → PAUSED (unless that
 * window is ended via end-this-save-mode → NORMAL); an upcoming window within
 * warnMinutes → WARN; otherwise NORMAL. Pure — reads only `input`.
 */
export function computeRawState(now: Date, input: StateInput): RawState {
  const { enabled, timezone, warnMinutes, windows, activeDays, endWindowUntil, endWindowKey } = input
  if (!enabled) return { name: 'NORMAL', reason: 'disabled' }
  // Global weekday switch (v1.4.4): weekends off-peak all day → no saving
  // unless the day is checked. Empty array = no active day = never pause;
  // absent/undefined = every day applies. Uses the CONFIG timezone's today.
  if (activeDays && !activeDays.includes(dowNum(wallClock(timezone, now).weekday))) {
    return { name: 'NORMAL', reason: 'weekday-off' }
  }
  for (const w of windows) {
    const tz = w.timezone || timezone
    if (windowMatchesAt(w, wallClock(tz, now))) {
      // "End this save mode" only affects the exact window it was applied to —
      // a stale endWindowUntil must not suppress later windows.
      if (endWindowUntil > now.getTime() && endWindowKey === windowKey(w, tz)) return { name: 'NORMAL', reason: 'ended', window: w }
      return { name: 'PAUSED', window: w }
    }
  }
  let nearest: { delta: number; window: TimeWindow } | null = null
  for (const w of windows) {
    const tz = w.timezone || timezone
    const wc = wallClock(tz, now)
    const np = nextPause(w, tz, wc)
    if (!np) continue
    const delta = np.dayOffset * 1440 + np.minutes - wc.minutes
    if (nearest === null || delta < nearest.delta) nearest = { delta, window: w }
  }
  if (nearest !== null && nearest.delta > 0 && nearest.delta <= warnMinutes) {
    // The upcoming window may already be ended via "end this save mode"
    // (clicked while WARN) — suppress the warning until the window's resumeAt.
    if (endWindowUntil > now.getTime() && endWindowKey === windowKey(nearest.window, nearest.window.timezone || timezone)) {
      return { name: 'NORMAL', reason: 'ended', window: nearest.window }
    }
    return { name: 'WARN', window: nearest.window, minutesToPause: nearest.delta }
  }
  return { name: 'NORMAL', reason: 'no-window' }
}
