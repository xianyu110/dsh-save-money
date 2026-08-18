/**
 * dsh-save-money — Host half (single source for both the dynamic-plugin
 * code.host and the official plugin/index.js bundle form).
 *
 * Time-window scheduling + goal freeze/resume + PauseRecord + tools + RPC.
 * Dependencies: timer (injected), agents / goals / fs (optional via ctx.get).
 * The request-level gate (user requirement: "paused = no API requests at
 * all") lives in src/gate.ts; Goals.pause is the second layer (turn-boundary
 * freeze, state preserved).
 *
 * Config persistence: written to the workspace save-money.config.json,
 * surviving refresh/restart. The workspace root is resolved AT RUNTIME from
 * the sandboxPolicy service (ctx.get('sandboxPolicy').workspaceRoot) — no
 * machine path is ever hard-coded, so the plugin works from any
 * checkout/workspace.
 */

// --- Type-only declarations (erased at build time) ---
// `harness` is injected as a global ONLY in the dynamic-plugin sandbox
// (cordis-host-runner); the official module form (plugin/index.js, mounted via
// --patch or a bundle) has no harness global and registers tools through the
// ctx.tools service instead. Runtime detection keeps one source working in
// both forms. (The `harness` declaration itself comes from the typecheck
// wrapper; see scripts/typecheck.js.)
interface TimeWindow {
  pauseAt: string
  resumeAt: string
  days?: number[]
  timezone?: string
}
interface WallClock {
  y: number
  mo: number
  d: number
  weekday: number
  minutes: number
}
interface RawState {
  name: 'NORMAL' | 'WARN' | 'PAUSED'
  reason?: string
  window?: TimeWindow
  minutesToPause?: number
}
interface CtxLike {
  get(name: string): any
  on(event: string, listener: (...args: any[]) => any, opts?: any): () => void
  effect(fn: () => void | (() => void)): void
  inject?(deps: string[], callback: (ctx: any) => void): any
  timer: {
    timeout(fn: () => void, ms: number): any
    interval(fn: () => void, ms: number): any
  }
}

// --- Pure helpers inlined from src/core.ts, src/balance-history.ts,
// src/balance-bars.ts, src/balance-host.ts, src/config.ts and src/state.ts at
// build time (scripts/build.js) — declared below to keep this file
// type-checked; the real implementations are unit-tested in the modules.
declare function wallClock(tz: string, date: Date): WallClock
declare function parseHHMM(s: string): number | null
declare function wallToUTC(tz: string, y: number, mo: number, d: number, hhmm: number): number
declare function createConfig(deps: any): any
declare function computeRawState(now: Date, input: any): RawState
declare function windowKey(w: TimeWindow, tz: string): string
// Host sub-modules (inlined at build time; factories share the state object
// `S` and receive the live config via getCfg).
declare function createGoalManager(ctx: any, S: any, getCfg: () => any): {
  collectTasks(): { ok: boolean; tasks: { agent: any; sessionId: string; goalId: string; revision: number; phase: string }[]; reason?: string }
  freeze(window: TimeWindow | undefined): { frozen: number; record: any }
  unfreeze(): { resumed: number; record: any }
  reconcile(): { restored: number; reason?: string }
}
declare function createGate(deps: any): any
declare function createBalanceTracker(ctx: any, S: any, deps: { getFs: () => any; getCfg: () => any; sandbox: boolean }): any
declare function registerHttpEndpoints(ws: any, deps: any): (() => void) | void
declare function createToolRegistrar(deps: any): void

return {
  inject: ['timer'],
  apply(ctx: CtxLike) {
    // ---- Config (moved to src/config.ts) ----
    // The config controller owns defaults, validation, load/persist and the
    // workspace resolver; `cfg` below is its live config object.
    const getFs = (): any => ctx.get('fs')
    const getSessions = (): any => ctx.get('sessions')
    const getAgents = (): any => ctx.get('agents')
    const getSandboxPolicy = (): any => ctx.get('sandboxPolicy')
    const cfgRef = createConfig({
      getFs, getSessions, getAgents, getSandboxPolicy,
      // Wake suspended requests whenever a config change opens the gate
      // (disable / window change / re-enable). Late-bound: the gate is
      // created below; the callback runs at apply time, after this apply().
      onConfigOpened: () => {
        if (gate && !gate.gateClosedAt(new Date())) gate.wakeGateWaiters()
      },
    })
    const cfg = cfgRef.cfg
    const applyConfig = (patch: any) => {
      const r = cfgRef.apply(patch)
      // Re-activation resets the one-shot "end this save mode" state: when
      // `enabled` goes false -> true, the user gets a deterministic way to
      // re-arm saving money (e.g. after skipping a window during a test).
      if (r && r.ok && patch && patch.enabled === true) {
        if (S.endWindowUntil > 0 || S.endWindowKey !== null) {
          S.endWindowUntil = 0
          S.endWindowKey = null
          console.log('[save-money] re-enabled: end-this-save-mode state reset')
        }
      }
      return r
    }
    const snapshot = () => cfgRef.snapshot()
    const loadConfig = () => cfgRef.load()
    const unwrap = (args: any) => (args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments : args)
    // "End this save mode" state — one-shot, in-memory only (never persisted):
    // applies to the exact window it was invoked for (matched by key), expires
    // at that window's resumeAt, and leaves the persistent `enabled` flag
    // untouched. The next window (today or later) is unaffected.
    // Shared plugin state (cross-module): consumed by the goal manager, the
    // request gate and the balance tracker.
    const S: any = {
      endWindowUntil: 0,
      endWindowKey: null,
      lastStateKey: 'NORMAL',
      pauseRecord: null,
      balanceDirty: false,
      lastRequestProvider: null,
      lastActivityAt: 0,
      historyDirty: false,
    }

    // ---------- Goals: freeze/resume/reconcile (src/host-goals.ts) ----------
    const goals = createGoalManager(ctx, S, () => cfg)

    // ---------- State computation ----------
    // Pure decision logic lives in src/state.ts (computeRawState); here we
    // wrap it to feed the live config + end-this-save-mode state.
    function computeRawStateLocal(now: Date): RawState {
      return computeRawState(now, {
        enabled: cfg.enabled,
        timezone: cfg.timezone,
        warnMinutes: cfg.warnMinutes,
        windows: cfg.windows,
        endWindowUntil: S.endWindowUntil,
        endWindowKey: S.endWindowKey,
      })
    }
    function onTick(now: Date) {
      const raw = computeRawStateLocal(now)
      let st = raw
      if (raw.name === 'PAUSED') {
        if (!S.pauseRecord) {
          const col = goals.collectTasks()
          if (!col.ok || col.tasks.length === 0) st = { name: 'NORMAL', reason: 'no-task' }
        }
      }
      const key = st.name + (st.window ? ':' + st.window.pauseAt : '')
      if (key !== S.lastStateKey) {
        const prevName = S.lastStateKey.split(':')[0]
        S.lastStateKey = key
        if (st.name === 'PAUSED' && prevName !== 'PAUSED') {
          goals.freeze(st.window)
        } else if (st.name !== 'PAUSED' && prevName === 'PAUSED') {
          goals.unfreeze()
        }
        console.log('[save-money] state -> ' + key)
      }
    }

    // ---------- Request-level gate (src/gate.ts) ----------
    // Event-driven suspension, never throws, zero timer dependencies — full
    // implementation notes live in the module.
    const gate = createGate({
      ctx,
      getCfg: () => cfg,
      computeRawStateLocal,
      // Called for EVERY llm/stream request (also exempted tiers — real
      // usage): marks the balance stale for the client, records the last
      // provider, and timestamps local activity (feeds the spend bars).
      onRequest: (options: any) => {
        S.balanceDirty = true
        S.lastActivityAt = Date.now()
        try {
          S.lastRequestProvider = (options && typeof options.provider === 'string' && options.provider.length > 0)
            ? options.provider
            : null
        } catch (e) { S.lastRequestProvider = null }
      },
    })
    gate.install()
    // Unload: restore any goals this plugin froze (fail-open, never hang).
    ctx.effect(() => {
      return () => {
        if (S.pauseRecord && S.pauseRecord.paused && S.pauseRecord.paused.length > 0) {
          console.log('[save-money] plugin unloading: restoring paused goals')
          goals.unfreeze()
        }
      }
    })

    // ---------- Startup reconciliation + owned timers ----------
    // ctx.timer.timeout/interval are fiber effects cleaned up automatically on
    // dispose, but hot-updates (run/update) must not rely on that: save both
    // disposers and call them explicitly in the unload effect, so a repeated
    // update can never leak a 60s tick or a boot timeout.
    ctx.effect(() => {
      const boot = ctx.timer.timeout(() => {
        // Load the persisted config first, then run startup reconciliation.
        // Balance history loads in parallel (keyId-gated; independent of config).
        void loadConfig().then(() => {
          if (cfg.reconcileOnStart) {
            const r = goals.reconcile()
            if (r.restored > 0) console.log('[save-money] startup reconcile restored ' + r.restored + ' goal(s)')
          }
        })
        void tracker.load()
      }, 100)
      const tick = ctx.timer.interval(() => {
        try {
          // Fallback release: whenever the gate is open (window ended /
          // disabled / end-window active) wake the waiters — this MUST run
          // before the enabled check, so disabling also releases waiters and
          // suspended requests never hang forever.
          if (!gate.gateClosedAt(new Date())) gate.wakeGateWaiters()
          if (!cfg.enabled) return
          onTick(new Date())
        } catch (e: any) {
          // A timer callback is a host callback: an escaping exception would
          // be an uncaughtException and crash the harness. Log and continue.
          console.error('[save-money] tick failed: ' + String((e && e.message) || e))
        }
      }, 60000)
      return () => {
        for (const dispose of [boot, tick]) {
          try { dispose() } catch (e) { /* unload must never throw */ }
        }
      }
    })
    // fs may activate AFTER the 100ms boot timer on compositions where the
    // save-money row precedes the base bundle's fs-sandbox row. Wait for the
    // service and run the same boot load + reconcile then — loadConfig is
    // idempotent, so the second run only fills the gap of the first attempt.
    if (typeof ctx.inject === 'function') {
      // Bind keeps `this` (the ctx) when Cordis calls the returned inject
      // function, and gives the closure a non-optional reference so the
      // strict-null check in the delayed callback is satisfied.
      const inject: (deps: string[], callback: (sub: any) => void) => any = ctx.inject.bind(ctx)
      ctx.effect(() => inject(['fs'], (sub: any) => {
        sub.effect(() => {
          void loadConfig().then(() => {
            if (cfg.reconcileOnStart) {
              const r = goals.reconcile()
              if (r.restored > 0) console.log('[save-money] late-fs reconcile restored ' + r.restored + ' goal(s)')
            }
          })
        })
      }))
    }

    // ---------- Status ----------
    function status(now: Date) {
      const st = computeRawStateLocal(now)
      const col = goals.collectTasks()
      const out: any = {
        enabled: cfg.enabled,
        state: st.name,
        reason: st.reason || null,
        gate: gate.gateClosedAt(now) ? 'closed' : 'open',
        gateInstalled: gate.gateInstalled,
        // Diagnostics (runtime workspace resolution) — helps verify where the
        // config file is loaded from / persisted to. resolveWorkspaceRoot is
        // async (pointer + fs probes), so report the last resolved value.
        workspaceRoot: cfgRef.resolvedConfigDir || cfgRef.defaultWorkspaceRoot,
        configLoaded: cfgRef.configLoaded,
        configPath: cfgRef.configPath,
        nowUTC: now.toISOString(),
        nowLocal: String(now),
        busy: col.ok ? (col.tasks.length > 0) : null,
        activeGoals: col.ok ? col.tasks.filter((t) => t.phase === 'active').length : null,
      }
      // Balance staleness signal: true when a user message arrived since the
      // last balance query (the client refreshes on the next poll).
      out.balanceDirty = S.balanceDirty
      if (st.window) {
        const tz = st.window.timezone || cfg.timezone
        const wc = wallClock(tz, now)
        const pUTC = wallToUTC(tz, wc.y, wc.mo, wc.d, parseHHMM(st.window.pauseAt)!)
        const rUTC = wallToUTC(tz, wc.y, wc.mo, wc.d, parseHHMM(st.window.resumeAt)!)
        out.window = {
          pauseAt: st.window.pauseAt,
          resumeAt: st.window.resumeAt,
          timezone: tz,
          pauseUTC: new Date(pUTC).toISOString(),
          resumeUTC: new Date(rUTC).toISOString(),
        }
      }
      if (st.name === 'WARN') out.minutesToPause = st.minutesToPause
      if (S.endWindowUntil > now.getTime()) out.endWindowUntil = new Date(S.endWindowUntil).toISOString()
      out.pauseRecord = S.pauseRecord ? {
        at: S.pauseRecord.at,
        window: S.pauseRecord.window,
        pausedCount: (S.pauseRecord.paused || []).length,
        paused: (S.pauseRecord.paused || []).map((p: any) => ({ sessionId: p.sessionId, goalId: p.goalId })),
      } : null
      out.config = snapshot()
      return out
    }

    // ---- Host RPC (dynamic-plugin form: harness sandbox) + HTTP endpoints
    // ---- (official bundle form ONLY: same-origin webServer /save-money/*;
    //      the dynamic Client half never registers host routes).
    const harnessApi = typeof harness !== 'undefined' ? harness : null
    if (harnessApi) {
      ctx.effect(() => harnessApi.handle('save-money/status', async () => status(new Date())))
      ctx.effect(() => harnessApi.handle('save-money/configure', async (args: any) => applyConfig(unwrap(args) || {})))
    }
    const webServer = ctx.get('webServer')
    // The plugin row only injects timer, so in the official bundle form apply()
    // can run BEFORE the webServer service is registered. Register the HTTP
    // endpoints via Cordis' inject() dependency waiting — it runs the callback
    // as soon as webServer is available, so the bundled Client half never sees
    // 404s. Skipped entirely in the dynamic form (harnessApi present).
    const httpDeps = {
      status: () => status(new Date()),
      balanceQuery: () => tracker.query(),
      applyConfig,
      endWindowHandler: () => endWindowHandler(),
    }
    if (!harnessApi && webServer && typeof webServer.register === 'function') {
      ctx.effect(() => registerHttpEndpoints(webServer, httpDeps) as any)
    } else if (!harnessApi && typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub: any) => {
        sub.effect(() => registerHttpEndpoints(sub.get('webServer'), httpDeps) as any)
      })
    }
    // UTC instant of a window's resumeAt (handles midnight-crossing windows).
    const endWindowUntilUTC = (w: TimeWindow, tz: string, baseWc: WallClock, dayOffset: number): number => {
      const p = parseHHMM(w.pauseAt)!, r = parseHHMM(w.resumeAt)!
      const off = dayOffset + (r < p ? 1 : 0)
      const base = new Date(Date.UTC(baseWc.y, baseWc.mo - 1, baseWc.d + off))
      return wallToUTC(tz, base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), r)
    }
    // "End this save mode" — one-shot, current window only: paused →
    // immediately resumes frozen goals and clears the record; pause upcoming
    // (WARN) → cancels it; no active window → nothing happens (never touches
    // later windows). The window is skipped until its resumeAt; the persistent
    // `enabled` flag is untouched.
    const endWindowHandler = async (): Promise<any> => {
      const now = new Date()
      const raw = computeRawStateLocal(now)
      if (!raw.window) {
        console.log('[save-money] end-window: no active window')
        return { ok: false, message: 'no active pause window to end', ...status(now) }
      }
      const tz = raw.window.timezone || cfg.timezone
      const wc = wallClock(tz, now)
      S.endWindowUntil = endWindowUntilUTC(raw.window, tz, wc, 0)
      S.endWindowKey = windowKey(raw.window, tz)
      if (S.lastStateKey.split(':')[0] === 'PAUSED') {
        S.lastStateKey = 'NORMAL'
        goals.unfreeze()
      }
      gate.wakeGateWaiters() // the gate is now open (endWindowUntil), release immediately
      console.log('[save-money] ended save mode for this window until ' + new Date(S.endWindowUntil).toISOString())
      return status(new Date())
    }
    if (harnessApi) {
      ctx.effect(() => harnessApi.handle('save-money/end-window', async () => endWindowHandler()))
    }

    // ---- Account balance (src/balance-host.ts transport +
    //      src/balance-tracker.ts sampling/persist/query) ----
    // The balance display is opt-in (cfg.showBalance, persisted, default off):
    // when off, the query reports unavailable so the UI hides the balance.
    // Every failure returns ok:false and never throws.
    const tracker = createBalanceTracker(ctx, S, { getFs, getCfg: () => cfg, sandbox: !!harnessApi })
    // Unload: force-flush the dirty history (async best-effort).
    ctx.effect(() => {
      return () => {
        if (S.historyDirty) void tracker.persist()
      }
    })
    // Backend 5-minute sampler: only while the balance display is on
    // (skipped when off — no upstream requests are produced).
    ctx.effect(() => {
      const dispose = ctx.timer.interval(() => {
        if (cfg.showBalance) void tracker.sample()
      }, 300000)
      return () => {
        try { dispose() } catch (e) { /* unload must never throw */ }
      }
    })
    // Write throttle: same 5-minute cadence as the sampler; only writes when
    // dirty (less disk IO).
    ctx.effect(() => {
      const dispose = ctx.timer.interval(() => {
        if (S.historyDirty) void tracker.persist()
      }, 300000)
      return () => {
        try { dispose() } catch (e) { /* unload must never throw */ }
      }
    })
    if (harnessApi) {
      ctx.effect(() => harnessApi.handle('save-money/balance', async () => tracker.query()))
    }

    // ---- Dynamic tools (src/host-tools.ts) ----
    createToolRegistrar({
      harnessApi,
      ctx,
      status: () => status(new Date()),
      configure: (args: any) => applyConfig(unwrap(args) || {}),
      onTick: () => { onTick(new Date()) },
      endWindowHandler,
    })
  },
}
