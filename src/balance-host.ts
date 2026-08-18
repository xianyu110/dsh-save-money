/**
 * dsh-save-money — Balance transport: one upstream /user/balance request
 * (official DeepSeek API), Host side.
 *
 * createBalanceService exposes a cached, in-flight-deduped query() that never
 * throws: it gates on the official API config, fetches through real fetch (the
 * official module form) or curl via the subprocess service (the dynamic-plugin
 * sandbox, where fetch is a guard stub), and fails closed on any error.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive, so cross-module references are `declare`d for standalone
 * type-checking and resolve to the inlined scope at runtime.
 */

// Node/browser globals used by the transport — declared here so the module
// type-checks standalone and the dynamic sandbox (no process globals) never
// trips over them.
declare const fetch: any
declare const AbortSignal: any
declare const setTimeout: any
declare const clearTimeout: any

/** Cache window; the header polls every 30s, so keep the upstream call rare. */
export const CACHE_MS = 60000

/** Hard ceiling for one upstream balance attempt (fetch or subprocess settle).
 * The DeepSeek /user/balance call normally returns in ~1s; a 5s bound gives
 * plenty of headroom while guaranteeing a hung child can never pin the plugin. */
const UPSTREAM_TIMEOUT_MS = 5000

/**
 * Race a promise against a timeout so a hung subprocess or service call can
 * NEVER pin the balance service (and therefore the plugin) forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Create the balance service for one plugin instance.
 * @param ctx - plugin context (ctx.get for credentials / settings / subprocess).
 * @param opts.sandbox - true in the dynamic-plugin sandbox (no real fetch);
 *   false in the official module form (Node fetch available).
 */
export function createBalanceService(ctx: any, opts: { sandbox: boolean }): { query(): Promise<any> } {
  let cache: { at: number; data: any } | null = null
  let inFlight: Promise<any> | null = null
  return {
    query(): Promise<any> {
      const now = Date.now()
      if (cache && now - cache.at < CACHE_MS) return Promise.resolve(cache.data)
      if (inFlight) return inFlight
      inFlight = (async () => {
        let out: any
        try {
          const gate = await balanceAvailable(ctx)
          out = gate.ok
            ? await withTimeout(fetchBalance(ctx, opts.sandbox), UPSTREAM_TIMEOUT_MS, 'balance upstream timeout')
            : { ok: false, error: gate.reason || 'balance not available' }
        } catch (e: any) {
          out = { ok: false, error: String((e && e.message) || e) }
        }
        cache = { at: Date.now(), data: out }
        return out
      })().finally(() => { inFlight = null })
      return inFlight
    },
  }
}

/**
 * Gate: only the official DeepSeek API offers /user/balance.
 *
 * The gate checks the DeepSeek provider's OWN configuration (baseURL must be
 * the official endpoint, or unset to use the official default), NOT the
 * session's current default model. Users routinely configure several model
 * sources (official DeepSeek + SiliconFlow / relays / …) and switch the
 * default model between them; the balance is a property of the official
 * DeepSeek account, so it stays queryable regardless of which provider the
 * current model belongs to. If the official baseURL is overridden to a relay
 * (no /user/balance endpoint), the gate rejects so the UI does not show a
 * misleading balance.
 */
async function balanceAvailable(ctx: any): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const settings = ctx.get('settings')
    const sec = settings && typeof settings.get === 'function' ? settings.get('llm-deepseek') : undefined
    const base = sec && typeof sec === 'object' && typeof sec.baseURL === 'string' ? sec.baseURL : ''
    if (base && !/^https?:\/\/api\.deepseek\.com\/?$/.test(String(base).trim())) {
      return { ok: false, reason: 'llm-deepseek baseURL is not the official API: ' + String(base) }
    }
  } catch (e) { /* settings unavailable — assume official default */ }
  return { ok: true }
}

/** One balance request (no caching; see the service wrapper). */
async function fetchBalance(ctx: any, sandbox: boolean): Promise<any> {
  const creds = ctx.get('credentials')
  const key = creds && typeof creds.resolve === 'function'
    ? await creds.resolve('DEEPSEEK_API_KEY').then((r: any) => r && r.value).catch(() => undefined)
    : undefined
  if (!key) return { ok: false, error: 'no DEEPSEEK_API_KEY credential' }
  const url = 'https://api.deepseek.com/user/balance'
  try {
    let status = 0
    let text = ''
    if (!sandbox && typeof fetch === 'function') {
      // Official module form runs in Node: real fetch is available.
      const res = await fetch(url, {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(10000)
          : undefined,
      })
      status = res.status
      text = await res.text()
    } else {
      // Dynamic sandbox: `fetch` exists but is a guard stub that throws on
      // call — run curl via the subprocess service. Any shape mismatch fails
      // closed (ok:false) and can never throw out of this function.
      const sub = ctx.get('subprocess')
      if (!sub || typeof sub.spawn !== 'function') {
        return { ok: false, error: 'no fetch or subprocess available for balance' }
      }
      let done: any = null
      let raw = ''
      try {
        const handle = sub.spawn({
          argv: ['curl', '-sS', '-f', '-m', '10', '-H', 'Authorization: Bearer ' + key, url],
          cwd: '.',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 4096 } },
          graceMs: 12000,
        })
        // handle.done is the settle result (awaitable); some spawn flavors
        // expose it as a function — support both shapes. A hard timeout keeps
        // a hung curl from ever pinning the balance query: on timeout we try
        // to kill the child (best-effort) and fail closed.
        const settle = typeof handle.done === 'function'
          ? withTimeout(Promise.resolve(handle.done()), UPSTREAM_TIMEOUT_MS, 'balance curl timeout')
          : withTimeout(Promise.resolve(handle.done), UPSTREAM_TIMEOUT_MS, 'balance curl timeout')
        done = await settle
        try { if (handle && typeof handle.kill === 'function') handle.kill() } catch (e) { /* best-effort */ }
        const collected = handle.collected && handle.collected.stdout
        raw = collected && typeof collected.readFrom === 'function'
          ? collected.readFrom(0).text
          : ''
      } catch (e: any) {
        return { ok: false, error: 'balance subprocess failed: ' + String((e && e.message) || e) }
      }
      // curl's exit code is NOT an HTTP status: with -f, exit 0 means the
      // request succeeded (2xx), non-zero means an HTTP error or transport
      // failure. Map exit 0 -> 200 so the ok check below works; anything else
      // keeps the non-zero code and fails the ok check.
      status = done && done.exitCode === 0 ? 200 : (done && typeof done.exitCode === 'number' ? done.exitCode : 0)
      text = raw || ''
    }
    let data: any = null
    try { data = JSON.parse(text) } catch (e) { /* non-JSON body */ }
    if (data && typeof data === 'object' && Array.isArray(data.balance_infos)) {
      return {
        ok: status >= 200 && status < 300,
        httpStatus: status,
        available: data.is_available === true,
        balance: data.balance_infos.map((b: any) => ({
          currency: b.currency,
          total: b.total_balance,
          granted: b.granted_balance,
          toppedUp: b.topped_up_balance,
        })),
      }
    }
    return { ok: false, httpStatus: status, error: 'unexpected response: ' + text.slice(0, 200) }
  } catch (e: any) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
