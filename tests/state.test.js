/**
 * state.test.js — Unit tests for the pure state machine (src/state.ts,
 * built to dist/state.js): the global weekday switch (v1.4.4) composed with
 * the per-window `days` filter.
 *
 * Test dates (all in the configured Asia/Shanghai timezone):
 *   Tue 2026-08-18 10:00 CST  → ISO weekday 2
 *   Sat 2026-08-22 10:00 CST  → ISO weekday 6
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeRawState } from '../dist/state.js'

const base = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  warnMinutes: 5,
  windows: [{ pauseAt: '09:00', resumeAt: '12:00' }],
  endWindowUntil: 0,
  endWindowKey: null,
}
const tue10 = new Date('2026-08-18T02:00:00Z') // Tuesday 10:00 CST
const sat10 = new Date('2026-08-22T02:00:00Z') // Saturday 10:00 CST

test('state: inside a window on an active day → PAUSED', () => {
  assert.equal(computeRawState(tue10, { ...base, activeDays: [1, 2, 3, 4, 5] }).name, 'PAUSED')
})

test('state: inside a window but the day is NOT active → NORMAL (weekday-off)', () => {
  const st = computeRawState(sat10, { ...base, activeDays: [1, 2, 3, 4, 5] })
  assert.equal(st.name, 'NORMAL')
  assert.equal(st.reason, 'weekday-off')
})

test('state: empty activeDays = never pause (all days off)', () => {
  const st = computeRawState(tue10, { ...base, activeDays: [] })
  assert.equal(st.name, 'NORMAL')
  assert.equal(st.reason, 'weekday-off')
})

test('state: absent activeDays = every day applies (backward compatible)', () => {
  assert.equal(computeRawState(sat10, base).name, 'PAUSED')
})

test('state: weekend explicitly active → window applies on Saturday', () => {
  assert.equal(computeRawState(sat10, { ...base, activeDays: [6] }).name, 'PAUSED')
})

test('state: global weekday switch composes with the per-window days filter', () => {
  // Window only on weekdays + global weekdays → both must match (Tuesday: ok)
  const win = { ...base, windows: [{ pauseAt: '09:00', resumeAt: '12:00', days: [1, 2, 3, 4, 5] }] }
  assert.equal(computeRawState(tue10, { ...win, activeDays: [1, 2, 3, 4, 5] }).name, 'PAUSED')
  // Window only on Sundays + global weekdays → window's own days never match
  const winSun = { ...base, windows: [{ pauseAt: '09:00', resumeAt: '12:00', days: [7] }] }
  assert.equal(computeRawState(tue10, { ...winSun, activeDays: [1, 2, 3, 4, 5] }).name, 'NORMAL')
})

test('state: disabled stays NORMAL regardless of the weekday switch', () => {
  const st = computeRawState(tue10, { ...base, enabled: false, activeDays: [1, 2, 3, 4, 5] })
  assert.equal(st.name, 'NORMAL')
  assert.equal(st.reason, 'disabled')
})
