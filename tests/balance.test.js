/**
 * balance.test.js — Unit tests for the balance modules (dist/balance-host.js,
 * dist/balance-client.js), the standalone feature modules split out of the
 * plugin bodies so the balance feature can grow independently.
 *
 * Run with: npm test (builds first, then `node --test tests/`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBalanceService } from '../dist/balance-host.js'
import { createBalanceHistory, keyFingerprint, serializeBalanceHistory, parseBalanceHistory, SAMPLE_MS, HISTORY_LEN } from '../dist/balance-history.js'
import { spendBars, alignWallClock, classifyModel, modelApplyEnabled } from '../dist/balance-bars.js'

/** Aligned base time: divisible by 5 and 10 minutes (1699999800000 % 300000 == 0).
 * All time tests start from it, avoiding boundary drift from sample/bar alignment. */
const T0 = 1_699_999_800_000
import { pickBalance, currencySymbol, balanceTitle, balanceDetailLines, renderBalanceElement } from '../dist/balance-client.js'

/** Fake ctx for host-side tests; returns per-service values from a map. */
function makeHostCtx(map) {
  return { get: (name) => (map[name] !== undefined ? map[name] : undefined) }
}

function goodSpawn(calls) {
  return {
    spawn(spec) {
      calls.push(spec ? spec.argv : ['spawn'])
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' }],
          }) }) },
        },
      }
    },
  }
}

// ---- dist/balance-host.js ----

test('balance-host: official baseURL (or unset) keeps balance queryable regardless of the current default model provider', async () => {
  // Multi-provider setup: the session's current model is on a NON-official
  // provider (e.g. SiliconFlow), but the DeepSeek official baseURL is
  // configured. The balance is a property of the official account, so it must
  // still be queryable — the old gate wrongly rejected on the default model.
  const svc = createBalanceService(makeHostCtx({
    agentDefaultModel: { currentSelection: () => ({ provider: 'siliconflow', model: 'deepseek-v3' }) },
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'env' }) },
    subprocess: goodSpawn([]),
  }), { sandbox: true })
  const out = await svc.query()
  assert.equal(out.ok, true, 'balance must work even when the default model is on another provider')
  assert.equal(out.balance[0].currency, 'CNY')
})

test('balance-host: default model provider is irrelevant; unset baseURL uses the official default', async () => {
  const svc = createBalanceService(makeHostCtx({
    agentDefaultModel: { currentSelection: () => ({ provider: 'siliconflow', model: 'deepseek-v3' }) },
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'env' }) },
    subprocess: goodSpawn([]),
  }), { sandbox: true })
  const out = await svc.query()
  assert.equal(out.ok, true)
})

test('balance-host: guard rejects a relay baseURL before any request', async () => {
  const svc = createBalanceService(makeHostCtx({
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) },
    settings: { get: () => ({ baseURL: 'https://relay.example/v1' }) },
  }), { sandbox: true })
  const out = await svc.query()
  assert.equal(out.ok, false)
  assert.match(out.error, /baseURL/)
})

test('balance-host: sandbox mode uses subprocess+curl (no fetch call)', async () => {
  const calls = []
  const svc = createBalanceService(makeHostCtx({
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'env' }) },
    subprocess: goodSpawn(calls),
  }), { sandbox: true })
  const out = await svc.query()
  assert.equal(out.ok, true)
  assert.equal(out.httpStatus, 200)
  assert.equal(out.balance[0].currency, 'CNY')
  assert.equal(out.balance[0].total, '12.34')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'curl')
})

test('balance-host: no credential returns a descriptive error', async () => {
  const svc = createBalanceService(makeHostCtx({
    credentials: { resolve: async () => undefined },
  }), { sandbox: true })
  const out = await svc.query()
  assert.equal(out.ok, false)
  assert.match(out.error, /credential/)
})

test('balance-host: caches results within the 60s window', async () => {
  const calls = []
  const svc = createBalanceService(makeHostCtx({
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'env' }) },
    subprocess: goodSpawn(calls),
  }), { sandbox: true })
  await svc.query()
  await svc.query()
  assert.equal(calls.length, 1, 'second query must hit the cache')
})

test('balance-host: concurrent queries share one in-flight upstream request', async () => {
  const calls = []
  const svc = createBalanceService(makeHostCtx({
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'env' }) },
    subprocess: goodSpawn(calls),
  }), { sandbox: true })
  const [a, b] = await Promise.all([svc.query(), svc.query()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(calls.length, 1, 'two concurrent queries must spawn curl only once')
})

test('balance-host: a throwing subprocess fails closed (ok:false, no throw)', async () => {
  const svc = createBalanceService(makeHostCtx({
    credentials: { resolve: async () => ({ value: 'sk-test', source: 'env' }) },
    subprocess: {
      spawn() { throw new Error('boom') },
    },
  }), { sandbox: true })
  let out
  await assert.doesNotReject(async () => { out = await svc.query() })
  assert.equal(out.ok, false)
  assert.match(out.error, /boom|subprocess/)
})

// ---- dist/balance-host.js: balance history (5-min sampler × 288) ----

test('balance-host: history records, dedupes within a 5-min window, and caps at 288', () => {
  const h = createBalanceHistory()
  const t0 = T0
  h.record(100, t0)
  h.record(90, t0 + 60_000) // same 5-min window → updates, no new point
  h.record(80, t0 + SAMPLE_MS + 1) // new window → new point
  assert.equal(h.latest(), 80)
  assert.equal(h.points().length, 2)
  for (let i = 0; i < HISTORY_LEN + 50; i++) h.record(1000 - i, t0 + SAMPLE_MS * (i + 10))
  assert.ok(h.points().length <= HISTORY_LEN, 'history is capped at 288 points')
})

test('balance-host: spend returns positive when balance dropped, negative on recovery', () => {
  const h = createBalanceHistory()
  const t0 = T0
  h.record(100, t0 - 3600_000) // 1h ago
  h.record(80, t0) // now
  assert.equal(h.spend(60 * 60 * 1000, t0), 20, 'spent 20 in the last hour')
  assert.equal(h.spend(10 * 60 * 1000, t0), 20, '10m window falls back to the oldest point')
  h.record(90, t0 + 1000) // topped back up within the same 5-min window
  assert.equal(h.spend(60 * 60 * 1000, t0 + 1000), 10)
  assert.equal(h.spend(10 * 60 * 1000, t0 + 1000), 10)
})

test('balance-host: spend is null when history is insufficient', () => {
  const h = createBalanceHistory()
  h.record(50, T0)
  assert.equal(h.spend(60 * 60 * 1000, T0), null, 'only one point → no spend window')
  assert.equal(h.latest(), 50)
  h.clear()
  assert.equal(h.latest(), null)
})

// ---- Anti-bloat guarantees (the queue must NEVER grow past HISTORY_LEN) ----

test('balance-host: NaN/Infinity/non-number at or total are rejected, never enqueued', () => {
  const h = createBalanceHistory()
  const t0 = T0
  h.record(100, t0)
  h.record(NaN, t0 + 1) // NaN total → ignored
  h.record(99, NaN) // NaN at → ignored
  h.record(98, Infinity) // Infinity at → ignored
  h.record(97, -Infinity) // -Infinity at → ignored
  h.record(96, 'x') // non-number at → ignored
  h.record('y', t0 + 2) // non-number total → ignored
  h.record(undefined, t0 + 3) // undefined total → ignored
  assert.equal(h.points().length, 1, 'only the valid point survives')
  assert.equal(h.latest(), 100)
})

test('balance-host: out-of-order (backwards) timestamps never add points', () => {
  const h = createBalanceHistory()
  const t0 = T0
  h.record(100, t0)
  h.record(95, t0 - 1_000_000) // backwards way more than a window → must NOT push
  h.record(90, t0 - 1) // backwards → must NOT push
  h.record(85, t0) // same instant → must NOT push
  assert.equal(h.points().length, 1, 'backwards/same-at records update in place')
  assert.equal(h.latest(), 85)
  // Order stays strictly ascending after the storm
  const pts = h.points()
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].at > pts[i - 1].at, 'points stay ascending')
})

test('balance-host: massive record storm never exceeds HISTORY_LEN (absolute ceiling)', () => {
  const h = createBalanceHistory()
  const t0 = T0
  // 10,000 window-spaced records + interleaved garbage timestamps
  for (let i = 0; i < 10_000; i++) {
    h.record(i, t0 + i * SAMPLE_MS) // one per window → all should push
    if (i % 7 === 0) h.record(i, NaN) // garbage interleaved
    if (i % 11 === 0) h.record(i, t0 - i * 5000) // backwards garbage
    if (i % 13 === 0) h.record(Infinity, t0 + i) // Infinity total
  }
  const n = h.points().length
  assert.ok(n <= HISTORY_LEN, `queue capped at ${HISTORY_LEN}, got ${n}`)
  assert.equal(n, HISTORY_LEN, 'after 10k windows the queue holds exactly the full history')
  assert.ok(Number.isFinite(h.latest()), 'latest is always a finite number')
})

test('balance-host: repeated same-window records (high-frequency client polls) do not grow the queue', () => {
  const h = createBalanceHistory()
  const t0 = T0
  h.record(100, t0)
  for (let i = 0; i < 100_000; i++) h.record(100 - i / 100, t0 + (i % 299_000)) // 100k records inside 5 min
  assert.equal(h.points().length, 1, '100k same-window records add zero points')
  assert.ok(Number.isFinite(h.latest()))
})

test('balance-host: totalAgo/spend with garbage ms/now return null (never throw, never NaN)', () => {
  const h = createBalanceHistory()
  const t0 = T0
  h.record(100, t0 - 3600_000)
  h.record(80, t0)
  assert.equal(h.totalAgo(NaN, t0), null)
  assert.equal(h.totalAgo(3600_000, NaN), null)
  assert.equal(h.spend(NaN, t0), null)
  assert.equal(h.spend(3600_000, NaN), null)
})

// ---- dist/balance-host.js: spendBars (last 8h per 10 min) ----

test('balance-host: spendBars aggregates 10-min windows from sampled points', () => {
  const now = T0
  // Sample points: one every 10 minutes, balance linear in i → each bar = adjacent sample difference of 2
  const points = []
  for (let i = 48; i >= 0; i--) points.push({ at: now - i * 10 * 60 * 1000, total: i * 2 })
  const bars = spendBars(points, now)
  assert.equal(bars.length, 48, 'always 48 bars')
  assert.equal(bars[0].spent, 2, 'most recent window: total(now-10m)=2 minus total(now)=0')
  assert.ok(bars.every((b) => b.spent === 2), 'linear decline → every window spends 2')
  // Bar 0 is the newest (at near now - 10min), older further back
  assert.ok(bars[0].at > bars[47].at, 'newest first')
})

test('balance-host: spendBars returns null for unsampled windows and keeps length', () => {
  const now = T0
  const points = [{ at: now - 10 * 60 * 1000, total: 50 }, { at: now, total: 40 }] // only the most recent 10 minutes
  const bars = spendBars(points, now)
  assert.equal(bars.length, 48)
  assert.equal(bars[0].spent, 10, 'the only sampled window reports its spend')
  assert.ok(bars.slice(1).every((b) => b.spent === null), 'older unsampled windows are null')
})

test('balance-host: spendBars never fabricates a zero when both ends resolve to the SAME sample (regression)', () => {
  const now = T0
  // Only one old sample point: both ends of the bar window resolve to it → must be null, never 0 (no spend ≠ no data)
  const points = [{ at: now - 20 * 60 * 1000, total: 50 }]
  const bars = spendBars(points, now)
  assert.ok(bars.every((b) => b.spent === null), 'single old sample → every bar null, never 0')
  // Both sample points lie outside the same bar window (history too thin) → null, not 0
  const points2 = [
    { at: now - 30 * 60 * 1000, total: 100 },
    { at: now - 25 * 60 * 1000, total: 95 },
  ]
  const bars2 = spendBars(points2, now)
  assert.equal(bars2[0].spent, null, 'window with no fresh sample → null, not 0')
})

test('balance-host: spendBars is length-stable and null-safe under empty/garbage input', () => {
  const now = T0
  assert.equal(spendBars([], now).length, 48, 'empty history still yields 48 null bars')
  assert.equal(spendBars([], now).every((b) => b.spent === null), true)
  assert.equal(spendBars([{ at: NaN, total: 1 }], now).length, 48, 'garbage points never throw')
  assert.equal(spendBars([{ at: now, total: Infinity }], now).length, 48)
})

// ---- dist/balance-client.js: spend summary in the hover title ----

const spanReact = { createElement: (type, props, children) => ({ type, props, children }) }
const bal = (spend) => ({ ok: true, balance: [{ currency: 'CNY', total: '5.00', granted: '0', toppedUp: '5.00' }], ...(spend ? { spend } : {}) })

test('balance-client: balanceDetailLines appends spend values with labels', () => {
  const lines = balanceDetailLines(bal({ m10: 0.5, h1: 1.25, h24: 8 }), { h1: '1h spent', m10: '10m spent', h24: '24h spent' })
  assert.equal(lines.length, 4)
  assert.equal(lines[0], '¥ total 5.00 (granted 0, topped-up 5.00)')
  assert.equal(lines[1], '1h spent ¥1.25')
  assert.equal(lines[2], '10m spent ¥0.50')
  assert.equal(lines[3], '24h spent ¥8.00')
})

test('balance-client: recovered balance shows a + prefix, unsampled windows show an en dash', () => {
  const lines = balanceDetailLines(bal({ m10: -2.5, h1: null, h24: 0 }), { h1: '1h', m10: '10m', h24: '24h' })
  assert.equal(lines.length, 4, 'every spend window is always rendered')
  assert.equal(lines[1], '1h \u2013', 'unsampled 1h history shows an en dash')
  assert.equal(lines[2], '10m +¥2.50')
  assert.equal(lines[3], '24h ¥0.00')
})

test('balance-client: fully unsampled history still shows all three windows with en dashes', () => {
  const lines = balanceDetailLines(bal({ m10: null, h1: null, h24: null }), { h1: '1h', m10: '10m', h24: '24h' })
  assert.equal(lines.length, 4)
  assert.deepEqual(lines.slice(1), ['1h \u2013', '10m \u2013', '24h \u2013'])
})

test('balance-client: no spend payload → only the balance summary line', () => {
  const lines = balanceDetailLines(bal(null), { h1: '1h', m10: '10m', h24: '24h' })
  assert.deepEqual(lines, ['¥ total 5.00 (granted 0, topped-up 5.00)'])
  assert.equal(balanceDetailLines({ ok: false }, { h1: '1h' }), null)
})

test('balance-client: pickBalance extracts the first entry of a good response', () => {
  const b = pickBalance({ ok: true, balance: [{ currency: 'CNY', total: '9.99', granted: '0.00', toppedUp: '9.99' }] })
  assert.deepEqual(b, { currency: 'CNY', total: '9.99', granted: '0.00', toppedUp: '9.99' })
})

test('balance-client: pickBalance returns null for failures or empty lists', () => {
  assert.equal(pickBalance({ ok: false, error: 'x' }), null)
  assert.equal(pickBalance({ ok: true, balance: [] }), null)
  assert.equal(pickBalance(null), null)
  assert.equal(pickBalance(undefined), null)
})

test('balance-client: currency symbol and title formatting', () => {
  assert.equal(currencySymbol('CNY'), '¥')
  assert.equal(currencySymbol('USD'), '$')
  assert.equal(currencySymbol('UNKNOWN'), '$', 'unknown currency falls back to $')
  const title = balanceTitle({ currency: 'CNY', total: '10.00', granted: '2.00', toppedUp: '8.00' })
  assert.equal(title, '¥ total 10.00 (granted 2.00, topped-up 8.00)')
})

test('balance-client: renderBalanceElement builds a span or null', () => {
  const React = { createElement: (type, props, children) => ({ type, props, children }) }
  const el = renderBalanceElement({ ok: true, balance: [{ currency: 'CNY', total: '5.00', granted: '0', toppedUp: '5.00' }] }, React)
  assert.equal(el.type, 'span')
  assert.equal(el.children, '¥5.00')
  assert.equal(el.props.title, undefined, 'no native title: the client renders a custom hover card instead')
  assert.equal(renderBalanceElement({ ok: false }, React), null)
})

// ---- Persistence round-trip + key fingerprint + activity attribution ----

test('balance-host: keyFingerprint is stable, distinct per key, and never leaks the key', () => {
  const a = keyFingerprint('sk-abc-123')
  const b = keyFingerprint('sk-abc-123')
  const c = keyFingerprint('sk-abc-124')
  assert.equal(a, b, 'same key → same fingerprint')
  assert.notEqual(a, c, 'different key → different fingerprint')
  assert.match(a, /^[0-9a-f]{8}$/, '8-hex-digit fingerprint')
  assert.ok(!a.includes('sk-'), 'fingerprint never contains the raw key')
})

test('balance-host: serialize/parse round-trips activity flags and survives garbage', () => {
  const points = [
    { at: 1000, total: 100 },
    { at: 2000, total: 90, activity: true },
    { at: 3000, total: 95, activity: false },
  ]
  const text = serializeBalanceHistory({ keyId: 'abc12345', points })
  const parsed = parseBalanceHistory(text)
  assert.ok(parsed, 'round-trip parses')
  assert.equal(parsed.keyId, 'abc12345')
  assert.equal(parsed.points.length, 3)
  assert.equal(parsed.points[1].activity, true)
  assert.equal(parsed.points[0].activity, undefined)
  // Garbage never throws and returns null
  assert.equal(parseBalanceHistory('not json'), null)
  assert.equal(parseBalanceHistory('{"keyId": 1}'), null)
  assert.equal(parseBalanceHistory('{"keyId":"x"}'), null)
  assert.equal(parseBalanceHistory('[]'), null)
})

test('balance-host: history.load accepts persisted data, dedupes, caps, and ignores garbage', () => {
  const h = createBalanceHistory()
  const B = T0 // alignment base (divisible by 5 min)
  h.load([
    { at: B + 5 * 60000, total: 50, activity: true },
    { at: B + 0, total: 80 }, // out of order → sorted
    { at: B + 0, total: 79 }, // duplicate at → last wins
    { at: B + 60000, total: 99 }, // not aligned → aligned to B
    { at: B + 4500, total: 'bad' }, // garbage → skipped
    { at: NaN, total: 1 }, // garbage → skipped
  ])
  const pts = h.points()
  // B+60000 aligns to B (same instant as B+0, which already exists and updates later → but 60000 aligns to 0),
  // so the valid points are: B+0 (dup→79), B+5min → 2 points; note after load's alignment B+60000 == B+0
  assert.equal(pts.length, 2, 'aligned duplicates collapse')
  assert.equal(pts[0].at, B)
  assert.equal(pts[0].total, 99, 'later in-window value wins after alignment')
  assert.equal(pts[1].at, B + 5 * 60000)
  assert.equal(pts[1].activity, true)
  // empty / invalid load is a no-op
  h.load([])
  assert.equal(h.points().length, 2)
  h.load(null)
  assert.equal(h.points().length, 2)
})

test('balance-host: spendBars flags activity=true when any window sample had local activity', () => {
  const now = T0
  // Samples: activity in the most recent 10 min, none in the 10 min before
  const points = [
    { at: now - 20 * 60000, total: 100 },
    { at: now - 10 * 60000, total: 95 }, // no activity
    { at: now, total: 90, activity: true }, // local activity
  ]
  const bars = spendBars(points, now)
  assert.equal(bars[0].spent, 5)
  assert.equal(bars[0].activity, true, 'window containing the activity sample is flagged')
  // Bar 1 window [now-20min, now-10min] covers two no-activity samples → activity=false
  assert.equal(bars[1].activity, false, 'window without any activity sample is not flagged')
})

test('balance-host: record carries activity and updates it within the same window', () => {
  const h = createBalanceHistory()
  const t0 = T0
  h.record(100, t0, false)
  h.record(90, t0 + 60_000, true) // same 5-min window → updates activity too
  const pts = h.points()
  assert.equal(pts.length, 1)
  assert.equal(pts[0].activity, true, 'in-window update refreshes the activity flag')
})

// ---- Senior-test coverage: history.load cap boundary ----

test('balance-host: history.load preserves activity flags and caps at exactly HISTORY_LEN', () => {
  const h = createBalanceHistory()
  const t0 = T0
  const pts = []
  // Over the cap: 300 points, alternating activity
  for (let i = 0; i < 300; i++) pts.push({ at: t0 + i * SAMPLE_MS, total: 1000 - i, activity: i % 2 === 0 })
  h.load(pts)
  assert.equal(h.points().length, HISTORY_LEN, 'load caps at HISTORY_LEN exactly')
  // Only the newest 288 are kept: the first trimmed at is t0 + (300-288)*SAMPLE_MS
  const firstKept = t0 + (300 - HISTORY_LEN) * SAMPLE_MS
  assert.equal(h.points()[0].at, firstKept, 'oldest 12 points dropped, newest kept')
  // Activity flag preserved
  assert.equal(typeof h.points()[0].activity, 'boolean')
  // latest() is the last (newest) one
  assert.equal(h.latest(), 1000 - 299)
})

test('balance-host: history.load keeps ordering and activity after in-window records', () => {
  const h = createBalanceHistory()
  const t0 = T0
  h.load([
    { at: t0, total: 100, activity: true },
    { at: t0 + 10 * 60 * 1000, total: 90, activity: false },
    { at: t0 + 20 * 60 * 1000, total: 95, activity: true },
  ])
  // Then keep recording: new points must come last and must not conflict with existing points
  h.record(88, t0 + 30 * 60 * 1000, true)
  h.record(85, t0 + 40 * 60 * 1000, false)
  const pts = h.points()
  assert.equal(pts.length, 5)
  assert.equal(pts[0].at, t0)
  assert.equal(pts[4].at, t0 + 40 * 60 * 1000)
  assert.equal(pts[4].total, 85)
  assert.equal(pts[4].activity, false)
})

// ---- Senior-test coverage: spendBars edge cases ----

test('balance-host: spendBars negative bars (top-up) carry activity but are not flagged external', () => {
  const now = T0
  const points = [
    { at: now - 20 * 60000, total: 90, activity: false },
    { at: now - 10 * 60000, total: 100, activity: true }, // topped up (rise)
    { at: now, total: 95, activity: true }, // then spent
  ]
  const bars = spendBars(points, now)
  assert.equal(bars[0].spent, 5, 'window [now-10m,now]: 100→95 = +5 spent')
  assert.equal(bars[0].activity, true)
  assert.equal(bars[1].spent, -10, 'window [now-20m,now-10m]: 90→100 = -10 top-up')
  assert.equal(bars[1].activity, true, 'rise with activity is still flagged as activity')
})

test('balance-host: spendBars marks positive spend WITHOUT activity as external, with activity as normal', () => {
  const now = T0
  const points = [
    { at: now - 20 * 60000, total: 100, activity: false },
    { at: now - 10 * 60000, total: 95, activity: false }, // decline, NO local activity
    { at: now, total: 90, activity: true }, // decline, WITH local activity
  ]
  const bars = spendBars(points, now)
  assert.equal(bars[0].spent, 5)
  assert.equal(bars[0].activity, true, 'window with activity → not external')
  assert.equal(bars[1].spent, 5)
  assert.equal(bars[1].activity, false, 'window without activity → external (warn)')
})

test('balance-host: spendBars window boundary exactly on a sample timestamp', () => {
  const now = T0
  // Sample points sit exactly on bar boundaries (now-10m, now-20m ...)
  const points = [
    { at: now - 20 * 60000, total: 100 },
    { at: now - 10 * 60000, total: 80 },
    { at: now, total: 70 },
  ]
  const bars = spendBars(points, now)
  assert.equal(bars[0].spent, 10, 'boundary sample at now-10m counts as end of window 0')
  assert.equal(bars[1].spent, 20, 'boundary sample at now-20m counts as end of window 1')
  // Window 0: end=now, start=now-10m → startT takes the now-10m sample (80), endT takes now (70) → 10 ✓
})

// ---- Senior-test coverage: spendBars activity across mixed windows ----

test('balance-host: spendBars activity is window-scoped, not cumulative', () => {
  const now = T0
  // Only the oldest window has activity
  const points = [
    { at: now - 30 * 60000, total: 100, activity: true },
    { at: now - 20 * 60000, total: 90, activity: false },
    { at: now - 10 * 60000, total: 85, activity: false },
    { at: now, total: 80, activity: false },
  ]
  const bars = spendBars(points, now)
  // Bar 2 = [now-30m, now-20m] contains an activity=true sample → activity true
  assert.equal(bars[2].activity, true, 'oldest window has activity')
  // Bars 0/1 have no activity
  assert.equal(bars[0].activity, false)
  assert.equal(bars[1].activity, false)
})

// ---- Alignment: sampling points and bar boundaries sit on integer minutes ----

test('balance-host: record aligns sample times to integer 5-minute boundaries', () => {
  const h = createBalanceHistory()
  const base = T0 // divisible by 5 min
  h.record(100, base + 42 * 1000 + 137) // 07:xx:42.137 → aligned to base
  assert.equal(h.points()[0].at % 300000, 0, 'sample at is aligned to 5 min')
  assert.equal(h.points()[0].at, base, '42s+137ms collapse to the window start')
  // Next 5-minute window
  h.record(95, base + SAMPLE_MS + 1) // after alignment = base + SAMPLE_MS
  assert.equal(h.points().length, 2)
  assert.equal(h.points()[1].at, base + SAMPLE_MS)
})

test('balance-host: spendBars aligns bar windows to integer 10-minute boundaries', () => {
  const now = T0 + 42 * 60 * 1000 + 5000 // now: 42 min + 5 s (unaligned)
  const points = [
    { at: T0 - 20 * 60000, total: 100 },
    { at: T0 - 10 * 60000, total: 90 },
    { at: T0, total: 80 },
  ]
  const bars = spendBars(points, now)
  // After alignment alignedNow = T0 + 40min; bar0 = [T0+30min, T0+40min], bar1 = [T0+20min, T0+30min]
  assert.equal(bars[0].at % 600000, 0, 'bar start aligned to 10 min')
  assert.equal(bars[1].at % 600000, 0, 'every bar aligned')
  assert.ok(bars[0].at > T0, 'newest bar window is after T0')
  // Bar 0 window [T0+30m, T0+40m]: startT = T0 sample (80), endT = T0 sample (80)? Both ends same point → null
  // In fact the T0 sample <= T0+30m, endIdx picks the T0 sample, startIdx also picks the T0 sample → same point → null
  assert.equal(bars[0].spent, null, 'window with no fresh sample between boundaries → null (not 0)')
})

test('balance-host: unaligned persisted times are aligned on load (no boundary drift)', () => {
  const h = createBalanceHistory()
  const base = T0
  h.load([
    { at: base - 9 * 60000 - 1000, total: 90 }, // unaligned, aligned to base-10min after load
    { at: base - 1, total: 80 }, // base-1 falls in [base-5min, base) → aligned to base-5min
  ])
  const pts = h.points()
  assert.equal(pts[0].at % 300000, 0, 'persisted point aligned on load')
  assert.equal(pts[1].at % 300000, 0)
  assert.equal(pts[0].at, base - 10 * 60000, 'base-9min-1s aligned down to base-10min')
  assert.equal(pts[1].at, base - 5 * 60000, 'base-1ms aligned down to base-5min')
})

// ---- Timezone-aware alignment ----

/** Return the wall-clock minute-of-day of the absolute instant ms in tz. */
function minutesInTz(tz, ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
  const parts = {}
  for (const p of f.formatToParts(new Date(ms))) parts[p.type] = p.value
  return Number(parts.hour) * 60 + Number(parts.minute)
}

test('balance-host: alignWallClock aligns to integer step in the GIVEN timezone (DST-safe)', () => {
  // Asia/Shanghai (UTC+8): after aligning any instant, its Shanghai wall-clock minute is a multiple of step
  const raw = new Date('2026-08-18T02:37:00Z').getTime() // Shanghai 10:37
  const aligned = alignWallClock('Asia/Shanghai', raw, 10 * 60000)
  assert.equal(aligned % 600000, 0, 'Shanghai UTC-aligned (offset is whole 10-min multiples)')
  // Europe/London summer (UTC+1): offset is not a whole 10-min multiple but wall-clock alignment is still correct
  const londonRaw = new Date('2026-08-18T09:37:00Z').getTime() // London 10:37 BST
  const londonAligned = alignWallClock('Europe/London', londonRaw, 10 * 60000)
  assert.equal(minutesInTz('Europe/London', londonAligned) % 10, 0, 'London wall-clock minute aligned to 10')
})

test('balance-host: alignWallClock handles non-10-minute-multiple offsets (Kathmandu +5:45)', () => {
  // Asia/Kathmandu = UTC+5:45 → instants at whole 10-min UTC are xx:x5 in the Nepali wall clock.
  // Timezone alignment must align to whole 10 minutes of the Nepali wall clock (xx:00 / xx:10 …), even
  // when the result is not a whole 10 minutes in UTC.
  const kathRaw = new Date('2026-08-18T04:42:00Z').getTime() // Nepal 10:27
  const aligned = alignWallClock('Asia/Kathmandu', kathRaw, 10 * 60000)
  assert.ok(aligned !== undefined)
  assert.equal(minutesInTz('Asia/Kathmandu', aligned) % 10, 0, 'Kathmandu wall-clock minute aligned to 10')
  assert.equal(aligned % 600000 !== 0, true, 'result is NOT UTC-aligned (offset is 5:45) — this is the point')
  // The aligned result is not later than the original instant
  assert.ok(aligned <= kathRaw, 'aligns backwards (floor), never forward')
})

test('balance-host: spendBars(tz) produces bar windows on integer minutes of that timezone', () => {
  const kathRaw = new Date('2026-08-18T04:42:00Z').getTime() // Nepal 10:27
  const points = [
    { at: kathRaw - 30 * 60000, total: 100 },
    { at: kathRaw - 20 * 60000, total: 90 },
    { at: kathRaw - 10 * 60000, total: 80 },
    { at: kathRaw, total: 70 },
  ]
  const bars = spendBars(points, kathRaw, 48, 10 * 60000, 'Asia/Kathmandu')
  // Every bar's at (window start) is a whole 10 minutes in the Nepali wall clock
  for (const b of bars) {
    assert.equal(minutesInTz('Asia/Kathmandu', b.at) % 10, 0, 'every bar start sits on an integer 10-min boundary in the configured tz')
  }
  // No tz → UTC-aligned (default compatibility)
  const barsUtc = spendBars(points, kathRaw, 48, 10 * 60000)
  assert.equal(barsUtc[0].at % 600000, 0, 'no tz → UTC-aligned')
})

test('balance-host: alignWallClock returns undefined for invalid timezone (caller falls back)', () => {
  assert.equal(alignWallClock('Not/AZone', Date.now(), 10 * 60000), undefined)
  assert.equal(alignWallClock('Asia/Shanghai', Date.now(), 0), undefined) // bad step
})

// ---- v1.4.1-1.4.4 model classification (per-tier save-money) ----

test('model-class: official provider classifies flash/pro/vision correctly', () => {
  assert.equal(classifyModel('deepseek-official', 'deepseek-v4-flash'), 'official-flash')
  assert.equal(classifyModel('deepseek-official', 'deepseek-v4-pro'), 'official-pro')
  // v1.4.4: vision-exp gets its own tier (its name also contains "flash",
  // so vision must win)
  assert.equal(classifyModel('deepseek-official', 'deepseek-v4-flash-vision-exp'), 'official-vision')
  assert.equal(classifyModel('deepseek-official', 'deepseek-v4-flash-vision'), 'official-vision')
  // Case-insensitive
  assert.equal(classifyModel('DEEPSEEK-OFFICIAL', 'DeepSeek-V4-Flash'), 'official-flash')
  assert.equal(classifyModel('deepseek-official', 'DeepSeek-V4-Flash-Vision-Exp'), 'official-vision')
})

test('model-class: EVERY non-official provider belongs to the "other" group (v1.4.4)', () => {
  assert.equal(classifyModel('opencode', 'deepseek-v4-flash'), 'other-flash')
  assert.equal(classifyModel('opencode', 'deepseek-v4-pro'), 'other-pro')
  assert.equal(classifyModel('opencode-go', 'deepseek-v4-flash'), 'other-flash')
  assert.equal(classifyModel('opencode-zen', 'deepseek-v4-pro'), 'other-pro')
  assert.equal(classifyModel('opencode-go', 'deepseek-v4-flash-free'), 'other-flash', 'flash-free still contains flash')
  assert.equal(classifyModel('opencode-go', 'deepseek-v4-flash-vision-exp'), 'other-vision')
  // v1.4.4: relays / SiliconFlow / anything non-official are no longer null —
  // they map to the "other" group (unchecked by default → exempt)
  assert.equal(classifyModel('siliconflow', 'deepseek-v4-flash'), 'other-flash')
  assert.equal(classifyModel('my-relay', 'deepseek-v4-pro'), 'other-pro')
  assert.equal(classifyModel('siliconflow', 'deepseek-v4-flash-vision-exp'), 'other-vision')
})

test('model-class: unknown model names are exempt (incl. legacy chat/reasoner)', () => {
  assert.equal(classifyModel('deepseek-official', 'deepseek-chat'), null, 'legacy chat → exempt (no mapping)')
  assert.equal(classifyModel('deepseek-official', 'deepseek-reasoner'), null, 'legacy reasoner → exempt')
  assert.equal(classifyModel('opencode', 'deepseek-v3'), null, 'v3 → exempt')
  assert.equal(classifyModel('deepseek-official', 'qwen-max'), null)
  assert.equal(classifyModel('openai', 'gpt-4o'), null, 'no flash/pro/vision in the name → exempt')
})

test('model-class: garbage input never throws, always null', () => {
  assert.equal(classifyModel(undefined, undefined), null)
  assert.equal(classifyModel(null, 'deepseek-v4-flash'), null)
  assert.equal(classifyModel('deepseek-official', null), null)
  assert.equal(classifyModel(123, 456), null)
  assert.equal(classifyModel('', ''), null)
})

test('model-apply: enabled follows the config object per tier; null class → false', () => {
  const applied = {
    'official-flash': true, 'official-pro': true, 'official-vision': true,
    'other-flash': false, 'other-pro': false, 'other-vision': false,
  }
  assert.equal(modelApplyEnabled(applied, 'official-flash'), true)
  assert.equal(modelApplyEnabled(applied, 'official-pro'), true)
  assert.equal(modelApplyEnabled(applied, 'official-vision'), true)
  assert.equal(modelApplyEnabled(applied, 'other-flash'), false)
  assert.equal(modelApplyEnabled(applied, 'other-pro'), false)
  assert.equal(modelApplyEnabled(applied, 'other-vision'), false)
  assert.equal(modelApplyEnabled(applied, null), false, 'unrecognized class never applies')
  assert.equal(modelApplyEnabled(undefined, 'official-flash'), false, 'missing config → safe false')
  assert.equal(modelApplyEnabled('garbage', 'official-flash'), false)
})
