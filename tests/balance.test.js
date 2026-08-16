/**
 * balance.test.js — Unit tests for the balance modules (dist/balance-host.js,
 * dist/balance-client.js), the standalone feature modules split out of the
 * plugin bodies so the balance feature can grow independently.
 *
 * Run with: npm test (builds first, then `node --test tests/`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBalanceService, createBalanceHistory, SAMPLE_MS, HISTORY_LEN } from '../dist/balance-host.js'
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

test('balance-host: createBalanceService reports the official-API guard first', async () => {
  const svc = createBalanceService(makeHostCtx({
    agentDefaultModel: { currentSelection: () => ({ provider: 'relay', model: 'x' }) },
  }), { sandbox: true })
  const out = await svc.query()
  assert.equal(out.ok, false)
  assert.match(out.error, /deepseek-official/)
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
  const t0 = 1_700_000_000_000
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
  const t0 = 1_700_000_000_000
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
  h.record(50, 1_700_000_000_000)
  assert.equal(h.spend(60 * 60 * 1000, 1_700_000_000_000), null, 'only one point → no spend window')
  assert.equal(h.latest(), 50)
  h.clear()
  assert.equal(h.latest(), null)
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

test('balance-client: recovered balance shows a + prefix, missing windows are skipped', () => {
  const lines = balanceDetailLines(bal({ m10: -2.5, h1: null, h24: 0 }), { h1: '1h', m10: '10m', h24: '24h' })
  assert.equal(lines.length, 3, 'null history line is skipped')
  assert.equal(lines[1], '10m +¥2.50')
  assert.equal(lines[2], '24h ¥0.00')
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
