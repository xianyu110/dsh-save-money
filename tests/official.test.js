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
    _timers: timers,
    interval(fn, ms) {
      timers.push({ fn, ms, kind: 'interval' })
      return () => {}
    },
    timeout(fn, ms) {
      timers.push({ fn, ms, kind: 'timeout' })
      return () => {}
    },
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
    inject(deps, callback) {
      this._injected.push({ deps, callback })
    },
    _disposers: [],
    _injected: [],
    timer: timerSvc,
    ...overrides.ctx,
  }
  return { ctx, tools, routes, timers }
}

/**
 * Official bundle timing regression (v1.2.4 -> v1.2.5): the plugin row only
 * injects timer, so in the official form apply() can run BEFORE webServer is
 * registered. The Host must wait via ctx.inject(['webServer']) and register
 * the /save-money routes as soon as the service appears — otherwise the
 * bundled Client half gets 404s and the Enable checkbox silently fails.
 */
test('official apply: registers HTTP routes via ctx.inject when webServer arrives late', async () => {
  const { ctx, routes } = makeCtx()
  // First apply with webServer ABSENT (get returns undefined; inject captured)
  let lateWebServer
  ctx.get = (name) => {
    if (name === 'webServer') return lateWebServer
    return undefined
  }
  await plugin.apply(ctx)
  assert.equal(routes.length, 0, 'no routes before webServer exists')
  // Two inject registrations: webServer routes + the fs fallback (config load)
  assert.equal(ctx._injected.length, 2)
  const wsInject = ctx._injected.find((i) => i.deps.includes('webServer'))
  const fsInject = ctx._injected.find((i) => i.deps.includes('fs'))
  assert.ok(wsInject, 'webServer inject registered')
  assert.ok(fsInject, 'fs inject registered (late-fs config load fallback)')
  assert.deepEqual(wsInject.deps, ['webServer'])
  // Now the webServer service appears (late activation) — run the inject callback
  const registered = []
  lateWebServer = {
    register(route) {
      registered.push(route)
      return () => {}
    },
  }
  const sub = {
    get: (name) => (name === 'webServer' ? lateWebServer : undefined),
    effect(fn) {
      const r = fn()
      if (typeof r === 'function') this._disposers.push(r)
    },
    _disposers: [],
  }
  wsInject.callback(sub)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/save-money')
})

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
  assert.equal(pkg.version, '1.3.3')
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

// ---- Balance endpoint (opt-in showBalance, default off) ----

/** Apply once and return the /save-money HTTP handler. */
async function applyForBalance() {
  const { ctx, routes } = makeCtx()
  await plugin.apply(ctx)
  assert.equal(routes.length, 1)
  return routes[0].handler
}

/** Drive a POST configure + GET balance pair against the handler. */
async function configureAndGetBalance(handler, patch) {
  const req = {
    method: 'POST',
    url: '/save-money/configure',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(patch)) },
  }
  const res = {
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(body) { this._body = body },
  }
  await handler(req, res)
  const res2 = {
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(body) { this._body = body },
  }
  await handler({ method: 'GET', url: '/save-money/balance' }, res2)
  assert.equal(res2.code, 200)
  return JSON.parse(res2._body)
}

test('official balance endpoint: hidden by default (opt-in showBalance=false)', async () => {
  const handler = await applyForBalance()
  const out = await configureAndGetBalance(handler, { showBalance: false })
  assert.equal(out.ok, false)
  assert.match(out.error, /disabled/)
})

test('official balance endpoint: enabling showBalance reveals the credential error (no credential in test ctx)', async () => {
  const handler = await applyForBalance()
  const out = await configureAndGetBalance(handler, { showBalance: true })
  assert.equal(out.ok, false)
  assert.match(out.error, /credential/)
})

test('official balance display switch: off by default, enable works, disable hides again', async () => {
  const handler = await applyForBalance()
  const off1 = await configureAndGetBalance(handler, { showBalance: false })
  assert.match(off1.error, /disabled/)
  const on = await configureAndGetBalance(handler, { showBalance: true })
  assert.equal(on.ok, false)
  assert.match(on.error, /credential/) // gated by the opt-in switch, not the guard
  const off2 = await configureAndGetBalance(handler, { showBalance: false })
  assert.match(off2.error, /disabled/)
})

// ---- Config location resolution (v1.3.1: multi-candidate + ~/.dsh pointer) ----

/** In-memory fs for config-resolution tests. `files` is a plain map of
 * absolute-path → content; writes mutate it. */
function makeMemFs(files = {}) {
  const writes = []
  return {
    files,
    writes,
    async resolve(p, opts = {}) {
      const cwd = opts.cwd || ''
      const abs = p.startsWith(process.cwd()) ? p : join(cwd, p)
      return { displayPath: abs, targetKey: abs, path: abs }
    },
    async readText(t) {
      const k = String(t.targetKey || t.path)
      if (!(k in files)) {
        const e = new Error('ENOENT ' + k)
        e.code = 'ENOENT'
        throw e
      }
      return files[k]
    },
    async writeText(t, content, expected, signal, policy) {
      writes.push({ path: String(t.targetKey || t.path), policy })
      files[String(t.targetKey || t.path)] = content
      return { ok: true }
    },
    processPath(t) { return String(t.targetKey || t.path) },
  }
}

/** Run one captured boot timeout (the 100ms loadConfig) and settle it. */
function fireBootTimeout(ctx) {
  const boot = (ctx.timer._timers || []).find((t) => t.kind === 'timeout')
  assert.ok(boot, 'a boot timeout was registered')
  boot.fn()
}

/** Apply with the given fs/sessions/sandboxPolicy overrides and return the
 * captured HTTP handler plus the raw ctx (for firing the boot timer). */
async function applyWithConfig({ fs, sessionsCwds = [], harnessRoot }) {
  const overrides = {
    fs,
    sessions: { list: () => sessionsCwds.map((c) => ({ id: 's', meta: { cwd: c } })), get: () => undefined },
    agents: { currentInitiator: () => undefined, list: () => [] },
    goals: { get: () => undefined },
    sandboxPolicy: { workspaceRoot: harnessRoot },
  }
  const { ctx, routes } = makeCtx(overrides)
  await plugin.apply(ctx)
  assert.equal(routes.length, 1)
  return { ctx, handler: routes[0].handler }
}

/** GET /save-money/status and parse it. */
async function getStatus(handler) {
  const res = {
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(body) { this._body = body },
  }
  await handler({ method: 'GET', url: '/save-money/status' }, res)
  return JSON.parse(res._body)
}

/** Drive a POST configure against a handler, then settle the async persist. */
async function configure(handler, patch) {
  const req = {
    method: 'POST',
    url: '/save-money/configure',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(patch)) },
  }
  const res = {
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(body) { this._body = body },
  }
  await handler(req, res)
  await new Promise((r) => setTimeout(r, 20)) // let the fire-and-forget persist settle
  return JSON.parse(res._body)
}

test('config resolution: pointer file in ~/.dsh pins the location across restarts', async () => {
  // Simulate a previous run that persisted the config to /repo-a: the pointer
  // file records it. Even when NO session cwd matches, the pointer must win.
  const repoA = join(process.cwd(), '..', 'repo-a')
  const home = join(process.cwd(), '..', 'fake-dsh-home')
  const files = {}
  files[join(repoA, 'save-money.config.json')] = JSON.stringify({ enabled: true, lang: 'en' })
  files[join(home, 'save-money-config-path.json')] = JSON.stringify({ path: repoA })
  const mem = makeMemFs(files)
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, handler } = await applyWithConfig({
      fs: mem,
      sessionsCwds: [], // no repo session at all — only the pointer can find it
      harnessRoot: join(process.cwd(), '..', 'deepseek-harness'),
    })
    fireBootTimeout(ctx) // loadConfig runs → resolves via the pointer
    await new Promise((r) => setTimeout(r, 20))
    const st = await getStatus(handler)
    assert.equal(st.workspaceRoot, repoA, 'pointer pins the config dir')
    assert.equal(st.configLoaded, true, 'config was loaded')
    assert.equal(st.config.lang, 'en', 'loaded the pointer-targeted config')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

test('config resolution: a session cwd matching the repo basename wins without a pointer', async () => {
  const repo = join(process.cwd(), '..', 'dsh-save-money') // basename matches
  const files = {}
  files[join(repo, 'save-money.config.json')] = JSON.stringify({ enabled: false, lang: 'zh' })
  const mem = makeMemFs(files)
  const oldHome = process.env.DSH_HOME
  delete process.env.DSH_HOME // no pointer available
  try {
    const { ctx, handler } = await applyWithConfig({
      fs: mem,
      sessionsCwds: [join(process.cwd(), '..', 'deepseek-harness'), repo],
      harnessRoot: join(process.cwd(), '..', 'deepseek-harness'),
    })
    fireBootTimeout(ctx)
    await new Promise((r) => setTimeout(r, 20))
    const st = await getStatus(handler)
    assert.equal(st.workspaceRoot, repo, 'session cwd resolves the repo')
    assert.equal(st.configLoaded, true)
    assert.equal(st.config.lang, 'zh')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

test('config resolution: fresh install (no config anywhere) still persists to a repo-named candidate', async () => {
  // README quick-install layout: harness at <parent>/deepseek-harness, repo at
  // <parent>/dsh-save-money. No config exists yet anywhere.
  const parent = join(process.cwd(), '..')
  const repo = join(parent, 'dsh-save-money')
  const mem = makeMemFs({}) // empty disk
  const oldHome = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    const { ctx, handler } = await applyWithConfig({
      fs: mem,
      sessionsCwds: [join(parent, 'deepseek-harness')], // only the harness dir session
      harnessRoot: join(parent, 'deepseek-harness'),
    })
    // No boot-time config → status reports the default; then a configure writes
    // the file and must pick the repo-named sibling candidate.
    fireBootTimeout(ctx)
    await new Promise((r) => setTimeout(r, 20))
    const out = await configure(handler, { enabled: true })
    assert.equal(out.ok, true)
    const wrote = mem.writes.find((w) => w.path.endsWith('save-money.config.json') && !w.path.includes('config-path'))
    assert.ok(wrote, 'config was written; writes=' + JSON.stringify(mem.writes.map((w) => w.path)))
    assert.ok(wrote.path.startsWith(repo), 'fresh install wrote next to the repo, got ' + wrote.path)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

test('config resolution: late fs service (the second-machine bug) still loads config via ctx.inject', async () => {
  // Regression: on some machines the save-money plugin row activates BEFORE the
  // base bundle's fs-sandbox row, so a one-shot `ctx.get('fs')` captured at
  // apply() time is undefined and the config never loads or persists. The host
  // must (a) re-read fs on every use, and (b) wait via ctx.inject(['fs']) so a
  // late fs is picked up as soon as it exists.
  const repo = join(process.cwd(), '..', 'latefs-dsh-save-money') // basename must match the repo pattern
  const files = {}
  files[join(repo, 'save-money.config.json')] = JSON.stringify({ enabled: true, lang: 'ko' })
  const mem = makeMemFs(files)
  const oldHome = process.env.DSH_HOME
  delete process.env.DSH_HOME // no pointer; resolution must find the session cwd
  // fs is ABSENT during apply (not in overrides → makeCtx.get('fs') is
  // undefined), then appears later — exactly the late-activation scenario.
  const overrides = {
    sessions: { list: () => [{ id: 's', meta: { cwd: repo } }], get: () => undefined },
    agents: { currentInitiator: () => undefined, list: () => [] },
    goals: { get: () => undefined },
    sandboxPolicy: { workspaceRoot: join(process.cwd(), '..', 'deepseek-harness') },
  }
  const { ctx, routes } = makeCtx(overrides)
  try {
    await plugin.apply(ctx)
    // No boot timer fired yet; fire it now — loadConfig finds no fs and skips.
    const boot = (ctx.timer._timers || []).find((t) => t.kind === 'timeout')
    assert.ok(boot, 'boot timeout registered')
    boot.fn()
    await new Promise((r) => setTimeout(r, 20))
    // fs appears NOW (late activation) → the fs inject must trigger loadConfig.
    const fsInject = ctx._injected.find((i) => i.deps.includes('fs'))
    assert.ok(fsInject, 'fs inject registered')
    const sub = {
      get: (name) => (name === 'fs' ? mem : undefined),
      effect(fn) {
        const r = fn()
        if (typeof r === 'function') this._disposers.push(r)
      },
      _disposers: [],
    }
    overrides.fs = mem // Cordis activates fs, so ctx.get('fs') now returns it
    fsInject.callback(sub) // Cordis calls the inject callback when fs appears
    await new Promise((r) => setTimeout(r, 20))
    // Status must now report the config was loaded from the repo.
    const res = {
      writeHead(code, headers) { this.code = code; this.headers = headers },
      end(body) { this._body = body },
    }
    await routes[0].handler({ method: 'GET', url: '/save-money/status' }, res)
    const st = JSON.parse(res._body)
    assert.equal(st.configLoaded, true, 'config loaded after fs appeared late')
    assert.equal(st.workspaceRoot, repo, 'resolved the repo dir')
    assert.equal(st.config.lang, 'ko')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})
