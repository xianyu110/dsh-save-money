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
