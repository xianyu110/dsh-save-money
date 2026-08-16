/**
 * dsh-save-money — Client half (single source of the dynamic-plugin code.client)
 *
 * Browser UI (entry convergence):
 * 1. conversation.session.header.utilities — the only persistent header entry
 *    (next to the Session log): status text "Save · 🟢 Working" (click to open
 *    the settings popover) + the top floating banner (position:fixed, includes
 *    the "Disable save mode" button).
 * 2. settings.section — system settings page "Save-money" (one section in the
 *    settings panel; not a persistent entry).
 *
 * Key implementation notes:
 * - The PAUSED banner copy ("Paused: model requests suspended, no cost, HH:mm
 *   auto-resumes") works with the Host request-level gate: nothing throws, the
 *   request waits before being sent and continues once released.
 * - The banner is registered in the session-header utilities slot (a normal
 *   layout chain) and floats with position:fixed — the shell.overlay container
 *   is pointer-events:none (click-through) and its slot anchor is
 *   display:contents, which broke button hit-testing.
 *
 * Experience notes:
 * - React / host are Client Builtin GLOBAL symbols — use them directly, do not
 *   ctx.get('React').
 * - slots / timer are Services — go through ctx.get / inject.
 * - The dynamic Client half has no browser timer globals (no setInterval) —
 *   use the timer service, and in React effects dispose via the cleanup.
 * - There is no "open settings panel" Client Event — the popover is drawn by
 *   the plugin (fixed + zIndex 10000).
 *
 * i18n: UI strings live in the I18N dictionary below (zh + en). The language is
 * auto-detected from navigator.language (zh* → zh, anything else → en).
 */

declare const React: any
declare const host: any
declare const navigator: { language?: string } | undefined

// --- i18n dictionary (erased types at build time) ---
type Lang = 'zh' | 'en'
interface Dict {
  badgeDisabled: string
  badgePaused: string
  badgeWarn: string
  badgeWorking: string
  bannerPaused: string
  bannerAutoResume: string
  bannerWarn: string
  bannerMinutes: string
  bannerMoment: string
  endThisWindow: string
  endWindowActive: string
  statusPrefix: string
  windowSuffix: string
  pausedNote: string
  deepseekPreset: string
  presetExists: string
  presetUpgraded: string
  presetAdded: string
  applyFailed: string
  savedMsg: string
  enable: string
  timezone: string
  language: string
  langAuto: string
  langZh: string
  langEn: string
  windowsTitle: string
  pause: string
  resume: string
  removeTitle: string
  addWindow: string
  save: string
  settingsTitle: string
  headerTitle: string
  badgeLabel: string
  sectionLabel: string
  settingsHeading: string
}

const I18N: Record<Lang, Dict> = {
  zh: {
    badgeDisabled: '未启用',
    badgePaused: '已经暂停',
    badgeWarn: '即将暂停',
    badgeWorking: '工作中',
    bannerPaused: '⛔ 已暂停：模型请求已挂起，不产生费用。',
    bannerAutoResume: ' 自动继续',
    bannerWarn: '⏳ 距离暂停还有 ',
    bannerMinutes: ' 分钟',
    bannerMoment: '片刻',
    endThisWindow: '结束本次省钱模式',
    endWindowActive: '✅ 您已结束本次省钱模式：窗口 {a}-{b} 已跳过，{c} 自动恢复省钱（重新关闭再勾选「启用」可重置）',
    statusPrefix: '状态：',
    windowSuffix: '（{a}-{b}）',
    pausedNote: '暂停窗口内所有模型请求在发出前被挂起（不产生费用），窗口结束自动继续，上下文不受影响；点「结束本次省钱模式」可立即恢复并跳过本窗口（只影响当前窗口，下一窗口照常生效）。',
    deepseekPreset: '一键 DeepSeek 分时计价省钱策略',
    presetExists: 'DeepSeek 预设两组窗口（含 2 分钟余量）已存在，未重复添加。勾选「启用」即可生效。',
    presetUpgraded: '已升级 {n} 组旧窗口为带余量窗口；',
    presetAdded: '已添加 {n} 组 DeepSeek 预设窗口（未启用，请自行勾选「启用」）。',
    applyFailed: '一键应用失败：',
    savedMsg: '已保存 {n} 组窗口。',
    enable: '启用',
    timezone: '时区',
    language: '语言',
    langAuto: '自动（跟随浏览器）',
    langZh: '中文',
    langEn: 'English',
    windowsTitle: '暂停窗口（{tz} 墙上时间，共 {n} 组）',
    pause: '暂停',
    resume: '继续',
    removeTitle: '删除该组',
    addWindow: '+ 添加窗口',
    save: '保存',
    settingsTitle: '省钱插件设置',
    headerTitle: 'save-money：{status}（点击进入设置）',
    badgeLabel: '省钱 · {symbol} {text}',
    sectionLabel: '省钱插件',
    settingsHeading: 'save-money 省钱插件',
  },
  en: {
    badgeDisabled: 'Disabled',
    badgePaused: 'Paused',
    badgeWarn: 'Pausing soon',
    badgeWorking: 'Working',
    bannerPaused: '⛔ Paused: model requests suspended, no cost.',
    bannerAutoResume: ' auto-resumes',
    bannerWarn: '⏳ Pause in ',
    bannerMinutes: ' min',
    bannerMoment: 'a moment',
    endThisWindow: 'End this save mode',
    endWindowActive: '✅ You ended this save mode: window {a}-{b} skipped, saving resumes at {c} (toggle Enable off/on to reset)',
    statusPrefix: 'Status: ',
    windowSuffix: ' ({a}-{b})',
    pausedNote: 'All model requests are suspended before being sent (no cost). They resume automatically when the window ends; context is unaffected. Click "End this save mode" to resume now and skip only this window (the next window still takes effect).',
    deepseekPreset: 'One-click DeepSeek peak/off-peak savings',
    presetExists: 'DeepSeek preset windows (2-min margin) already present; not re-added. Check "Enable" to activate.',
    presetUpgraded: 'Upgraded {n} window(s) to the margin version; ',
    presetAdded: 'Added {n} DeepSeek preset window(s) (not enabled — check "Enable" to activate).',
    applyFailed: 'One-click failed: ',
    savedMsg: 'Saved {n} window(s).',
    enable: 'Enable',
    timezone: 'Timezone',
    language: 'Language',
    langAuto: 'Auto (browser)',
    langZh: '中文',
    langEn: 'English',
    windowsTitle: 'Pause windows ({tz} wall-clock, {n} total)',
    pause: 'Pause',
    resume: 'Resume',
    removeTitle: 'Remove this window',
    addWindow: '+ Add window',
    save: 'Save',
    settingsTitle: 'Save-money settings',
    headerTitle: 'save-money: {status} (click for settings)',
    badgeLabel: 'Save · {symbol} {text}',
    sectionLabel: 'Save-money',
    settingsHeading: 'save-money plugin',
  },
}

function detectLang(): Lang {
  try {
    const l = (typeof navigator !== 'undefined' && navigator && navigator.language) || ''
    if (/^zh/i.test(l)) return 'zh'
  } catch (e) { /* fall through to en */ }
  return 'en'
}
// Language is reactive: currentLang starts from browser detection and is
// overridden by the persisted config choice ('zh'/'en') or kept on 'auto'
// (follow the browser) — see refresh() below and the settings dropdown.
let currentLang: Lang = detectLang()
const resolveLang = (cfgLang: string | undefined | null): Lang => {
  if (cfgLang === 'zh' || cfgLang === 'en') return cfgLang
  return detectLang()
}
const t = (key: string, vars?: Record<string, string | number>): string => {
  let s: string = (I18N[currentLang] && (I18N[currentLang] as any)[key]) || (I18N.en as any)[key] || key
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]))
  }
  return s
}

return {
  inject: ['timer'],
  async apply(ctx: any) {
    const slots = ctx.get('slots')
    const timer = ctx.timer
    if (!React || !host || !slots || !timer) {
      console.error('[save-money] client apply aborted')
      return
    }

    // Detect the browser timezone, fall back to Beijing time
    let detectedTz = 'Asia/Shanghai'
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz && typeof tz === 'string' && tz.length > 0) detectedTz = tz
    } catch (e) { /* fall back to Beijing time */ }

    let snapshot: any = { enabled: false, state: 'NORMAL', reason: null, window: null, minutesToPause: null, endWindowUntil: null, pauseRecord: null, config: null }
    const refresh = async () => {
      try {
        const s = await host.call('save-money/status')
        if (s && typeof s === 'object') {
          snapshot = s
          // Keep the UI language in sync with the persisted config choice
          if (s.config && typeof s.config.lang === 'string') currentLang = resolveLang(s.config.lang)
        }
      } catch (e) {}
    }
    void refresh()
    ctx.effect(() => timer.interval(() => { void refresh() }, 30000))

    // useSnap returns [st, setSt]: components can refresh manually (button
    // clicks reflect the new state immediately)
    const useSnap = () => {
      const [st, setSt] = React.useState({ ...snapshot })
      React.useEffect(() => {
        let alive = true
        const tick = async () => { await refresh(); if (alive) setSt({ ...snapshot }) }
        void tick()
        const stop = timer.interval(() => { void tick() }, 30000)
        return () => { alive = false; stop() }
      }, [])
      return [st, setSt]
    }

    // Per-registration actions: doConfigure = RPC + immediate refresh
    const makeActions = (setSt: any) => ({
      doConfigure: async (patch: any) => {
        try { await host.call('save-money/configure', patch); await refresh(); setSt({ ...snapshot }) } catch (e) {}
      },
      doEndWindow: async () => {
        try { await host.call('save-money/end-window'); await refresh(); setSt({ ...snapshot }) } catch (e) {}
      },
    })

    // ---------- Status badge color / text / symbol ----------
    const badgeInfo = (st: any) => {
      const color = !st.enabled ? '#9E9E9E' : st.state === 'PAUSED' ? '#E53935' : st.state === 'WARN' ? '#F9A825' : '#4CAF50'
      const text = !st.enabled ? t('badgeDisabled') : st.state === 'PAUSED' ? t('badgePaused') : st.state === 'WARN' ? t('badgeWarn') : t('badgeWorking')
      const symbol = !st.enabled ? '⚪' : st.state === 'PAUSED' ? '🔴' : st.state === 'WARN' ? '🟡' : '🟢'
      return { color, text, symbol }
    }

    // ---------- Settings panel (ignore on top, single Save at the bottom) ----------
    const SettingsView = (props: any) => {
      const st = props.st
      const doConfigure = props.doConfigure
      const doEndWindow = props.doEndWindow || (async () => {})
      const cfg = st.config || {}
      const [tz, setTz] = React.useState(cfg.timezone || detectedTz)
      // Default windows shown when none are configured (fresh install / all
      // windows deleted) — matches the one-click DeepSeek preset (2-minute
      // boundary margin): 08:58–12:02, 13:58–18:02.
      const DEFAULT_WINS = [
        { pauseAt: '08:58', resumeAt: '12:02' },
        { pauseAt: '13:58', resumeAt: '18:02' },
      ]
      const [wins, setWins] = React.useState(DEFAULT_WINS.map((w: any) => ({ ...w })))
      const [msg, setMsg] = React.useState('')
      const [langSel, setLangSel] = React.useState(cfg.lang || 'auto')
      const prevWinKey = React.useRef('')
      const prevTz = React.useRef(null)
      const prevLang = React.useRef(null)
      React.useEffect(() => {
        // Sync only when the config actually changed (the 30s poll must not
        // interrupt in-progress edits)
        if (cfg.timezone && cfg.timezone !== prevTz.current) {
          prevTz.current = cfg.timezone
          setTz(cfg.timezone)
        }
        const cl = cfg.lang || 'auto'
        if (cl !== prevLang.current) {
          prevLang.current = cl
          setLangSel(cl)
          currentLang = resolveLang(cl)
        }
        const ws = cfg.windows || []
        const key = JSON.stringify(ws)
        if (key !== prevWinKey.current) {
          prevWinKey.current = key
          setWins(ws.length > 0
            ? ws.map((w: any) => ({ pauseAt: w.pauseAt, resumeAt: w.resumeAt }))
            : DEFAULT_WINS.map((w: any) => ({ ...w })))
        }
      }, [st])
      const row = (label: string, children: any) => React.createElement('div', { style: { margin: '8px 0', display: 'flex', alignItems: 'center', gap: '8px' } },
        React.createElement('span', { style: { minWidth: '80px', fontSize: '13px' } }, label), children)
      const input = (value: string, setter: any, width?: string) => React.createElement('input', {
        value, onChange: (e: any) => setter(e.target.value),
        style: { width: width || '72px', padding: '3px 6px', fontSize: '13px' },
      })
      const btn = (text: string, fn: any, primary: boolean) => React.createElement('button', {
        onClick: fn,
        style: { padding: '6px 14px', cursor: 'pointer', fontSize: '13px', background: primary ? '#1565C0' : '#eee', color: primary ? '#fff' : '#333', border: 'none', borderRadius: '6px' },
      }, text)
      // Window add/remove/edit
      const setWin = (i: number, key: string, val: string) => setWins(wins.map((w: any, j: number) => (j === i ? { ...w, [key]: val } : w)))
      const addWin = () => setWins([...wins, { pauseAt: '08:58', resumeAt: '12:02' }])
      const delWin = (i: number) => setWins(wins.filter((_: any, j: number) => j !== i))
      // One-click apply = dedupe-append (does NOT auto-enable; the user checks
      // the Enable box themselves). The DeepSeek preset windows carry a 2-minute
      // boundary margin — pause 2 min early, resume 2 min late
      // (08:58–12:02, 13:58–18:02, avoiding clock-skew requests slipping
      // through or releasing early at peak boundaries).
      const DEEPSEEK_PRESET = [
        { pauseAt: '08:58', resumeAt: '12:02', timezone: 'Asia/Shanghai' },
        { pauseAt: '13:58', resumeAt: '18:02', timezone: 'Asia/Shanghai' },
      ]
      // Legacy DeepSeek windows (no margin) — removed first on one-click so the
      // overlap validation does not reject the new ones.
      const DEEPSEEK_LEGACY = [
        { pauseAt: '09:00', resumeAt: '12:00', timezone: 'Asia/Shanghai' },
        { pauseAt: '14:00', resumeAt: '18:00', timezone: 'Asia/Shanghai' },
      ]
      const applyDeepSeekPreset = async () => {
        try {
          // WYSIWYG: work from the window list the user currently SEES in the
          // UI (wins), not from whatever was last persisted on the host — so
          // edits made but not yet saved are respected.
          const curTz = (st.config && st.config.timezone) || 'Asia/Shanghai'
          const key = (w: any) => String(w.pauseAt) + '|' + String(w.resumeAt) + '|' + (w.timezone || curTz)
          const legacyKeys = new Set(DEEPSEEK_LEGACY.map(key))
          const cleaned = wins.filter((w: any) => !legacyKeys.has(key(w))) // upgrade legacy windows
          const existing = new Set(cleaned.map(key))
          const add = DEEPSEEK_PRESET.filter((p: any) => !existing.has(key(p)))
          if (add.length === 0) {
            setMsg(t('presetExists'))
            return
          }
          const merged = cleaned.concat(add)
          setWins(merged) // reflect the result in the UI immediately
          await doConfigure({ windows: merged }) // windows only, enabled untouched
          const upgraded = wins.length - cleaned.length
          setMsg((upgraded > 0 ? t('presetUpgraded', { n: upgraded }) : '') + t('presetAdded', { n: add.length }))
        } catch (e: any) {
          setMsg(t('applyFailed') + String((e && e.message) || e))
        }
      }
      // Unified Save at the bottom (replaces the old "apply windows" button)
      const saveAll = () => {
        const clean = wins
          .map((w: any) => ({ pauseAt: String(w.pauseAt || '').trim(), resumeAt: String(w.resumeAt || '').trim() }))
          .filter((w: any) => w.pauseAt !== '' && w.resumeAt !== '')
        void doConfigure({ windows: clean.map((w: any) => ({ ...w, timezone: tz })) })
        setMsg(t('savedMsg', { n: clean.length }))
      }
      const b = badgeInfo(st)
      return React.createElement('div', { style: { padding: '12px' } },
        // Top: status text + end-this-window button (kept near the top; shown
        // only when a window is active — WARN or PAUSED)
        React.createElement('div', { style: { margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          React.createElement('span', { style: { fontSize: '13px', fontWeight: 600, color: b.color } },
            t('statusPrefix') + b.text + (st.state === 'PAUSED' && st.window ? t('windowSuffix', { a: st.window.pauseAt, b: st.window.resumeAt }) : '')),
          (st.state === 'WARN' || st.state === 'PAUSED')
            ? btn(t('endThisWindow'), () => void doEndWindow(), st.state === 'PAUSED')
            : null,
          st.state === 'PAUSED' ? React.createElement('div', { style: { margin: '6px 0', fontSize: '12px', color: '#C62828' } }, t('pausedNote')) : null,
        ),
        // Green status line while "end this save mode" is in effect for the
        // current window (in-memory, one-shot): tells the user what happened
        // and how to reset it.
        st.endWindowUntil ? React.createElement('div', { style: { margin: '6px 0 10px', fontSize: '12px', color: '#2E7D32', fontWeight: 600 } },
          t('endWindowActive', { a: st.window ? st.window.pauseAt : '', b: st.window ? st.window.resumeAt : '', c: st.window ? st.window.resumeAt : '' })) : null,
        btn(t('deepseekPreset'), () => void applyDeepSeekPreset(), true),
        msg ? React.createElement('div', { style: { margin: '8px 0', fontSize: '12px', color: '#555' } }, msg) : null,
        row(t('enable'), React.createElement('input', {
          type: 'checkbox', checked: !!st.enabled,
          onChange: (e: any) => void doConfigure({ enabled: e.target.checked }),
        })),
        row(t('timezone'), React.createElement('select', {
          value: tz,
          onChange: (e: any) => { setTz(e.target.value); void doConfigure({ timezone: e.target.value }) },
          style: { padding: '3px 6px', fontSize: '13px' },
        },
          React.createElement('option', { value: 'Asia/Shanghai' }, 'Asia/Shanghai (UTC+8)'),
          React.createElement('option', { value: 'UTC' }, 'UTC (+0)'),
          React.createElement('option', { value: 'Asia/Tokyo' }, 'Asia/Tokyo (UTC+9)'),
          React.createElement('option', { value: 'Europe/London' }, 'Europe/London'),
          React.createElement('option', { value: 'America/New_York' }, 'America/New_York'),
          React.createElement('option', { value: 'America/Los_Angeles' }, 'America/Los_Angeles'),
        )),
        // Language: auto (follow the browser) by default; manual zh/en choice is
        // persisted into the host config (save-money.config.json, `lang` field)
        // so it survives refresh/restart in every plugin form.
        row(t('language'), React.createElement('select', {
          value: langSel,
          onChange: (e: any) => {
            const v = e.target.value
            setLangSel(v)
            currentLang = resolveLang(v)
            void doConfigure({ lang: v })
          },
          style: { padding: '3px 6px', fontSize: '13px' },
        },
          React.createElement('option', { value: 'auto' }, t('langAuto')),
          React.createElement('option', { value: 'zh' }, t('langZh')),
          React.createElement('option', { value: 'en' }, t('langEn')),
        )),
        React.createElement('div', { style: { marginTop: '12px', fontSize: '13px', fontWeight: 600 } },
          t('windowsTitle', { tz, n: wins.length })),
        wins.map((w: any, i: number) => React.createElement('div', { key: i, style: { margin: '6px 0', display: 'flex', alignItems: 'center', gap: '6px' } },
          React.createElement('span', { style: { fontSize: '12px', color: '#888', width: '28px' } }, String(i + 1) + '.'),
          React.createElement('span', { style: { fontSize: '12px' } }, t('pause')),
          input(w.pauseAt, (v: string) => setWin(i, 'pauseAt', v)),
          React.createElement('span', { style: { fontSize: '12px' } }, t('resume')),
          input(w.resumeAt, (v: string) => setWin(i, 'resumeAt', v)),
          React.createElement('button', {
            onClick: () => delWin(i),
            style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', color: '#C62828', padding: '2px 4px' },
            title: t('removeTitle'),
          }, '✕'),
        )),
        React.createElement('div', { style: { margin: '8px 0' } },
          btn(t('addWindow'), () => addWin(), false),
        ),
        // Bottom: unified Save button
        React.createElement('div', { style: { margin: '10px 0 2px', display: 'flex', justifyContent: 'flex-end' } },
          btn(t('save'), () => saveAll(), true),
        ),
      )
    }

    // ---------- Top floating banner (registered in the header slot,
    //            position:fixed) ----------
    // The button is "End this save mode" — one-shot end for the current
    // window only (in-memory, not persisted; the persistent enabled flag is
    // untouched, so future windows keep saving money).
    const FloatingBanner = (props: any) => {
      const st = props.st
      const doEndWindow = props.doEndWindow
      const isWarn = st.state === 'WARN'
      const isPaused = st.state === 'PAUSED'
      if (!isWarn && !isPaused) return null
      return React.createElement('div', {
        style: {
          position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
          background: isPaused ? '#FFEBEE' : '#FFF8E1',
          color: isPaused ? '#C62828' : '#B26A00',
          padding: '8px 18px', borderRadius: '999px', fontSize: '13px', fontWeight: 600,
          zIndex: 9999, boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
          display: 'flex', alignItems: 'center', gap: '10px',
          pointerEvents: 'auto',
        },
      },
        React.createElement('span', { style: { pointerEvents: 'none' } }, isPaused
          ? t('bannerPaused') + (st.window ? ' ' + st.window.resumeAt + t('bannerAutoResume') : '')
          : t('bannerWarn') + (st.minutesToPause != null ? st.minutesToPause + t('bannerMinutes') : t('bannerMoment'))),
        React.createElement('button', {
          style: {
            border: 'none', background: isPaused ? '#C62828' : '#B26A00', color: '#fff',
            borderRadius: '999px', padding: '3px 12px', cursor: 'pointer', fontSize: '12px',
            pointerEvents: 'auto',
          },
          onClick: () => void doEndWindow(),
        }, t('endThisWindow')),
      )
    }
    // ---- Main UI: session-header right-aligned area (status text + floating
    //      banner in the same slot; the banner no longer uses shell.overlay) ----
    slots.inject('conversation.session.header.utilities', () => slots.register(
      { name: 'conversation.session.header.utilities', id: 'save-money-status-text', order: 5 },
      () => {
        const [st, setSt] = useSnap()
        const [open, setOpen] = React.useState(false)
        const actions = makeActions(setSt)
        const b = badgeInfo(st)
        // "Save" + symbol + status text all use the state color
        const text = React.createElement('span', {
          onClick: () => setOpen(!open),
          style: {
            color: b.color, fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap',
            padding: '4px 8px', cursor: 'pointer', borderRadius: '6px',
            border: '1px solid ' + b.color, marginRight: '8px',
            pointerEvents: 'auto',
          },
          title: t('headerTitle', { status: b.text }),
        }, t('badgeLabel', { symbol: b.symbol, text: b.text }))
        const pop = open
          ? React.createElement('div', {
              style: {
                position: 'fixed', right: '16px', top: '56px', width: '380px',
                background: '#fff', color: '#222', borderRadius: '10px',
                boxShadow: '0 6px 24px rgba(0,0,0,0.25)', padding: '4px 8px 8px',
                zIndex: 10000, border: '1px solid rgba(0,0,0,0.12)', maxHeight: '70vh', overflowY: 'auto',
                pointerEvents: 'auto',
              },
            },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 6px 0' } },
                React.createElement('span', { style: { fontSize: '13px', fontWeight: 700 } }, t('settingsTitle')),
                React.createElement('button', {
                  onClick: () => setOpen(false),
                  style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px', color: '#888', pointerEvents: 'auto' },
                }, '✕'),
              ),
              React.createElement(SettingsView, { st, ...actions }),
            )
          : null
        return React.createElement('div', { style: { display: 'contents' } },
          text,
          pop,
          React.createElement(FloatingBanner, { st, doEndWindow: actions.doEndWindow }),
        )
      }
    ))

    // ---- System settings page (settings.section, kept) ----
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'save-money', order: 25, label: t('sectionLabel') },
      () => {
        const [st, setSt] = useSnap()
        const actions = makeActions(setSt)
        return React.createElement('div', { style: { padding: '12px' } },
          React.createElement('h3', { style: { margin: '0 0 12px', fontSize: '15px' } }, t('settingsHeading')),
          React.createElement(SettingsView, { st, ...actions }),
        )
      }
    ))
  },
}
