/**
 * dsh-save-money — Request-level gate (Host side).
 *
 * Inside a pause window every streaming model call is intercepted (llm/stream
 * is the mandatory waterfall every call goes through). The gate uses the same
 * "inside window and not ignored" check as the state machine and does NOT
 * depend on the freeze record: even when no active goal is frozen,
 * manual-conversation model requests are still suspended — that is the
 * saving-money semantics.
 *
 * Implementation notes:
 *  - Cordis 3 registration API is ctx.on only; llm.stream dispatches via
 *    ctx.waterfall, and listeners must synchronously return an AsyncIterable
 *    (the caller for-await's it; an async listener would break the return
 *    type). So we return a WRAPPER stream: iteration waits for the gate to
 *    open first, then calls next() to get the real stream — options pass
 *    through untouched, routing/retry/validation are unaffected (we are
 *    registered at the chain tail; the suspend happens before the actual
 *    adapterStream).
 *  - The sandbox has no Node timer globals (setTimeout throws and fails the
 *    turn as "this run failed"); ctx.timer.timeout is a fiber effect and can
 *    still throw when registered inside an agent-turn fiber context. So
 *    waiting is EVENT-DRIVEN: suspending = registering the resolve into
 *    gateWaiters, woken by: ① the 60s tick (registered in the plugin apply
 *    context, runs reliably); ② applyConfig (disable / window change);
 *    ③ endWindowHandler (end-window); ④ plugin unload (fail-open); ⑤ request
 *    signal abort. No timers / fiber-effect calls → cannot throw, cannot
 *    interrupt a turn.
 *
 * Inlined into the host plugin body at build time (scripts/build.js): no
 * imports survive, so cross-module references are `declare`d for standalone
 * type-checking and resolve to the inlined scope at runtime.
 */

// Model tier classification comes from src/balance-bars.ts (inlined ahead).
// `console` is a sandbox global (declared so this module type-checks
// standalone; the host body provides it at runtime).
declare const console: any
declare type ModelClass = 'official-flash' | 'official-pro' | 'opencode-flash' | 'opencode-pro' | null
declare function classifyModel(provider: any, model: any): ModelClass
declare function modelApplyEnabled(applied: any, cls: ModelClass): boolean

/**
 * Create the request gate for one plugin instance.
 * @param deps.ctx - plugin context (ctx.on registration, ctx.effect).
 * @param deps.getCfg - returns the live config (enabled + modelApply).
 * @param deps.computeRawStateLocal - state-machine wrapper (same check as the
 *   tick, fed with the live config + end-this-save-mode state).
 * @param deps.onRequest - called for EVERY llm/stream request before the gate
 *   check: the host uses it to mark balance staleness / last provider / local
 *   activity (activity feeds the spend bars' activity flag).
 */
export function createGate(deps: any) {
  const ctx = deps.ctx
  let gateDisposed = false
  let gateWaiters: (() => void)[] = []
  const wakeGateWaiters = () => {
    const waiters = gateWaiters
    gateWaiters = []
    for (const release of waiters) {
      // Each waiter synchronously calls next() inside release(); if the
      // waterfall chain (DSH's own llm/stream invariants run first) throws
      // synchronously — e.g. the request context was torn down while the
      // gate held it — the exception must NOT escape into the host callback
      // that woke us (60s tick / applyConfig / unload). That would surface as
      // an uncaughtException and crash the harness. We swallow it here; the
      // pending request then rejects with the same error via the promise.
      try { release() } catch (e: any) {
        console.error('[save-money] gate release failed: ' + String((e && e.message) || e))
      }
    }
  }
  const gateClosedAt = (now: Date): boolean => {
    if (!deps.getCfg().enabled) return false
    // The gate follows the state machine exactly: computeRawStateLocal already
    // exempts the ended window (endWindowKey match + endWindowUntil), so a
    // different window (e.g. cross-timezone overlap) stays gated.
    const st = deps.computeRawStateLocal(now)
    return st.name === 'PAUSED'
  }
  const gateInstalled = typeof ctx.on === 'function'
  const install = (): void => {
    if (typeof ctx.on !== 'function') {
      console.error('[save-money] ctx.on unavailable; llm/stream gate not installed')
      return
    }
    ctx.effect(() => {
      const dispose = ctx.on('llm/stream', (options: any, next: any) => {
        // Fresh user/model activity: every llm/stream request counts (also for
        // exempted tiers — it is real usage), so mark it before any check.
        deps.onRequest(options)
        // Model-tier exemption: classify the request's provider/model tier; if
        // that tier is unchecked in modelApply (or recognition fails = null),
        // pass straight through — not paused inside windows either. Any
        // classification/query error fails safely as exempt (no pause), never
        // throws.
        try {
          const cls = classifyModel(options && options.provider, options && options.model)
          if (!modelApplyEnabled(deps.getCfg().modelApply, cls)) return next()
        } catch (e) { /* classification error → exempt (no pause) */ }
        if (!gateClosedAt(new Date())) return next()
        const waitForOpen = () => new Promise((resolve) => {
          const ready = () => gateDisposed || !gateClosedAt(new Date())
            || !!(options && options.signal && options.signal.aborted)
          // Release helper: call next() defensively. A synchronous throw from
          // the waterfall chain (request context torn down / invariant fail)
          // must surface as a rejected promise — never as an exception
          // escaping into the abort event dispatch or wakeGateWaiters.
          // Once-guard: the abort listener AND wakeGateWaiters (60s tick /
          // config change / unload) can both reach release() in the same
          // instant — resolve() is idempotent but next() is NOT, so a second
          // call would invoke the downstream chain twice.
          let released = false
          const release = () => {
            if (released) return
            released = true
            try { resolve(next()) } catch (e) {
              resolve(Promise.reject(e))
            }
          }
          if (ready()) return release()
          const waiter = () => { release() }
          gateWaiters.push(waiter)
          if (options && options.signal && typeof options.signal.addEventListener === 'function') {
            options.signal.addEventListener('abort', () => {
              const i = gateWaiters.indexOf(waiter)
              if (i >= 0) gateWaiters.splice(i, 1)
              release()
            }, { once: true })
          }
        })
        // Wrapper stream: iteration waits only when the gate is closed; once
        // open → next() → the real request proceeds as usual.
        let inner: any = null
        const getInner = () => (inner !== null ? Promise.resolve(inner) : waitForOpen().then((s) => { inner = s; return inner }))
        return {
          [Symbol.asyncIterator]() {
            let it: any = null
            return {
              next() {
                return getInner().then((s: any) => {
                  if (!it) it = s[Symbol.asyncIterator]()
                  return it.next()
                })
              },
              return(value: any) {
                return getInner().then((s: any) => {
                  if (!it) it = s[Symbol.asyncIterator]()
                  return it.return ? it.return(value) : { done: true, value }
                })
              },
              throw(e: any) {
                return getInner().then((s: any) => {
                  if (!it) it = s[Symbol.asyncIterator]()
                  return it.throw ? it.throw(e) : { done: true, value: e }
                })
              },
            }
          },
        }
      }, { global: true })
      return () => {
        gateDisposed = true
        try { wakeGateWaiters() } catch (e) { /* unload must never throw */ }
        dispose()
      }
    })
  }
  return { gateInstalled, gateClosedAt, wakeGateWaiters, install }
}
