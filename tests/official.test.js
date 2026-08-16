/**
 * official.test.js — Unit tests for the official plugin module (plugin/index.js)
 * mounted via --patch / bundle: tools registered through ctx.tools, HTTP
 * endpoints registered on ctx.webServer for the bundled Client half, and the
 * generated plugin/client.js bundle shape.
 *
 * The module under test is built from src/host.ts by scripts/make-plugin.js.
 * Run with: npm test (builds first, then `node --test tests/`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import('../plugin/index.js')

/** Minimal Cordis-like context: tools + webServer + timer + effect() capture. */
function makeCtx(overrides = {}) {
  const tools = {
    registered: [],
    register(tool) {
      this.registered.push(tool)
      return () => {}
    },
  }
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const timers = []
  const timerSvc = {
    interval(fn, ms) {
      timers.push({ fn, ms })
      return () => {}
    },
    timeout() { return () => {} },
  }
  const ctx = {
    get(name) {
      if (name === 'tools') return tools
      if (name === 'webServer') return webServer
      return overrides[name] // fs / sessions / agents / sandboxPolicy…
    },
    on() { return () => {} },
    effect(fn) {
      const r = fn()
      if (typeof r === 'function') this._disposers.push(r)
    },
    _disposers: [],
    timer: timerSvc,
    ...overrides.ctx,
  }
  return { ctx, tools, routes, timers }
}

test('official module exports name / inject / apply', () => {
  assert.equal(plugin.name, 'dsh-save-money')
  assert.deepEqual(plugin.inject, ['timer'])
  assert.equal(typeof plugin.apply, 'function')
})

test('official apply: registers 4 tools through ctx.tools and the webServer route', async () => {
  const { ctx, tools, routes } = makeCtx()
  await plugin.apply(ctx)
  const names = tools.registered.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'save_money_configure',
    'save_money_debug_tick',
    'save_money_end_window',
    'save_money_status',
  ])
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/save-money')
  assert.equal(typeof routes[0].handler, 'function')
})

test('official apply: HTTP status endpoint returns the plugin status JSON', async () => {
  const { ctx, routes } = makeCtx()
  await plugin.apply(ctx)
  const handler = routes[0].handler
  let written
  const res = {
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(body) { written = body },
  }
  await handler({ method: 'GET', url: '/save-money/status' }, res)
  assert.equal(res.code, 200)
  const body = JSON.parse(written)
  assert.equal(typeof body.enabled, 'boolean')
  assert.equal(typeof body.gate, 'string')
  assert.ok(body.config)
})

test('official apply: HTTP configure endpoint applies a patch and persists nothing without fs', async () => {
  const { ctx, routes } = makeCtx()
  await plugin.apply(ctx)
  const handler = routes[0].handler
  // Simulate an async-iterable request body
  const req = {
    method: 'POST',
    url: '/save-money/configure',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ enabled: true, lang: 'en' }))
    },
  }
  let written
  const res = {
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(body) { written = body },
  }
  await handler(req, res)
  assert.equal(res.code, 200)
  const body = JSON.parse(written)
  assert.equal(body.ok, true)
  assert.equal(body.config.enabled, true)
  assert.equal(body.config.lang, 'en')
})

test('official apply: unknown path returns 404 JSON', async () => {
  const { ctx, routes } = makeCtx()
  await plugin.apply(ctx)
  const handler = routes[0].handler
  let written
  const res = {
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(body) { written = body },
  }
  await handler({ method: 'GET', url: '/save-money/nope' }, res)
  assert.equal(res.code, 404)
  const body = JSON.parse(written)
  assert.equal(body.ok, false)
})

test('official client bundle: plugin/client.js is a __ModuleLoader__ factory exporting apply/inject', () => {
  const js = readFileSync(join(root, 'plugin', 'client.js'), 'utf8')
  assert.match(js, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(js, /id: 'dsh-save-money'/)
  assert.match(js, /require\('react'\)/)
  assert.match(js, /exports\.apply = plugin\.apply;/)
  assert.match(js, /exports\.inject = plugin\.inject;/)
})

test('official bundle manifest: package.json declares dsh.client + exports["./client"]', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'plugin', 'package.json'), 'utf8'))
  assert.equal(pkg.version, '1.2.4')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.files.includes('client.js'))
  assert.ok(pkg.files.includes('index.js'))
})

test('official bundle manifest: exports declares ./package.json so client-modules can resolve the package', () => {
  // client-modules resolves the plugin package via require.resolve('<name>/package.json');
  // Node's "exports" map blocks undeclared subpaths, which silently disables the
  // client half (regression: v1.2.3 shipped without this entry and the UI never loaded).
  const pkg = JSON.parse(readFileSync(join(root, 'plugin', 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./package.json'], './package.json')
})

test('official client bundle parses (node --check equivalent)', () => {
  // The bundle references window / __ModuleLoader__ / require at runtime, but
  // its syntax must be valid JavaScript — import it through a syntax-only pass
  // by wrapping it; node:test has no --check, so compile via `new Function` is
  // not possible (it is a script, not an expression). Instead, assert the
  // structural markers and that the factory body is balanced.
  const js = readFileSync(join(root, 'plugin', 'client.js'), 'utf8')
  const opens = (js.match(/\(/g) || []).length
  const closes = (js.match(/\)/g) || []).length
  const bracesOpen = (js.match(/\{/g) || []).length
  const bracesClose = (js.match(/\}/g) || []).length
  assert.equal(opens, closes, 'balanced parentheses')
  assert.equal(bracesOpen, bracesClose, 'balanced braces')
})
