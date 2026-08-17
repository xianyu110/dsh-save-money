/**
 * dsh-save-money — Host half (single source for both the dynamic-plugin
 * code.host and the official plugin/index.js bundle form).
 *
 * Dynamic Cordis plugin: time-window scheduling + goal freeze/resume +
 * PauseRecord + tools + RPC.
 * Dependencies: timer (injected), agents / goals / fs (optional via ctx.get).
 *
 * Request-level gate (user requirement: "paused = no API requests at all"):
 *  - A llm/stream listener is registered via ctx.on (the Cordis 3 registration
 *    API; llm/stream is dispatched through ctx.waterfall, so every listener
 *    receives (options, next)) — inside a pause window every streaming model
 *    call (including retries, sub-agents, workflows and title generation) is
 *    suspended before it is sent, so nothing ever reaches the API provider and
 *    no cost is incurred.
 *  - Goals.pause is the second layer: turn-boundary freeze (state preserved)
 *    plus this hard request-level gate (no request leaves).
 *  - Suspension semantics (user requirement: "like a C hook + spin sleep —
 *    intercept before the request is sent, do not disturb the context or the
 *    API interaction trajectory, keep flowing once released"): llm.stream is
 *    dispatched through ctx.waterfall and each listener must synchronously
 *    return an AsyncIterable; we return a WRAPPER stream: iteration waits for
 *    the gate to open, then calls next() to obtain the real stream — the
 *    options request object passes through untouched and the underlying
 *    routing / retry / validation chain is unaffected (retries happen at the
 *    agent/request-error extension point and are unrelated to this pause).
 *  - Waiting is EVENT-DRIVEN: waiters register into gateWaiters and are woken
 *    by one of five events — the 60s tick (registered in the plugin apply
 *    context), applyConfig (disable / window change), endWindowHandler
 *    (end-window), plugin unload (fail-open), or the request signal abort.
 *    Then next() is called to release. Zero timers, zero fiber-effect calls:
 *    it cannot throw and cannot interrupt a turn.
 *  - Release conditions: window ended / enabled:false (disabled) / window
 *    ended early via "end this save mode" (one-shot, current window only) /
 *    plugin unloaded (fail-open, so requests never hang forever after
 *    unload) / request signal aborted (delegated to the underlying layer to
 *    emit an aborted finish chunk).
 *  - Note: llm/stream is a global waterfall (bound to LlmRuntime), so the
 *    suspension also applies to manual conversations in the current session —
 *    the AI not replying inside a window is expected behaviour (that is the
 *    saving-money semantics); the user can release via the
 *    "end this save mode" UI buttons (host.call RPC, no model needed).
 *
 * Config persistence: written to the workspace save-money.config.json, surviving
 * refresh/restart. The workspace root is resolved AT RUNTIME from the
 * sandboxPolicy service (ctx.get('sandboxPolicy').workspaceRoot) — no machine
 * path is ever hard-coded, so the plugin works from any checkout/workspace.
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
type LangChoice = 'auto' | 'zh' | 'en'
interface WallClock {
  y: number
  mo: number
  d: number
  weekday: number
  minutes: number
}
interface NextPause {
  dayOffset: number
  minutes: number
}
interface GoalRef {
  sessionId: string
  goalId: string
  revision: number
  pausedAt?: number
}
interface TaskInfo {
  agent: any
  sessionId: string
  goalId: string
  revision: number
  phase: string
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
// `process` exists ONLY in the official module form (plugin/index.js runs in
// the Node harness process); the dynamic-plugin sandbox has no Node globals.
// Every access is guarded with typeof so one source works in both forms.
declare const process: any

// --- Pure helpers inlined from src/core.ts + src/balance-host.ts at build
// time (scripts/build.js) ---
// The declarations below keep this file type-checked; the real implementations
// live in the modules and are unit-tested there.
declare function wallClock(tz: string, date: Date): WallClock
declare function parseHHMM(s: string): number | null
declare function dowNum(wd: number): number
declare function windowMatchesAt(w: TimeWindow, wc: WallClock): boolean
declare function nextPause(w: TimeWindow, tz: string, wc: WallClock): NextPause | null
declare function wallToUTC(tz: string, y: number, mo: number, d: number, hhmm: number): number
declare function isValidTz(tz: string): boolean
declare function validateWindows(windows: TimeWindow[], defaultTz: string): { ok: boolean; error?: string }
declare function createBalanceService(ctx: any, opts: { sandbox: boolean }): { query(): Promise<any> }
declare function createBalanceHistory(): {
  record(total: number, at?: number): void
  latest(): number | null
  totalAgo(ms: number, now?: number): number | null
  spend(ms: number, now?: number): number | null
  points(): { at: number; total: number }[]
  clear(): void
}

return {
  inject: ['timer'],
  apply(ctx: CtxLike) {
    const DEFAULTS = {
      enabled: false,
      timezone: 'Asia/Shanghai',
      warnMinutes: 5,
      windows: [] as TimeWindow[],
      reconcileOnStart: true,
      lang: 'auto' as LangChoice,
      showBalance: false,
    }
    let cfg = { ...DEFAULTS, windows: [] as TimeWindow[] }
    let pauseRecord: {
      pausedBySaveMoney: boolean
      at: string
      window: { pauseAt: string; resumeAt: string; timezone: string } | null
      paused: GoalRef[]
      cascaded: boolean
    } | null = null
    // "End this save mode" state — one-shot, in-memory only (never persisted):
    // applies to the exact window it was invoked for (matched by key), expires
    // at that window's resumeAt, and leaves the persistent `enabled` flag
    // untouched. The next window (today or later) is unaffected.
    let endWindowUntil = 0
    let endWindowKey: string | null = null
    let lastStateKey = 'NORMAL'
    let configLoaded = false
    let configPath = ''
    const unwrap = (args: any) => (args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments : args)

    // Config persistence to the workspace file (survives browser refresh /
    // plugin re-activation). The config location is resolved AT RUNTIME by
    // walking a candidate list (see candidateRoots) — session cwd first, then
    // process cwd and its sibling directory (the README quick-install layout
    // ~/app/dsh-save-money next to ~/app/deepseek-harness), then the
    // sandboxPolicy fallback. The FIRST directory that actually contains a
    // save-money.config.json wins; a pointer file in the DSH user dir
    // (~/.dsh/save-money-config-path.json) records the last real location so
    // a later restart resolves the SAME file even when no session cwd matches
    // (e.g. the harness was started from a different directory). No machine
    // path is ever hard-coded.
    const CONFIG_FILE = 'save-money.config.json'
    const POINTER_FILE = 'save-money-config-path.json'
    // Services are read DYNAMICALLY on every use, not captured once at apply():
    // the official bundle form (plugin/index.js) is a plugin row that can be
    // activated BEFORE the base bundle's fs-sandbox / sandbox-policy / sessions
    // rows (Cordis activation order is composition order, and the user's plugin
    // row is inserted into the profile alongside them). A one-shot
    // `const fs = ctx.get('fs')` would permanently capture `undefined` on such
    // machines — exactly the "settings never persist / never load" report on a
    // second computer. Each helper re-reads the service at call time, and the
    // boot path also waits via ctx.inject(['fs']) (see startup below), so a
    // late fs service is picked up as soon as it exists.
    const getFs = (): any => ctx.get('fs')
    const getSessions = (): any => ctx.get('sessions')
    const getAgents = (): any => ctx.get('agents')
    const getSandboxPolicy = (): any => ctx.get('sandboxPolicy')
    const defaultWorkspaceRoot: string = (() => {
      const sandboxPolicy = getSandboxPolicy()
      return (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot.length > 0)
        ? sandboxPolicy.workspaceRoot
        : ''
    })()
    // sandboxPolicy.workspaceRoot is the process cwd (the DSH install dir), not
    // the session workspace. The plugin config belongs to the save-money
    // workspace, so prefer a session whose cwd points at this repo (matched by
    // directory basename only — no machine path is hard-coded).
    const sessionCwdOf = (s: any): string => {
      const c = s && (s.meta && s.meta.cwd || s.header && s.header.cwd || s.cwd)
      return typeof c === 'string' ? c : ''
    }
    // DSH user dir (~/.dsh): exists on Windows / macOS / Linux. The pointer
    // file lives here because it is the one location that never moves with the
    // harness install dir or the session cwd.
    const dshHome = (): string => {
      try {
        const h = (typeof process !== 'undefined' && process && process.env)
          ? (process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME)
          : ''
        return typeof h === 'string' && h.length > 0 ? h.replace(/[\\/]+$/, '') : ''
      } catch (e) { return '' }
    }
    // Read the pointer file (best-effort; '' when absent/unreadable).
    const readPointer = async (): Promise<string> => {
      const home = dshHome()
      const fs = getFs()
      if (!home || !fs) return ''
      try {
        const target = await fs.resolve(POINTER_FILE, { cwd: home })
        const text = await fs.readText(target)
        const data = JSON.parse(text)
        const p = data && typeof data.path === 'string' ? data.path : ''
        return p.replace(/[\\/]+$/, '')
      } catch (e) { return '' }
    }
    // Record the last real config dir in ~/.dsh (best-effort; never throws).
    const writePointer = async (dir: string): Promise<void> => {
      const home = dshHome()
      const fs = getFs()
      if (!home || !fs || !dir) return
      try {
        const target = await fs.resolve(POINTER_FILE, { cwd: home })
        await fs.writeText(target, JSON.stringify({ path: dir }, null, 2), undefined, undefined,
          { mode: 'workspace-write', workspaceRoot: home })
      } catch (e) { /* best-effort */ }
    }
    // Candidate config directories, highest priority first. The pointer (the
    // last real location) is handled separately in resolveWorkspaceRoot.
    const candidateRoots = (): string[] => {
      const out: string[] = []
      const push = (c: string) => {
        c = String(c || '').replace(/[\\/]+$/, '')
        if (c && !out.includes(c)) out.push(c)
      }
      // ① the calling session (agents.currentInitiator): the session that
      //    actually uses the plugin, so config follows the user's workspace.
      try {
        const agentsSvc = getAgents()
        const init = agentsSvc && typeof agentsSvc.currentInitiator === 'function'
          ? agentsSvc.currentInitiator()
          : undefined
        const sessionsSvc = getSessions()
        if (init && sessionsSvc && typeof sessionsSvc.get === 'function') {
          push(sessionCwdOf(sessionsSvc.get(init.id) || init))
        }
      } catch (e) { /* skip */ }
      // ② every session whose cwd matches the repo basename (last wins, so
      //    the newest checkout is preferred when several exist).
      const sessionsSvc = getSessions()
      if (sessionsSvc && typeof sessionsSvc.list === 'function') {
        try {
          const matches: string[] = []
          for (const s of sessionsSvc.list()) {
            const c = sessionCwdOf(s).replace(/[\\/]+$/, '')
            if (/dsh-save-money$/i.test(c)) matches.push(c)
          }
          for (const m of matches) push(m)
        } catch (e) { /* skip */ }
      }
      // ③ process.cwd() itself (official module form only; the harness may be
      //    started from the repo checkout).
      try {
        if (typeof process !== 'undefined' && process && typeof process.cwd === 'function') {
          push(String(process.cwd()))
        }
      } catch (e) { /* skip */ }
      // ④ sibling of process.cwd() named dsh-save-money — the README
      //    quick-install layout: ~/app/dsh-save-money next to
      //    ~/app/deepseek-harness, harness started from the latter.
      try {
        if (typeof process !== 'undefined' && process && typeof process.cwd === 'function') {
          const cwd = String(process.cwd()).replace(/[\\/]+$/, '')
          const idx = Math.max(cwd.lastIndexOf('\\'), cwd.lastIndexOf('/'))
          if (idx > 0) push(cwd.slice(0, idx + 1) + 'dsh-save-money')
        }
      } catch (e) { /* skip */ }
      // ⑤ sandboxPolicy fallback (the harness install dir).
      push(defaultWorkspaceRoot)
      return out
    }
    // The last successfully used config dir (for status diagnostics + write
    // targeting without re-resolving on every call).
    let resolvedConfigDir = ''
    const resolveWorkspaceRoot = async (): Promise<string> => {
      const fs = getFs()
      if (!fs) return defaultWorkspaceRoot
      // ① pointer file: the last real location wins, so a restart resolves the
      //    same file even when no session cwd matches (the harness was started
      //    from a different directory than the repo).
      const ptr = await readPointer()
      if (ptr) {
        try {
          await fs.readText(await fs.resolve(CONFIG_FILE, { cwd: ptr }))
          resolvedConfigDir = ptr
          return ptr
        } catch (e) { /* pointer stale — fall through to candidates */ }
      }
      const roots = candidateRoots()
      for (const dir of roots) {
        if (!dir) continue
        try {
          await fs.readText(await fs.resolve(CONFIG_FILE, { cwd: dir }))
          resolvedConfigDir = dir
          return dir
        } catch (e) { /* no config here — try next */ }
      }
      // No config exists anywhere yet: prefer a repo-named candidate (the
      // sibling-directory layout from the README, or a session cwd), so a
      // fresh install writes next to the checkout instead of polluting the
      // harness install dir; fall back to the first candidate.
      let target = ''
      for (const dir of roots) {
        if (dir && /dsh-save-money$/i.test(dir)) { target = dir; break }
      }
      resolvedConfigDir = target || roots[0] || defaultWorkspaceRoot
      return resolvedConfigDir
    }
    const windowKey = (w: TimeWindow, tz: string) => w.pauseAt + '|' + w.resumeAt + '|' + (w.timezone || tz)
    const persistConfig = async () => {
      const fs = getFs()
      if (!fs) {
        console.error('[save-money] persist skipped: fs service unavailable')
        return
      }
      try {
        const workspaceRoot = await resolveWorkspaceRoot()
        if (!workspaceRoot) return
        const resolveOpts = { cwd: workspaceRoot }
        const writePolicy = { mode: 'workspace-write', workspaceRoot }
        const target = await fs.resolve(CONFIG_FILE, resolveOpts)
        configPath = fs.processPath ? String(fs.processPath(target)) : String(target && (target.path || target.filePath || ''))
        await fs.writeText(target, JSON.stringify(snapshot(), null, 2), undefined, undefined, writePolicy)
        await writePointer(workspaceRoot)
        console.log('[save-money] config persisted to ' + workspaceRoot + '\\' + CONFIG_FILE)
      } catch (e: any) {
        console.error('[save-money] persist failed: ' + String((e && e.message) || e))
      }
    }
    const loadConfig = async () => {
      const fs = getFs()
      if (!fs) {
        console.error('[save-money] load skipped: fs service unavailable')
        return
      }
      try {
        const workspaceRoot = await resolveWorkspaceRoot()
        if (!workspaceRoot) return
        const resolveOpts = { cwd: workspaceRoot }
        const target = await fs.resolve(CONFIG_FILE, resolveOpts)
        configPath = fs.processPath ? String(fs.processPath(target)) : String(target && (target.path || target.filePath || ''))
        const text = await fs.readText(target)
        const data = JSON.parse(text)
        configLoaded = true
        const next = { ...cfg }
        if (typeof data.enabled === 'boolean') next.enabled = data.enabled
        if (typeof data.timezone === 'string' && isValidTz(data.timezone)) next.timezone = data.timezone
        if (typeof data.warnMinutes === 'number' && data.warnMinutes >= 0) next.warnMinutes = data.warnMinutes
        if (typeof data.reconcileOnStart === 'boolean') next.reconcileOnStart = data.reconcileOnStart
        if (typeof data.showBalance === 'boolean') next.showBalance = data.showBalance
        if (data.lang === 'auto' || data.lang === 'zh' || data.lang === 'zh-TW' || data.lang === 'en' ||
            data.lang === 'de' || data.lang === 'fr' || data.lang === 'es' || data.lang === 'it' ||
            data.lang === 'pt' || data.lang === 'ja' || data.lang === 'ko') next.lang = data.lang
        if (Array.isArray(data.windows)) {
          const v = validateWindows(data.windows, next.timezone)
          if (v.ok) next.windows = data.windows.map((w: TimeWindow) => ({ ...w }))
        }
        cfg = next
        console.log('[save-money] config loaded from ' + workspaceRoot + '\\' + CONFIG_FILE)
      } catch (e: any) {
        console.log('[save-money] no config file (fresh start): ' + String((e && e.message) || e))
      }
    }

    // ---------- Config ----------
    // Pure helpers (wallClock / parseHHMM / windowMatchesAt / nextPause /
    // wallToUTC / isValidTz / validateWindows) live in src/core.ts and are
    // inlined into this body at build time; see the declarations above.
    function applyConfig(patch: any): any {
      const next = { ...cfg, ...patch }
      if (next.windows === undefined) next.windows = []
      const v = validateWindows(next.windows, next.timezone)
      if (!v.ok) return { ok: false, error: v.error }
      if (next.timezone !== undefined && !isValidTz(next.timezone)) {
        return { ok: false, error: 'invalid IANA timezone: ' + next.timezone }
      }
      if (next.warnMinutes !== undefined && (!Number.isFinite(next.warnMinutes) || next.warnMinutes < 0)) {
        return { ok: false, error: 'warnMinutes must be >= 0' }
      }
      if (next.showBalance !== undefined && typeof next.showBalance !== 'boolean') {
        return { ok: false, error: 'showBalance must be a boolean' }
      }
      const LANGS = ['auto', 'zh', 'zh-TW', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ja', 'ko']
      if (next.lang !== undefined && !LANGS.includes(next.lang)) {
        return { ok: false, error: 'lang must be one of auto/zh/zh-TW/en/de/fr/es/it/pt/ja/ko' }
      }
      // Re-activation resets the one-shot "end this save mode" state: when
      // `enabled` goes false -> true, clear endWindowUntil/endWindowKey so
      // every window takes effect again. The user gets a deterministic way to
      // re-arm saving money (e.g. after skipping a window during a test) by
      // toggling the Enable switch off and on.
      if (patch && patch.enabled === true && !cfg.enabled) {
        endWindowUntil = 0
        endWindowKey = null
        console.log('[save-money] re-enabled: end-this-save-mode state reset')
      }
      cfg = next
      // Wake waiters only when the gate is actually open (unconditional wake
      // released suspended requests inside the window — observed as "still
      // thinking after pause" caused by the tick releasing every 60s).
      if (!gateClosedAt(new Date())) wakeGateWaiters()
      void persistConfig() // persist on every config change
      return { ok: true, config: snapshot() }
    }
    function snapshot() {
      return {
        enabled: cfg.enabled,
        timezone: cfg.timezone,
        warnMinutes: cfg.warnMinutes,
        reconcileOnStart: cfg.reconcileOnStart,
        lang: cfg.lang,
        showBalance: cfg.showBalance,
        windows: cfg.windows.map((w) => ({ ...w })),
      }
    }

    // ---------- Busy detection / freeze / resume ----------
    function collectTasks(): { ok: boolean; tasks: TaskInfo[]; reason?: string } {
      const agents = ctx.get('agents')
      const goals = ctx.get('goals')
      if (!agents || !goals) return { ok: false, tasks: [], reason: 'agents/goals services unavailable' }
      const tasks: TaskInfo[] = []
      for (const agent of agents.list()) {
        let gv: any = undefined
        try { gv = goals.get(agent) } catch (e) { gv = undefined }
        if (gv && (gv.phase === 'active' || (pauseRecord && pauseRecord.paused && pauseRecord.paused.some((p) => p.sessionId === agent.id)))) {
          tasks.push({ agent, sessionId: agent.id, goalId: gv.id, revision: gv.revision, phase: gv.phase })
        }
      }
      return { ok: true, tasks }
    }
    function freeze(window: TimeWindow | undefined): { frozen: number; record: any } {
      const col = collectTasks()
      if (!col.ok) { console.error('[save-money] freeze skipped:', col.reason); return { frozen: 0, record: null } }
      const freezeTargets = col.tasks.filter((t) => t.phase === 'active')
      if (freezeTargets.length === 0) {
        console.log('[save-money] pauseAt reached but no active tasks; not pausing')
        return { frozen: 0, record: null }
      }
      const goals = ctx.get('goals')
      const paused: GoalRef[] = []
      for (const t of freezeTargets) {
        try {
          goals.pause(t.agent, { id: t.goalId, revision: t.revision })
          paused.push({ sessionId: t.sessionId, goalId: t.goalId, revision: t.revision, pausedAt: Date.now() })
        } catch (e: any) {
          console.error('[save-money] goals.pause failed for ' + t.sessionId + ': ' + String((e && e.message) || e))
        }
      }
      pauseRecord = {
        pausedBySaveMoney: true,
        at: new Date().toISOString(),
        window: window ? { pauseAt: window.pauseAt, resumeAt: window.resumeAt, timezone: window.timezone || cfg.timezone } : null,
        paused,
        cascaded: true,
      }
      console.log('[save-money] FROZEN ' + paused.length + ' goal(s), record written')
      return { frozen: paused.length, record: pauseRecord }
    }
    function unfreeze(): { resumed: number; record: any } {
      if (!pauseRecord) return { resumed: 0, record: null }
      const agents = ctx.get('agents')
      const goals = ctx.get('goals')
      const remaining: GoalRef[] = []
      let resumed = 0
      const targets = pauseRecord.paused || []
      for (const p of targets) {
        const agent = agents && agents.get(p.sessionId)
        if (!agent) continue
        try {
          const gv = goals.get(agent)
          if (gv && gv.phase === 'paused') {
            goals.resume(agent, { id: gv.id, revision: gv.revision })
            resumed++
          } else if (gv && gv.phase === 'active') {
            resumed++
          }
        } catch (e: any) {
          console.error('[save-money] goals.resume failed for ' + p.sessionId + ': ' + String((e && e.message) || e))
          remaining.push(p)
        }
      }
      pauseRecord = remaining.length > 0 ? { ...pauseRecord, paused: remaining } : null
      console.log('[save-money] RESUMED ' + resumed + ' goal(s)' + (remaining.length > 0 ? ', ' + remaining.length + ' still pending' : ', record cleared'))
      return { resumed, record: pauseRecord }
    }
    ctx.effect(() => {
      return () => {
        if (pauseRecord && pauseRecord.paused && pauseRecord.paused.length > 0) {
          console.log('[save-money] plugin unloading: restoring paused goals')
          unfreeze()
        }
      }
    })

    // ---------- State computation ----------
    function computeRawState(now: Date): RawState {
      if (!cfg.enabled) return { name: 'NORMAL', reason: 'disabled' }
      for (const w of cfg.windows) {
        const tz = w.timezone || cfg.timezone
        if (windowMatchesAt(w, wallClock(tz, now))) {
          // "End this save mode" only affects the exact window it was applied
          // to — a stale endWindowUntil must not suppress later windows.
          if (endWindowUntil > now.getTime() && endWindowKey === windowKey(w, tz)) return { name: 'NORMAL', reason: 'ended', window: w }
          return { name: 'PAUSED', window: w }
        }
      }
      let nearest: { delta: number; window: TimeWindow } | null = null
      for (const w of cfg.windows) {
        const tz = w.timezone || cfg.timezone
        const wc = wallClock(tz, now)
        const np = nextPause(w, tz, wc)
        if (!np) continue
        const delta = np.dayOffset * 1440 + np.minutes - wc.minutes
        if (nearest === null || delta < nearest.delta) nearest = { delta, window: w }
      }
      if (nearest !== null && nearest.delta > 0 && nearest.delta <= cfg.warnMinutes) {
        // The upcoming window may already be ended via "end this save mode"
        // (clicked while WARN) — do not keep showing "pause soon", suppress it
        // until the window's own resumeAt.
        if (endWindowUntil > now.getTime() && endWindowKey === windowKey(nearest.window, nearest.window.timezone || cfg.timezone)) {
          return { name: 'NORMAL', reason: 'ended', window: nearest.window }
        }
        return { name: 'WARN', window: nearest.window, minutesToPause: nearest.delta }
      }
      return { name: 'NORMAL', reason: 'no-window' }
    }
    function onTick(now: Date) {
      const raw = computeRawState(now)
      let st = raw
      if (raw.name === 'PAUSED') {
        if (!pauseRecord) {
          const col = collectTasks()
          if (!col.ok || col.tasks.length === 0) st = { name: 'NORMAL', reason: 'no-task' }
        }
      }
      const key = st.name + (st.window ? ':' + st.window.pauseAt : '')
      if (key !== lastStateKey) {
        const prevName = lastStateKey.split(':')[0]
        lastStateKey = key
        if (st.name === 'PAUSED' && prevName !== 'PAUSED') {
          freeze(st.window)
        } else if (st.name !== 'PAUSED' && prevName === 'PAUSED') {
          unfreeze()
        }
        console.log('[save-money] state -> ' + key)
      }
    }

    // ---------- Request-level gate (event-driven suspension; never throws,
    //            zero timer dependencies) ----------
    // Inside a pause window every streaming model call is intercepted (llm/stream
    // is the mandatory waterfall every call goes through). The gate uses the
    // same "inside window and not ignored" check as the state machine, and does
    // NOT depend on the freeze record: even when no active goal is frozen,
    // manual-conversation model requests are still suspended — that is
    // the saving-money semantics.
    // Implementation notes:
    //  - Cordis 3 registration API is ctx.on only; llm.stream dispatches via
    //    ctx.waterfall, and listeners must synchronously return an AsyncIterable
    //    (the caller for-await's it; an async listener would break the return
    //    type). So we return a WRAPPER stream: iteration waits for the gate to
    //    open first, then calls next() to get the real stream — options pass
    //    through untouched, routing/retry/validation are unaffected (we are
    //    registered at the chain tail; the suspend happens before the actual
    //    adapterStream).
    //  - The sandbox has no Node timer globals (setTimeout throws and fails the
    //    turn as "this run failed"); ctx.timer.timeout is a fiber effect and can
    //    still throw when registered inside an agent-turn fiber context. So
    //    waiting is EVENT-DRIVEN: suspending = registering the resolve into
    //    gateWaiters, woken by: ① the 60s tick (registered in the plugin apply
    //    context, runs reliably); ② applyConfig (disable / window change);
    //    ③ endWindowHandler (end-window); ④ plugin unload (fail-open); ⑤ request
    //    signal abort. No timers / fiber-effect calls → cannot throw, cannot
    //    interrupt a turn.
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
      if (!cfg.enabled) return false
      // The gate follows the state machine exactly: computeRawState already
      // exempts the ended window (endWindowKey match + endWindowUntil), so a
      // different window (e.g. cross-timezone overlap) stays gated.
      const st = computeRawState(now)
      return st.name === 'PAUSED'
    }
    const gateInstalled = typeof ctx.on === 'function'
    // "User sent a message" signal for the balance display: every llm/stream
    // request corresponds to fresh user activity, so mark the balance stale —
    // the client refreshes it on the next poll (message-driven update; the
    // 10-minute timer is the client-side fallback cadence).
    let balanceDirty = false
    if (typeof ctx.on === 'function') {
      ctx.effect(() => {
        const dispose = ctx.on('llm/stream', (options: any, next: any) => {
          balanceDirty = true
          if (!gateClosedAt(new Date())) return next()
          const waitForOpen = () => new Promise((resolve) => {
            const ready = () => gateDisposed || !gateClosedAt(new Date())
              || !!(options && options.signal && options.signal.aborted)
            // Release helper: call next() defensively. A synchronous throw from
            // the waterfall chain (request context torn down / invariant fail)
            // must surface as a rejected promise — never as an exception
            // escaping into the abort event dispatch or wakeGateWaiters.
            const release = () => {
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
    } else {
      console.error('[save-money] ctx.on unavailable; llm/stream gate not installed')
    }

    // ---------- Startup reconciliation ----------
    function reconcile(): { restored: number; reason?: string } {
      const col = collectTasks()
      if (!col.ok) return { restored: 0, reason: col.reason }
      const goals = ctx.get('goals')
      const agents = ctx.get('agents')
      let restored = 0
      for (const agent of agents.list()) {
        let gv: any = undefined
        try { gv = goals.get(agent) } catch (e) { gv = undefined }
        if (gv && gv.phase === 'paused') {
          try {
            goals.resume(agent, { id: gv.id, revision: gv.revision })
            restored++
            console.log('[save-money] reconcile: restored paused goal of ' + agent.id)
          } catch (e: any) {
            console.error('[save-money] reconcile resume failed for ' + agent.id + ': ' + String((e && e.message) || e))
          }
        }
      }
      return { restored }
    }
    // ---- Owned timers (explicitly disposed on unload) ----
    // ctx.timer.timeout/interval are fiber effects and *should* be cleaned up
    // automatically when the fiber disposes, but hot-updates (run/update) are
    // the one path where we do NOT rely on implicit cleanup: save both
    // disposers and call them explicitly in the unload effect, so a repeated
    // update can never leak a 60s tick or a boot timeout.
    ctx.effect(() => {
      const boot = ctx.timer.timeout(() => {
        // Load the persisted config first, then run startup reconciliation
        void loadConfig().then(() => {
          if (cfg.reconcileOnStart) {
            const r = reconcile()
            if (r.restored > 0) console.log('[save-money] startup reconcile restored ' + r.restored + ' goal(s)')
          }
        })
      }, 100)
      const tick = ctx.timer.interval(() => {
        try {
          // Fallback release: whenever the gate is open (window ended / disabled /
          // end-window active) wake the waiters — this MUST run before the enabled
          // check, so disabling also releases waiters and suspended requests never
          // hang forever.
          if (!gateClosedAt(new Date())) wakeGateWaiters()
          if (!cfg.enabled) return
          onTick(new Date())
        } catch (e: any) {
          // A timer callback is a host callback: an escaping exception would be
          // an uncaughtException and crash the harness. Log and continue.
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
    // service (Cordis resolves the dependency as soon as it exists) and run the
    // same boot load + reconcile then — loadConfig is idempotent (it re-reads
    // the file and re-applies), so running it a second time is harmless and
    // only fills the gap when the first attempt found no fs yet.
    if (typeof ctx.inject === 'function') {
      // Bind keeps `this` (the ctx) when Cordis calls the returned inject
      // function, and gives the closure a non-optional reference so the
      // strict-null check in the delayed callback is satisfied.
      const inject: (deps: string[], callback: (sub: any) => void) => any = ctx.inject.bind(ctx)
      ctx.effect(() => inject(['fs'], (sub: any) => {
        sub.effect(() => {
          void loadConfig().then(() => {
            if (cfg.reconcileOnStart) {
              const r = reconcile()
              if (r.restored > 0) console.log('[save-money] late-fs reconcile restored ' + r.restored + ' goal(s)')
            }
          })
        })
      }))
    }

    // ---------- Status ----------
    function status(now: Date) {
      const st = computeRawState(now)
      const col = collectTasks()
      const out: any = {
        enabled: cfg.enabled,
        state: st.name,
        reason: st.reason || null,
        gate: gateClosedAt(now) ? 'closed' : 'open',
        gateInstalled,
        // Diagnostics (runtime workspace resolution) — helps verify where the
        // config file is loaded from / persisted to. resolveWorkspaceRoot is
        // async (pointer + fs probes), so report the last resolved value.
        workspaceRoot: resolvedConfigDir || defaultWorkspaceRoot,
        configLoaded,
        configPath,
        nowUTC: now.toISOString(),
        nowLocal: String(now),
        busy: col.ok ? (col.tasks.length > 0) : null,
        activeGoals: col.ok ? col.tasks.filter((t) => t.phase === 'active').length : null,
      }
      // Balance staleness signal: true when a user message arrived since the
      // last balance query (the client refreshes on the next poll).
      out.balanceDirty = balanceDirty
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
      if (endWindowUntil > now.getTime()) out.endWindowUntil = new Date(endWindowUntil).toISOString()
      out.pauseRecord = pauseRecord ? {
        at: pauseRecord.at,
        window: pauseRecord.window,
        pausedCount: (pauseRecord.paused || []).length,
        paused: (pauseRecord.paused || []).map((p) => ({ sessionId: p.sessionId, goalId: p.goalId })),
      } : null
      out.config = snapshot()
      return out
    }

    // ---- Host RPC (dynamic-plugin form: registered on the harness sandbox)
    // ---- + HTTP endpoints (official bundle form ONLY: the bundled Client half
    //      talks to the same-origin webServer; the dynamic Client half keeps
    //      using the harness RPC below and never registers routes on the host's
    //      global webServer).
    const harnessApi = typeof harness !== 'undefined' ? harness : null
    if (harnessApi) {
      ctx.effect(() => harnessApi.handle('save-money/status', async () => status(new Date())))
      ctx.effect(() => harnessApi.handle('save-money/configure', async (args: any) => applyConfig(unwrap(args) || {})))
    }
    const webServer = ctx.get('webServer')
    // The plugin row only injects timer, so in the official bundle form apply()
    // can run BEFORE the webServer service is registered. Register the HTTP
    // endpoints via Cordis' inject() dependency waiting — it runs the callback
    // as soon as webServer is available (immediately when already present), so
    // the bundled Client half never sees 404s (e.g. the Enable checkbox would
    // silently fail to configure). The disposer returned by webServer.register
    // is owned by the injected sub-context. Skipped entirely in the dynamic
    // form (harnessApi present).
    const registerHttpEndpoints = (ws: any): (() => void) | void => {
      if (!ws || typeof ws.register !== 'function') return
      const sendJson = (res: any, code: number, obj: any) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      return ws.register({
        kind: 'prefix',
        path: '/save-money',
        handler: async (req: any, res: any) => {
          try {
            const rawPath = String(req.url || '/').split('?')[0]
            const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath
            if (path === '/save-money/status') {
              sendJson(res, 200, status(new Date()))
              return
            }
            if (path === '/save-money/balance') {
              sendJson(res, 200, await balanceQuery())
              return
            }
            if (req.method === 'POST' && path === '/save-money/configure') {
              let raw = ''
              for await (const chunk of req) raw += chunk
              let patch: any = {}
              try { patch = JSON.parse(raw || '{}') } catch (e) { patch = {} }
              sendJson(res, 200, applyConfig(patch))
              return
            }
            if (req.method === 'POST' && path === '/save-money/end-window') {
              for await (const _ of req) { /* drain */ }
              sendJson(res, 200, await endWindowHandler())
              return
            }
            sendJson(res, 404, { ok: false, message: 'not found: ' + path })
          } catch (e: any) {
            sendJson(res, 500, { ok: false, message: String((e && e.message) || e) })
          }
        },
      })
    }
    if (!harnessApi && webServer && typeof webServer.register === 'function') {
      ctx.effect(() => registerHttpEndpoints(webServer) as any)
    } else if (!harnessApi && typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub: any) => {
        sub.effect(() => registerHttpEndpoints(sub.get('webServer')) as any)
      })
    }
    // UTC instant of a window's resumeAt (handles midnight-crossing windows).
    const endWindowUntilUTC = (w: TimeWindow, tz: string, baseWc: WallClock, dayOffset: number): number => {
      const p = parseHHMM(w.pauseAt)!, r = parseHHMM(w.resumeAt)!
      const off = dayOffset + (r < p ? 1 : 0)
      const base = new Date(Date.UTC(baseWc.y, baseWc.mo - 1, baseWc.d + off))
      return wallToUTC(tz, base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), r)
    }
    // "End this save mode" — one-shot, current window only:
    //  - paused: immediately resumes frozen goals and clears the record
    //  - pause upcoming (WARN): cancels the upcoming pause
    //  - no active window: nothing happens (never touches later windows)
    // The window is skipped until its resumeAt; the next window (today or
    // later) still takes effect; the persistent `enabled` flag is untouched.
    const endWindowHandler = async (): Promise<any> => {
      const now = new Date()
      const raw = computeRawState(now)
      if (!raw.window) {
        console.log('[save-money] end-window: no active window')
        return { ok: false, message: 'no active pause window to end', ...status(now) }
      }
      const tz = raw.window.timezone || cfg.timezone
      const wc = wallClock(tz, now)
      endWindowUntil = endWindowUntilUTC(raw.window, tz, wc, 0)
      endWindowKey = windowKey(raw.window, tz)
      if (lastStateKey.split(':')[0] === 'PAUSED') {
        lastStateKey = 'NORMAL'
        unfreeze()
      }
      wakeGateWaiters() // the gate is now open (endWindowUntil), release immediately
      console.log('[save-money] ended save mode for this window until ' + new Date(endWindowUntil).toISOString())
      return status(new Date())
    }
    if (harnessApi) {
      ctx.effect(() => harnessApi.handle('save-money/end-window', async () => endWindowHandler()))
    }

    // ---- Account balance (DeepSeek API /user/balance, shown in the header) ----
    // Implemented in src/balance-host.ts (inlined at build time): host-side
    // request, official-API guard, fetch/curl transport, 60s cache + in-flight
    // dedupe. The balance display is opt-in (cfg.showBalance, persisted,
    // default off): when off, the query reports unavailable so the UI hides
    // the balance entirely. Every failure returns ok:false and never throws.
    const balanceSvc = createBalanceService(ctx, { sandbox: !!harnessApi })
    // 余额历史(5 分钟采样 × 288 = 24 小时):由余额变化计算
    // 最近 1 小时 / 10 分钟 / 24 小时的消费金额。
    const balanceHistory = createBalanceHistory()
    /** 拉一次余额并写入历史采样点(5 分钟窗口内只更新不新增)。 */
    const sampleBalance = async (): Promise<void> => {
      try {
        const out = await balanceSvc.query()
        if (out && out.ok && Array.isArray(out.balance) && out.balance.length > 0 && typeof out.balance[0].total === 'string') {
          const total = parseFloat(out.balance[0].total)
          if (Number.isFinite(total)) balanceHistory.record(total)
        }
      } catch (e) { /* the sampler must never throw */ }
    }
    // 后端 5 分钟采样定时器:仅「显示余额」开启时拉取并记录(关闭时跳过,不产生请求)。
    ctx.effect(() => {
      const dispose = ctx.timer.interval(() => {
        if (cfg.showBalance) void sampleBalance()
      }, 300000)
      return () => {
        try { dispose() } catch (e) { /* unload must never throw */ }
      }
    })
    const balanceQuery = async (): Promise<any> => {
      if (!cfg.showBalance) return { ok: false, error: 'balance display is disabled' }
      const out = await balanceSvc.query()
      balanceDirty = false // a fresh balance was just fetched for the client
      // 把本次余额记为最新采样点(窗口内去重),再附带消费统计。
      if (out && out.ok && Array.isArray(out.balance) && out.balance.length > 0 && typeof out.balance[0].total === 'string') {
        const total = parseFloat(out.balance[0].total)
        if (Number.isFinite(total)) balanceHistory.record(total)
      }
      return {
        ...out,
        spend: {
          m10: balanceHistory.spend(10 * 60 * 1000),
          h1: balanceHistory.spend(60 * 60 * 1000),
          h24: balanceHistory.spend(24 * 60 * 60 * 1000),
        },
      }
    }
    if (harnessApi) {
      ctx.effect(() => harnessApi.handle('save-money/balance', async () => balanceQuery()))
    }

    // ---- Dynamic tools ----
    // Registered through harness in the dynamic-plugin sandbox; through the
    // ctx.tools service in the official module (plugin/index.js) form.
    const TOOL_DEFS: any[] = [
      {
        name: 'save_money_status',
        description: 'Query the save-money plugin state: enabled, gate state (NORMAL/WARN/PAUSED), busy detection, current window with UTC projection, PauseRecord summary, and full config.',
        parameters: { type: 'object', properties: {} },
        execute: async () => status(new Date()),
      },
      {
        name: 'save_money_configure',
        description: 'Set the save-money plugin configuration. Partial patch: enabled (bool), timezone (IANA name), warnMinutes (number), reconcileOnStart (bool), lang (auto/zh/zh-TW/en/de/fr/es/it/pt/ja/ko), showBalance (bool, shows the DeepSeek account balance in the header; off by default), windows (array of {pauseAt, resumeAt, days?, timezone?}, HH:mm wall-clock in the window timezone). Validates, stores in memory, and persists to the workspace config file. Returns the applied config.',
        parameters: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            timezone: { type: 'string' },
            warnMinutes: { type: 'number' },
            reconcileOnStart: { type: 'boolean' },
            lang: { type: 'string' },
            showBalance: { type: 'boolean' },
            windows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  pauseAt: { type: 'string' },
                  resumeAt: { type: 'string' },
                  days: { type: 'array', items: { type: 'number' } },
                  timezone: { type: 'string' },
                },
              },
            },
          },
        },
        execute: async (args: any) => applyConfig(unwrap(args) || {}),
      },
      {
        name: 'save_money_end_window',
        description: 'End save mode for the currently active pause window only (one-shot, in-memory, not persisted): if paused, immediately resumes frozen goals and releases the request gate; if a pause is upcoming, cancels it. The window is skipped until its resumeAt. The next window (today or later) still takes effect; the persistent enabled flag is untouched. Returns the new status.',
        parameters: { type: 'object', properties: {} },
        execute: async () => endWindowHandler(),
      },
      {
        name: 'save_money_debug_tick',
        description: 'Development tool: run one state-machine transition manually (as if a tick fired now). Returns the new status. Useful to verify freeze/resume without waiting for the timer.',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          onTick(new Date())
          return status(new Date())
        },
      },
    ]
    for (const def of TOOL_DEFS) {
      const tool = {
        ...def,
        output: {
          schema: { type: 'object', properties: {}, additionalProperties: true },
          render: (_args: any, result: any) => [{ type: 'text', text: JSON.stringify(result) }],
        },
      }
      if (harnessApi) {
        ctx.effect(() => harnessApi.registerTool(ctx, harnessApi.defineTool(tool)))
      } else {
        const tools = ctx.get('tools')
        if (tools && typeof tools.register === 'function') ctx.effect(() => tools.register(tool))
      }
    }
  },
}
