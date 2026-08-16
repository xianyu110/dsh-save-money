/**
 * core.test.js — Unit tests for the pure scheduling/time logic.
 *
 * The functions under test live in src/core.ts (single source of truth) and
 * are exercised through the built dist/core.js. Run with: npm test
 * (builds first, then `node --test tests/`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseHHMM,
  wallClock,
  windowMatchesAt,
  nextPause,
  wallToUTC,
  isValidTz,
  validateWindows,
  formatHHMM,
  convertHHMM,
  utcOffsetMinutes,
} from '../dist/core.js'

// --- parseHHMM -------------------------------------------------------------

test('parseHHMM: valid times become minutes-of-day', () => {
  assert.equal(parseHHMM('00:00'), 0)
  assert.equal(parseHHMM('09:00'), 540)
  assert.equal(parseHHMM('9:00'), 540) // single-digit hour is accepted
  assert.equal(parseHHMM('23:59'), 1439)
  assert.equal(parseHHMM(' 08:30 '), 510) // trims whitespace
})

test('parseHHMM: rejects malformed or out-of-range times', () => {
  assert.equal(parseHHMM('9:5'), null) // minute must be zero-padded
  assert.equal(parseHHMM('24:00'), null)
  assert.equal(parseHHMM('12:60'), null)
  assert.equal(parseHHMM('noon'), null)
  assert.equal(parseHHMM(''), null)
})

// --- windowMatchesAt --------------------------------------------------------

test('windowMatchesAt: matches inside a normal window, not outside', () => {
  const w = { pauseAt: '09:00', resumeAt: '12:00' }
  assert.equal(windowMatchesAt(w, { y: 2026, mo: 8, d: 15, weekday: 6, minutes: 540 }), true)
  assert.equal(windowMatchesAt(w, { y: 2026, mo: 8, d: 15, weekday: 6, minutes: 720 }), false) // 12:00 = end, exclusive
  assert.equal(windowMatchesAt(w, { y: 2026, mo: 8, d: 15, weekday: 6, minutes: 539 }), false)
})

test('windowMatchesAt: handles midnight-crossing windows', () => {
  const w = { pauseAt: '23:00', resumeAt: '08:00' }
  assert.equal(windowMatchesAt(w, { y: 2026, mo: 8, d: 15, weekday: 6, minutes: 1410 }), true) // 23:30
  assert.equal(windowMatchesAt(w, { y: 2026, mo: 8, d: 16, weekday: 7, minutes: 60 }), true) // next day 01:00
  assert.equal(windowMatchesAt(w, { y: 2026, mo: 8, d: 16, weekday: 7, minutes: 480 }), false) // 08:00, exclusive
})

test('windowMatchesAt: respects the weekday filter', () => {
  const w = { pauseAt: '09:00', resumeAt: '12:00', days: [1, 2, 3, 4, 5] } // Mon-Fri
  assert.equal(windowMatchesAt(w, { y: 2026, mo: 8, d: 17, weekday: 1, minutes: 600 }), true) // Monday
  assert.equal(windowMatchesAt(w, { y: 2026, mo: 8, d: 15, weekday: 6, minutes: 600 }), false) // Saturday
})

// --- nextPause --------------------------------------------------------------

test('nextPause: reports today or the next day offset', () => {
  const w = { pauseAt: '09:00', resumeAt: '12:00' }
  const morning = wallClock('Asia/Shanghai', new Date('2026-08-15T00:00:00Z')) // 08:00 Beijing, before the window
  assert.equal(nextPause(w, 'Asia/Shanghai', morning).dayOffset, 0)
  assert.equal(nextPause(w, 'Asia/Shanghai', morning).minutes, 540)
  // Exactly at the pause instant the window is already open; the next pause is tomorrow.
  const atPause = wallClock('Asia/Shanghai', new Date('2026-08-15T01:00:00Z')) // 09:00 Beijing
  assert.equal(nextPause(w, 'Asia/Shanghai', atPause).dayOffset, 1)
  const afternoon = wallClock('Asia/Shanghai', new Date('2026-08-15T10:00:00Z')) // 18:00 Beijing
  assert.equal(nextPause(w, 'Asia/Shanghai', afternoon).dayOffset, 1)
})

// --- wallToUTC --------------------------------------------------------------

test('wallToUTC: Beijing 09:00 equals UTC 01:00', () => {
  const utc = wallToUTC('Asia/Shanghai', 2026, 8, 15, 540)
  assert.equal(new Date(utc).toISOString(), '2026-08-15T01:00:00.000Z')
})

// --- isValidTz --------------------------------------------------------------

test('isValidTz: accepts real IANA names, rejects junk', () => {
  assert.equal(isValidTz('Asia/Shanghai'), true)
  assert.equal(isValidTz('UTC'), true)
  assert.equal(isValidTz('Mars/Olympus'), false)
  assert.equal(isValidTz(''), false)
})

// --- validateWindows ---------------------------------------------------------

test('validateWindows: accepts a valid window list', () => {
  const windows = [
    { pauseAt: '08:58', resumeAt: '12:02', timezone: 'Asia/Shanghai' },
    { pauseAt: '13:58', resumeAt: '18:02', timezone: 'Asia/Shanghai' },
  ]
  assert.deepEqual(validateWindows(windows, 'Asia/Shanghai'), { ok: true })
})

test('validateWindows: rejects same-timezone overlaps (incl. midnight-crossing)', () => {
  const overlap = [
    { pauseAt: '09:00', resumeAt: '12:00' },
    { pauseAt: '11:00', resumeAt: '14:00' },
  ]
  assert.equal(validateWindows(overlap, 'Asia/Shanghai').ok, false)

  const midnightOverlap = [
    { pauseAt: '23:00', resumeAt: '08:00' },
    { pauseAt: '06:00', resumeAt: '10:00' },
  ]
  assert.equal(validateWindows(midnightOverlap, 'Asia/Shanghai').ok, false)
})

test('validateWindows: different timezones may overlap freely', () => {
  const windows = [
    { pauseAt: '09:00', resumeAt: '12:00', timezone: 'Asia/Shanghai' },
    { pauseAt: '09:00', resumeAt: '12:00', timezone: 'UTC' },
  ]
  assert.deepEqual(validateWindows(windows, 'Asia/Shanghai'), { ok: true })
})

test('validateWindows: rejects malformed windows', () => {
  assert.equal(validateWindows([{ pauseAt: '09:00', resumeAt: '09:00' }], 'Asia/Shanghai').ok, false) // pause == resume
  assert.equal(validateWindows([{ pauseAt: '25:00', resumeAt: '12:00' }], 'Asia/Shanghai').ok, false) // bad HH:mm
  assert.equal(validateWindows([{ pauseAt: '09:00', resumeAt: '12:00', timezone: 'Nope/Nowhere' }], 'Asia/Shanghai').ok, false)
  assert.equal(validateWindows([{ pauseAt: '09:00', resumeAt: '12:00', days: [8] }], 'Asia/Shanghai').ok, false) // day out of range
  assert.equal(validateWindows('nope', 'Asia/Shanghai').ok, false)
})

// --- formatHHMM -------------------------------------------------------------

test('formatHHMM: minutes-of-day to zero-padded HH:mm', () => {
  assert.equal(formatHHMM(0), '00:00')
  assert.equal(formatHHMM(540), '09:00')
  assert.equal(formatHHMM(538), '08:58')
  assert.equal(formatHHMM(1439), '23:59')
})

// --- convertHHMM ------------------------------------------------------------

test('convertHHMM: Beijing to London follows real timezone rules (DST-aware)', () => {
  // Summer (BST, UTC+1): Beijing 08:58 == London 01:58
  const summer = new Date('2026-07-15T00:00:00Z')
  assert.equal(convertHHMM('Asia/Shanghai', 'Europe/London', 538, summer), 118) // 01:58
  // Winter (GMT, UTC+0): Beijing 08:58 == London 00:58
  const winter = new Date('2026-01-15T00:00:00Z')
  assert.equal(convertHHMM('Asia/Shanghai', 'Europe/London', 538, winter), 58) // 00:58
})

test('convertHHMM: Beijing DeepSeek windows map to London wall clock', () => {
  const summer = new Date('2026-07-15T00:00:00Z')
  // 08:58-12:02 -> 01:58-05:02 ; 13:58-18:02 -> 06:58-11:02
  assert.deepEqual(
    [538, 722, 838, 1082].map((m) => convertHHMM('Asia/Shanghai', 'Europe/London', m, summer)),
    [118, 302, 418, 662],
  )
})

test('convertHHMM: midnight-crossing windows keep their span', () => {
  const summer = new Date('2026-07-15T00:00:00Z')
  // Beijing 23:00-08:00 -> London 16:00-01:00 (same absolute period, order preserved)
  const p = convertHHMM('Asia/Shanghai', 'Europe/London', 1380, summer) // 23:00
  const r = convertHHMM('Asia/Shanghai', 'Europe/London', 480, summer) // 08:00
  assert.equal(p, 960) // 16:00
  assert.equal(r, 60) // 01:00 (next day)
  assert.ok(p > r) // still crosses midnight
})

test('convertHHMM: fixed-offset zones and identity', () => {
  const d = new Date('2026-07-15T00:00:00Z')
  assert.equal(convertHHMM('Asia/Tokyo', 'Asia/Shanghai', 540, d), 480) // 09:00 JST == 08:00 CST
  assert.equal(convertHHMM('Asia/Shanghai', 'Asia/Shanghai', 538, d), 538) // identity
  assert.equal(convertHHMM('UTC', 'UTC', 0, d), 0) // identity
})

test('convertHHMM: round-trip is consistent within the same day', () => {
  const summer = new Date('2026-07-15T00:00:00Z')
  const winter = new Date('2026-01-15T00:00:00Z')
  for (const ref of [summer, winter]) {
    for (const m of [0, 1, 118, 538, 722, 838, 1380, 1439]) {
      const there = convertHHMM('Asia/Shanghai', 'Europe/London', m, ref)
      const back = convertHHMM('Europe/London', 'Asia/Shanghai', there, ref)
      assert.equal(back, m, 'round-trip failed for ' + m + ' at ' + ref.toISOString())
    }
  }
})

test('convertHHMM: DST transition days in London (BST starts late March, ends late October)', () => {
  // 2026-03-28: still GMT (UTC+0) -> 08:58 Beijing == 00:58 London
  assert.equal(convertHHMM('Asia/Shanghai', 'Europe/London', 538, new Date('2026-03-28T00:00:00Z')), 58)
  // 2026-03-30: BST (UTC+1) -> 08:58 Beijing == 01:58 London
  assert.equal(convertHHMM('Asia/Shanghai', 'Europe/London', 538, new Date('2026-03-30T00:00:00Z')), 118)
  // 2026-10-24: still BST -> 01:58
  assert.equal(convertHHMM('Asia/Shanghai', 'Europe/London', 538, new Date('2026-10-24T00:00:00Z')), 118)
  // 2026-10-26: back to GMT -> 00:58
  assert.equal(convertHHMM('Asia/Shanghai', 'Europe/London', 538, new Date('2026-10-26T00:00:00Z')), 58)
})

test('convertHHMM: New York and Sydney follow their own DST', () => {
  const summer = new Date('2026-07-15T00:00:00Z') // NY EDT (UTC-4), Sydney AEST (UTC+10)
  const winter = new Date('2026-01-15T00:00:00Z') // NY EST (UTC-5), Sydney AEDT (UTC+11)
  // Beijing 08:58 -> New York 20:58 (EDT) / 19:58 (EST), previous day
  assert.equal(convertHHMM('Asia/Shanghai', 'America/New_York', 538, summer), 1258)
  assert.equal(convertHHMM('Asia/Shanghai', 'America/New_York', 538, winter), 1198)
  // Beijing 08:58 -> Sydney 10:58 (AEST, UTC+10) / 11:58 (AEDT, UTC+11)
  assert.equal(convertHHMM('Asia/Shanghai', 'Australia/Sydney', 538, summer), 658)
  assert.equal(convertHHMM('Asia/Shanghai', 'Australia/Sydney', 538, winter), 718)
})

test('convertHHMM: half-hour and :45 offsets', () => {
  const d = new Date('2026-07-15T00:00:00Z')
  // India UTC+5:30: Beijing 08:58 == 06:28 IST
  assert.equal(convertHHMM('Asia/Shanghai', 'Asia/Kolkata', 538, d), 388)
  // Nepal UTC+5:45: Beijing 08:58 == 06:43 NPT
  assert.equal(convertHHMM('Asia/Shanghai', 'Asia/Kathmandu', 538, d), 403)
})

test('convertHHMM: reverse direction London -> Beijing', () => {
  const summer = new Date('2026-07-15T00:00:00Z')
  // London 01:58 (BST) == Beijing 08:58 ; London 00:58 (GMT, winter) == Beijing 08:58
  assert.equal(convertHHMM('Europe/London', 'Asia/Shanghai', 118, summer), 538)
  assert.equal(convertHHMM('Europe/London', 'Asia/Shanghai', 58, new Date('2026-01-15T00:00:00Z')), 538)
})

// --- utcOffsetMinutes --------------------------------------------------------

test('utcOffsetMinutes: fixed offsets and identity', () => {
  const d = new Date('2026-07-15T00:00:00Z')
  assert.equal(utcOffsetMinutes('UTC', d), 0)
  assert.equal(utcOffsetMinutes('Asia/Shanghai', d), 480) // UTC+8
  assert.equal(utcOffsetMinutes('Asia/Tokyo', d), 540) // UTC+9
})

test('utcOffsetMinutes: DST-aware offsets (summer vs winter)', () => {
  const summer = new Date('2026-07-15T00:00:00Z')
  const winter = new Date('2026-01-15T00:00:00Z')
  assert.equal(utcOffsetMinutes('Europe/London', summer), 60) // BST
  assert.equal(utcOffsetMinutes('Europe/London', winter), 0) // GMT
  assert.equal(utcOffsetMinutes('America/New_York', summer), -240) // EDT
  assert.equal(utcOffsetMinutes('America/New_York', winter), -300) // EST
  assert.equal(utcOffsetMinutes('Australia/Sydney', summer), 600) // AEST
  assert.equal(utcOffsetMinutes('Australia/Sydney', winter), 660) // AEDT
})

test('utcOffsetMinutes: ±12/13h boundaries (Pacific/Auckland)', () => {
  // July (southern winter) = NZST UTC+12 — the exact ±12h boundary that
  // used to be mis-converged by wallToUTC.
  assert.equal(utcOffsetMinutes('Pacific/Auckland', new Date('2026-07-15T00:00:00Z')), 720)
  // January (southern summer) = NZDT UTC+13
  assert.equal(utcOffsetMinutes('Pacific/Auckland', new Date('2026-01-15T00:00:00Z')), 780)
})
